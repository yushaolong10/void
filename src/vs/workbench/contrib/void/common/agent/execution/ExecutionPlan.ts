export type ExecutionPlanStepStatus = 'pending' | 'running' | 'blocked' | 'complete' | 'failed';

export interface ExecutionPlanStep {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly status: ExecutionPlanStepStatus;
	readonly dependsOn?: readonly string[];
}

export interface ExecutionPlan {
	readonly id: string;
	readonly goal: string;
	readonly steps: readonly ExecutionPlanStep[];
}
