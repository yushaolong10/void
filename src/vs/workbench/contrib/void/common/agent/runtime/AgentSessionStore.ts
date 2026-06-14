import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { safeCloneForStorage } from '../tools/safeSerialize.js';
import { AgentEvent } from './AgentEvent.js';
import { AgentRunId, AgentRunState, AgentSessionId, AgentSessionState } from './AgentState.js';

const MAX_EVENTS_PER_SESSION_IN_MEMORY = 800;
const MAX_EVENT_TEXT_LENGTH_IN_MEMORY = 20_000;

export interface IAgentSessionStore {
	readonly onDidAppendEvent: Event<AgentEvent>;
	append(event: AgentEvent): void;
	getEvents(sessionId: AgentSessionId): readonly AgentEvent[];
	getRunEvents(sessionId: AgentSessionId, runId: AgentRunId): readonly AgentEvent[];
	getSession(sessionId: AgentSessionId): AgentSessionState | undefined;
	listSessions(): readonly AgentSessionState[];
}

export class InMemoryAgentSessionStore extends Disposable implements IAgentSessionStore {
	private readonly _onDidAppendEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidAppendEvent = this._onDidAppendEvent.event;

	private readonly eventsBySession = new Map<AgentSessionId, AgentEvent[]>();
	private readonly sessions = new Map<AgentSessionId, AgentSessionState>();

	append(event: AgentEvent): void {
		const trimmedEvent = this._trimEvent(event);
		const events = this.eventsBySession.get(event.sessionId) ?? [];
		const lastEvent = events[events.length - 1];
		if (
			trimmedEvent.type === 'model.delta'
			&& lastEvent?.type === 'model.delta'
			&& lastEvent.runId === trimmedEvent.runId
		) {
			events[events.length - 1] = {
				...lastEvent,
				text: this._trimTextInMemory(`${lastEvent.text}${trimmedEvent.text}`),
			};
			this.eventsBySession.set(trimmedEvent.sessionId, events);
			this.sessions.set(trimmedEvent.sessionId, this._reduceSession(trimmedEvent.sessionId, events));
			this._onDidAppendEvent.fire(events[events.length - 1]);
			return;
		}
		events.push(trimmedEvent);
		const boundedEvents = events.slice(-MAX_EVENTS_PER_SESSION_IN_MEMORY);
		this.eventsBySession.set(trimmedEvent.sessionId, boundedEvents);
		this.sessions.set(trimmedEvent.sessionId, this._reduceSession(trimmedEvent.sessionId, boundedEvents));
		this._onDidAppendEvent.fire(trimmedEvent);
	}

	getEvents(sessionId: AgentSessionId): readonly AgentEvent[] {
		return this.eventsBySession.get(sessionId) ?? [];
	}

	getRunEvents(sessionId: AgentSessionId, runId: AgentRunId): readonly AgentEvent[] {
		return this.getEvents(sessionId).filter(event => event.runId === runId);
	}

	getSession(sessionId: AgentSessionId): AgentSessionState | undefined {
		return this.sessions.get(sessionId);
	}

	listSessions(): readonly AgentSessionState[] {
		return [...this.sessions.values()];
	}

	private _trimEvent(event: AgentEvent): AgentEvent {
		if (event.type === 'model.delta') {
			return { ...event, text: this._trimTextInMemory(event.text) };
		}
		if (event.type === 'tool.requested') {
			return {
				...event,
				call: {
					...event.call,
					input: safeCloneForStorage(event.call.input, MAX_EVENT_TEXT_LENGTH_IN_MEMORY),
					rawInput: safeCloneForStorage(event.call.rawInput, MAX_EVENT_TEXT_LENGTH_IN_MEMORY),
				},
			};
		}
		if (event.type === 'tool.finished') {
			return {
				...event,
				result: {
					...event.result,
					stdout: this._trimOptionalTextInMemory(event.result.stdout),
					stderr: this._trimOptionalTextInMemory(event.result.stderr),
					data: safeCloneForStorage(event.result.data, MAX_EVENT_TEXT_LENGTH_IN_MEMORY),
					artifacts: event.result.artifacts?.map(artifact => ({
						...artifact,
						data: safeCloneForStorage(artifact.data, MAX_EVENT_TEXT_LENGTH_IN_MEMORY),
					})),
				},
			};
		}
		return event;
	}

	private _trimTextInMemory(value: string): string {
		if (value.length <= MAX_EVENT_TEXT_LENGTH_IN_MEMORY) return value;
		return `${value.slice(0, MAX_EVENT_TEXT_LENGTH_IN_MEMORY)}\n...`;
	}

	private _trimOptionalTextInMemory(value: string | undefined): string | undefined {
		if (value === undefined) return undefined;
		return this._trimTextInMemory(value);
	}

	private _reduceSession(sessionId: AgentSessionId, events: readonly AgentEvent[]): AgentSessionState {
		const runs = new Map<AgentRunId, AgentRunState>();
		let createdAt = Date.now();
		let lastModified = createdAt;

		for (const event of events) {
			if (event.type === 'run.started') {
				createdAt = Math.min(createdAt, event.startedAt);
				lastModified = Math.max(lastModified, event.startedAt);
				runs.set(event.runId, {
					sessionId,
					runId: event.runId,
					goal: event.goal,
					status: 'running',
					startedAt: event.startedAt,
				});
				continue;
			}

			const existing = runs.get(event.runId);
			if (!existing) continue;

			if (event.type === 'permission.required') {
				runs.set(event.runId, { ...existing, status: 'awaiting-permission' });
			}
			else if (event.type === 'tool.started' && existing.status === 'awaiting-permission') {
				runs.set(event.runId, { ...existing, status: 'running' });
			}
			else if (event.type === 'run.finished') {
				runs.set(event.runId, { ...existing, status: 'finished', summary: event.summary, finishedAt: event.finishedAt });
				lastModified = Math.max(lastModified, event.finishedAt);
			}
			else if (event.type === 'run.failed') {
				runs.set(event.runId, { ...existing, status: 'failed', error: event.error, finishedAt: event.finishedAt });
				lastModified = Math.max(lastModified, event.finishedAt);
			}
		}

		return {
			sessionId,
			createdAt,
			lastModified,
			runs: [...runs.values()],
		};
	}
}
