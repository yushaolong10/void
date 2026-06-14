import { URI } from '../../../../../../base/common/uri.js';

export interface AgentContextItem {
	readonly kind: 'workspace' | 'editor' | 'selection' | 'diff' | 'diagnostic' | 'terminal' | 'manifest' | 'file' | 'symbol';
	readonly label: string;
	readonly uri?: URI;
	readonly content: string;
	readonly priority: number;
}

export interface AgentContext {
	readonly items: readonly AgentContextItem[];
	readonly tokenCostHint?: number;
}

export class ContextBuilder {
	private readonly items: AgentContextItem[] = [];

	add(item: AgentContextItem): this {
		this.items.push(item);
		return this;
	}

	build(): AgentContext {
		return {
			items: [...this.items].sort((a, b) => b.priority - a.priority),
			tokenCostHint: this.items.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0),
		};
	}
}
