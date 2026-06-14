import { AgentEvent } from '../runtime/AgentEvent.js';
import { AgentContext, AgentContextItem } from './ContextBuilder.js';

export interface ContextCompressionResult {
	readonly context: AgentContext;
	readonly droppedItems: readonly string[];
}

export class ContextCompressor {
	compress(context: AgentContext, maxChars: number): ContextCompressionResult {
		let remaining = maxChars;
		const kept: AgentContextItem[] = [];
		const droppedItems: string[] = [];

		for (const item of context.items) {
			if (item.content.length <= remaining) {
				kept.push(item);
				remaining -= item.content.length;
			}
			else {
				droppedItems.push(item.label);
			}
		}

		return {
			context: {
				items: kept,
				tokenCostHint: kept.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0),
			},
			droppedItems,
		};
	}

	summarizeEvents(events: readonly AgentEvent[], maxChars: number): string {
		const lines = events.map(event => {
			if (event.type === 'tool.finished') return `${event.type}: ${event.callId} ok=${event.result.ok}`;
			if (event.type === 'tool.failed') return `${event.type}: ${event.callId} ${event.error}`;
			if (event.type === 'model.delta') return `${event.type}: ${event.text}`;
			if (event.type === 'run.started') return `${event.type}: ${event.goal}`;
			if (event.type === 'run.finished') return `${event.type}: ${event.summary}`;
			return event.type;
		});
		const text = lines.join('\n');
		if (text.length <= maxChars) return text;
		return `${text.slice(0, maxChars)}\n...`;
	}
}
