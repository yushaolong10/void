import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { HookContext, HookDefinition, HookEventName, HookRunner } from '../../common/agent/extensions/HookRunner.js';
import { PluginDefinition, PluginLoader } from '../../common/agent/extensions/PluginLoader.js';
import { SkillDefinition, SkillLoader } from '../../common/agent/extensions/SkillLoader.js';
import { ITerminalToolService } from '../terminalToolService.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

export interface IAgentExtensionService {
	readonly _serviceBrand: undefined;
	reload(): Promise<void>;
	runHook(context: HookContext): Promise<void>;
	listSkills(): readonly SkillDefinition[];
	listPlugins(): readonly PluginDefinition[];
	listHooks(): readonly HookDefinition[];
}

export const IAgentExtensionService = createDecorator<IAgentExtensionService>('AgentExtensionService');

export class AgentExtensionService extends Disposable implements IAgentExtensionService {
	readonly _serviceBrand: undefined;

	private readonly hookRunner = new HookRunner();
	private readonly skillLoader = new SkillLoader();
	private readonly pluginLoader = new PluginLoader();
	private skills: SkillDefinition[] = [];

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
	) {
		super();
		this.reload();
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const voidDir = URI.joinPath(folder.uri, '.void');
			this._register(this.fileService.watch(voidDir, { recursive: true, excludes: [] }));
		}
		this._register(this.fileService.onDidFilesChange(e => {
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				if (e.contains(URI.joinPath(folder.uri, '.void'))) {
					this.reload();
					return;
				}
			}
		}));
	}

	async reload(): Promise<void> {
		this.skills = [];
		this.hookRunner.clearDefinitions();
		this.pluginLoader.clear();
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			await this._loadSkills(folder.uri);
			await this._loadHooks(folder.uri);
			await this._loadPlugins(folder.uri);
		}
	}

	async runHook(context: HookContext): Promise<void> {
		await this.hookRunner.run(context);
		for (const hook of this.hookRunner.listDefinitions()) {
			if (hook.event !== context.event || !hook.command) continue;
			const { resPromise } = await this.terminalToolService.runCommand(hook.command, {
				type: 'temporary',
				cwd: hook.cwd ?? null,
				terminalId: generateUuid(),
			});
			await resPromise;
		}
	}

	listSkills(): readonly SkillDefinition[] {
		return this.skills;
	}

	listPlugins(): readonly PluginDefinition[] {
		return this.pluginLoader.list();
	}

	listHooks(): readonly HookDefinition[] {
		return this.hookRunner.listDefinitions();
	}

	private async _loadSkills(workspaceUri: URI): Promise<void> {
		const skillsDir = URI.joinPath(workspaceUri, '.void', 'skills');
		await this._loadSkillsFromDirectory(skillsDir);
	}

	private async _loadSkillsFromDirectory(skillsDir: URI): Promise<void> {
		for (const file of await this._listFiles(skillsDir)) {
			if (!file.path.endsWith('.md')) continue;
			const content = (await this.fileService.readFile(file)).value.toString();
			this.skills.push(this.skillLoader.parseMarkdown(file.path.split('/').pop() ?? 'SKILL.md', content));
		}
	}

	private async _loadHooks(workspaceUri: URI): Promise<void> {
		const hooksDir = URI.joinPath(workspaceUri, '.void', 'hooks');
		await this._loadHooksFromDirectory(hooksDir);
	}

	private async _loadHooksFromDirectory(hooksDir: URI): Promise<void> {
		for (const file of await this._listFiles(hooksDir)) {
			if (!file.path.endsWith('.json')) continue;
			try {
				const parsed = JSON.parse((await this.fileService.readFile(file)).value.toString()) as Partial<HookDefinition>;
				if (!parsed.event || !this._isHookEventName(parsed.event)) continue;
				this.hookRunner.registerDefinition({
					id: parsed.id ?? file.path,
					event: parsed.event,
					command: parsed.command,
					cwd: parsed.cwd,
				});
			}
			catch {
				continue;
			}
		}
	}

	private async _loadPlugins(workspaceUri: URI): Promise<void> {
		const pluginsDir = URI.joinPath(workspaceUri, '.void', 'plugins');
		for (const pluginDir of await this._listDirectories(pluginsDir)) {
			const pluginJson = URI.joinPath(pluginDir, 'plugin.json');
			try {
				const parsed = JSON.parse((await this.fileService.readFile(pluginJson)).value.toString()) as PluginDefinition;
				if (parsed.name) this.pluginLoader.register(parsed);
			}
			catch {
				continue;
			}
			await this._loadSkillsFromDirectory(URI.joinPath(pluginDir, 'skills'));
			await this._loadHooksFromDirectory(URI.joinPath(pluginDir, 'hooks'));
		}
	}

	private async _listFiles(uri: URI): Promise<URI[]> {
		try {
			const stat = await this.fileService.resolve(uri);
			return stat.children?.filter(child => child.isFile).map(child => child.resource) ?? [];
		}
		catch {
			return [];
		}
	}

	private async _listDirectories(uri: URI): Promise<URI[]> {
		try {
			const stat = await this.fileService.resolve(uri);
			return stat.children?.filter(child => child.isDirectory).map(child => child.resource) ?? [];
		}
		catch {
			return [];
		}
	}

	private _isHookEventName(value: string): value is HookEventName {
		return value === 'before_tool_call'
			|| value === 'after_tool_call'
			|| value === 'before_file_edit'
			|| value === 'after_file_edit'
			|| value === 'after_run_command'
			|| value === 'before_checkpoint'
			|| value === 'after_checkpoint'
			|| value === 'on_run_failed';
	}
}

registerSingleton(IAgentExtensionService, AgentExtensionService, InstantiationType.Eager);
