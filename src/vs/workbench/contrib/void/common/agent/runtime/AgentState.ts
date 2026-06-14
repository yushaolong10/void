export type AgentSessionId = string;
export type AgentRunId = string;

export type AgentRunStatus =
	| 'idle'
	| 'running'
	| 'awaiting-permission'
	| 'failed'
	| 'finished'
	| 'cancelled';

export interface AgentRunState {
	readonly sessionId: AgentSessionId;
	readonly runId: AgentRunId;
	readonly goal: string;
	readonly status: AgentRunStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly summary?: string;
	readonly error?: string;
}

export interface AgentSessionState {
	readonly sessionId: AgentSessionId;
	readonly createdAt: number;
	readonly lastModified: number;
	readonly runs: readonly AgentRunState[];
}
