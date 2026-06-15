import { URI } from '../../../../base/common/uri.js'
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { builtinTools } from './prompt/prompts.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';



export type TerminalResolveReason =
	{ type: 'idle_timeout' }
	| { type: 'total_timeout' }
	| { type: 'done', exitCode: number }
	| { type: 'aborted' }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}


export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'MCP tools' }> = {
	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'edit_file': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'kill_persistent_terminal': 'terminal',
	'run_tests': 'terminal',
	'install_dependencies': 'terminal',
	'git_apply_patch': 'terminal',
	'git_create_branch': 'terminal',
	'git_commit': 'terminal',
	'git_worktree_create': 'terminal',
	'git_worktree_delete': 'terminal',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'read_symbol': { symbol: string, searchInFolder: URI | null, pageNumber: number },
	'find_references': { symbol: string, searchInFolder: URI | null, pageNumber: number },
	'go_to_definition': { symbol: string, searchInFolder: URI | null, pageNumber: number },
	'read_lint_errors': { uri: URI },
	'git_status': { cwd: string | null },
	'git_diff': { cwd: string | null, staged: boolean },
	'git_apply_patch': { cwd: string | null, patch: string, checkOnly: boolean },
	'git_create_branch': { cwd: string | null, branchName: string, baseRef: string | null },
	'git_commit': { cwd: string | null, message: string, all: boolean },
	'git_worktree_create': { cwd: string | null, path: string, branchName: string, baseRef: string | null },
	'git_worktree_delete': { cwd: string | null, path: string, prune: boolean },
	'package_script_list': { cwd: string | null },
	'review_snapshot': { cwd: string | null, goal: string, includeDiff: boolean },
	'read_test_failures': { output: string, maxItems: number },
	// ---
	'rewrite_file': { uri: URI, newContent: string },
	'edit_file': { uri: URI, searchReplaceBlocks: string },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string },
	'run_tests': { command: string; cwd: string | null, terminalId: string },
	'install_dependencies': { command: string; cwd: string | null, terminalId: string },
	'open_persistent_terminal': { cwd: string | null },
	'run_persistent_command': { command: string; persistentTerminalId: string },
	'kill_persistent_terminal': { persistentTerminalId: string },
}

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'read_file': { fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean },
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	'search_in_file': { lines: number[]; },
	'read_symbol': { result: string; resolveReason: TerminalResolveReason; },
	'find_references': { result: string; resolveReason: TerminalResolveReason; },
	'go_to_definition': { result: string; resolveReason: TerminalResolveReason; },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	'git_status': { result: string; resolveReason: TerminalResolveReason; },
	'git_diff': { result: string; resolveReason: TerminalResolveReason; },
	'git_apply_patch': { result: string; resolveReason: TerminalResolveReason; },
	'git_create_branch': { result: string; resolveReason: TerminalResolveReason; },
	'git_commit': { result: string; resolveReason: TerminalResolveReason; },
	'git_worktree_create': { id: string; path: string; branchName: string; status: 'ready' | 'failed'; result: string; resolveReason: TerminalResolveReason; },
	'git_worktree_delete': { path: string; status: 'deleted' | 'failed'; result: string; resolveReason: TerminalResolveReason; },
	'package_script_list': { result: string; resolveReason: TerminalResolveReason; },
	'review_snapshot': { id: string; goal: string; result: string; resolveReason: TerminalResolveReason; },
	'read_test_failures': { failures: string[] },
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'create_file_or_folder': {},
	'delete_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; },
	'run_tests': { result: string; resolveReason: TerminalResolveReason; },
	'install_dependencies': { result: string; resolveReason: TerminalResolveReason; },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'kill_persistent_terminal': {},
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof (typeof builtinTools)[T]['params']
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string
