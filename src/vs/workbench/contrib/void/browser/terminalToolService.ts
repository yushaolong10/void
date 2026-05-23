/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_INACTIVE_TIME, MAX_TERMINAL_TOTAL_TIME } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { timeout } from '../../../../base/common/async.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVoidSpawnCommandService } from '../common/voidSpawnCommandTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';



export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { type: 'persistent', persistentTerminalId: string }
		| { type: 'temporary', cwd: string | null, terminalId: string }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string, resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>
	persistentTerminalExists(terminalId: string): boolean

	readTerminal(terminalId: string): Promise<string>

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>
	killPersistentTerminal(terminalId: string): Promise<void>

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }


export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') return 'Void Agent'
	return `Void Agent (${id})`
}
export const idOfPersistentTerminalName = (name: string) => {
	if (name === 'Void Agent') return '1'

	const match = name.match(/Void Agent \((\d+)\)/)
	if (!match) return null
	if (Number.isInteger(match[1]) && Number(match[1]) >= 1) return match[1]
	return null
}

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private _spawnCommandService: IVoidSpawnCommandService | undefined = undefined;

	private get spawnCommandService(): IVoidSpawnCommandService {
		if (!this._spawnCommandService) {
			this._spawnCommandService = ProxyChannel.toService<IVoidSpawnCommandService>(
				this.mainProcessService.getChannel('void-channel-spawnCommand')
			);
		}
		return this._spawnCommandService;
	}

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove
			const d = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title)
				if (terminalId !== null && (terminalId in this.persistentTerminalInstanceOfId)) delete this.persistentTerminalInstanceOfId[terminalId]
				d.dispose()
			})
		}


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
			if (proposedTerminalId) this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal

			initializeTerminal(terminal)
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => { initializeTerminal(terminal) })
		)

	}


	listPersistentTerminalIds() {
		return Object.keys(this.persistentTerminalInstanceOfId)
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) return '1'

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!(potentialId in this.persistentTerminalInstanceOfId)) return potentialId;
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'], hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined = (override_cwd ?? undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : undefined,
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options)

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) }
		const terminal = await this._createTerminal({ cwd, config, })
		this.persistentTerminalInstanceOfId[terminalId] = terminal
		return terminalId
	}

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		terminal.dispose()
		delete this.persistentTerminalInstanceOfId[terminalId]
		return
	}

	persistentTerminalExists(terminalId: string): boolean {
		return terminalId in this.persistentTerminalInstanceOfId
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.temporaryTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		this.terminalService.setActiveInstance(terminal)
		await this.terminalService.focusActiveInstance()
	}




	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		// Ensure the xterm.js instance has been created – otherwise we cannot access the buffer.
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		// Use head/tail approach to avoid collecting the entire buffer into memory before truncating.
		// For large scrollback buffers, this avoids creating many intermediate strings and arrays.
		const half = MAX_TERMINAL_CHARS / 2;
		const headLines: string[] = [];
		const tailLines: string[] = [];
		let headChars = 0;
		let tailChars = 0;
		let totalChars = 0;

		// Collect lines from the buffer iterator (newest to oldest via reverse iterator)
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			const cleanedLine = removeAnsiEscapeCodes(line);
			totalChars += cleanedLine.length + 1; // +1 for newline

			if (headChars < half) {
				headLines.push(cleanedLine);
				headChars += cleanedLine.length + 1;
			} else if (tailChars < half) {
				tailLines.push(cleanedLine);
				tailChars += cleanedLine.length + 1;
			}
			// If both head and tail are full, stop collecting
			if (headChars >= half && tailChars >= half) {
				break;
			}
		}

		// headLines are newest→oldest (reverse order from iterator), need to reverse for chronological
		headLines.reverse();
		// tailLines are oldest portion (newest→oldest from iterator), reverse for chronological
		tailLines.reverse();

		if (totalChars <= MAX_TERMINAL_CHARS) {
			// If total fits, reconstruct in correct order: tail (older) + head (newer)
			// Note: tailLines currently holds older lines (collected after head was full)
			// and headLines holds the newest lines (collected first from reverse iterator)
			const allLines = [...tailLines, ...headLines];
			return allLines.join('\n');
		}

		// Truncated output: tail (oldest/beginning) + separator + head (newest/end)
		// to match original format: first half + '...' + last half
		const result = tailLines.join('\n') + '\n...\n' + headLines.join('\n');
		return result;
	};

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) return cmdCap

		const disposables: IDisposable[] = []

		const waitTimeout = timeout(10_000)
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) res(e.capability)
				})
			)
		})

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()) })

		return capability ?? undefined
	}

	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		const { type } = params
		const isPersistent = type === 'persistent'

		// ========================================================
		// TEMPORARY: Use child_process.spawn (via main-process IPC)
		// Avoids the pty host → IPC → xterm forwarding chain that
		// is the primary performance hotspot for high-output commands.
		// ========================================================
		if (!isPersistent) {
			const { cwd } = params;

			// Generate commandId on the browser side so interrupt() works even
			// before runCommand() resolves (function calls can't pass through IPC).
			const commandId = generateUuid();
			let aborted = false;

			const interrupt = () => {
				if (aborted) return;
				aborted = true;
				// Fire-and-forget abort via IPC. Errors are non-fatal since the
				// command will be killed by its own timeout mechanisms regardless.
				this.spawnCommandService.abortCommand(commandId).catch(() => { /* ignore */ });
			};

			const resPromise = (async () => {
				const { result, resolveReason } = await this.spawnCommandService.runCommand({
					command,
					cwd,
					maxChars: MAX_TERMINAL_CHARS,
					idleTimeout: MAX_TERMINAL_INACTIVE_TIME,
					totalTimeout: MAX_TERMINAL_TOTAL_TIME,
					commandId,
				});

				// Format result same as terminal path: prefix command, strip ANSI, truncate
				let formatted = `$ ${command}\n${result}`;
				formatted = removeAnsiEscapeCodes(formatted);
				if (formatted.length > MAX_TERMINAL_CHARS) {
					const half = MAX_TERMINAL_CHARS / 2;
					formatted = formatted.slice(0, half)
						+ '\n...\n'
						+ formatted.slice(formatted.length - half, Infinity);
				}

				return { result: formatted, resolveReason };
			})();

			return { interrupt, resPromise };
		}

		// ========================================================
		// PERSISTENT: Use VS Code terminal (user-visible, interactive)
		// ========================================================
		await this.terminalService.whenConnected;

		const { persistentTerminalId } = params;
		const terminal = this.persistentTerminalInstanceOfId[persistentTerminalId];
		if (!terminal) throw new Error(`Unexpected internal error: Terminal with ID ${persistentTerminalId} did not exist.`);

		const disposables: IDisposable[] = [];

		const interrupt = () => {
			terminal.dispose();
			delete this.persistentTerminalInstanceOfId[persistentTerminalId];
		};

		const waitForResult = async () => {
			// Focus the terminal about to run
			this.terminalService.setActiveInstance(terminal);
			await this.terminalService.focusActiveInstance();

			let result: string = '';
			let resolveReason: TerminalResolveReason | undefined;

			const cmdCap = await this._waitForCommandDetectionCapability(terminal);

			const waitUntilDone = new Promise<void>(resolve => {
				if (!cmdCap) {
					resolve();
					return;
				}
				const l = cmdCap.onCommandFinished(cmd => {
					if (resolveReason) return;
					resolveReason = { type: 'done', exitCode: cmd.exitCode ?? 0 };
					result = cmd.getOutput() ?? '';
					l.dispose();
					resolve();
				});
				disposables.push(l);
			});

			const waitUntilInterrupt = new Promise<void>((res) => {
				setTimeout(() => {
					resolveReason = { type: 'total_timeout' };
					res();
				}, MAX_TERMINAL_BG_COMMAND_TIME * 1000);
			});

			const waitForCompletion = Promise.any([waitUntilDone, waitUntilInterrupt]);
			const sendTextFailure = terminal.sendText(command, true)
				.then(() => new Promise<never>(() => { }));

			await Promise.race([waitForCompletion, sendTextFailure])
				.finally(() => disposables.forEach(d => d.dispose()));

			// Read result if timed out
			if (resolveReason?.type === 'total_timeout') {
				result = await this.readTerminal(persistentTerminalId);
			}

			if (!resolveReason) throw new Error('Unexpected internal error: Promise.any should have resolved with a reason.');

			result = removeAnsiEscapeCodes(result);
			if (result.length > MAX_TERMINAL_CHARS) {
				const half = MAX_TERMINAL_CHARS / 2;
				result = result.slice(0, half)
					+ '\n...\n'
					+ result.slice(result.length - half, Infinity);
			}

			return { result, resolveReason };
		};

		const resPromise = waitForResult();

		return { interrupt, resPromise };
	}


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
