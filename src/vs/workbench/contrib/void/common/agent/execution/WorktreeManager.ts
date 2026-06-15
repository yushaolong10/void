import { URI } from '../../../../../../base/common/uri.js';

export interface WorktreeDescriptor {
	readonly id: string;
	readonly uri: URI;
	readonly branchName: string;
	readonly createdAt: number;
	readonly status: 'creating' | 'ready' | 'failed' | 'deleted';
	readonly error?: string;
}

export class WorktreeManager {
	private readonly worktrees = new Map<string, WorktreeDescriptor>();

	track(worktree: WorktreeDescriptor): void {
		this.worktrees.set(worktree.id, worktree);
	}

	update(id: string, patch: Partial<Omit<WorktreeDescriptor, 'id'>>): WorktreeDescriptor | undefined {
		const current = this.worktrees.get(id);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		this.worktrees.set(id, next);
		return next;
	}

	get(id: string): WorktreeDescriptor | undefined {
		return this.worktrees.get(id);
	}

	findByPath(path: string): WorktreeDescriptor | undefined {
		return [...this.worktrees.values()].find(worktree => worktree.uri.fsPath === path);
	}

	list(): readonly WorktreeDescriptor[] {
		return [...this.worktrees.values()];
	}
}
