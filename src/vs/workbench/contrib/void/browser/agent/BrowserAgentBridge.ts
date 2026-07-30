import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentRuntime } from '../../common/agent/runtime/AgentRuntime.js';
import { AgentEvent } from '../../common/agent/runtime/AgentEvent.js';
import { ToolInvocation } from '../../common/agent/tools/ToolInvocation.js';
import { ToolResult } from '../../common/agent/tools/ToolResult.js';
import { ToolContext } from '../../common/agent/tools/ToolDefinition.js';
import { PermissionDecision } from '../../common/agent/permissions/PermissionDecision.js';

export type BrowserToolContext = Partial<ToolContext> & { toolAlreadyRequested?: boolean; toolInvocation?: ToolInvocation };

export interface IBrowserAgentBridge {
	readonly _serviceBrand: undefined;
	readonly runtime: AgentRuntime;
	readonly onDidEmitEvent: Event<AgentEvent>;
	emit(event: AgentEvent): void;
	getCurrentToolContext(): BrowserToolContext | undefined;
	withToolContext<T>(ctx: BrowserToolContext, fn: () => T): T;
	recordToolRequested(call: ToolInvocation, ctx?: BrowserToolContext): ToolContext;
	recordPermissionRequired(callId: string, decision: PermissionDecision, ctx: ToolContext): void;
	recordPermissionResolved(callId: string, decision: PermissionDecision, ctx: ToolContext): void;
	recordToolStarted(call: ToolInvocation, ctx?: BrowserToolContext): ToolContext;
	recordToolFinished(callId: string, result: ToolResult, ctx: ToolContext): void;
	recordToolFailed(callId: string, error: string, ctx: ToolContext): void;
}

export const IBrowserAgentBridge = createDecorator<IBrowserAgentBridge>('BrowserAgentBridge');

export class BrowserAgentBridge extends Disposable implements IBrowserAgentBridge {
	readonly _serviceBrand: undefined;
	readonly runtime: AgentRuntime;

	private readonly _onDidEmitEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidEmitEvent = this._onDidEmitEvent.event;
	private readonly toolContextStack: BrowserToolContext[] = [];

	constructor() {
		super();
		this.runtime = this._register(new AgentRuntime());
		this._register(this.runtime.onDidEmitEvent(event => this._onDidEmitEvent.fire(event)));
	}

	emit(event: AgentEvent): void {
		this.runtime.emit(event);
	}

	getCurrentToolContext(): BrowserToolContext | undefined {
		return this.toolContextStack[this.toolContextStack.length - 1];
	}

	withToolContext<T>(ctx: BrowserToolContext, fn: () => T): T {
		this.toolContextStack.push(ctx);
		try {
			return fn();
		}
		finally {
			this.toolContextStack.pop();
		}
	}

	recordToolRequested(call: ToolInvocation, ctx?: BrowserToolContext): ToolContext {
		const fullCtx: ToolContext = {
			sessionId: ctx?.sessionId ?? 'legacy-chat-session',
			runId: ctx?.runId ?? 'legacy-chat-run',
			cwd: ctx?.cwd,
			permissionMode: ctx?.permissionMode,
		};
		this.runtime.emit({ type: 'tool.requested', sessionId: fullCtx.sessionId, runId: fullCtx.runId, call });
		return fullCtx;
	}

	recordPermissionRequired(callId: string, decision: PermissionDecision, ctx: ToolContext): void {
		this.runtime.emit({
			type: 'permission.required',
			sessionId: ctx.sessionId,
			runId: ctx.runId,
			decision,
		});
	}

	recordPermissionResolved(callId: string, decision: PermissionDecision, ctx: ToolContext): void {
		this.runtime.emit({
			type: 'permission.resolved',
			sessionId: ctx.sessionId,
			runId: ctx.runId,
			callId,
			decision,
		});
	}

	recordToolStarted(call: ToolInvocation, ctx?: BrowserToolContext): ToolContext {
		const fullCtx = ctx && 'toolAlreadyRequested' in ctx && (ctx as BrowserToolContext).toolAlreadyRequested
			? {
				sessionId: ctx.sessionId ?? 'legacy-chat-session',
				runId: ctx.runId ?? 'legacy-chat-run',
				cwd: ctx.cwd,
				permissionMode: ctx.permissionMode,
			}
			: this.recordToolRequested(call, ctx);
		this.runtime.emit({ type: 'tool.started', sessionId: fullCtx.sessionId, runId: fullCtx.runId, call, startedAt: Date.now() });
		return fullCtx;
	}

	recordToolFinished(callId: string, result: ToolResult, ctx: ToolContext): void {
		this.runtime.emit({ type: 'tool.finished', sessionId: ctx.sessionId, runId: ctx.runId, callId, result, finishedAt: Date.now() });
	}

	recordToolFailed(callId: string, error: string, ctx: ToolContext): void {
		this.runtime.emit({ type: 'tool.failed', sessionId: ctx.sessionId, runId: ctx.runId, callId, error, finishedAt: Date.now() });
	}
}

export const createLegacyToolInvocation = (name: string, input: unknown, rawInput?: unknown): ToolInvocation => ({
	callId: generateUuid(),
	name,
	input,
	rawInput,
});

registerSingleton(IBrowserAgentBridge, BrowserAgentBridge, InstantiationType.Eager);
