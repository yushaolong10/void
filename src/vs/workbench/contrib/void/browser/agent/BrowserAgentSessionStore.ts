import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { AgentEvent } from '../../common/agent/runtime/AgentEvent.js';
import { InMemoryAgentSessionStore } from '../../common/agent/runtime/AgentSessionStore.js';
import { safeCloneForStorage, safeStringify } from '../../common/agent/tools/safeSerialize.js';
import { AGENT_SESSION_STORAGE_KEY } from '../../common/storageKeys.js';

type StoredAgentSessionEvents = {
	readonly version: 1;
	readonly eventsBySession: Record<string, AgentEvent[]>;
}

const MAX_EVENTS_PER_SESSION = 800;
const MAX_STORED_TEXT_LENGTH = 20_000;

export class BrowserAgentSessionStore extends InMemoryAgentSessionStore {
	private isRestoring = false;

	constructor(private readonly storageService: IStorageService) {
		super();
		this._restore();
	}

	override append(event: AgentEvent): void {
		super.append(event);
		if (!this.isRestoring) {
			this._persist();
		}
	}

	private _restore(): void {
		const rawValue = this.storageService.get(AGENT_SESSION_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!rawValue) return;

		let stored: StoredAgentSessionEvents | undefined;
		try {
			stored = JSON.parse(rawValue) as StoredAgentSessionEvents;
		}
		catch {
			return;
		}

		this.isRestoring = true;
		try {
			for (const events of Object.values(stored.eventsBySession ?? {})) {
				for (const event of events) {
					super.append(event);
				}
			}
		}
		finally {
			this.isRestoring = false;
		}
	}

	private _persist(): void {
		const sessions = this.listSessions();
		const eventsBySession: Record<string, AgentEvent[]> = {};
		for (const session of sessions) {
			eventsBySession[session.sessionId] = this.getEvents(session.sessionId)
				.slice(-MAX_EVENTS_PER_SESSION)
				.map(event => this._trimEventForStorage(event));
		}

		this.storageService.store(
			AGENT_SESSION_STORAGE_KEY,
			safeStringify({ version: 1, eventsBySession } satisfies StoredAgentSessionEvents),
			StorageScope.WORKSPACE,
			StorageTarget.USER,
		);
	}

	private _trimEventForStorage(event: AgentEvent): AgentEvent {
		if (event.type === 'model.delta' && event.text.length > MAX_STORED_TEXT_LENGTH) {
			return { ...event, text: `${event.text.slice(0, MAX_STORED_TEXT_LENGTH)}\n...` };
		}
		if (event.type === 'tool.finished') {
			return {
				...event,
				result: {
					...event.result,
					stdout: this._trimString(event.result.stdout),
					stderr: this._trimString(event.result.stderr),
					data: this._trimUnknown(event.result.data),
				},
			};
		}
		if (event.type === 'tool.requested') {
			return {
				...event,
				call: {
					...event.call,
					input: this._trimUnknown(event.call.input),
					rawInput: this._trimUnknown(event.call.rawInput),
				},
			};
		}
		return event;
	}

	private _trimUnknown(value: unknown): unknown {
		if (typeof value === 'string') return this._trimString(value);
		if (value === null || value === undefined) return value;
		return safeCloneForStorage(value, MAX_STORED_TEXT_LENGTH);
	}

	private _trimString(value: string | undefined): string | undefined {
		if (!value || value.length <= MAX_STORED_TEXT_LENGTH) return value;
		return `${value.slice(0, MAX_STORED_TEXT_LENGTH)}\n...`;
	}
}
