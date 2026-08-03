import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { PermissionEngine, PermissionEvaluationContext } from '../permissions/PermissionEngine.js';
import { ToolInvocation } from '../tools/ToolInvocation.js';
import { AgentEvent } from './AgentEvent.js';
import { AgentRun } from './AgentRun.js';
import { InMemoryAgentSessionStore, IAgentSessionStore } from './AgentSessionStore.js';
import { AgentRunId, AgentSessionId } from './AgentState.js';

export interface StartAgentRunOptions {
	readonly sessionId?: AgentSessionId;
	readonly goal: string;
}

export class AgentRuntime extends Disposable {
	private readonly _onDidEmitEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidEmitEvent: Event<AgentEvent> = this._onDidEmitEvent.event;

	constructor(
		private readonly permissions: PermissionEngine = new PermissionEngine(),
		public readonly sessions: IAgentSessionStore = new InMemoryAgentSessionStore(),
	) {
		super();
		this._register(this.sessions.onDidAppendEvent(event => this._onDidEmitEvent.fire(event)));
	}

	startRun(options: StartAgentRunOptions): AgentRun {
		const sessionId = options.sessionId ?? generateUuid();
		const run = new AgentRun(sessionId, options.goal);
		this.emit({ type: 'run.started', sessionId, runId: run.runId, goal: run.goal, startedAt: run.startedAt });
		return run;
	}

	async decidePermission(call: ToolInvocation, context?: PermissionEvaluationContext) {
		return this.permissions.decide(call, context);
	}

	finishRun(sessionId: AgentSessionId, runId: AgentRunId, summary: string): void {
		this.emit({ type: 'run.finished', sessionId, runId, summary, finishedAt: Date.now() });
	}

	cancelRun(sessionId: AgentSessionId, runId: AgentRunId, reason: string): void {
		this.emit({ type: 'run.cancelled', sessionId, runId, reason, cancelledAt: Date.now() });
	}

	failRun(sessionId: AgentSessionId, runId: AgentRunId, error: string): void {
		this.emit({ type: 'run.failed', sessionId, runId, error, finishedAt: Date.now() });
	}

	emit(event: AgentEvent): void {
		this.sessions.append(event);
	}
}
