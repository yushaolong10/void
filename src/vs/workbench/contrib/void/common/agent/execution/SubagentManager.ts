import { ExecutionPlan } from './ExecutionPlan.js';
import { WorktreeDescriptor } from './WorktreeManager.js';

export type SubagentKind = 'review' | 'test-fix' | 'plan-impl' | 'custom';

export interface SubagentRunDescriptor {
	readonly id: string;
	readonly kind: SubagentKind;
	readonly goal: string;
	readonly status: 'queued' | 'running' | 'awaiting-merge' | 'complete' | 'failed';
	readonly worktree?: WorktreeDescriptor;
	readonly plan?: ExecutionPlan;
	readonly summary?: string;
}

export class SubagentManager {
	private readonly runs = new Map<string, SubagentRunDescriptor>();

	track(run: SubagentRunDescriptor): void {
		this.runs.set(run.id, run);
	}

	update(id: string, patch: Partial<Omit<SubagentRunDescriptor, 'id'>>): SubagentRunDescriptor | undefined {
		const current = this.runs.get(id);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		this.runs.set(id, next);
		return next;
	}

	get(id: string): SubagentRunDescriptor | undefined {
		return this.runs.get(id);
	}

	list(): readonly SubagentRunDescriptor[] {
		return [...this.runs.values()];
	}
}
