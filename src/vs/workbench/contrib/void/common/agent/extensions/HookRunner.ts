import { ToolInvocation } from '../tools/ToolInvocation.js';
import { ToolResult } from '../tools/ToolResult.js';

export type HookEventName =
	| 'before_tool_call'
	| 'after_tool_call'
	| 'before_file_edit'
	| 'after_file_edit'
	| 'after_run_command'
	| 'before_checkpoint'
	| 'after_checkpoint'
	| 'on_run_failed';

export interface HookContext {
	readonly event: HookEventName;
	readonly toolCall?: ToolInvocation;
	readonly toolResult?: ToolResult;
	readonly metadata?: Record<string, unknown>;
}

export type HookHandler = (context: HookContext) => Promise<void>;

export interface HookDefinition {
	readonly id: string;
	readonly event: HookEventName;
	readonly command?: string;
	readonly cwd?: string;
}

export class HookRunner {
	private readonly handlers = new Map<HookEventName, HookHandler[]>();
	private readonly definitions = new Map<string, HookDefinition>();

	register(event: HookEventName, handler: HookHandler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerDefinition(definition: HookDefinition): void {
		this.definitions.set(definition.id, definition);
	}

	clearDefinitions(): void {
		this.definitions.clear();
	}

	listDefinitions(): readonly HookDefinition[] {
		return [...this.definitions.values()];
	}

	async run(context: HookContext): Promise<void> {
		for (const handler of this.handlers.get(context.event) ?? []) {
			await handler(context);
		}
	}
}
