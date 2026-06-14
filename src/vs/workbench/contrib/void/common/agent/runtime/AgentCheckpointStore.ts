import { AgentRunId, AgentSessionId } from './AgentState.js';

export interface AgentCheckpoint {
	readonly checkpointId: string;
	readonly sessionId: AgentSessionId;
	readonly runId: AgentRunId;
	readonly createdAt: number;
	readonly label?: string;
	readonly metadata?: Record<string, unknown>;
}

export class AgentCheckpointStore {
	private readonly checkpointsByRun = new Map<string, AgentCheckpoint[]>();

	add(checkpoint: AgentCheckpoint): void {
		const key = this._key(checkpoint.sessionId, checkpoint.runId);
		const checkpoints = this.checkpointsByRun.get(key) ?? [];
		checkpoints.push(checkpoint);
		this.checkpointsByRun.set(key, checkpoints);
	}

	list(sessionId: AgentSessionId, runId: AgentRunId): readonly AgentCheckpoint[] {
		return this.checkpointsByRun.get(this._key(sessionId, runId)) ?? [];
	}

	private _key(sessionId: AgentSessionId, runId: AgentRunId): string {
		return `${sessionId}:${runId}`;
	}
}
