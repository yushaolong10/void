import { ToolName } from '../../toolsServiceTypes.js';
import { safeStringify } from '../tools/safeSerialize.js';
import { RiskLevel } from './PermissionDecision.js';

const readTools = new Set<string>([
	'read_file',
	'read_image',
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
	'review_snapshot',
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

const pathValues = (input: unknown): string[] => {
	if (!input || typeof input !== 'object') return [];
	const record = input as Record<string, unknown>;
	return ['uri', 'path']
		.map(key => record[key])
		.map(value => {
			if (typeof value === 'string') return value;
			if (value && typeof value === 'object' && 'fsPath' in value && typeof (value as { fsPath?: unknown }).fsPath === 'string') {
				return (value as { fsPath: string }).fsPath;
			}
			return '';
		})
		.filter(Boolean);
};

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globRegExp = (glob: string): RegExp => {
	const normalized = glob.replace(/\\/g, '/');
	let pattern = '';
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		if (char === '*' && normalized[index + 1] === '*') {
			if (normalized[index + 2] === '/') {
				pattern += '(?:.*/)?';
				index += 2;
			}
			else {
				pattern += '.*';
				index++;
			}
		}
		else if (char === '*') pattern += '[^/]*';
		else if (char === '?') pattern += '[^/]';
		else pattern += escapeRegExp(char);
	}
	return new RegExp(`^(?:${pattern}|.*/${pattern})$`, 'i');
};

export const matchesProtectedPath = (path: string, globs: readonly string[]): boolean => {
	const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
	return globs.some(glob => globRegExp(glob).test(normalized));
};

export const isWriteToolName = (toolName: string): boolean => writeTools.has(toolName)
	|| toolName === 'delete_file_or_folder'
	|| toolName === 'git_commit'
	|| toolName === 'git_create_branch'
	|| toolName === 'git_worktree_create'
	|| toolName === 'git_worktree_delete';

export const isNetworkToolCall = (toolName: string, input: unknown, mcpServerName?: string): boolean => {
	if (mcpServerName || toolName === 'mcp_call_tool' || toolName === 'install_dependencies') return true;
	if (toolName !== 'run_command' && toolName !== 'run_persistent_command' && toolName !== 'run_tests') return false;
	const command = typeof input === 'object' && input && 'command' in input
		? String((input as { command?: unknown }).command ?? '')
		: String(input ?? '');
	return /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet)\b/i.test(command)
		|| /\b(npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go)\s+(install|add|update|upgrade|get)\b/i.test(command);
};

export class RiskClassifier {
	classify(toolName: ToolName, input: unknown, protectedPathGlobs: readonly string[] = []): RiskLevel {
		if (readTools.has(toolName)) return 'low';
		if (writeTools.has(toolName)) return this._mentionsProtectedPath(input, protectedPathGlobs) ? 'high' : 'medium';
		if (toolName === 'delete_file_or_folder') {
			const params = input && typeof input === 'object'
				? input as { isFolder?: unknown; isRecursive?: unknown }
				: {};
			return params.isFolder === true || params.isRecursive === true ? 'critical' : 'high';
		}
		if (toolName === 'run_command' || toolName === 'run_persistent_command') return this._classifyTerminalCommand(input);
		if (toolName === 'git_commit' || toolName === 'git_create_branch') return 'medium';
		if (toolName === 'git_worktree_delete' || toolName === 'git_push') return 'high';
		if (executeTools.has(toolName)) return this._looksDangerousCommand(input) ? 'critical' : 'high';
		if (toolName === 'mcp_call_tool') return 'high';
		return 'medium';
	}

	private _mentionsProtectedPath(input: unknown, protectedPathGlobs: readonly string[]): boolean {
		if (protectedPathGlobs.length && pathValues(input).some(path => matchesProtectedPath(path, protectedPathGlobs))) return true;
		const value = safeStringify(input ?? '').toLowerCase();
		return value.includes('.env') || value.includes('/.ssh/') || value.includes('token') || value.includes('secret');
	}

	private _looksDangerousCommand(input: unknown): boolean {
		const value = safeStringify(input ?? '').toLowerCase();
		return /\brm\s+-rf\b/.test(value) || value.includes(' sudo ') || value.includes('curl ') || value.includes('wget ');
	}

	private _classifyTerminalCommand(input: unknown): RiskLevel {
		const command = this._extractCommand(input);
		if (!command) return 'high';
		const normalized = command.toLowerCase();
		const hasShellControlOperator = /(?:&&|\|\||[;|&<>\n\r])/.test(normalized);

		if (
			/\brm\s+-rf\b/.test(normalized)
			|| /\bsudo\b/.test(normalized)
			|| /\bchmod\s+[-+]?[0-7]*777\b/.test(normalized)
			|| /\b(chown|mkfs|dd)\b/.test(normalized)
			|| /\b(git\s+reset|git\s+clean)\b/.test(normalized)
			|| /\b(git\s+branch\s+-d|git\s+branch\s+-D|git\s+worktree\s+remove|git\s+push)\b/i.test(command)
			|| /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/.test(normalized)
		) {
			return 'critical';
		}

		if (
			/\b(git\s+commit|git\s+checkout\s+-b|git\s+switch\s+-c|git\s+apply|git\s+am|git\s+merge|git\s+rebase|git\s+cherry-pick|git\s+tag)\b/.test(normalized)
			|| /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(normalized)
			|| /\b(pip|pip3|uv|poetry|cargo|go)\s+(install|add|remove|update|get)\b/.test(normalized)
			|| /\b(curl|wget)\b/.test(normalized)
		) {
			return 'high';
		}

		if (!hasShellControlOperator && (
			/^\s*git\s+(status|diff|show|log|branch\s+(--show-current|-vv?)?|rev-parse|ls-files)\b/.test(normalized)
			|| /^\s*(rg|grep|sed|awk|cat|head|tail|ls|find|pwd|wc)\b/.test(normalized)
		)) {
			return 'low';
		}

		return 'high';
	}

	private _extractCommand(input: unknown): string {
		if (typeof input === 'string') return input;
		if (input && typeof input === 'object' && 'command' in input) {
			const command = (input as { command?: unknown }).command;
			return typeof command === 'string' ? command : safeStringify(command ?? '');
		}
		return safeStringify(input ?? '');
	}
}
