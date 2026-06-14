import { SkillDefinition } from './SkillLoader.js';

export interface PluginDefinition {
	readonly name: string;
	readonly version?: string;
	readonly skills?: readonly SkillDefinition[];
	readonly hooks?: readonly string[];
	readonly mcpServers?: readonly string[];
	readonly subagents?: readonly string[];
}

export class PluginLoader {
	private readonly plugins = new Map<string, PluginDefinition>();

	register(plugin: PluginDefinition): void {
		this.plugins.set(plugin.name, plugin);
	}

	clear(): void {
		this.plugins.clear();
	}

	list(): readonly PluginDefinition[] {
		return [...this.plugins.values()];
	}
}
