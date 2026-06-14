import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { PermissionEngine } from '../permissions/PermissionEngine.js';
import { ToolContext } from '../tools/ToolDefinition.js';
import { ToolInvocation } from '../tools/ToolInvocation.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ToolResult } from '../tools/ToolResult.js';
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
		public readonly tools: ToolRegistry = new ToolRegistry(),
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

	async invokeTool(call: ToolInvocation, ctx: ToolContext): Promise<ToolResult> {
		this.emit({ type: 'tool.requested', sessionId: ctx.sessionId, runId: ctx.runId, call });
		const decision = await this.decidePermission(call);
		if (decision.type === 'ask') {
			this.emit({ type: 'permission.required', sessionId: ctx.sessionId, runId: ctx.runId, decision });
			return { ok: false, stderr: decision.reason, display: decision.preview };
		}
		this.emit({ type: 'permission.resolved', sessionId: ctx.sessionId, runId: ctx.runId, callId: call.callId, decision });
		if (decision.type === 'deny') {
			const result = { ok: false, stderr: decision.reason };
			this.emit({ type: 'tool.finished', sessionId: ctx.sessionId, runId: ctx.runId, callId: call.callId, result, finishedAt: Date.now() });
			return result;
		}

		const definition = this.tools.get(call.name);
		if (!definition) {
			const result = { ok: false, stderr: `Tool "${call.name}" is not registered.` };
			this.emit({ type: 'tool.finished', sessionId: ctx.sessionId, runId: ctx.runId, callId: call.callId, result, finishedAt: Date.now() });
			return result;
		}

		this.emit({ type: 'tool.started', sessionId: ctx.sessionId, runId: ctx.runId, call, startedAt: Date.now() });
		try {
			const result = await definition.invoke(call.input, ctx);
			this.emit({ type: 'tool.finished', sessionId: ctx.sessionId, runId: ctx.runId, callId: call.callId, result, finishedAt: Date.now() });
			return result;
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit({ type: 'tool.failed', sessionId: ctx.sessionId, runId: ctx.runId, callId: call.callId, error: message, finishedAt: Date.now() });
			return { ok: false, stderr: message };
		}
	}

	async decidePermission(call: ToolInvocation) {
		return this.permissions.decide(call);
	}

	finishRun(sessionId: AgentSessionId, runId: AgentRunId, summary: string): void {
		this.emit({ type: 'run.finished', sessionId, runId, summary, finishedAt: Date.now() });
	}

	failRun(sessionId: AgentSessionId, runId: AgentRunId, error: string): void {
		this.emit({ type: 'run.failed', sessionId, runId, error, finishedAt: Date.now() });
	}

	emit(event: AgentEvent): void {
		this.sessions.append(event);
	}
}
