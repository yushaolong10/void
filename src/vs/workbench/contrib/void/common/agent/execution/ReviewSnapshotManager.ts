import { ExecutionPlan } from './ExecutionPlan.js';
import { WorktreeDescriptor } from './WorktreeManager.js';

export interface ReviewSnapshotDescriptor {
	readonly id: string;
	readonly goal: string;
	readonly status: 'running' | 'complete' | 'failed';
	readonly worktree?: WorktreeDescriptor;
	readonly plan?: ExecutionPlan;
	readonly summary?: string;
}

export class ReviewSnapshotManager {
	private readonly snapshots = new Map<string, ReviewSnapshotDescriptor>();

	track(snapshot: ReviewSnapshotDescriptor): void {
		this.snapshots.set(snapshot.id, snapshot);
	}

	update(id: string, patch: Partial<Omit<ReviewSnapshotDescriptor, 'id'>>): ReviewSnapshotDescriptor | undefined {
		const current = this.snapshots.get(id);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		this.snapshots.set(id, next);
		return next;
	}

	get(id: string): ReviewSnapshotDescriptor | undefined {
		return this.snapshots.get(id);
	}

	list(): readonly ReviewSnapshotDescriptor[] {
		return [...this.snapshots.values()];
	}
}
