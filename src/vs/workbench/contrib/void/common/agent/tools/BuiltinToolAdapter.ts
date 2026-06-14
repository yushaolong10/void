import { BuiltinToolName, BuiltinToolResultType } from '../../toolsServiceTypes.js';
import { ToolDefinition, ToolRisk } from './ToolDefinition.js';
import { safeStringify } from './safeSerialize.js';

export interface BuiltinToolAdapterOptions<TName extends BuiltinToolName> {
	readonly name: TName;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly risk: ToolRisk;
	readonly invoke: (input: unknown) => Promise<Awaited<BuiltinToolResultType[TName]>>;
	readonly renderResultForModel: (output: Awaited<BuiltinToolResultType[TName]>) => string;
}

export class BuiltinToolAdapter {
	static define<TName extends BuiltinToolName>(options: BuiltinToolAdapterOptions<TName>): ToolDefinition {
		return {
			name: options.name,
			description: options.description,
			inputSchema: options.inputSchema,
			risk: options.risk,
			requiresApproval: async () => options.risk !== 'read',
			invoke: async input => {
				const result = await options.invoke(input);
				return {
					ok: true,
					data: result,
					stdout: options.renderResultForModel(result),
				};
			},
			renderResultForModel: output => output.stdout ?? output.stderr ?? safeStringify(output.data ?? ''),
		};
	}
}
