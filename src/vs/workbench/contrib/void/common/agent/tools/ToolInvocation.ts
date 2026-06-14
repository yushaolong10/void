import { ToolName } from '../../toolsServiceTypes.js';

export interface ToolInvocation<TInput = unknown> {
	readonly callId: string;
	readonly name: ToolName;
	readonly input: TInput;
	readonly rawInput?: unknown;
	readonly mcpServerName?: string;
}
