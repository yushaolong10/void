import { Disposable } from '../../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentEvent } from '../../common/agent/runtime/AgentEvent.js';
import { AgentRunId, AgentSessionId, AgentSessionState } from '../../common/agent/runtime/AgentState.js';
import { IBrowserAgentBridge } from './BrowserAgentBridge.js';
import { Event } from '../../../../../base/common/event.js';

export interface IAgentTimelineService {
	readonly _serviceBrand: undefined;
	readonly onDidAppendEvent: Event<AgentEvent>;
	getEvents(sessionId: AgentSessionId, runId?: AgentRunId): readonly AgentEvent[];
	listSessions(): readonly AgentSessionState[];
}

export const IAgentTimelineService = createDecorator<IAgentTimelineService>('AgentTimelineService');

export class AgentTimelineService extends Disposable implements IAgentTimelineService {
	readonly _serviceBrand: undefined;
	readonly onDidAppendEvent: Event<AgentEvent>;

	constructor(
		@IBrowserAgentBridge private readonly agentBridge: IBrowserAgentBridge,
	) {
		super();
		this.onDidAppendEvent = this.agentBridge.onDidEmitEvent;
	}

	getEvents(sessionId: AgentSessionId, runId?: AgentRunId): readonly AgentEvent[] {
		if (runId) return this.agentBridge.runtime.sessions.getRunEvents(sessionId, runId);
		return this.agentBridge.runtime.sessions.getEvents(sessionId);
	}

	listSessions(): readonly AgentSessionState[] {
		return this.agentBridge.runtime.sessions.listSessions();
	}
}

registerSingleton(IAgentTimelineService, AgentTimelineService, InstantiationType.Eager);
