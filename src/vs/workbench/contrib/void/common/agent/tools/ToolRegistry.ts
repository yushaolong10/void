import { ToolName } from '../../toolsServiceTypes.js';
import { ToolDefinition } from './ToolDefinition.js';

export class ToolRegistry {
	private readonly tools = new Map<ToolName, ToolDefinition<any, any>>();

	register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
		this.tools.set(definition.name, definition);
	}

	unregister(name: ToolName): void {
		this.tools.delete(name);
	}

	get<TInput = unknown, TOutput = unknown>(name: ToolName): ToolDefinition<TInput, TOutput> | undefined {
		return this.tools.get(name);
	}

	has(name: ToolName): boolean {
		return this.tools.has(name);
	}

	list(): readonly ToolDefinition<any, any>[] {
		return [...this.tools.values()];
	}
}
