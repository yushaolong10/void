export interface SkillDefinition {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly context: 'main' | 'fork';
	readonly body: string;
}

export class SkillLoader {
	parseMarkdown(filename: string, content: string): SkillDefinition {
		const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? filename.replace(/\.md$/i, '');
		const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '';
		const frontmatter = /^---\s*([\s\S]*?)---/.exec(content)?.[1] ?? content;
		const inlineTools = /^tools:\s*(.+)$/m.exec(frontmatter)?.[1]?.split(',').map(tool => tool.trim()).filter(Boolean) ?? [];
		const listedTools = /^tools:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(frontmatter)?.[1]
			?.split(/\r?\n/)
			.map(line => /^\s*-\s*(.+)$/.exec(line)?.[1]?.trim())
			.filter((tool): tool is string => !!tool) ?? [];
		const tools = inlineTools.length ? inlineTools : listedTools;
		const contextValue = /^context:\s*(main|fork)$/m.exec(content)?.[1] as 'main' | 'fork' | undefined;
		return {
			name,
			description,
			tools,
			context: contextValue ?? 'main',
			body: content.replace(/^---[\s\S]*?---\s*/, ''),
		};
	}
}
