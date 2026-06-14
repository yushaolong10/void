export const agentManifestFilenames = [
	'AGENTS.md',
	'VOID.md',
	'CLAUDE.md',
	'.voidrules',
	'.mcp.json',
] as const;

export type AgentManifestFilename = typeof agentManifestFilenames[number];

export interface AgentManifest {
	readonly filename: AgentManifestFilename | string;
	readonly content: string;
	readonly source: 'workspace' | 'user' | 'plugin';
}

export class ManifestLoader {
	normalize(manifests: readonly AgentManifest[]): readonly AgentManifest[] {
		const byFilename = new Map<string, AgentManifest>();
		for (const manifest of manifests) {
			if (!manifest.content.trim()) continue;
			byFilename.set(manifest.filename, manifest);
		}
		return [...byFilename.values()];
	}
}
