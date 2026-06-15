import { ToolInvocation } from '../tools/ToolInvocation.js';
import { PermissionDecision } from './PermissionDecision.js';
import { defaultPermissionPolicy, PermissionPolicy } from './PermissionPolicy.js';
import { RiskClassifier } from './RiskClassifier.js';
import { safeStringify } from '../tools/safeSerialize.js';

export class PermissionEngine {
	constructor(
		private readonly policy: PermissionPolicy = defaultPermissionPolicy,
		private readonly riskClassifier = new RiskClassifier(),
	) { }

	async decide(call: ToolInvocation): Promise<PermissionDecision> {
		const risk = this.riskClassifier.classify(call.name, call.input);

		if (this.policy.mode === 'dangerous-skip-approval') {
			return { type: 'allow', reason: 'Dangerous skip approval mode is enabled.' };
		}

		if (this.policy.mode === 'chat-only') {
			return { type: 'deny', reason: 'Tool calls are disabled in chat-only mode.' };
		}

		if (risk === 'low') {
			return { type: 'allow', reason: 'Read-only tool calls are allowed.' };
		}

		if (this.policy.mode === 'read-only') {
			return { type: 'deny', reason: 'This permission mode only allows read-only tools.' };
		}

		if (risk === 'medium' && (this.policy.mode === 'auto-edit' || this.policy.mode === 'workspace-auto')) {
			return { type: 'allow', reason: 'Workspace edit policy allows this tool.' };
		}

		return {
			type: 'ask',
			reason: this._reasonForDecision(call.name, risk),
			risk,
			preview: this._previewForDecision(call, risk),
		};
	}

	private _reasonForDecision(toolName: string, risk: string): string {
		if (risk === 'critical') return `Critical-risk tool "${toolName}" requires explicit approval.`;
		if (risk === 'high') return `High-risk tool "${toolName}" requires approval.`;
		return `Tool "${toolName}" requires approval.`;
	}

	private _previewForDecision(call: ToolInvocation, risk: string) {
		const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
		const items = [
			`Tool: ${call.name}`,
			`Risk: ${risk}`,
			...this._impactItems(call.name, input),
		];
		return {
			type: 'list' as const,
			items,
		};
	}

	private _impactItems(toolName: string, input: Record<string, unknown>): string[] {
		const cwd = typeof input.cwd === 'string' ? `cwd: ${input.cwd}` : undefined;
		const command = typeof input.command === 'string' ? `command: ${input.command}` : undefined;
		const uri = input.uri ? `path: ${safeStringify(input.uri)}` : undefined;
		const branchName = typeof input.branchName === 'string' ? `branch: ${input.branchName}` : undefined;
		const baseRef = typeof input.baseRef === 'string' ? `base ref: ${input.baseRef}` : undefined;
		const path = typeof input.path === 'string' ? `path: ${input.path}` : undefined;
		const message = typeof input.message === 'string' ? `commit message: ${input.message}` : undefined;

		const details = [cwd, command, uri, branchName, baseRef, path, message].filter((item): item is string => !!item);
		if (toolName === 'git_commit') return ['Creates a git commit in the selected repository.', ...details, 'Recommended check: inspect git_status and git_diff before approving.'];
		if (toolName === 'git_create_branch') return ['Creates and checks out a new git branch.', ...details];
		if (toolName === 'git_worktree_create') return ['Creates a candidate git worktree and branch.', ...details];
		if (toolName === 'git_worktree_delete') return ['Removes a git worktree and may prune worktree metadata.', ...details];
		if (toolName === 'git_apply_patch') return ['Applies a patch through git apply.', ...details, 'Recommended check: use check_only first when practical.'];
		if (toolName === 'delete_file_or_folder') return ['Deletes a file or folder.', ...details];
		if (toolName === 'run_command' || toolName === 'run_persistent_command') return ['Runs a terminal command in the user environment.', ...details];
		if (toolName === 'install_dependencies') return ['Runs a dependency installation command.', ...details];
		if (toolName === 'run_tests') return ['Runs a verification command.', ...details];
		return details.length ? details : [`Input: ${safeStringify(input, 2)}`];
	}
}
