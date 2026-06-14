import { ToolInvocation } from '../tools/ToolInvocation.js';
import { AgentRuntime } from './AgentRuntime.js';
import { AgentRun } from './AgentRun.js';

export interface AgentLoopStep {
	readonly text?: string;
	readonly toolCall?: ToolInvocation;
}

export class AgentLoop {
	constructor(private readonly runtime: AgentRuntime) { }

	async run(goal: string, steps: AsyncIterable<AgentLoopStep>, sessionId?: string): Promise<AgentRun> {
		const run = this.runtime.startRun({ goal, sessionId });
		try {
			for await (const step of steps) {
				if (step.text) {
					this.runtime.emit({ type: 'model.delta', sessionId: run.sessionId, runId: run.runId, text: step.text });
				}
				if (step.toolCall) {
					await this.runtime.invokeTool(step.toolCall, { sessionId: run.sessionId, runId: run.runId });
				}
			}
			this.runtime.finishRun(run.sessionId, run.runId, 'Run completed.');
		}
		catch (error) {
			this.runtime.failRun(run.sessionId, run.runId, error instanceof Error ? error.message : String(error));
		}
		return run;
	}
}
