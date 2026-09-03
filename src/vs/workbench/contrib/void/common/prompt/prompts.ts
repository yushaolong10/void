/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName } from '../toolsServiceTypes.js';
import { ChatMode } from '../voidSettingsTypes.js';
import { DEFAULT_READ_FILE_CONTEXT_CHARS } from '../agent/context/ContextOptimization.js';

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
// Large enough to inspect a meaningful source section without repeatedly paging.
export const MAX_READ_FILE_CONTEXT_CHARS_PAGE = DEFAULT_READ_FILE_CONTEXT_CHARS
export const MAX_CHILDREN_URIs_PAGE = 500

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 20 // seconds
export const MAX_TERMINAL_TOTAL_TIME = 60 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
You are a precise code-application assistant. Convert the requested \`DIFF\` into SEARCH/REPLACE blocks that can be applied to \`ORIGINAL_FILE\`. Make only the requested change.

Required block format:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

Rules:
1. Apply \`DIFF\` exactly. Do not skip requested edits, reinterpret them, or add unrelated edits.
2. Output ONLY SEARCH/REPLACE blocks. Do not include explanations, headings, markdown text, or code fences around the blocks.
3. Use one or more blocks. Prefer the fewest blocks that apply cleanly and reliably.
4. In every block, the \`ORIGINAL\` section must be copied verbatim from \`ORIGINAL_FILE\`, including whitespace, comments, indentation, and blank lines.
5. Each \`ORIGINAL\` section must uniquely identify its target location. Use the smallest unique context; add surrounding lines only when needed for uniqueness.
6. \`ORIGINAL\` sections must not overlap with each other.
7. The \`UPDATED\` section must preserve existing style, indentation, line endings, imports, ordering, and surrounding code unless \`DIFF\` explicitly changes them.
8. Treat comments shown in \`DIFF\` as requested content unless they are clearly placeholders such as "// ... existing code".
9. Do not invent missing context. If a change cannot be applied exactly, produce the smallest valid block for the part that can be applied.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


const replaceTool_description = `\
A single string containing one or more SEARCH/REPLACE blocks to apply to the file.

Required format:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

Guidelines:
1. This parameter is a STRING, not an array and not nested XML.
2. Use multiple blocks only when that is clearer or safer than one block.
3. In each block, \`ORIGINAL\` must exactly match the current file, including whitespace, comments, indentation, and blank lines.
4. Each \`ORIGINAL\` must uniquely identify the target location. Prefer the smallest unique context.
5. \`ORIGINAL\` regions must be disjoint; do not overlap blocks.
6. Preserve existing style and avoid unrelated edits.
7. Do not include explanations, markdown fences, or any text outside the SEARCH/REPLACE blocks.`


// ======================================================== tools ========================================================


export type ToolParamInfo = {
	description: string;
	type?: 'string' | 'number' | 'boolean';
	required?: boolean;
	enum?: readonly string[];
}

export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: ToolParamInfo
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
}



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'number', required: false }
} as const



const terminalDescHelper = `Run terminal commands for inspection or verification only, such as sed, grep, one-off diagnostics, format checks, and benchmarks. Prefer purpose-built tools for supported actions: use edit_file/rewrite_file for file edits, git_status/git_diff/git_apply_patch/git_create_branch/git_commit/git_worktree_create/git_worktree_delete for git operations, run_tests for tests/builds/type checks/lints, install_dependencies for dependency installs, and package_script_list for package scripts. Use run_command only as a fallback when no purpose-built tool covers the command. Choose the smallest command that reduces uncertainty. For commands that may run for a long time or produce delayed output, such as dev servers or watchers, open a persistent terminal first and run the command there. For commands that may open an interactive editor or pager, pipe output to cat or use a non-interactive flag.`

const optionalStringParam = (description: string): ToolParamInfo => ({ description, required: false })
const optionalBooleanParam = (description: string): ToolParamInfo => ({ description, type: 'boolean', required: false })

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'
const cwdParam = optionalStringParam(cwdHelper)

export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};



export const builtinTools: {
	[T in keyof BuiltinToolCallParams]: {
		name: string;
		description: string;
		// more params can be generated than exist here, but these params must be a subset of them
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: ToolParamInfo }>
	}
} = {
	// --- context-gathering (read/search/list) ---

	read_file: {
		name: 'read_file',
		description: `Reads a contiguous section of a source file. Prefer search_in_file or read_symbol when locating a specific symbol. For normal file understanding, use the default 64K-character page and select a relevant start_line/end_line range instead of repeatedly reading small ranges. Increase max_chars up to 128K only when broader context is necessary. If more content remains, continue with the next page only when needed.`,
		params: {
			...uriParam('file'),
			start_line: { description: 'Optional. Inclusive, 1-based start line. Defaults to the beginning of the file.', type: 'number', required: false },
			end_line: { description: 'Optional. Inclusive, 1-based end line. Defaults to the end of the file.', type: 'number', required: false },
			max_chars: { description: 'Optional. Maximum characters per page. Defaults to 64000 and is clamped between 8000 and 128000.', type: 'number', required: false },
			...paginationParam,
		},
	},

	read_image: {
		name: 'read_image',
		description: `Reads an image file and provides it to the vision-capable model for analysis. Use this for PNG, JPEG, WebP, or GIF files when visual inspection is needed.`,
		params: {
			...uriParam('image file'),
		},
	},

	ls_dir: {
		name: 'ls_dir',
		description: `Lists all files and folders in the given URI.`,
		params: {
			uri: { description: `Optional. The FULL path to the ${'folder'}. Leave this as empty or "" to search all folders.`, required: false },
			...paginationParam,
		},
	},

	get_dir_tree: {
		name: 'get_dir_tree',
		description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
		params: {
			...uriParam('folder')
		}
	},

	// pathname_search: {
	// 	name: 'pathname_search',
	// 	description: `Returns all pathnames that match a given \`find\`-style query over the entire workspace. ONLY searches file names. ONLY searches the current workspace. You should use this when looking for a file with a specific name or path. ${paginationHelper.desc}`,

	search_pathnames_only: {
		name: 'search_pathnames_only',
		description: `Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.`,
		params: {
			query: { description: `Your query for the search.` },
			include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.', required: false },
			...paginationParam,
		},
	},



	search_for_files: {
		name: 'search_for_files',
		description: `Returns a list of file names whose content matches the given query. The query can be any substring or regex.`,
		params: {
			query: { description: `Your query for the search.` },
			search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.', required: false },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.', type: 'boolean', required: false },
			...paginationParam,
		},
	},

	// add new search_in_file tool
	search_in_file: {
		name: 'search_in_file',
		description: `Returns an array of all the start line numbers where the content appears in the file.`,
		params: {
			...uriParam('file'),
			query: { description: 'The string or regex to search for in the file.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.', type: 'boolean', required: false }
		}
	},

	read_symbol: {
		name: 'read_symbol',
		description: `Finds likely definitions and important mentions of a symbol using workspace text search. Use this before editing code that depends on a function, class, type, or variable.`,
		params: {
			symbol: { description: 'The exact symbol name to search for.' },
			search_in_folder: optionalStringParam('Optional. Search descendants of this folder only.'),
			...paginationParam,
		},
	},

	find_references: {
		name: 'find_references',
		description: `Finds workspace references to a symbol using text search. Use this to estimate blast radius before refactors.`,
		params: {
			symbol: { description: 'The exact symbol name to search for.' },
			search_in_folder: optionalStringParam('Optional. Search descendants of this folder only.'),
			...paginationParam,
		},
	},

	go_to_definition: {
		name: 'go_to_definition',
		description: `Finds likely definition locations for a symbol using language-like text patterns. Prefer this before opening many unrelated files.`,
		params: {
			symbol: { description: 'The exact symbol name to find.' },
			search_in_folder: optionalStringParam('Optional. Search descendants of this folder only.'),
			...paginationParam,
		},
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Use this tool to view all the lint errors on a file.`,
		params: {
			...uriParam('file'),
		},
	},

	git_status: {
		name: 'git_status',
		description: `Returns the current git status in porcelain format plus the current branch. Use this before summarizing changes or deciding what needs verification.`,
		params: {
			cwd: { description: cwdHelper },
		},
	},

	git_diff: {
		name: 'git_diff',
		description: `Returns the current git diff. Use this after edits to review exactly what changed before summarizing or committing.`,
		params: {
			cwd: { description: cwdHelper },
			staged: { description: 'Optional. Set true to inspect staged changes only. Default is false.', type: 'boolean', required: false },
		},
	},

	git_apply_patch: {
		name: 'git_apply_patch',
		description: `Applies a unified diff patch through git apply. Use only for candidate patches or patch artifacts; prefer edit_file/rewrite_file for normal source edits.`,
		params: {
			cwd: { description: cwdHelper },
			patch: { description: 'The complete unified diff patch text.' },
			check_only: { description: 'Optional. Set true to validate without applying. Default is false.', type: 'boolean', required: false },
		},
	},

	git_create_branch: {
		name: 'git_create_branch',
		description: `Creates and checks out a git branch for an isolated task branch.`,
		params: {
			cwd: { description: cwdHelper },
			branch_name: { description: 'The branch name to create and check out.' },
			base_ref: { description: 'Optional. Git ref to create the branch from. Defaults to current HEAD.' },
		},
	},

	git_commit: {
		name: 'git_commit',
		description: `Creates a git commit after the user has approved the changes. Use git_status and git_diff first.`,
		params: {
			cwd: cwdParam,
			message: { description: 'The commit message.' },
			all: optionalBooleanParam('Optional. Set true to stage modified/deleted tracked files with git commit -am. Default is false.'),
		},
	},

	git_worktree_create: {
		name: 'git_worktree_create',
		description: `Creates an isolated git worktree for a candidate patch. Use this when exploring an implementation path that should not directly modify the main workspace.`,
		params: {
			cwd: { description: cwdHelper },
			path: { description: 'Optional. Relative or absolute destination path for the worktree. Defaults to .void/worktrees/<run id>.' },
			branch_name: { description: 'Optional. Branch name for the candidate worktree. Defaults to void/<run id>.' },
			base_ref: { description: 'Optional. Git ref to branch from. Defaults to the current HEAD.' },
		},
	},

	git_worktree_delete: {
		name: 'git_worktree_delete',
		description: `Removes an isolated git worktree after a candidate patch is discarded or merged.`,
		params: {
			cwd: { description: cwdHelper },
			path: { description: 'The relative or absolute worktree path to remove.' },
			prune: { description: 'Optional. Set true to run git worktree prune after removing. Default is true.', type: 'boolean', required: false },
		},
	},

	package_script_list: {
		name: 'package_script_list',
		description: `Lists scripts from package.json so you can choose the right test, lint, build, or typecheck command.`,
		params: {
			cwd: { description: cwdHelper },
		},
	},

	review_snapshot: {
		name: 'review_snapshot',
		description: `Collects a read-only review snapshot of the current workspace state. It gathers git status, diff stats, whitespace checks, and optionally the full diff for risk review without editing files. This is not a separate agent.`,
		params: {
			cwd: { description: cwdHelper },
			goal: { description: 'The review focus, such as "check regression risk before commit".' },
			include_diff: { description: 'Optional. Include the full git diff in the review snapshot. Default is true.', type: 'boolean', required: false },
		},
	},

	read_test_failures: {
		name: 'read_test_failures',
		description: `Extracts likely failure snippets from a test, lint, build, or typecheck output. Use this after run_tests when the output is long or noisy.`,
		params: {
			output: { description: 'The raw output returned by run_tests or another verification command.' },
			max_items: { description: 'Optional. Maximum number of failure snippets to return. Default is 8.', type: 'number', required: false },
		},
	},

	// --- editing (create/delete) ---

	create_file_or_folder: {
		name: 'create_file_or_folder',
		description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.`,
		params: {
			...uriParam('file or folder'),
		},
	},

	delete_file_or_folder: {
		name: 'delete_file_or_folder',
		description: `Delete a file or folder at the given path.`,
		params: {
			...uriParam('file or folder'),
			is_recursive: { description: 'Optional. Return true to delete recursively.', type: 'boolean', required: false }
		},
	},

	edit_file: {
		name: 'edit_file',
		description: `Preferred tool for editing an existing file. Provide the file URI and a SINGLE string of SEARCH/REPLACE block(s). If an edit fails, re-read the smallest relevant range and retry with smaller, exact, unique ORIGINAL context before considering rewrite_file.`,
		params: {
			...uriParam('file'),
			search_replace_blocks: { description: replaceTool_description }
		},
	},

	rewrite_file: {
		name: 'rewrite_file',
		description: `Fallback whole-file replacement. Use for a newly created file, or only after two targeted edit_file attempts on the current file failed even after re-reading fresh context. Never use it as the first choice for an existing file.`,
		params: {
			...uriParam('file'),
			new_content: { description: `The new contents of the file. Must be a string.` }
		},
	},
	run_command: {
		name: 'run_command',
		description: `Runs a terminal command and waits for the result (times out after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity or ${MAX_TERMINAL_TOTAL_TIME}s total wait time). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			cwd: { description: cwdHelper },
		},
	},

	run_tests: {
		name: 'run_tests',
		description: `Runs a targeted test, lint, build, or typecheck command and waits for the result. Prefer the smallest verification command that matches the files changed.`,
		params: {
			command: { description: 'The test, lint, build, or typecheck command to run.' },
			cwd: { description: cwdHelper },
		},
	},

	install_dependencies: {
		name: 'install_dependencies',
		description: `Runs a package manager install command when dependencies are missing. This requires approval and should be used only after inspecting package metadata or an install error.`,
		params: {
			command: { description: 'The install command to run, such as npm install, pnpm install, yarn install, or pip install -r requirements.txt.' },
			cwd: { description: cwdHelper },
		},
	},

	run_persistent_command: {
		name: 'run_persistent_command',
		description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after ${MAX_TERMINAL_BG_COMMAND_TIME} are returned, and command continues running in background). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
		},
	},



	open_persistent_terminal: {
		name: 'open_persistent_terminal',
		description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
		params: {
			cwd: { description: cwdHelper },
		}
	},


	kill_persistent_terminal: {
		name: 'kill_persistent_terminal',
		description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
		params: { persistent_terminal_id: { description: `The ID of the persistent terminal.` } }
	}


	// go_to_definition
	// go_to_usages

} satisfies { [T in keyof BuiltinToolResultType]: InternalToolInfo }




export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[]
const toolNamesSet = new Set<string>(builtinToolNames)
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName)
	return isAToolName
}

type AvailableToolsOptions = {
	supportsVision?: boolean;
}




export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, options?: AvailableToolsOptions) => {

	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? undefined
		: chatMode === 'gather' ? (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !(toolName in approvalTypeOfBuiltinToolName))
			: chatMode === 'agent' ? Object.keys(builtinTools) as BuiltinToolName[]
				: undefined

	const effectiveBuiltinToolNames = options?.supportsVision === false
		? builtinToolNames?.filter(toolName => toolName !== 'read_image')
		: builtinToolNames
	const effectiveBuiltinTools = effectiveBuiltinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined
	const effectiveMCPTools = chatMode === 'agent' ? mcpTools : undefined

	const tools: InternalToolInfo[] | undefined = !(effectiveBuiltinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		].sort((a, b) => a.name.localeCompare(b.name))

	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).sort().map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
		return `\
    ${i + 1}. ${t.name}
    Description: ${t.description}
    Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>`
	}).join('\n\n')}`
}

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}

/* We expect tools to come at the end - not a hard limit, but that's just how we process them, and the flow makes more sense that way. */
// - You are allowed to call multiple tools by specifying them consecutively. However, there should be NO text or writing between tool calls or after them.
const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, options?: AvailableToolsOptions) => {
	const tools = availableTools(chatMode, mcpTools, options)
	if (!tools || tools.length === 0) return null
	const toolNameSet = new Set(tools.map(tool => tool.name))
	const batchableReadTools = [
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
	].filter(toolName => toolNameSet.has(toolName)).join(', ')

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    Tool calling contract:
    - Use a tool only when it directly helps complete the user's request.
    - Prefer the most specific purpose-built tool available. Use terminal tools only as a fallback when no dedicated tool covers the action.
    - Do not use run_command or run_persistent_command for supported file edits, git operations, package script discovery, dependency installs, tests, builds, lints, or type checks; use the dedicated tool for that action instead.
    - If you call a tool, output ONLY the XML tool call. Do not write any prose, markdown, explanation, or purpose sentence before or after it.
    - The XML root tag must be exactly the tool name, for example <ls_dir>...</ls_dir>.
    - Do NOT wrap tool calls in generic tags such as <tool_call name="ls_dir">...</tool_call>.
    - Do NOT put tool XML inside markdown code fences.
    - You may call multiple tools in one response when every call is independent and safe to run concurrently.
    - Prefer batching independent read/search/list/snapshot tools such as ${batchableReadTools}.
    - You may also batch independent write tools when they affect different files or parent directories.
    - Do not batch tools when a later tool depends on an earlier result.
    - Do not batch delete operations, raw terminal tools such as run_command or run_persistent_command, MCP tools, or multiple writes to the same file. Dedicated read-only tools may be batched even if they are implemented using terminal commands internally.
    - After outputting the closing tag for the final tool call, stop immediately and wait for the tool results.
    - All parameters are required unless their description says Optional.
    - Parameter values are plain text. Do NOT include XML tags, closing tags, partial tags, or markdown fences inside parameter values.
    - Escape or avoid any content in parameter values that would be parsed as XML markup.

    Response modes:
    - If no tool is needed, respond normally in markdown.
    - If a tool is needed, respond with only the XML tool call and nothing else.
    - Do not mention internal tool names to the user in prose. The tool XML itself is enough.

    Correct XML examples:
    ${tripleTick[0]}
    <read_file>
      <uri>/home/user/file.ts</uri>
    </read_file>
    ${tripleTick[1]}

    ${tripleTick[0]}
    <read_file>
      <uri>/home/user/file.ts</uri>
      <start_line>10</start_line>
      <end_line>20</end_line>
    </read_file>
    ${tripleTick[1]}

    ${tripleTick[0]}
    <ls_dir>
      <uri>/repo</uri>
    </ls_dir>
    ${tripleTick[1]}

    Correct edit_file example:
    ${tripleTick[0]}
    <edit_file>
      <uri>/repo/src/app.ts</uri>
      <search_replace_blocks>
${ORIGINAL}
const x = 1
${DIVIDER}
const x = 2
${FINAL}
      </search_replace_blocks>
    </edit_file>
    ${tripleTick[1]}

    XML formatting requirements:
    - Every XML element must have exactly one opening tag and exactly one matching closing tag.
    - A closing tag must be exactly </tagname>. Do not add spaces inside it, omit the final >, repeat it, or try to repair it after writing it.
    - A tool call is complete immediately after the first exact closing tag for its root tool.
    - For edit_file, the only valid final characters of the response are exactly </edit_file>.
    - For read_file, the only valid final characters of the response are exactly </read_file>.
    - For ls_dir, the only valid final characters of the response are exactly </ls_dir>.
    - For get_dir_tree, the only valid final characters of the response are exactly </get_dir_tree>.
    - For run_command, the only valid final characters of the response are exactly </run_command>.
    - For run_persistent_command, the only valid final characters of the response are exactly </run_persistent_command>.
    - For open_persistent_terminal, the only valid final characters of the response are exactly </open_persistent_terminal>.
    - For kill_persistent_terminal, the only valid final characters of the response are exactly </kill_persistent_terminal>.
    - Multiple root tool calls are allowed only for independent read-only calls or independent writes to different files.
    - If you are uncertain about formatting or dependency order, output one small, valid tool call and stop.

    edit_file-specific requirements:
    - The SEARCH/REPLACE blocks belong inside <search_replace_blocks> as one string value.
    - SEARCH/REPLACE blocks are not XML and must not be treated as nested tool calls.
    - The value of <search_replace_blocks> must not contain XML closing tag text such as </edit_file> or </search_replace_blocks>.
    - Close <search_replace_blocks> exactly once, then close <edit_file> exactly once, then stop immediately.

    Execution details:
    - The tool call will be executed immediately.
    - The result will appear in the following user message.`)

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`
}

// ======================================================== chat (normal, gather, agent) ========================================================

export const PROMPT_CACHE_BREAKPOINT = '<!-- VOID_PROMPT_CACHE_BREAKPOINT -->'

type ChatSystemMessageOptions = {
	workspaceFolders: string[];
	directoryStr: string;
	openedURIs: string[];
	activeURI: string | undefined;
	persistentTerminalIDs: string[];
	chatMode: ChatMode;
	mcpTools: InternalToolInfo[] | undefined;
	includeXMLToolDefinitions: boolean;
	supportsVision?: boolean;
}

/**
 * Keep the universal policy short. Tool schemas own parameter-level guidance,
 * and provider adapters own native/XML serialization details.
 */
export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions, supportsVision }: ChatSystemMessageOptions) => {
	const role = mode === 'agent'
		? `You are a software engineering agent working in the user's workspace. Complete coding tasks end-to-end with small, correct, maintainable changes.`
		: mode === 'gather'
			? `You are a software engineering assistant with read-only workspace tools. Gather targeted evidence and answer accurately.`
			: `You are a software engineering assistant. Give clear, accurate, maintainable guidance.`

	const policies = [
		`Use only information from the user, workspace instructions, selected context, and tool results. Distinguish facts from hypotheses.`,
		`Inspect only the files, symbols, tests, and configuration needed for the task. Prefer targeted search over broad repository exploration.`,
		`Preserve existing architecture and style. Avoid unrelated changes and never modify outside the workspace without permission.`,
		`Use tools only when they advance the task. Independent read-only calls may run together; dependent calls and writes should run in order.`,
		`For existing files, prefer targeted edit_file changes. Use rewrite_file only for new files or when targeted edits cannot be applied safely.`,
		`After changes, run the smallest useful verification. Never claim a command, test, build, or inspection succeeded unless its result was observed.`,
		`Stop when the request is complete, blocked, or requires user permission. State any remaining unverified work clearly.`,
	]
	if (mode === 'gather') policies.push(`Do not modify workspace files in Gather mode.`)
	if (mode === 'normal') policies.push(`If repository context is missing, ask the user to attach the relevant file or folder.`)

	const runtimeLines = [
		`OS: ${os}`,
		`Workspace roots: ${workspaceFolders.join(', ') || 'none'}`,
		activeURI ? `Active file: ${activeURI}` : '',
		openedURIs.length ? `Open files: ${openedURIs.join(', ')}` : '',
		mode === 'agent' && persistentTerminalIDs.length ? `Persistent terminals: ${persistentTerminalIDs.join(', ')}` : '',
	].filter(Boolean)
	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools, { supportsVision }) : null
	const workspaceOverview = directoryStr ? `<workspace_overview>\n${directoryStr}\n</workspace_overview>` : ''

	return [
		role,
		toolDefinitions,
		`Operating rules:\n${policies.map((policy, index) => `${index + 1}. ${policy}`).join('\n')}`,
		PROMPT_CACHE_BREAKPOINT,
		workspaceOverview,
		`<runtime_context>\n${runtimeLines.join('\n')}\n</runtime_context>`,
	].filter(Boolean).join('\n\n').trim()
}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const CHAT_HISTORY_COMPRESSION = {
	maxSummaryChars: 5000,
} as const

export const COMPRESSING_HISTORY_LABEL = 'Compressing earlier history...'

export const compressHistoryPrompt = `You are a conversation compression assistant. Produce a compact, factual memory that lets another coding agent continue without rereading the original turns.
Preserve confirmed user goals, constraints, decisions, changed files and symbols, exact failures, verification results, unresolved work, and artifact/file references. Tool results below have already been reduced; do not discard their concrete findings. Never turn an inference into a confirmed fact. Keep the original language of the conversation.
Use exactly these short sections and omit empty sections:
Goal:
Constraints:
Decisions:
Changes:
Observations:
Verification:
Unresolved:
Output only the memory.`

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000
const MAX_SELECTED_FILE_CHARS = 120_000
const MAX_SELECTION_CONTEXT_CHARS = 200_000

const capSelectedContext = (value: string, maxChars: number): string => {
	if (value.length <= maxChars) return value
	const edgeChars = Math.max(1, Math.floor((maxChars - 80) / 2))
	return `${value.slice(0, edgeChars)}\n... selected context omitted ...\n${value.slice(-edgeChars)}`
}

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const lines = val?.split('\n')

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n')
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`
		return str
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, MAX_SELECTED_FILE_CHARS)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`
		return `${folderStructure}\nUse workspace tools to read only the files needed from this folder.`
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = capSelectedContext(selnsStrs.join('\n\n') ?? '', MAX_SELECTION_CONTEXT_CHARS)
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`
	return str;
}


export const rewriteCode_systemMessage = `\
You are a precise whole-file rewrite assistant. You will receive \`ORIGINAL_FILE\` and \`CHANGE\`.

Directions:
1. Return the complete new file after applying \`CHANGE\` to \`ORIGINAL_FILE\`.
2. Apply \`CHANGE\` exactly. Do not omit requested edits or add unrelated edits.
3. Preserve comments, spacing, newlines, imports, ordering, naming, and style unless \`CHANGE\` explicitly requires otherwise.
4. Preserve behavior except where \`CHANGE\` explicitly requires a behavior change.
5. Output ONLY the full new file contents. Do not include explanations, markdown fences, headings, or surrounding text.
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Apply CHANGE to ORIGINAL_FILE and return only the complete rewritten file content. Do not include explanations, markdown fences, or extra text.
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a precise fill-in-the-middle coding assistant. Replace only the code inside the <${midTag}>...</${midTag}> selection.

Input structure:
- INSTRUCTIONS: what the user wants changed.
- <${preTag}>...</${preTag}>: code before the selection. Use this as read-only context.
- <${sufTag}>...</${sufTag}>: code after the selection. Use this as read-only context.
- CURRENT SELECTION: the original code that will be replaced.

Output requirements:
1. Output exactly one block of the form <${midTag}>...new_code...</${midTag}>.
2. Do not output explanations, markdown fences, headings, or text before or after the <${midTag}> block.
3. Modify only the selected code. Do not duplicate, remove, or rewrite content from <${preTag}> or <${sufTag}> unless it must appear inside the replacement selection.
4. Preserve indentation, style, names, imports, and behavior unless the user explicitly requests a change.
5. Ensure brackets, quotes, JSX/XML tags, comments, and syntax are balanced and compatible with the surrounding code.
6. If the best change is to leave the selection unchanged, return the original selection inside <${midTag}>...</${midTag}>.
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

READ-ONLY CONTEXT BEFORE THE SELECTION
<${preTag}>${prefix}</${preTag}>

READ-ONLY CONTEXT AFTER THE SELECTION
<${sufTag}>${suffix}</${sufTag}>

Return only:
${tripleTick[0]}${language}
<${midTag}>...new code...</${midTag}>
${tripleTick[1]}`
};







/*
// ======================================================== ai search/replace ========================================================


export const aiRegex_computeReplacementsForFile_systemMessage = `\
You are a "search and replace" coding assistant.

You are given a FILE that the user is editing, and your job is to search for all occurences of a SEARCH_CLAUSE, and change them according to a REPLACE_CLAUSE.

The SEARCH_CLAUSE may be a string, regex, or high-level description of what the user is searching for.

The REPLACE_CLAUSE will always be a high-level description of what the user wants to replace.

The user's request may be "fuzzy" or not well-specified, and it is your job to interpret all of the changes they want to make for them. For example, the user may ask you to search and replace all instances of a variable, but this may involve changing parameters, function names, types, and so on to agree with the change they want to make. Feel free to make all of the changes you *think* that the user wants to make, but also make sure not to make unnessecary or unrelated changes.

## Instructions

1. If you do not want to make any changes, you should respond with the word "no".

2. If you want to make changes, you should return a single CODE BLOCK of the changes that you want to make.
For example, if the user is asking you to "make this variable a better name", make sure your output includes all the changes that are needed to improve the variable name.
- Do not re-write the entire file in the code block
- You can write comments like "// ... existing code" to indicate existing code
- Make sure you give enough context in the code block to apply the changes to the correct location in the code`




// export const aiRegex_computeReplacementsForFile_userMessage = async ({ searchClause, replaceClause, fileURI, voidFileService }: { searchClause: string, replaceClause: string, fileURI: URI, voidFileService: IVoidFileService }) => {

// 	// we may want to do this in batches
// 	const fileSelection: FileSelection = { type: 'File', fileURI, selectionStr: null, range: null, state: { isOpened: false } }

// 	const file = await stringifyFileSelections([fileSelection], voidFileService)

// 	return `\
// ## FILE
// ${file}

// ## SEARCH_CLAUSE
// Here is what the user is searching for:
// ${searchClause}

// ## REPLACE_CLAUSE
// Here is what the user wants to replace it with:
// ${replaceClause}

// ## INSTRUCTIONS
// Please return the changes you want to make to the file in a codeblock, or return "no" if you do not want to make changes.`
// }




// // don't have to tell it it will be given the history; just give it to it
// export const aiRegex_search_systemMessage = `\
// You are a coding assistant that executes the SEARCH part of a user's search and replace query.

// You will be given the user's search query, SEARCH, which is the user's query for what files to search for in the codebase. You may also be given the user's REPLACE query for additional context.

// Output
// - Regex query
// - Files to Include (optional)
// - Files to Exclude? (optional)

// `






// ======================================================== old examples ========================================================

Do not tell the user anything about the examples below. Do not assume the user is talking about any of the examples below.

## EXAMPLE 1
FILES
math.ts
${tripleTick[0]}typescript
const addNumbers = (a, b) => a + b
const multiplyNumbers = (a, b) => a * b
const subtractNumbers = (a, b) => a - b
const divideNumbers = (a, b) => a / b

const vectorize = (...numbers) => {
	return numbers // vector
}

const dot = (vector1: number[], vector2: number[]) => {
	if (vector1.length !== vector2.length) throw new Error(\`Could not dot vectors \${vector1} and \${vector2}. Size mismatch.\`)
	let sum = 0
	for (let i = 0; i < vector1.length; i += 1)
		sum += multiplyNumbers(vector1[i], vector2[i])
	return sum
}

const normalize = (vector: number[]) => {
	const norm = Math.sqrt(dot(vector, vector))
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = divideNumbers(vector[i], norm)
	return vector
}

const normalized = (vector: number[]) => {
	const v2 = [...vector] // clone vector
	return normalize(v2)
}
${tripleTick[1]}


SELECTIONS
math.ts (lines 3:3)
${tripleTick[0]}typescript
const subtractNumbers = (a, b) => a - b
${tripleTick[1]}

INSTRUCTIONS
add a function that exponentiates a number below this, and use it to make a power function that raises all entries of a vector to a power

## ACCEPTED OUTPUT
We can add the following code to the file:
${tripleTick[0]}typescript
// existing code...
const subtractNumbers = (a, b) => a - b
const exponentiateNumbers = (a, b) => Math.pow(a, b)
const divideNumbers = (a, b) => a / b
// existing code...

const raiseAll = (vector: number[], power: number) => {
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = exponentiateNumbers(vector[i], power)
	return vector
}
${tripleTick[1]}


## EXAMPLE 2
FILES
fib.ts
${tripleTick[0]}typescript

const dfs = (root) => {
	if (!root) return;
	console.log(root.val);
	dfs(root.left);
	dfs(root.right);
}
const fib = (n) => {
	if (n < 1) return 1
	return fib(n - 1) + fib(n - 2)
}
${tripleTick[1]}

SELECTIONS
fib.ts (lines 10:10)
${tripleTick[0]}typescript
	return fib(n - 1) + fib(n - 2)
${tripleTick[1]}

INSTRUCTIONS
memoize results

## ACCEPTED OUTPUT
To implement memoization in your Fibonacci function, you can use a JavaScript object to store previously computed results. This will help avoid redundant calculations and improve performance. Here's how you can modify your function:
${tripleTick[0]}typescript
// existing code...
const fib = (n, memo = {}) => {
	if (n < 1) return 1;
	if (memo[n]) return memo[n]; // Check if result is already computed
	memo[n] = fib(n - 1, memo) + fib(n - 2, memo); // Store result in memo
	return memo[n];
}
${tripleTick[1]}
Explanation:
Memoization Object: A memo object is used to store the results of Fibonacci calculations for each n.
Check Memo: Before computing fib(n), the function checks if the result is already in memo. If it is, it returns the stored result.
Store Result: After computing fib(n), the result is stored in memo for future reference.

## END EXAMPLES

*/


// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are a senior software engineer writing a clear Git commit message from the provided diff and metadata.

Guidelines:
- Prefer one concise sentence. Use a second sentence only if it adds necessary context.
- Summarize the intent of the change, not a mechanical list of edited files.
- Emphasize user-visible behavior, bug fixed, architectural intent, or maintenance value.
- Match the scope shown in the diff. Do not infer or overstate changes that are not supported by the provided data.
- Use an imperative, present-tense style when it reads naturally.
- Avoid quotes, markdown, bullets, and extra commentary.

Required output:
<output>Commit message here</output>
<reasoning>Briefly explain why this message matches the diff and metadata.</reasoning>

Do not include anything outside the <output> and <reasoning> tags.
Both tags are required exactly once.
Do not nest XML tags inside either value.`.trim()


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`
	const section3 = `Section 3 - Current Git Branch:`
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim()
}
