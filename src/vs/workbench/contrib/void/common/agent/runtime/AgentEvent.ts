import { URI } from '../../../../../../base/common/uri.js';
import { ExecutionPlan, ExecutionPlanStep } from '../execution/ExecutionPlan.js';
import { ToolInvocation } from '../tools/ToolInvocation.js';
import { ToolResult } from '../tools/ToolResult.js';
import { PermissionDecision } from '../permissions/PermissionDecision.js';
import { AgentRunId, AgentSessionId } from './AgentState.js';

export type AgentEvent =
	| { type: 'run.started'; sessionId: AgentSessionId; runId: AgentRunId; goal: string; startedAt: number }
	| { type: 'plan.created'; sessionId: AgentSessionId; runId: AgentRunId; plan: ExecutionPlan; createdAt: number }
	| { type: 'plan.step.started'; sessionId: AgentSessionId; runId: AgentRunId; step: ExecutionPlanStep; startedAt: number }
	| { type: 'plan.step.completed'; sessionId: AgentSessionId; runId: AgentRunId; step: ExecutionPlanStep; completedAt: number }
	| { type: 'plan.step.blocked'; sessionId: AgentSessionId; runId: AgentRunId; step: ExecutionPlanStep; reason: string; blockedAt: number }
	| { type: 'model.delta'; sessionId: AgentSessionId; runId: AgentRunId; text: string }
	| { type: 'tool.requested'; sessionId: AgentSessionId; runId: AgentRunId; call: ToolInvocation }
	| { type: 'permission.required'; sessionId: AgentSessionId; runId: AgentRunId; callId: string; decision: PermissionDecision }
	| { type: 'permission.resolved'; sessionId: AgentSessionId; runId: AgentRunId; callId: string; decision: PermissionDecision }
	| { type: 'tool.started'; sessionId: AgentSessionId; runId: AgentRunId; call: ToolInvocation; startedAt: number }
	| { type: 'tool.finished'; sessionId: AgentSessionId; runId: AgentRunId; callId: string; result: ToolResult; finishedAt: number }
	| { type: 'tool.failed'; sessionId: AgentSessionId; runId: AgentRunId; callId: string; error: string; finishedAt: number }
	| { type: 'file.patch.proposed'; sessionId: AgentSessionId; runId: AgentRunId; uri: URI; patchId: string }
	| { type: 'checkpoint.created'; sessionId: AgentSessionId; runId: AgentRunId; checkpointId: string }
	| { type: 'run.finished'; sessionId: AgentSessionId; runId: AgentRunId; summary: string; finishedAt: number }
	| { type: 'run.cancelled'; sessionId: AgentSessionId; runId: AgentRunId; reason: string; cancelledAt: number }
	| { type: 'run.failed'; sessionId: AgentSessionId; runId: AgentRunId; error: string; finishedAt: number };

export type AgentEventType = AgentEvent['type'];
