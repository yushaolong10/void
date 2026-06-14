import { MCPTool } from '../../mcpServiceTypes.js';
import { ToolDefinition } from '../tools/ToolDefinition.js';
import { ToolResult } from '../tools/ToolResult.js';
import { safeStringify } from '../tools/safeSerialize.js';

export interface McpToolBinding {
	readonly serverName: string;
	readonly tool: MCPTool;
}

export class McpManager {
	toToolDefinition(binding: McpToolBinding, invoke: (params: unknown) => Promise<ToolResult>): ToolDefinition {
		return {
			name: binding.tool.name,
			description: binding.tool.description ?? `MCP tool ${binding.tool.name}`,
			inputSchema: binding.tool.inputSchema ?? {},
			risk: 'network',
			requiresApproval: async () => true,
			invoke: async input => invoke(input),
			renderResultForModel: output => output.stdout ?? output.stderr ?? safeStringify(output.data ?? ''),
		};
	}
}
