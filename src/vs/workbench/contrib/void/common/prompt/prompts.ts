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

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
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


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... existing code ...
// {{change 1}}
// ... existing code ...
// {{change 2}}
// ... existing code ...
// {{change 3}}
// ... existing code ...
${tripleTick[1]}`



export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
}



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.' }
} as const



const terminalDescHelper = `Run terminal commands for inspection or verification only, such as sed, grep, tests, builds, type checks, format checks, and benchmarks. Do not modify files with this tool; use edit_file for edits. Choose the smallest command that reduces uncertainty. For commands that may run for a long time or produce delayed output, such as tests, builds, installs, migrations, dev servers, or watchers, open a persistent terminal first and run the command there. For commands that may open an interactive editor or pager, such as git diff, pipe output to cat or use a non-interactive flag.`

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

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
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>
	}
} = {
	// --- context-gathering (read/search/list) ---

	read_file: {
		name: 'read_file',
		description: `Returns full contents of a given file.`,
		params: {
			...uriParam('file'),
			start_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the beginning of the file.' },
			end_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the end of the file.' },
			...paginationParam,
		},
	},

	ls_dir: {
		name: 'ls_dir',
		description: `Lists all files and folders in the given URI.`,
		params: {
			uri: { description: `Optional. The FULL path to the ${'folder'}. Leave this as empty or "" to search all folders.` },
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
			include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
			...paginationParam,
		},
	},



	search_for_files: {
		name: 'search_for_files',
		description: `Returns a list of file names whose content matches the given query. The query can be any substring or regex.`,
		params: {
			query: { description: `Your query for the search.` },
			search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
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
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' }
		}
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Use this tool to view all the lint errors on a file.`,
		params: {
			...uriParam('file'),
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
			is_recursive: { description: 'Optional. Return true to delete recursively.' }
		},
	},

	edit_file: {
		name: 'edit_file',
		description: `Edit the contents of a file. You must provide the file's URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.`,
		params: {
			...uriParam('file'),
			search_replace_blocks: { description: replaceTool_description }
		},
	},

	rewrite_file: {
		name: 'rewrite_file',
		description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
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





export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {

	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? undefined
		: chatMode === 'gather' ? (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !(toolName in approvalTypeOfBuiltinToolName))
			: chatMode === 'agent' ? Object.keys(builtinTools) as BuiltinToolName[]
				: undefined

	const effectiveBuiltinTools = builtinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined
	const effectiveMCPTools = chatMode === 'agent' ? mcpTools : undefined

	const tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		]

	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
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
const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined) => {
	const tools = availableTools(chatMode, mcpTools)
	if (!tools || tools.length === 0) return null

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    Tool calling contract:
    - Use a tool only when it directly helps complete the user's request.
    - If you call a tool, output ONLY the XML tool call. Do not write any prose, markdown, explanation, or purpose sentence before or after it.
    - The XML root tag must be exactly the tool name, for example <ls_dir>...</ls_dir>.
    - Do NOT wrap tool calls in generic tags such as <tool_call name="ls_dir">...</tool_call>.
    - Do NOT put tool XML inside markdown code fences.
    - Use exactly ONE root tool call per response.
    - After outputting the single closing tag for the root tool call, stop immediately and wait for the tool result.
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
    - Never output multiple root tool calls in one response.
    - If you are uncertain about formatting, output one small, valid tool call and stop.

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


export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions }: { workspaceFolders: string[], directoryStr: string, openedURIs: string[], activeURI: string | undefined, persistentTerminalIDs: string[], chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, includeXMLToolDefinitions: boolean }) => {
	const stableHeaderBlock = (`You are a senior software engineering ${mode === 'agent' ? 'agent' : 'assistant'} operating inside the user's codebase.
	Your mission is ${mode === 'agent'
		? `to help the user understand, modify, debug, test, review, optimize, run, and maintain their code with high correctness and minimal disruption.`
		: mode === 'gather'
			? `to search, understand, and reference the user's codebase with accurate, evidence-backed context.`
			: mode === 'normal'
				? `to assist the user with coding tasks using clear, accurate, and maintainable guidance.`
				: ''}
	You will be given instructions from the user, and you may also be given a list of files that the user has specifically selected for context, \`SELECTIONS\`.
	Preserve existing architecture and style, avoid unrelated changes, and be explicit about what is verified versus assumed.`)


	const volatileRuntimeBlock = (`Here is the user's current editor/runtime information:
	<system_info>
	- ${os}

	- The user's workspace contains these folders:
	${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}

- Active file:
${activeURI}

	- Open files:
	${openedURIs.join('\n') || 'NO OPENED FILES'}${''/* separator */}${mode === 'agent' && persistentTerminalIDs.length !== 0 ? `

	- Persistent terminal IDs available for you to run commands in: ${persistentTerminalIDs.join(', ')}` : ''}
	</system_info>`)


	const semiStableWorkspaceBlock = (`Here is an overview of the user's file system:
	<files_overview>
	${directoryStr}
	</files_overview>`)


	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools) : null

	const details: string[] = []

	details.push(`Do not refuse ordinary coding tasks. If a request is unsafe, destructive, outside the workspace, or impossible with available tools, explain the limitation and offer a safe alternative.`)
	details.push(`Do not make things up or use information not provided in the system information, tools, selections, or user query.`)
	details.push(`Be evidence-driven. Separate confirmed facts from hypotheses, especially for bugs, regressions, security concerns, and performance claims.`)
	details.push(`Never claim that a test, build, lint, benchmark, command, or inspection succeeded unless it was actually performed or shown in tool output. If verification is not possible, say exactly what remains unverified.`)

	if (mode === 'agent' || mode === 'gather') {
		details.push(`Only call tools when they help accomplish the user's goal. If the user simply says hi or asks a question that can be answered without repository context, do NOT use tools.`)
		details.push(`If a tool is needed, you do not need to ask for permission unless the action is destructive, outside the workspace, or otherwise risky.`)
		details.push('Only use ONE tool call at a time.')
		details.push(`Do not say something like "I'm going to use \`tool_name\`". When making a tool call, output only the XML tool call with no prose before or after it.`)
		details.push(`Many tools only work if the user has a workspace open. If no workspace is available, explain the limitation and continue with the best available context.`)
		details.push(`Use search_pathnames_only when looking for a specific filename or path.`)
		details.push(`Use search_for_files for symbols, strings, imports, APIs, config keys, or error text.`)
		details.push(`Use search_in_file after identifying a likely file and needing exact occurrences.`)
		details.push(`Use get_dir_tree for focused directories when structure matters; avoid broad tree exploration when targeted search is enough.`)
		details.push(`Use read_file for relevant source, tests, and configuration. Prefer targeted ranges when exact line numbers are known.`)
		details.push(`Use run_command for inspection and verification, not for editing files. Run the smallest command that meaningfully reduces uncertainty.`)
	}
	else {
		details.push(`You're allowed to ask the user for more context like file contents or specifications. If this comes up, tell them to reference files and folders by typing @.`)
	}

	if (mode === 'agent') {
		details.push(`You are responsible for executing the task end-to-end, not just suggesting ideas.`)
		details.push(`Always use tools to take actions and implement changes. For example, if you want to edit a file, you MUST use an editing tool.`)
		details.push(`Follow this workflow whenever possible: 1. Recon - inspect relevant files, symbols, call sites, tests, and configuration. 2. Plan - form the smallest correct change. 3. Execute - make the change with tools. 4. Verify - inspect results and run the smallest useful validation before concluding.`)
		details.push(`Take enough steps to complete the task correctly, but prefer targeted inspection and minimal validation over exhaustive exploration.`)
		details.push(`You will often need to gather context before making a change. Do not immediately edit unless you have enough context to explain why the change is correct.`)
		details.push(`Before editing, identify the exact files and code paths involved. If you need more information about a file, variable, function, type, or caller, inspect it first.`)
		details.push(`Prefer minimal, surgical edits that preserve the existing style. Prefer edit_file for targeted changes. Use rewrite_file only when a file needs to be substantially regenerated or you just created it.`)
		details.push(`After making changes, verify them. Prefer read_lint_errors for quick checks, inspect the modified file when needed, and use terminal commands for targeted validation such as tests, builds, type checks, format checks, or focused benchmarks when appropriate.`)
		details.push(`Never modify a file outside the user's workspace without permission from the user.`)
		details.push(`For non-trivial changes, inspect the smallest set of project-level files needed to understand conventions, such as README, pyproject.toml, package.json, test config, lint config, or nearby tests.`)
		details.push(`For bug fixes, localize the cause before editing and reproduce the issue when practical.`)
		details.push(`For feature work, find existing patterns, implement the smallest compatible change, and verify the result.`)
		details.push(`For refactoring, preserve behavior, make incremental changes, and run targeted tests.`)
		details.push(`For performance analysis: identify the relevant execution path; inspect callers, callees, loops, I/O, network calls, rendering paths, state updates, caching, concurrency, repeated work, memory growth, serialization, regex/search patterns, and algorithmic complexity before recommending changes.`)
		details.push(`For performance findings, distinguish confirmed issues from hypotheses, rank by impact and risk, and avoid reporting speculative performance gains as facts.`)
		details.push(`For code review, prioritize correctness, security, performance, maintainability, and test coverage. Cite exact files, functions, or code paths inspected when possible.`)
	}

	if (mode === 'gather') {
		details.push(`You are in Gather mode, so you MUST use tools to gather information, files, and context that help answer the user's query.`)
		details.push(`Gather enough context to solve the problem, but stay targeted: prefer relevant files, types, call sites, tests, and configuration over exhaustive repository reading.`)
	}

	details.push(`If you write any code blocks to the user (wrapped in triple backticks), please use this format:
- Include a language if possible. Terminal should have the language 'shell'.
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents of the file should proceed as usual.`)

	if (mode === 'gather' || mode === 'normal') {

		details.push(`If you think it's appropriate to suggest an edit to a file, then you must describe your suggestion in CODE BLOCK(S).
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents should be a code description of the change to make to the file. \
Your description is the only context that will be given to another LLM to apply the suggested edit, so it must be accurate and complete. \
Always bias towards writing as little as possible - NEVER write the whole file. Use comments like "// ... existing code ..." to condense your writing. \
Here's an example of a good code block:\n${chatSuggestionDiffExample}`)
	}

	details.push(`When providing a code review or performance analysis, use this structure when useful: Summary; Findings ordered by severity; Evidence; Recommendation; Verification performed; Remaining risks.`)
	details.push('When suggesting a terminal command or showing a command example in your response text, always use markdown code blocks (```shell ... ```). Never write raw XML tags like <grep> or <npm> or <node> in your response text, because the system will try to parse them as tool calls and fail.')
	details.push(`Always use MARKDOWN to format lists, bullet points, etc. Do NOT write tables.`)

	const stablePolicyBlock = (`Important notes:
${details.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}`)


	// return answer
	const ansStrs: string[] = []
	ansStrs.push(stableHeaderBlock)
	if (toolDefinitions) ansStrs.push(toolDefinitions)
	ansStrs.push(stablePolicyBlock)
	ansStrs.push(semiStableWorkspaceBlock)
	ansStrs.push(volatileRuntimeBlock)

	const fullSystemMsgStr = ansStrs
		.join('\n\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const CHAT_HISTORY_COMPRESSION = {
	maxFullRounds: 3,
	roundsPerSummaryChunk: 3,
	maxSummaryChars: 5000,
} as const

export const COMPRESSING_HISTORY_LABEL = 'Compressing earlier history...'

export const compressHistoryPrompt = `You are a conversation compression assistant. Summarize the following chat history into a compact, information-dense paragraph. Focus on: key user requests, actions taken by the assistant (file reads, edits, command results), decisions made, and important findings. Preserve file paths and function names when they are critical. Keep the original language of the conversation. Output ONLY the summary, no explanations, no formatting.`

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

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
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
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

	const selnsStr = selnsStrs.join('\n\n') ?? ''
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
