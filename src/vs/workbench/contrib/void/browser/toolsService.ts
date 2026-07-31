import { CancellationTokenSource } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_READ_FILE_CONTEXT_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME, MAX_TERMINAL_TOTAL_TIME } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { extractSearchReplaceBlocks, normalizeSearchReplaceBlocks } from '../common/helpers/extractCodeFromResult.js'
import { IBrowserAgentBridge, createLegacyToolInvocation } from './agent/BrowserAgentBridge.js'
import { ReviewSnapshotManager } from '../common/agent/execution/ReviewSnapshotManager.js'
import { WorktreeManager } from '../common/agent/execution/WorktreeManager.js'
import { paginateContiguousSource } from '../common/agent/context/ContextOptimization.js'
import { safeStringify } from '../common/agent/tools/safeSerialize.js'
import type { ImageAttachment } from '../common/chatThreadServiceTypes.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }

const SUPPORTED_IMAGE_MIME_TYPES = new Set<ImageAttachment['mimeType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024

const imageMimeTypeOfPath = (path: string): ImageAttachment['mimeType'] | null => {
	const lower = path.toLowerCase()
	if (lower.endsWith('.png')) return 'image/png'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	if (lower.endsWith('.webp')) return 'image/webp'
	if (lower.endsWith('.gif')) return 'image/gif'
	return null
}

const bytesToBase64 = (bytes: Uint8Array) => {
	let binary = ''
	const chunkSize = 0x8000
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize)
		binary += String.fromCharCode(...chunk)
	}
	return btoa(binary)
}

const basenameOfPath = (path: string) => {
	const normalized = path.replace(/\\/g, '/')
	const slashIdx = normalized.lastIndexOf('/')
	return slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1)
}


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const stripTrailingXMLArtifacts = (value: string) => {
	return value
		.replace(/(?:\s*<\/?[a-zA-Z_][\w:-]*(?:\s+[^>]*)?>\s*)+$/g, '')
		.replace(/(?:\s*<\/?[a-zA-Z_][\w:-]*)+$/g, '')
		.trimEnd()
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${safeStringify(value)}.`)
	return stripTrailingXMLArtifacts(value)
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${safeStringify(uriStr)}.`)
	const cleanedUriStr = stripTrailingXMLArtifacts(uriStr)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (cleanedUriStr.includes('://')) {
		try {
			const uri = URI.parse(cleanedUriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${cleanedUriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(cleanedUriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}

const sanitizeGitRefSegment = (value: string) => {
	return value.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/\/+/g, '/').replace(/^-+|-+$/g, '')
}

const shellQuote = (value: string) => {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

const dirnameForShell = (value: string) => {
	const normalized = value.replace(/\/+$/, '')
	const lastSlash = normalized.lastIndexOf('/')
	if (lastSlash < 0) return '.'
	if (lastSlash === 0) return '/'
	return normalized.slice(0, lastSlash)
}

const extractTestFailureSnippets = (output: string, maxItems: number) => {
	const lines = output.split(/\r?\n/)
	const interesting = /(fail|failed|failure|error|exception|assert|expected|received|actual|panic|traceback|ts\d{4}|eslint|jest|vitest|mocha|pytest|cargo test)/i
	const snippets: string[] = []
	const seen = new Set<string>()
	for (let i = 0; i < lines.length; i++) {
		if (!interesting.test(lines[i])) continue
		const start = Math.max(0, i - 3)
		const end = Math.min(lines.length, i + 8)
		const snippet = lines.slice(start, end).join('\n').trim()
		if (!snippet || seen.has(snippet)) continue
		seen.add(snippet)
		snippets.push(snippet)
		if (snippets.length >= maxItems) break
	}
	return snippets
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;
	private readonly reviewSnapshotManager = new ReviewSnapshotManager();
	private readonly worktreeManager = new WorktreeManager();

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IBrowserAgentBridge private readonly agentBridge: IBrowserAgentBridge,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);
		const waitForMarkerSettle = async (uri: URI, { timeoutMs = 1000, settleMs = 100 } = {}) => {
			await new Promise<void>(resolve => {
				let isDone = false
				let settleTimeout: any
				let timeoutHandle: any
				const disposable = this.markerService.onMarkerChanged(changedResources => {
					if (!changedResources.some(resource => resource.toString() === uri.toString())) return
					clearTimeout(settleTimeout)
					settleTimeout = setTimeout(finish, settleMs)
				})
				const finish = () => {
					if (isDone) return
					isDone = true
					clearTimeout(settleTimeout)
					clearTimeout(timeoutHandle)
					disposable.dispose()
					resolve()
				}
				timeoutHandle = setTimeout(finish, timeoutMs)
			})
		}

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) throw new Error('start_line must be a 1-based line number greater than or equal to 1.')
				if (endLine !== null && endLine < 1) throw new Error('end_line must be a 1-based line number greater than or equal to 1.')
				if (startLine !== null && endLine !== null && startLine > endLine) throw new Error('start_line must be less than or equal to end_line.')

				return { uri, startLine, endLine, pageNumber }
			},
			read_image: (params: RawToolParamsObj) => {
				const { uri: uriStr } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_symbol: (params: RawToolParamsObj) => {
				const { symbol: symbolUnknown, search_in_folder: searchInFolderUnknown, page_number: pageNumberUnknown } = params
				const symbol = validateStr('symbol', symbolUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { symbol, searchInFolder, pageNumber }
			},

			find_references: (params: RawToolParamsObj) => {
				const { symbol: symbolUnknown, search_in_folder: searchInFolderUnknown, page_number: pageNumberUnknown } = params
				const symbol = validateStr('symbol', symbolUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { symbol, searchInFolder, pageNumber }
			},

			go_to_definition: (params: RawToolParamsObj) => {
				const { symbol: symbolUnknown, search_in_folder: searchInFolderUnknown, page_number: pageNumberUnknown } = params
				const symbol = validateStr('symbol', symbolUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { symbol, searchInFolder, pageNumber }
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			git_status: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				return { cwd }
			},

			git_diff: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, staged: stagedUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const staged = validateBoolean(stagedUnknown, { default: false })
				return { cwd, staged }
			},

			git_apply_patch: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, patch: patchUnknown, check_only: checkOnlyUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const patch = validateStr('patch', patchUnknown)
				const checkOnly = validateBoolean(checkOnlyUnknown, { default: false })
				return { cwd, patch, checkOnly }
			},

			git_create_branch: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, branch_name: branchNameUnknown, base_ref: baseRefUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const branchName = sanitizeGitRefSegment(validateStr('branch_name', branchNameUnknown))
				const baseRef = validateOptionalStr('base_ref', baseRefUnknown)
				return { cwd, branchName, baseRef }
			},

			git_commit: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, message: messageUnknown, all: allUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const message = validateStr('message', messageUnknown)
				const all = validateBoolean(allUnknown, { default: false })
				return { cwd, message, all }
			},

			git_worktree_create: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, path: pathUnknown, branch_name: branchNameUnknown, base_ref: baseRefUnknown } = params
				const id = generateUuid().slice(0, 8)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const path = validateOptionalStr('path', pathUnknown) ?? `.void/worktrees/${id}`
				const rawBranchName = validateOptionalStr('branch_name', branchNameUnknown)
				const branchName = rawBranchName ? sanitizeGitRefSegment(rawBranchName) : `void/${id}`
				const baseRef = validateOptionalStr('base_ref', baseRefUnknown)
				return { cwd, path, branchName, baseRef }
			},

			git_worktree_delete: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, path: pathUnknown, prune: pruneUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const path = validateStr('path', pathUnknown)
				const prune = validateBoolean(pruneUnknown, { default: true })
				return { cwd, path, prune }
			},

			package_script_list: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				return { cwd }
			},

			review_snapshot: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, goal: goalUnknown, include_diff: includeDiffUnknown } = params
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const goal = validateOptionalStr('goal', goalUnknown) ?? 'Review the current workspace changes for risk.'
				const includeDiff = validateBoolean(includeDiffUnknown, { default: true })
				return { cwd, goal, includeDiff }
			},

			read_test_failures: (params: RawToolParamsObj) => {
				const { output: outputUnknown, max_items: maxItemsUnknown } = params
				const output = validateStr('output', outputUnknown)
				const maxItems = Math.max(1, Math.min(20, validateNumber(maxItemsUnknown, { default: 8 }) ?? 8))
				return { output, maxItems }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentSnakeCase, newContent: newContentCamelCase } = params
				const newContentUnknown = newContentSnakeCase ?? newContentCamelCase
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksSnakeCase, searchReplaceBlocks: searchReplaceBlocksCamelCase } = params
				const searchReplaceBlocksUnknown = searchReplaceBlocksSnakeCase ?? searchReplaceBlocksCamelCase
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = normalizeSearchReplaceBlocks(validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown))
				const blocks = extractSearchReplaceBlocks(searchReplaceBlocks)
				if (blocks.length === 0) {
					throw new Error(`Invalid LLM output format: searchReplaceBlocks must contain at least one valid SEARCH/REPLACE block.`)
				}
				if (blocks.some(block => block.state !== 'done' || block.orig.length === 0)) {
					throw new Error(`Invalid LLM output format: every SEARCH/REPLACE block must be complete and contain a non-empty ORIGINAL section. Re-read the target range and retry edit_file with a smaller exact block.`)
				}
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_tests: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			install_dependencies: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				const startLineNumber = startLine === null ? 1 : startLine
				const endLineNumber = endLine === null ? model.getLineCount() : endLine
				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const pages = paginateContiguousSource(contents, startLineNumber, MAX_READ_FILE_CONTEXT_CHARS_PAGE)
				const page = pages[pageNumber - 1]
				const fileContents = page?.content ?? ''
				const hasNextPage = pageNumber < pages.length
				const totalFileLen = contents.length
				return {
					result: {
						fileContents,
						totalFileLen,
						hasNextPage,
						totalNumLines,
						pageStartLine: page?.startLine ?? startLineNumber,
						pageEndLine: page?.endLine ?? startLineNumber,
						startsMidLine: page?.startsMidLine ?? false,
						endsMidLine: page?.endsMidLine ?? false,
					}
				}
			},
			read_image: async ({ uri }) => {
				const mimeType = imageMimeTypeOfPath(uri.fsPath)
				if (!mimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
					throw new Error(`Unsupported image type. Supported types: PNG, JPEG, WebP, GIF.`)
				}

				const contents = await fileService.readFile(uri)
				if (contents.value.byteLength > MAX_TOOL_IMAGE_BYTES) {
					throw new Error(`Image is larger than 5MB. Please use a smaller image.`)
				}

				const dataUrl = `data:${mimeType};base64,${bytesToBase64(contents.value.buffer)}`
				const attachment: ImageAttachment = {
					type: 'image',
					id: generateUuid(),
					name: basenameOfPath(uri.fsPath),
					mimeType,
					sizeBytes: contents.value.byteLength,
					dataUrl,
				}

				return { result: { attachment } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const cts = new CancellationTokenSource()
				const result = searchService.fileSearch(query, cts.token).then(data => {
					const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
					const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
					const uris = data.results
						.slice(fromIdx, toIdx + 1) // paginate
						.map(({ resource, results }) => resource)

					const hasNextPage = (data.results.length - 1) - toIdx >= 1
					return { uris, hasNextPage }
				})

				return { result, interruptTool: () => cts.cancel() }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const cts = new CancellationTokenSource()
				const result = searchService.textSearch(query, cts.token).then(data => {
					const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
					const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
					const uris = data.results
						.slice(fromIdx, toIdx + 1) // paginate
						.map(({ resource, results }) => resource)

					const hasNextPage = (data.results.length - 1) - toIdx >= 1
					return { queryStr, uris, hasNextPage }
				})

				return { result, interruptTool: () => cts.cancel() }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_symbol: async ({ symbol, searchInFolder, pageNumber }) => {
				const terminalId = generateUuid()
				const from = (pageNumber - 1) * 100 + 1
				const to = pageNumber * 100
				const target = searchInFolder?.fsPath ?? '.'
				const pattern = `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
				const command = `rg --line-number --column --context 2 ${shellQuote(pattern)} ${shellQuote(target)} | sed -n ${shellQuote(`${from},${to}p`)}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd: null, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			find_references: async ({ symbol, searchInFolder, pageNumber }) => {
				const terminalId = generateUuid()
				const from = (pageNumber - 1) * 100 + 1
				const to = pageNumber * 100
				const target = searchInFolder?.fsPath ?? '.'
				const pattern = `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
				const command = `rg --line-number --column ${shellQuote(pattern)} ${shellQuote(target)} | sed -n ${shellQuote(`${from},${to}p`)}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd: null, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			go_to_definition: async ({ symbol, searchInFolder, pageNumber }) => {
				const terminalId = generateUuid()
				const from = (pageNumber - 1) * 100 + 1
				const to = pageNumber * 100
				const target = searchInFolder?.fsPath ?? '.'
				const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
				const pattern = `(class|function|interface|type|enum|const|let|var|def|struct|trait)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(async\\s*)?(function|class|\\()`
				const command = `rg --line-number --column ${shellQuote(pattern)} ${shellQuote(target)} | sed -n ${shellQuote(`${from},${to}p`)}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd: null, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			read_lint_errors: async ({ uri }) => {
				await waitForMarkerSettle(uri)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			git_status: async ({ cwd }) => {
				const terminalId = generateUuid()
				const command = 'git branch --show-current && git status --short --branch'
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			git_diff: async ({ cwd, staged }) => {
				const terminalId = generateUuid()
				const command = staged ? 'git diff --staged --no-ext-diff --' : 'git diff --no-ext-diff --'
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			git_apply_patch: async ({ cwd, patch, checkOnly }) => {
				const terminalId = generateUuid()
				const command = `printf %s ${shellQuote(patch)} | git apply ${checkOnly ? '--check ' : ''}--whitespace=nowarn -`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			git_create_branch: async ({ cwd, branchName, baseRef }) => {
				const terminalId = generateUuid()
				const command = `git checkout -b ${shellQuote(branchName)}${baseRef ? ` ${shellQuote(baseRef)}` : ''}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			git_commit: async ({ cwd, message, all }) => {
				const terminalId = generateUuid()
				const command = `git commit ${all ? '-am' : '-m'} ${shellQuote(message)}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			git_worktree_create: async ({ cwd, path, branchName, baseRef }) => {
				const id = branchName.startsWith('void/') ? branchName.slice('void/'.length) : generateUuid().slice(0, 8)
				this.worktreeManager.track({
					id,
					uri: URI.file(path),
					branchName,
					createdAt: Date.now(),
					status: 'creating',
				})
				const terminalId = generateUuid()
				const command = `mkdir -p ${shellQuote(dirnameForShell(path))} && git worktree add -b ${shellQuote(branchName)} ${shellQuote(path)}${baseRef ? ` ${shellQuote(baseRef)}` : ''}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				const result = resPromise.then(result => {
					this.worktreeManager.update(id, { status: result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0 ? 'ready' : 'failed', error: result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0 ? undefined : result.result })
					const status = result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0 ? 'ready' as const : 'failed' as const
					return { id, path, branchName, status, ...result }
				})
				return { result, interruptTool: interrupt }
			},

			git_worktree_delete: async ({ cwd, path, prune }) => {
				const terminalId = generateUuid()
				const command = `git worktree remove ${shellQuote(path)}${prune ? ` && git worktree prune` : ''}`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				const result = resPromise.then(result => {
					const status = result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0 ? 'deleted' as const : 'failed' as const
					const tracked = this.worktreeManager.findByPath(path)
					if (tracked) this.worktreeManager.update(tracked.id, { status, error: status === 'failed' ? result.result : undefined })
					return { path, status, ...result }
				})
				return { result, interruptTool: interrupt }
			},

			package_script_list: async ({ cwd }) => {
				const terminalId = generateUuid()
				const command = `node -e "const fs=require('fs');const p='package.json';if(!fs.existsSync(p)){console.log('No package.json found in cwd.');process.exit(0)}const pkg=JSON.parse(fs.readFileSync(p,'utf8'));const scripts=pkg.scripts||{};for(const [k,v] of Object.entries(scripts)) console.log(k+': '+v)"`
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},

			review_snapshot: async ({ cwd, goal, includeDiff }) => {
				const id = generateUuid().slice(0, 8)
				this.reviewSnapshotManager.track({
					id,
					goal,
					status: 'running',
				})
				const terminalId = generateUuid()
				const command = [
					`printf ${shellQuote(`Review goal: ${goal}\n\n`)}`,
					`printf ${shellQuote('--- git status ---\n')}`,
					`git status --short --branch`,
					`printf ${shellQuote('\n--- diff stat ---\n')}`,
					`git diff --stat --`,
					`printf ${shellQuote('\n--- whitespace check ---\n')}`,
					`git diff --check --`,
					...(includeDiff ? [
						`printf ${shellQuote('\n--- diff ---\n')}`,
						`git diff --no-ext-diff --`,
					] : []),
				].join('; ')
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				const result = resPromise.then(result => {
					const ok = result.resolveReason.type === 'done' && result.resolveReason.exitCode === 0
					this.reviewSnapshotManager.update(id, {
						status: ok ? 'complete' : 'failed',
						summary: result.result.slice(0, 4000),
					})
					return { id, goal, ...result }
				})
				return { result, interruptTool: interrupt }
			},

			read_test_failures: async ({ output, maxItems }) => {
				const failures = extractTestFailureSnippets(output, maxItems)
				return { result: { failures } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors (only if user wants them, otherwise skip the 1s delay)
				const includeLintErrors = this.voidSettingsService.state.globalSettings.includeToolLintErrors
				const lintErrorsPromise = includeLintErrors ? Promise.resolve().then(async () => {
					await waitForMarkerSettle(uri)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				}) : Promise.resolve({ lintErrors: null })
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors (only if user wants them, otherwise skip the 1s delay)
				const includeLintErrors = this.voidSettingsService.state.globalSettings.includeToolLintErrors
				const lintErrorsPromise = includeLintErrors ? Promise.resolve().then(async () => {
					await waitForMarkerSettle(uri)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				}) : Promise.resolve({ lintErrors: null })

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_tests: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			install_dependencies: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}

		const originalCallTool = { ...this.callTool } as CallBuiltinTool
		for (const toolName of Object.keys(originalCallTool) as BuiltinToolName[]) {
			this.callTool[toolName] = (async (params: any) => {
				const currentToolContext = this.agentBridge.getCurrentToolContext()
				const invocation = currentToolContext?.toolInvocation ?? createLegacyToolInvocation(toolName, params)
				const ctx = this.agentBridge.recordToolStarted(invocation, currentToolContext)
				try {
					const runningTool = await originalCallTool[toolName](params)
					const result = Promise.resolve(runningTool.result).then(
						toolResult => {
							this.agentBridge.recordToolFinished(invocation.callId, {
								ok: true,
								data: toolResult,
								artifacts: toolName === 'git_worktree_create' && (toolResult as any).path
									? [{
										kind: 'patch' as const,
										title: `Candidate patch ${(toolResult as any).branchName}`,
										uri: (toolResult as any).path,
										data: toolResult,
									}]
									: undefined,
							}, ctx)
							return toolResult
						},
						error => {
							const message = error instanceof Error ? error.message : String(error)
							this.agentBridge.recordToolFailed(invocation.callId, message, ctx)
							throw error
						},
					)
					return { result: result as any, interruptTool: runningTool.interruptTool }
				}
				catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					this.agentBridge.recordToolFailed(invocation.callId, message, ctx)
					throw error
				}
			}) as any
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''
		const verificationReminder = `\nNext step: verify this change before concluding. Prefer read_lint_errors for a quick check, then inspect the affected file or run a targeted command if needed.`

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		const stringifyTemporaryTerminalResult = (result: BuiltinToolResultType['run_command']) => {
			const { resolveReason, result: result_, } = result
			if (resolveReason.type === 'done') {
				return `${result_}\n(exit code ${resolveReason.exitCode})`
			}
			if (resolveReason.type === 'idle_timeout') {
				return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. If this command may stay quiet before producing output, open a persistent terminal and run the command there instead.`
			}
			if (resolveReason.type === 'total_timeout') {
				return `${result_}\nTerminal command ran for ${MAX_TERMINAL_TOTAL_TIME}s and did not finish successfully in the temporary terminal. For longer-running commands, open a persistent terminal and run the command there.`
			}
			if (resolveReason.type === 'aborted') {
				return `${result_}\nCommand was aborted before completion.`
			}
			throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				const partialLineNote = result.startsMidLine || result.endsMidLine
					? `\nThis page ${result.startsMidLine ? 'starts' : 'ends'} in the middle of an unusually long line.`
					: ''
				const continuation = result.hasNextPage
					? `\n\nMore contiguous content remains in the requested range. Before advancing to another line range, call read_file again with the same uri/start_line/end_line and page_number=${params.pageNumber + 1}.`
					: ''
				return `${params.uri.fsPath}\nReturned contiguous lines ${result.pageStartLine}-${result.pageEndLine} (page ${params.pageNumber}).${partialLineNote}\n\`\`\`\n${result.fileContents}\n\`\`\`${continuation}\nFile info: the file has ${result.totalNumLines} lines; the requested range has ${result.totalFileLen} characters.`
			},
			read_image: (params, result) => {
				return `${params.uri.fsPath}\n[Image: ${result.attachment.name}, ${result.attachment.mimeType}, ${result.attachment.sizeBytes} bytes]`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_symbol: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			find_references: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			go_to_definition: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			git_status: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			git_diff: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			git_apply_patch: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			git_create_branch: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			git_commit: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			git_worktree_create: (_params, result) => {
				return `Created candidate worktree ${result.id}\nPath: ${result.path}\nBranch: ${result.branchName}\n${stringifyTemporaryTerminalResult(result)}`
			},
			git_worktree_delete: (_params, result) => {
				return `Removed candidate worktree\nPath: ${result.path}\n${stringifyTemporaryTerminalResult(result)}`
			},
			package_script_list: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},
			review_snapshot: (_params, result) => {
				return `Read-only review snapshot ${result.id}\nGoal: ${result.goal}\n${stringifyTemporaryTerminalResult(result)}`
			},
			read_test_failures: (_params, result) => {
				if (result.failures.length === 0) return 'No obvious test failures found in the provided output.'
				return result.failures.map((failure, index) => `Failure ${index + 1}:\n${failure}`).join('\n\n')
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.${verificationReminder}`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.${verificationReminder}`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${verificationReminder}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${verificationReminder}`
			},
			run_command: (params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},

			run_tests: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},

			install_dependencies: (_params, result) => {
				return stringifyTemporaryTerminalResult(result)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'total_timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
