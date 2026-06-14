import { ToolName } from '../../toolsServiceTypes.js';
import { safeStringify } from '../tools/safeSerialize.js';
import { RiskLevel } from './PermissionDecision.js';

const readTools = new Set<string>([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_in_file',
	'read_symbol',
	'find_references',
	'go_to_definition',
	'read_lint_errors',
	'git_status',
	'git_diff',
	'package_script_list',
	'subagent_review',
	'read_test_failures',
]);

const writeTools = new Set<string>([
	'rewrite_file',
	'edit_file',
	'create_file_or_folder',
	'git_apply_patch',
]);

const executeTools = new Set<string>([
	'run_command',
	'run_persistent_command',
	'open_persistent_terminal',
	'kill_persistent_terminal',
	'run_tests',
	'install_dependencies',
	'git_create_branch',
	'git_commit',
	'git_worktree_create',
]);

export class RiskClassifier {
	classify(toolName: ToolName, input: unknown): RiskLevel {
		if (readTools.has(toolName)) return 'low';
		if (writeTools.has(toolName)) return this._mentionsProtectedPath(input) ? 'high' : 'medium';
		if (toolName === 'delete_file_or_folder') return 'critical';
		if (executeTools.has(toolName)) return this._looksDangerousCommand(input) ? 'critical' : 'high';
		if (toolName === 'git_commit' || toolName === 'git_create_branch') return 'medium';
		if (toolName === 'git_worktree_delete' || toolName === 'git_push') return 'high';
		if (toolName === 'mcp_call_tool') return 'high';
		return 'medium';
	}

	private _mentionsProtectedPath(input: unknown): boolean {
		const value = safeStringify(input ?? '').toLowerCase();
		return value.includes('.env') || value.includes('/.ssh/') || value.includes('token') || value.includes('secret');
	}

	private _looksDangerousCommand(input: unknown): boolean {
		const value = safeStringify(input ?? '').toLowerCase();
		return /\brm\s+-rf\b/.test(value) || value.includes(' sudo ') || value.includes('curl ') || value.includes('wget ');
	}
}
