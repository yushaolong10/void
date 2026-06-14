import { generateUuid } from '../../../../../../base/common/uuid.js';
import { AgentRunId, AgentRunState, AgentSessionId } from './AgentState.js';

export class AgentRun {
	public readonly runId: AgentRunId;
	public readonly startedAt: number;

	constructor(
		public readonly sessionId: AgentSessionId,
		public readonly goal: string,
		runId: AgentRunId = generateUuid(),
		startedAt: number = Date.now(),
	) {
		this.runId = runId;
		this.startedAt = startedAt;
	}

	toState(): AgentRunState {
		return {
			sessionId: this.sessionId,
			runId: this.runId,
			goal: this.goal,
			status: 'running',
			startedAt: this.startedAt,
		};
	}
}
