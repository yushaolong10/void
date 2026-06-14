export interface AgentArtifact {
	readonly kind: 'file' | 'patch' | 'terminal' | 'diagnostic' | 'url' | 'custom';
	readonly uri?: string;
	readonly title?: string;
	readonly data?: unknown;
}

export interface AgentDiagnostic {
	readonly message: string;
	readonly severity?: 'error' | 'warning' | 'info';
	readonly uri?: string;
	readonly startLineNumber?: number;
	readonly endLineNumber?: number;
}

export type AgentVisualBlock =
	| { type: 'text'; text: string }
	| { type: 'code'; language?: string; value: string }
	| { type: 'diff'; uri: string; patch?: string }
	| { type: 'terminal'; command?: string; cwd?: string; output?: string }
	| { type: 'list'; items: string[] };

export interface ToolResult<T = unknown> {
	readonly ok: boolean;
	readonly data?: T;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly artifacts?: AgentArtifact[];
	readonly diagnostics?: AgentDiagnostic[];
	readonly tokenCostHint?: number;
	readonly display?: AgentVisualBlock;
}
