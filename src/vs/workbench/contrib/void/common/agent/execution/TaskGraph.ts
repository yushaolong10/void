import { ExecutionPlan, ExecutionPlanStep } from './ExecutionPlan.js';

export class TaskGraph {
	constructor(private readonly plan: ExecutionPlan) { }

	readySteps(completedStepIds: readonly string[]): readonly ExecutionPlanStep[] {
		const completed = new Set(completedStepIds);
		return this.plan.steps.filter(step => (
			step.status === 'pending'
			&& (step.dependsOn ?? []).every(dep => completed.has(dep))
		));
	}
}
