import { AgentEvent } from '../../common/agent/runtime/AgentEvent.js';
import { AgentRunStatus } from '../../common/agent/runtime/AgentState.js';

export interface AgentTimelineItem {
	readonly title: string;
	readonly detail?: string;
	readonly kind: AgentEvent['type'];
	readonly timestamp?: number;
}

export interface AgentRunViewModel {
	readonly status: AgentRunStatus;
	readonly items: readonly AgentTimelineItem[];
}

export const toAgentRunViewModel = (events: readonly AgentEvent[]): AgentRunViewModel => {
	let status: AgentRunStatus = 'idle';
	const items: AgentTimelineItem[] = [];

	for (const event of events) {
		if (event.type === 'run.started') {
			status = 'running';
			items.push({ kind: event.type, title: 'Run started', detail: event.goal, timestamp: event.startedAt });
		}
		else if (event.type === 'permission.required') {
			status = 'awaiting-permission';
			items.push({ kind: event.type, title: 'Permission required', detail: event.decision.reason });
		}
		else if (event.type === 'tool.started') {
			items.push({ kind: event.type, title: `Tool started: ${event.call.name}`, timestamp: event.startedAt });
		}
		else if (event.type === 'tool.finished') {
			items.push({ kind: event.type, title: `Tool finished: ${event.callId}`, detail: event.result.ok ? 'ok' : event.result.stderr, timestamp: event.finishedAt });
		}
		else if (event.type === 'tool.failed') {
			items.push({ kind: event.type, title: `Tool failed: ${event.callId}`, detail: event.error, timestamp: event.finishedAt });
		}
		else if (event.type === 'checkpoint.created') {
			items.push({ kind: event.type, title: 'Checkpoint created', detail: event.checkpointId });
		}
		else if (event.type === 'run.finished') {
			status = 'finished';
			items.push({ kind: event.type, title: 'Run finished', detail: event.summary, timestamp: event.finishedAt });
		}
		else if (event.type === 'run.failed') {
			status = 'failed';
			items.push({ kind: event.type, title: 'Run failed', detail: event.error, timestamp: event.finishedAt });
		}
	}

	return { status, items };
};
