import { ToolName } from '../../toolsServiceTypes.js';
import { PermissionDecision } from '../permissions/PermissionDecision.js';
import { AgentVisualBlock, ToolResult } from './ToolResult.js';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'delete';

export interface ToolContext {
	readonly sessionId: string;
	readonly runId: string;
	readonly cwd?: string;
	readonly permissionMode?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
	readonly name: ToolName;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly risk: ToolRisk;
	requiresApproval(input: TInput, ctx: ToolContext): Promise<boolean>;
	invoke(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
	renderResultForModel(output: ToolResult<TOutput>, input: TInput): string;
	renderResultForUI?(output: ToolResult<TOutput>, input: TInput): AgentVisualBlock | undefined;
	describePermission?(input: TInput, ctx: ToolContext): Promise<PermissionDecision>;
}
