/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService, MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT_ERROR } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, ImageAttachment, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { dirname } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { IBrowserAgentBridge, createLegacyToolInvocation } from './agent/BrowserAgentBridge.js';
import { AgentRun } from '../common/agent/runtime/AgentRun.js';
import { ToolContext } from '../common/agent/tools/ToolDefinition.js';
import { IAgentExtensionService } from './agent/AgentExtensionService.js';
import { PermissionDecision } from '../common/agent/permissions/PermissionDecision.js';
import { ExecutionPlan, ExecutionPlanStep, ExecutionPlanStepStatus } from '../common/agent/execution/ExecutionPlan.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500
const LLM_STREAM_STATE_THROTTLE_MS = 200
const MAX_AGENT_PLAN_AUTO_CONTINUATIONS = 20

const AGENT_PLAN_STEP_IDS = {
	recon: 'recon',
	plan: 'plan',
	execute: 'execute',
	verify: 'verify',
} as const

const IMAGE_INPUT_REJECTED_BY_PROVIDER_ERROR = 'The current model endpoint rejected image input. I stopped sending images from this thread to the model so the conversation can continue. Switch to a vision-capable endpoint, or set supportsVision to false for this model.'
const IMAGE_INPUT_DISABLED_REASON = 'current model endpoint rejected image input'
const IMAGE_INPUT_UNSUPPORTED_BY_MODEL_REASON = 'selected model does not support image input'

const isImageInputRejectedByProviderError = (message: string | undefined): boolean => {
	if (!message) return false
	const lower = message.toLowerCase()
	return lower.includes('image_url')
		|| lower.includes('unknown variant `image`')
		|| lower.includes('unknown variant image')
		|| lower.includes('unsupported image')
		|| lower.includes('image input is not supported')
}

const parallelReadonlyBuiltinTools = new Set<string>([
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
])

const parallelWriteBuiltinTools = new Set<string>([
	'rewrite_file',
	'edit_file',
	'create_file_or_folder',
])


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}
type AgentExecutionPlanState = {
	plan: ExecutionPlan;
	startedStepIds: Set<string>;
	completedStepIds: Set<string>;
	blockedStepIds: Set<string>;
	currentStepId: string | null;
	autoContinuations: number;
}
type ToolRunResult = { awaitingUserApproval?: boolean, interrupted?: boolean, successfulToolName?: string }
type EarlyReadonlyToolRun = {
	toolCall: RawToolCallObj;
	promise: Promise<ChatMessage & { role: 'tool' }>;
	interruptTool?: () => void;
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		startedAt?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		startedAt?: number;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
			toolCallsSoFar: RawToolCallObj[] | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		startedAt?: number;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'compressing';
		error?: undefined;
		startedAt?: number;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		startedAt?: number;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		startedAt?: number;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId, attachments }: { userMessage: string, threadId: string, attachments?: ImageAttachment[] }): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not
	private readonly _agentPlanStateByRunId = new Map<string, AgentExecutionPlanState>()

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IBrowserAgentBridge private readonly _agentBridge: IBrowserAgentBridge,
		@IAgentExtensionService private readonly _agentExtensionService: IAgentExtensionService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}

		// always be in a thread
		this.openNewThread()


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private readonly _flushStoreScheduler = this._register(new RunOnceScheduler(() => {
		if (!this._latestThreads) return;
		this._writeThreadsSync(this._latestThreads);
		this._latestThreads = null;
	}, 500));

	private _latestThreads: ChatThreads | null = null;
	private _compressionAborted = false;

	private readonly _pendingLLMStreamState = new Map<string, {
		llmInfo: NonNullable<Extract<ThreadStreamState[string], { isRunning: 'LLM' }>['llmInfo']>;
		interrupt: Promise<() => void>;
	}>();
	private readonly _llmStreamStateSchedulers = new Map<string, RunOnceScheduler>();

	private _writeThreadsSync(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
	}

	private _storeAllThreads(threads: ChatThreads) {
		this._latestThreads = threads;
		this._flushStoreScheduler.schedule();
	}

	private _storeAllThreadsImmediate(threads: ChatThreads) {
		this._writeThreadsSync(threads);
	}

	private _createMountedInfo(threadId: string): NonNullable<ThreadType['state']['mountedInfo']> {
		let whenMountedResolver: (w: WhenMounted) => void = () => { }
		const whenMountedPromise = new Promise<WhenMounted>((res) => { whenMountedResolver = res })

		return {
			whenMounted: whenMountedPromise,
			mountedIsResolvedRef: { current: false },
			_whenMountedResolver: (w: WhenMounted) => {
				whenMountedResolver(w)
				const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
				if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
			},
		}
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		let newState = {
			...this.state,
			...state
		}

		if (!doNotRefreshMountInfo) {
			const threadId = newState.currentThreadId
			const thread = newState.allThreads[threadId]
			const needsMountedInfo = !!thread && (
				threadId !== this.state.currentThreadId ||
				!thread.state.mountedInfo
			)

			if (needsMountedInfo) {
				newState = {
					...newState,
					allThreads: {
						...newState.allThreads,
						[thread.id]: {
							...thread,
							state: {
								...thread.state,
								mountedInfo: this._createMountedInfo(threadId),
							}
						}
					}
				}
			}
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}
	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		if (state?.isRunning !== 'LLM') {
			this._pendingLLMStreamState.delete(threadId)
			this._llmStreamStateSchedulers.get(threadId)?.cancel()
		}
		if (state?.isRunning) {
			state = {
				...state,
				startedAt: this.streamState[threadId]?.startedAt ?? Date.now(),
			} as ThreadStreamState[string]
		}
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}

	private _getOrCreateLLMStreamScheduler(threadId: string) {
		let scheduler = this._llmStreamStateSchedulers.get(threadId)
		if (!scheduler) {
			scheduler = this._register(new RunOnceScheduler(() => {
				this._flushPendingLLMStreamState(threadId)
			}, LLM_STREAM_STATE_THROTTLE_MS))
			this._llmStreamStateSchedulers.set(threadId, scheduler)
		}
		return scheduler
	}

	private _scheduleLLMStreamState(threadId: string, llmInfo: NonNullable<Extract<ThreadStreamState[string], { isRunning: 'LLM' }>['llmInfo']>, interrupt: Promise<() => void>) {
		this._pendingLLMStreamState.set(threadId, { llmInfo, interrupt })
		const scheduler = this._getOrCreateLLMStreamScheduler(threadId)
		if (!scheduler.isScheduled()) scheduler.schedule()
	}

	private _flushPendingLLMStreamState(threadId: string) {
		const pendingState = this._pendingLLMStreamState.get(threadId)
		if (!pendingState) return
		this._pendingLLMStreamState.delete(threadId)
		this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: pendingState.llmInfo, interrupt: pendingState.interrupt })
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const existingToolIdx = messages.findIndex(m => m.role === 'tool' && m.id === tool.id && m.type !== 'invalid_params')
		if (existingToolIdx !== -1) {
			this._editMessageInThread(threadId, existingToolIdx, tool)
			return true
		}
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			this._flushPendingLLMStreamState(threadId)
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId]?.llmInfo ?? { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null, toolCallsSoFar: null }
			this._addMessageToThread(threadId, { role: 'aborted_assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}
		else if (this.streamState[threadId]?.isRunning === 'compressing') {
			// Compression is non-interruptible at the LLM level, but we need to
			// abort as soon as the compressed message exchange completes.
			// Set a flag so _runChatAgent can detect this.
			this._compressionAborted = true
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}

	private readonly _toolWriteLocks = new Map<string, Promise<void>>()
	private _exclusiveToolWriteLock: Promise<void> = Promise.resolve()
	private readonly _agentRunOfThreadId = new Map<string, AgentRun>()
	private readonly _pendingAgentToolInvocationOfChatToolId = new Map<string, { invocation: ReturnType<typeof createLegacyToolInvocation>; ctx: ToolContext }>()
	private readonly _rememberedPermissionApprovalKeysByThreadId = new Map<string, Set<string>>()


	private _canRunInReadonlyBatch(toolName: ToolName) {
		return isABuiltinToolName(toolName) && parallelReadonlyBuiltinTools.has(toolName)
	}

	private _canRunInWriteBatch(toolName: ToolName) {
		return isABuiltinToolName(toolName) && parallelWriteBuiltinTools.has(toolName)
	}

	private _writeLockKeysForToolCall(toolName: ToolName, toolParams: ToolCallParams<ToolName>): { type: 'keyed', keys: string[] } | { type: 'exclusive' } | null {
		if (!isABuiltinToolName(toolName)) return null
		if (toolName === 'delete_file_or_folder' || toolName === 'git_apply_patch') return { type: 'exclusive' }
		if (toolName === 'edit_file' || toolName === 'rewrite_file') {
			const { uri } = toolParams as BuiltinToolCallParams['edit_file'] | BuiltinToolCallParams['rewrite_file']
			return { type: 'keyed', keys: [`file:${uri.toString()}`] }
		}
		if (toolName === 'create_file_or_folder') {
			const { uri } = toolParams as BuiltinToolCallParams['create_file_or_folder']
			return { type: 'keyed', keys: [`dir:${dirname(uri).toString()}`] }
		}
		return null
	}

	private async _withToolWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
		await this._exclusiveToolWriteLock

		const sortedKeys = [...new Set(keys)].sort()
		const acquire = async (idx: number): Promise<T> => {
			if (idx >= sortedKeys.length) return fn()

			const key = sortedKeys[idx]
			const previous = this._toolWriteLocks.get(key) ?? Promise.resolve()
			let release: () => void = () => { }
			const current = previous.then(() => new Promise<void>(res => { release = res }))
			this._toolWriteLocks.set(key, current)

			await previous
			try {
				return await acquire(idx + 1)
			}
			finally {
				release()
				if (this._toolWriteLocks.get(key) === current) {
					this._toolWriteLocks.delete(key)
				}
			}
		}

		return acquire(0)
	}

	private async _withExclusiveToolWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const previousExclusive = this._exclusiveToolWriteLock
		let releaseExclusive: () => void = () => { }
		const currentExclusive = previousExclusive.then(() => new Promise<void>(res => { releaseExclusive = res }))
		this._exclusiveToolWriteLock = currentExclusive

		await previousExclusive
		await Promise.all([...this._toolWriteLocks.values()])

		try {
			return await fn()
		}
		finally {
			releaseExclusive()
			if (this._exclusiveToolWriteLock === currentExclusive) {
				this._exclusiveToolWriteLock = Promise.resolve()
			}
		}
	}

	private async _withToolExecutionLock<T>(toolName: ToolName, toolParams: ToolCallParams<ToolName>, fn: () => Promise<T>): Promise<T> {
		const lockMode = this._writeLockKeysForToolCall(toolName, toolParams)
		if (!lockMode) return fn()
		if (lockMode.type === 'exclusive') return this._withExclusiveToolWriteLock(fn)
		return this._withToolWriteLocks(lockMode.keys, fn)
	}

	private _currentOrStartAgentRun(threadId: string): AgentRun {
		const existingRun = this._agentRunOfThreadId.get(threadId)
		if (existingRun) return existingRun

		const messages = this.state.allThreads[threadId]?.messages ?? []
		const lastUserMessage = findLast(messages, message => message.role === 'user')
		const goal = lastUserMessage?.role === 'user'
			? (lastUserMessage.displayContent || lastUserMessage.content || 'Continue agent run')
			: 'Continue agent run'
		const run = this._agentBridge.runtime.startRun({ sessionId: threadId, goal })
		this._agentRunOfThreadId.set(threadId, run)
		return run
	}

	private _agentToolContext(threadId: string): ToolContext {
		const run = this._currentOrStartAgentRun(threadId)
		return { sessionId: threadId, runId: run.runId }
	}

	private _finishAgentRun(threadId: string, summary: string): void {
		const run = this._agentRunOfThreadId.get(threadId)
		if (!run) return
		this._agentBridge.runtime.finishRun(threadId, run.runId, summary)
		this._agentRunOfThreadId.delete(threadId)
		this._agentPlanStateByRunId.delete(run.runId)
	}

	private _failAgentRun(threadId: string, error: string): void {
		const run = this._agentRunOfThreadId.get(threadId)
		if (!run) return
		this._agentBridge.runtime.failRun(threadId, run.runId, error)
		this._agentRunOfThreadId.delete(threadId)
		this._agentPlanStateByRunId.delete(run.runId)
		this._runAgentHookSafely({ event: 'on_run_failed', metadata: { threadId, error } })
	}

	private async _runAgentHookSafely(context: Parameters<IAgentExtensionService['runHook']>[0]): Promise<void> {
		try {
			await this._agentExtensionService.runHook(context)
		}
		catch {
			// Hooks are user automation; failures should not corrupt the agent control flow.
		}
	}

	private _createAgentExecutionPlan(goal: string): ExecutionPlan {
		return {
			id: generateUuid(),
			goal,
			steps: [
				{
					id: AGENT_PLAN_STEP_IDS.recon,
					title: 'Recon',
					description: 'Inspect the relevant workspace context, current files, manifests, skills, tests, and constraints needed for the task.',
					status: 'pending',
				},
				{
					id: AGENT_PLAN_STEP_IDS.plan,
					title: 'Plan',
					description: 'Choose the smallest correct approach before taking action. Follow workspace instructions and active skills.',
					status: 'pending',
					dependsOn: [AGENT_PLAN_STEP_IDS.recon],
				},
				{
					id: AGENT_PLAN_STEP_IDS.execute,
					title: 'Execute',
					description: 'Apply the change or produce the requested work with tools when files, commands, or repository state are involved.',
					status: 'pending',
					dependsOn: [AGENT_PLAN_STEP_IDS.plan],
				},
				{
					id: AGENT_PLAN_STEP_IDS.verify,
					title: 'Verify',
					description: 'Validate the result with the smallest useful checks, then summarize what changed and what remains unverified.',
					status: 'pending',
					dependsOn: [AGENT_PLAN_STEP_IDS.execute],
				},
			],
		}
	}

	private _ensureAgentPlanState(threadId: string): AgentExecutionPlanState {
		const run = this._currentOrStartAgentRun(threadId)
		const existing = this._agentPlanStateByRunId.get(run.runId)
		if (existing) return existing

		const plan = this._createAgentExecutionPlan(run.goal)
		const state: AgentExecutionPlanState = {
			plan,
			startedStepIds: new Set<string>(),
			completedStepIds: new Set<string>(),
			blockedStepIds: new Set<string>(),
			currentStepId: plan.steps[0]?.id ?? null,
			autoContinuations: 0,
		}
		this._agentPlanStateByRunId.set(run.runId, state)
		this._agentBridge.emit({ type: 'plan.created', sessionId: threadId, runId: run.runId, plan, createdAt: Date.now() })
		this._startCurrentAgentPlanStep(threadId, state)
		return state
	}

	private _getAgentPlanState(threadId: string): AgentExecutionPlanState | undefined {
		const run = this._agentRunOfThreadId.get(threadId)
		if (!run) return undefined
		return this._agentPlanStateByRunId.get(run.runId)
	}

	private _currentAgentPlanStep(state: AgentExecutionPlanState): ExecutionPlanStep | undefined {
		return state.plan.steps.find(step => step.id === state.currentStepId)
	}

	private _isAgentPlanComplete(state: AgentExecutionPlanState): boolean {
		return state.plan.steps.every(step => state.completedStepIds.has(step.id))
	}

	private _updateAgentPlanStepStatus(state: AgentExecutionPlanState, stepId: string, status: ExecutionPlanStepStatus): ExecutionPlanStep | undefined {
		let updatedStep: ExecutionPlanStep | undefined
		state.plan = {
			...state.plan,
			steps: state.plan.steps.map(step => {
				if (step.id !== stepId) return step
				updatedStep = { ...step, status }
				return updatedStep
			}),
		}
		return updatedStep
	}

	private _startCurrentAgentPlanStep(threadId: string, state: AgentExecutionPlanState): void {
		const run = this._currentOrStartAgentRun(threadId)
		const step = this._currentAgentPlanStep(state)
		if (!step || state.startedStepIds.has(step.id) || state.completedStepIds.has(step.id) || state.blockedStepIds.has(step.id)) return
		const startedStep = this._updateAgentPlanStepStatus(state, step.id, 'running') ?? step
		state.startedStepIds.add(step.id)
		this._agentBridge.emit({ type: 'plan.step.started', sessionId: threadId, runId: run.runId, step: startedStep, startedAt: Date.now() })
	}

	private _completeAgentPlanStep(threadId: string, state: AgentExecutionPlanState, stepId: string): void {
		if (state.completedStepIds.has(stepId)) return
		const run = this._currentOrStartAgentRun(threadId)
		const step = this._updateAgentPlanStepStatus(state, stepId, 'complete')
		if (!step) return
		state.completedStepIds.add(stepId)
		this._agentBridge.emit({ type: 'plan.step.completed', sessionId: threadId, runId: run.runId, step, completedAt: Date.now() })
		if (state.currentStepId === stepId) {
			const nextStep = state.plan.steps.find(candidate => !state.completedStepIds.has(candidate.id) && !state.blockedStepIds.has(candidate.id))
			state.currentStepId = nextStep?.id ?? null
			this._startCurrentAgentPlanStep(threadId, state)
		}
	}

	private _blockCurrentAgentPlanStep(threadId: string, state: AgentExecutionPlanState, reason: string): void {
		const step = this._currentAgentPlanStep(state)
		if (!step || state.blockedStepIds.has(step.id)) return
		const run = this._currentOrStartAgentRun(threadId)
		const blockedStep = this._updateAgentPlanStepStatus(state, step.id, 'blocked') ?? step
		state.blockedStepIds.add(step.id)
		this._agentBridge.emit({ type: 'plan.step.blocked', sessionId: threadId, runId: run.runId, step: blockedStep, reason, blockedAt: Date.now() })
	}

	private _completeAgentPlanThrough(threadId: string, state: AgentExecutionPlanState, stepId: string): void {
		for (const step of state.plan.steps) {
			this._completeAgentPlanStep(threadId, state, step.id)
			if (step.id === stepId) break
		}
	}

	private _isWriteToolName(toolName: string): boolean {
		return parallelWriteBuiltinTools.has(toolName)
			|| toolName === 'delete_file_or_folder'
			|| toolName === 'git_apply_patch'
			|| toolName === 'git_commit'
	}

	private _isVerificationToolName(toolName: string): boolean {
		return toolName === 'run_tests'
			|| toolName === 'read_lint_errors'
			|| toolName === 'read_test_failures'
			|| toolName === 'git_diff'
			|| toolName === 'review_snapshot'
	}

	private _advanceAgentPlanAfterTools(threadId: string, successfulToolNames: readonly string[]): void {
		if (!successfulToolNames.length) return
		const state = this._getAgentPlanState(threadId)
		if (!state || this._isAgentPlanComplete(state)) return
		state.autoContinuations = 0
		this._completeAgentPlanThrough(threadId, state, AGENT_PLAN_STEP_IDS.recon)
		if (successfulToolNames.some(toolName => this._isWriteToolName(toolName))) {
			this._completeAgentPlanThrough(threadId, state, AGENT_PLAN_STEP_IDS.execute)
		}
		if (successfulToolNames.some(toolName => this._isVerificationToolName(toolName))) {
			this._completeAgentPlanThrough(threadId, state, AGENT_PLAN_STEP_IDS.verify)
		}
	}

	private _assistantTextLooksBlocked(text: string): boolean {
		const normalized = text.toLowerCase()
		return /需要(你|用户|提供|确认|批准)/.test(normalized)
			|| /无法继续/.test(normalized)
			|| /\b(blocked|cannot continue|can't continue|need your|need the user|please provide|waiting for)\b/.test(normalized)
	}

	private _assistantTextLooksComplete(text: string): boolean {
		const normalized = text.toLowerCase()
		return /已完成|任务完成|完成了|验证通过/.test(normalized)
			|| /\b(done|completed|finished|verified)\b/.test(normalized)
	}

	private _addInternalAgentPlanMessage(threadId: string, state: AgentExecutionPlanState, reason: string): void {
		const step = this._currentAgentPlanStep(state)
		if (!step) return
		const planLines = state.plan.steps.map((planStep, index) => {
			const status = state.completedStepIds.has(planStep.id)
				? 'complete'
				: state.blockedStepIds.has(planStep.id)
					? 'blocked'
					: planStep.id === state.currentStepId
						? 'current'
						: planStep.status
			return `${index + 1}. [${status}] ${planStep.title}: ${planStep.description ?? ''}`
		})
		this._addUserCheckpoint({ threadId })
		this._addMessageToThread(threadId, {
			role: 'user',
			contextMeta: {
				id: generateUuid(),
				origin: 'internal-plan',
				startsRound: false,
			},
			content: [
				'[Internal agent execution directive]',
				`Reason: ${reason}`,
				`Goal: ${state.plan.goal}`,
				'Execution plan:',
				...planLines,
				`Current step: ${step.title}`,
				'Continue autonomously through this plan. Use tools when they help the current step. Do not ask whether to continue. Stop only when the plan is complete, blocked, or awaiting permission.',
			].join('\n'),
			displayContent: '',
			selections: null,
			state: defaultMessageState,
		})
	}

	private _advanceAgentPlanAfterAssistantText(threadId: string, text: string): boolean {
		const state = this._getAgentPlanState(threadId)
		if (!state || this._isAgentPlanComplete(state)) return false
		if (this._assistantTextLooksBlocked(text)) {
			this._blockCurrentAgentPlanStep(threadId, state, 'The assistant indicated it is blocked or needs user input.')
			return false
		}
		if (this._assistantTextLooksComplete(text)) {
			this._completeAgentPlanThrough(threadId, state, AGENT_PLAN_STEP_IDS.verify)
			return false
		}
		const currentStep = this._currentAgentPlanStep(state)
		if (!currentStep) return false
		this._completeAgentPlanStep(threadId, state, currentStep.id)
		if (this._isAgentPlanComplete(state)) return false
		if (state.autoContinuations >= MAX_AGENT_PLAN_AUTO_CONTINUATIONS) {
			this._blockCurrentAgentPlanStep(threadId, state, `Stopped after ${MAX_AGENT_PLAN_AUTO_CONTINUATIONS} automatic plan continuations.`)
			return false
		}
		state.autoContinuations += 1
		this._addInternalAgentPlanMessage(threadId, state, 'Advance to the next plan step.')
		return true
	}

	private _canAutoApprovePermissionDecision(decision: PermissionDecision): boolean {
		if (decision.type === 'allow') return true
		if (decision.type === 'deny') return false
		return decision.risk !== 'critical' // 仅 critical 需要手动审批
	}

	private _permissionRequestContent(decision: PermissionDecision): string {
		if (decision.type !== 'ask') return '(Awaiting user permission...)'
		const preview = decision.preview?.type === 'list'
			? `\n${decision.preview.items.map(item => `- ${item}`).join('\n')}`
			: decision.preview?.type === 'code'
				? `\n${decision.preview.value}`
				: ''
		return `${decision.reason}${preview}`
	}

	private _rememberedPermissionApprovalKeys(threadId: string): Set<string> {
		let keys = this._rememberedPermissionApprovalKeysByThreadId.get(threadId)
		if (!keys) {
			keys = new Set<string>()
			this._rememberedPermissionApprovalKeysByThreadId.set(threadId, keys)
		}
		return keys
	}

	private _rememberPermissionApproval(threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>): void {
		const key = this._permissionApprovalKey(toolName, toolParams)
		if (!key) return
		this._rememberedPermissionApprovalKeys(threadId).add(key)
	}

	private _hasRememberedPermissionApproval(threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>): boolean {
		const key = this._permissionApprovalKey(toolName, toolParams)
		if (!key) return false
		return this._rememberedPermissionApprovalKeys(threadId).has(key)
	}

	private _permissionApprovalKey(toolName: ToolName, toolParams: ToolCallParams<ToolName>): string | null {
		if (toolName === 'run_command') {
			const { command, cwd } = toolParams as BuiltinToolCallParams['run_command']
			const family = this._terminalCommandApprovalFamily(command)
			return family ? `terminal:${family}:cwd=${cwd ?? ''}` : null
		}
		if (toolName === 'run_persistent_command') {
			const { command, persistentTerminalId } = toolParams as BuiltinToolCallParams['run_persistent_command']
			const family = this._terminalCommandApprovalFamily(command)
			return family ? `persistent-terminal:${family}:terminal=${persistentTerminalId}` : null
		}
		if (toolName === 'git_commit') {
			const { cwd } = toolParams as BuiltinToolCallParams['git_commit']
			return `git:commit:cwd=${cwd ?? ''}`
		}
		if (toolName === 'git_create_branch') {
			const { cwd } = toolParams as BuiltinToolCallParams['git_create_branch']
			return `git:create-branch:cwd=${cwd ?? ''}`
		}
		if (toolName === 'git_apply_patch') {
			const { cwd, checkOnly } = toolParams as BuiltinToolCallParams['git_apply_patch']
			return `git:apply-patch:${checkOnly ? 'check' : 'apply'}:cwd=${cwd ?? ''}`
		}
		if (toolName === 'git_worktree_create') {
			const { cwd } = toolParams as BuiltinToolCallParams['git_worktree_create']
			return `git:worktree-create:cwd=${cwd ?? ''}`
		}
		if (toolName === 'git_worktree_delete') {
			const { cwd, path } = toolParams as BuiltinToolCallParams['git_worktree_delete']
			return `git:worktree-delete:cwd=${cwd ?? ''}:path=${path}`
		}
		if (toolName === 'install_dependencies') {
			const { command, cwd } = toolParams as BuiltinToolCallParams['install_dependencies']
			return `deps:${this._packageCommandApprovalFamily(command) ?? 'install'}:cwd=${cwd ?? ''}`
		}
		return null
	}

	private _terminalCommandApprovalFamily(command: string): string | null {
		const normalized = command.toLowerCase().trim()
		if (/\brm\s+-rf\b/.test(normalized)) return 'delete:rm-rf'
		if (/\bsudo\b/.test(normalized)) return 'system:sudo'
		if (/\bchmod\s+[-+]?[0-7]*777\b/.test(normalized)) return 'system:chmod-777'
		if (/\bchown\b/.test(normalized)) return 'system:chown'
		if (/\bmkfs\b/.test(normalized)) return 'system:mkfs'
		if (/\bdd\b/.test(normalized)) return 'system:dd'
		if (/\bgit\s+reset\b/.test(normalized)) return 'git:reset'
		if (/\bgit\s+clean\b/.test(normalized)) return 'git:clean'
		if (/\bgit\s+push\b/.test(normalized)) return 'git:push'
		if (/\bgit\s+branch\s+-d\b/i.test(command) || /\bgit\s+branch\s+-D\b/.test(command)) return 'git:delete-branch'
		if (/\bgit\s+worktree\s+remove\b/.test(normalized)) return 'git:worktree-remove'
		if (/\bgit\s+commit\b/.test(normalized)) return 'git:commit'
		if (/\bgit\s+(checkout\s+-b|switch\s+-c)\b/.test(normalized)) return 'git:create-branch'
		if (/\bgit\s+apply\b/.test(normalized)) return 'git:apply-patch'
		if (/\bgit\s+am\b/.test(normalized)) return 'git:am'
		if (/\bgit\s+merge\b/.test(normalized)) return 'git:merge'
		if (/\bgit\s+rebase\b/.test(normalized)) return 'git:rebase'
		if (/\bgit\s+cherry-pick\b/.test(normalized)) return 'git:cherry-pick'
		if (/\bgit\s+tag\b/.test(normalized)) return 'git:tag'
		if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/.test(normalized)) return 'network:download-execute'
		if (/\b(curl|wget)\b/.test(normalized)) return 'network:download'
		const packageFamily = this._packageCommandApprovalFamily(command)
		if (packageFamily) return `deps:${packageFamily}`
		return null
	}

	private _packageCommandApprovalFamily(command: string): string | null {
		const normalized = command.toLowerCase().trim()
		if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(normalized)) return 'js-package-manager'
		if (/\b(pip|pip3|uv|poetry)\s+(install|add|remove|update)\b/.test(normalized)) return 'python-package-manager'
		if (/\bcargo\s+(install|add|remove|update)\b/.test(normalized)) return 'rust-package-manager'
		if (/\bgo\s+get\b/.test(normalized)) return 'go-package-manager'
		return null
	}

	private _runReadonlyToolBatch = async (
		threadId: string,
		toolCalls: RawToolCallObj[],
	): Promise<{ interrupted?: boolean, successfulToolNames: string[] }> => {
		const results = await Promise.all(toolCalls.map(toolCall => (
			this._runToolCall(threadId, toolCall.name, toolCall.id, undefined, {
				preapproved: false,
				unvalidatedToolParams: toolCall.rawParams,
			})
		)))
		return {
			interrupted: results.some(result => result.interrupted),
			successfulToolNames: results.map(result => result.successfulToolName).filter((name): name is string => !!name),
		}
	}

	private _startReadonlyToolCallEarly = (threadId: string, toolCall: RawToolCallObj): EarlyReadonlyToolRun => {
		const earlyRun: EarlyReadonlyToolRun = {
			toolCall,
			promise: Promise.resolve(null as any),
			interruptTool: undefined,
		}
		earlyRun.promise = (async () => {
			const toolName = toolCall.name
			if (!this._canRunInReadonlyBatch(toolName) || !isABuiltinToolName(toolName)) {
				return { role: 'tool', type: 'tool_error', params: toolCall.rawParams, result: `Tool ${toolName} cannot be started early.`, name: toolName, content: `Tool ${toolName} cannot be started early.`, id: toolCall.id, rawParams: toolCall.rawParams, mcpServerName: undefined } as ChatMessage & { role: 'tool' }
			}

			let toolParams: ToolCallParams<ToolName>
			try {
				toolParams = this._toolsService.validateParams[toolName](toolCall.rawParams) as ToolCallParams<ToolName>
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				return { role: 'tool', type: 'invalid_params', rawParams: toolCall.rawParams, result: null, name: toolName, content: errorMessage, id: toolCall.id, mcpServerName: undefined } as ChatMessage & { role: 'tool' }
			}

			try {
				const invocation = createLegacyToolInvocation(toolName, toolParams, toolCall.rawParams)
				const toolCtx = this._agentToolContext(threadId)
				const runningTool = await this._agentBridge.withToolContext({ ...toolCtx, toolInvocation: invocation }, () => (
					this._toolsService.callTool[toolName](toolParams as any)
				))
				earlyRun.interruptTool = runningTool.interruptTool
				const toolResult = await runningTool.result
				const toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
				return { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolCall.id, rawParams: toolCall.rawParams, mcpServerName: undefined } as ChatMessage & { role: 'tool' }
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				return { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolCall.id, rawParams: toolCall.rawParams, mcpServerName: undefined } as ChatMessage & { role: 'tool' }
			}
		})()
		return earlyRun
	}

	private _startEarlyReadonlyToolCalls = (threadId: string, toolCalls: RawToolCallObj[] | undefined, earlyRuns: Map<string, EarlyReadonlyToolRun>) => {
		if (!this._settingsService.state.globalSettings.parallelReadonlyTools) return
		if (!toolCalls) return

		for (const toolCall of toolCalls) {
			if (!toolCall.isDone || !this._canRunInReadonlyBatch(toolCall.name)) return
			if (!earlyRuns.has(toolCall.id)) {
				earlyRuns.set(toolCall.id, this._startReadonlyToolCallEarly(threadId, toolCall))
			}
		}
	}

	private _interruptEarlyReadonlyToolCalls = (earlyRuns: Map<string, EarlyReadonlyToolRun>) => {
		for (const earlyRun of earlyRuns.values()) {
			earlyRun.interruptTool?.()
		}
	}

	private _runWriteToolBatch = async (
		threadId: string,
		toolCalls: RawToolCallObj[],
	): Promise<{ interrupted?: boolean, awaitingUserApproval?: boolean, successfulToolNames: string[] }> => {
		const results = await Promise.all(toolCalls.map(toolCall => (
			this._runToolCall(threadId, toolCall.name, toolCall.id, undefined, {
				preapproved: false,
				unvalidatedToolParams: toolCall.rawParams,
			})
		)))
		return {
			interrupted: results.some(result => result.interrupted),
			awaitingUserApproval: results.some(result => result.awaitingUserApproval),
			successfulToolNames: results.map(result => result.successfulToolName).filter((name): name is string => !!name),
		}
	}

	private _runToolCallsInOrder = async (
		threadId: string,
		toolCalls: RawToolCallObj[],
		earlyRuns: Map<string, EarlyReadonlyToolRun>,
	): Promise<{ interrupted?: boolean, awaitingUserApproval?: boolean, shouldSendAnotherMessage?: boolean, successfulToolNames?: string[] }> => {
		const mcpTools = this._mcpService.getMCPTools()
		const useReadonlyBatch = this._settingsService.state.globalSettings.parallelReadonlyTools
		const useWriteBatch = this._settingsService.state.globalSettings.parallelWriteTools && !!this._settingsService.state.globalSettings.autoApprove.edits
		let shouldSendAnotherMessage = false
		const successfulToolNames: string[] = []

		for (let i = 0; i < toolCalls.length;) {
			const earlyRun = earlyRuns.get(toolCalls[i].id)
			if (earlyRun) {
				const toolMessage = await earlyRun.promise
				this._addMessageToThread(threadId, toolMessage)
				if (toolMessage.type === 'success') {
					shouldSendAnotherMessage = true
					successfulToolNames.push(toolMessage.name)
				}
				i += 1
				continue
			}

			if (useReadonlyBatch && this._canRunInReadonlyBatch(toolCalls[i].name)) {
				const batch: RawToolCallObj[] = []
				while (i + batch.length < toolCalls.length) {
					const toolCall = toolCalls[i + batch.length]
					if (earlyRuns.has(toolCall.id) || !this._canRunInReadonlyBatch(toolCall.name)) break
					batch.push(toolCall)
				}
				const { interrupted, successfulToolNames: batchSuccessfulToolNames } = await this._runReadonlyToolBatch(threadId, batch)
				if (interrupted) return { interrupted: true }
				successfulToolNames.push(...batchSuccessfulToolNames)
				shouldSendAnotherMessage = true
				i += batch.length
				continue
			}

			if (useWriteBatch && this._canRunInWriteBatch(toolCalls[i].name)) {
				const batch: RawToolCallObj[] = []
				while (i + batch.length < toolCalls.length) {
					const toolCall = toolCalls[i + batch.length]
					if (!this._canRunInWriteBatch(toolCall.name)) break
					batch.push(toolCall)
				}
				const { awaitingUserApproval, interrupted, successfulToolNames: batchSuccessfulToolNames } = await this._runWriteToolBatch(threadId, batch)
				if (interrupted) return { interrupted: true }
				if (awaitingUserApproval) return { awaitingUserApproval: true }
				successfulToolNames.push(...batchSuccessfulToolNames)
				shouldSendAnotherMessage = true
				i += batch.length
				continue
			}

			const toolCall = toolCalls[i]
			const mcpTool = mcpTools?.find(t => t.name === toolCall.name)
			const { awaitingUserApproval, interrupted, successfulToolName } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams })
			if (interrupted) return { interrupted: true }
			if (awaitingUserApproval) return { awaitingUserApproval: true }
			if (successfulToolName) successfulToolNames.push(successfulToolName)
			shouldSendAnotherMessage = true
			i += 1
		}

		return { shouldSendAnotherMessage, successfulToolNames }
	}


	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
	): Promise<ToolRunResult> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string
		let toolInvocation = createLegacyToolInvocation(toolName, opts.unvalidatedToolParams)
		const toolCtx = this._agentToolContext(threadId)

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
				// once validated, add checkpoint for edit
				if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }) }
				if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }) }

				toolInvocation = createLegacyToolInvocation(toolName, toolParams, opts.unvalidatedToolParams)
				this._agentBridge.recordToolRequested(toolInvocation, toolCtx)
				const permissionDecision = await this._agentBridge.runtime.decidePermission(toolInvocation)
				if (permissionDecision.type === 'deny') {
					this._agentBridge.recordPermissionResolved(toolInvocation.callId, permissionDecision, toolCtx)
					this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: toolParams, result: null, name: toolName, content: permissionDecision.reason, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
					return {}
				}

				// 2. if tool requires approval, break from the loop, awaiting approval

				const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
				if (permissionDecision.type === 'ask' || approvalType) {
					if (permissionDecision.type === 'ask' && this._hasRememberedPermissionApproval(threadId, toolName, toolParams)) {
						this._agentBridge.recordPermissionResolved(toolInvocation.callId, { type: 'allow', reason: `A similar ${permissionDecision.risk}-risk "${toolName}" action was already approved in this thread.` }, toolCtx)
					}
					else {
						const autoApprove = approvalType ? this._settingsService.state.globalSettings.autoApprove[approvalType] : false
						const canAutoApprove = autoApprove && this._canAutoApprovePermissionDecision(permissionDecision)
						// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
						this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: this._permissionRequestContent(permissionDecision), result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
						if (permissionDecision.type === 'ask' && !canAutoApprove) {
							this._pendingAgentToolInvocationOfChatToolId.set(toolId, { invocation: toolInvocation, ctx: toolCtx })
							this._agentBridge.recordPermissionRequired(toolInvocation.callId, permissionDecision, toolCtx)
							return { awaitingUserApproval: true }
						}
						this._agentBridge.recordPermissionResolved(toolInvocation.callId, { type: 'allow', reason: permissionDecision.type === 'ask' ? `Tool "${toolName}" was auto-approved by Void settings.` : permissionDecision.reason }, toolCtx)
					}
				}
				else {
					this._agentBridge.recordPermissionResolved(toolInvocation.callId, permissionDecision, toolCtx)
				}
			}
			else {
				toolParams = opts.validatedParams
				const pendingInvocation = this._pendingAgentToolInvocationOfChatToolId.get(toolId)
				if (pendingInvocation) {
					toolInvocation = pendingInvocation.invocation
					this._pendingAgentToolInvocationOfChatToolId.delete(toolId)
				}
				else {
					toolInvocation = createLegacyToolInvocation(toolName, toolParams, opts.unvalidatedToolParams)
					this._agentBridge.recordToolRequested(toolInvocation, toolCtx)
				}
				this._rememberPermissionApproval(threadId, toolName, toolParams)
				this._agentBridge.recordPermissionResolved(toolInvocation.callId, { type: 'allow', reason: `Tool "${toolName}" was approved by the user.` }, toolCtx)
			}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let interruptTool: (() => void) | undefined
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
			try {

				// set stream state
				this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })
			resolveInterruptor(() => {
				interrupted = true
				interruptTool?.()
			})

			const runTool = async () => {
					if (interrupted) return undefined
					await this._runAgentHookSafely({ event: 'before_tool_call', toolCall: toolInvocation, metadata: { threadId, toolId, toolName } })
					if (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'create_file_or_folder' || toolName === 'delete_file_or_folder' || toolName === 'git_apply_patch') {
						await this._runAgentHookSafely({ event: 'before_file_edit', toolCall: toolInvocation, metadata: { threadId, toolId, toolName } })
					}
					if (isBuiltInTool) {
						const toolCall = await this._agentBridge.withToolContext({ ...toolCtx, toolAlreadyRequested: true, toolInvocation }, () => (
							this._toolsService.callTool[toolName](toolParams as any)
						))
						interruptTool = toolCall.interruptTool

					if (interrupted) {
						interruptTool?.()
						return undefined
					}

					return await toolCall.result
				}
					else {
						const mcpTools = this._mcpService.getMCPTools()
						const mcpTool = mcpTools?.find(t => t.name === toolName)
						if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

						this._agentBridge.recordToolStarted(toolInvocation, { ...toolCtx, toolAlreadyRequested: true })
						const mcpResult = (await this._mcpService.callMCPTool({
							serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
							toolName: toolName,
							params: toolParams
						})).result
						this._agentBridge.recordToolFinished(toolInvocation.callId, { ok: true, data: mcpResult }, toolCtx)
						return mcpResult
					}
				}

			const lockedToolResult = await this._withToolExecutionLock(toolName, toolParams, runTool)
			if (lockedToolResult === undefined && interrupted) {
				return { interrupted: true }
			}
			toolResult = lockedToolResult as ToolResult<ToolName>

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

				const errorMessage = getErrorMessage(error)
				if (!isBuiltInTool) {
					this._agentBridge.recordToolFailed(toolInvocation.callId, errorMessage, toolCtx)
				}
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

			// 5. add to history and keep going
			this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			await this._runAgentHookSafely({ event: 'after_tool_call', toolCall: toolInvocation, toolResult: { ok: true, data: toolResult }, metadata: { threadId, toolId, toolName } })
			if (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'create_file_or_folder' || toolName === 'delete_file_or_folder' || toolName === 'git_apply_patch') {
				await this._runAgentHookSafely({ event: 'after_file_edit', toolCall: toolInvocation, toolResult: { ok: true, data: toolResult }, metadata: { threadId, toolId, toolName } })
			}
			if (toolName === 'run_command' || toolName === 'run_tests' || toolName === 'install_dependencies' || toolName === 'run_persistent_command' || toolName === 'git_status' || toolName === 'git_diff' || toolName === 'git_apply_patch' || toolName === 'git_create_branch' || toolName === 'git_commit' || toolName === 'package_script_list' || toolName === 'review_snapshot' || toolName === 'git_worktree_create' || toolName === 'git_worktree_delete') {
				await this._runAgentHookSafely({ event: 'after_run_command', toolCall: toolInvocation, toolResult: { ok: true, data: toolResult }, metadata: { threadId, toolId, toolName } })
			}
			return { successfulToolName: toolName }
		};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
		}) {

			this._currentOrStartAgentRun(threadId)
			let keepAgentRunOpen = false
			let agentRunError: string | null = null

			try {

			let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

			// above just defines helpers, below starts the actual function
			const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
			const { overridesOfModel } = this._settingsService.state
			const useCustomAgentPlanRuntime = chatMode === 'agent' && this._settingsService.state.globalSettings.disableSystemMessage
			if (useCustomAgentPlanRuntime) {
				const planState = this._ensureAgentPlanState(threadId)
				if (!callThisToolFirst) {
					this._addInternalAgentPlanMessage(threadId, planState, 'Begin the agent run.')
				}
			}
			const promptContext = await this._convertToLLMMessagesService.prepareAgentRunPromptContext({
				chatMode,
				modelSelection,
		})

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined
		const agentRunStartedAt = Date.now()
		const elapsedMs = () => Date.now() - agentRunStartedAt

			// before enter loop, call tool
			if (callThisToolFirst) {
				const { interrupted, successfulToolName } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
				if (interrupted) {
					this._setStreamState(threadId, undefined)
					this._addUserCheckpoint({ threadId })
					return
				}
				if (useCustomAgentPlanRuntime) {
					if (successfulToolName) this._advanceAgentPlanAfterTools(threadId, [successfulToolName])
					const currentPlanState = this._getAgentPlanState(threadId)
					if (currentPlanState && !this._isAgentPlanComplete(currentPlanState)) {
						this._addInternalAgentPlanMessage(threadId, currentPlanState, 'Continue after the approved tool result.')
					}
				}
			}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

		this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			// Reset compression abort flag — a stale abort from a previous iteration
			// should not abort the current one.
			this._compressionAborted = false

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []

			const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				promptContextOverride: promptContext,
				threadId,
				onWillCompress: () => this._setStreamState(threadId, { isRunning: 'compressing' }),
			})

			// Check if compression was aborted by the user during the call
			if (this._compressionAborted) {
				this._compressionAborted = false
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })
				return
			}

			// Restore idle state after compression (if it was compressing)
			const curState = this.streamState[threadId]
			if (curState?.isRunning === 'compressing' || curState?.isRunning === 'idle') {
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
			}

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCalls?: RawToolCallObj[], info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

					let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
					const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })
					const earlyReadonlyToolRuns = new Map<string, EarlyReadonlyToolRun>()

					const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
						separateSystemMessage: separateSystemMessage,
						onText: ({ fullText, fullReasoning, toolCall, toolCalls }) => {
							this._startEarlyReadonlyToolCalls(threadId, toolCalls, earlyReadonlyToolRuns)
						this._scheduleLLMStreamState(
							threadId,
							{ displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? toolCalls?.[0] ?? null, toolCallsSoFar: toolCalls ?? (toolCall ? [toolCall] : null) },
							Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) })
						)
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, toolCalls, anthropicReasoning, }) => {
						if (fullText) {
							const run = this._currentOrStartAgentRun(threadId)
							this._agentBridge.emit({ type: 'model.delta', sessionId: threadId, runId: run.runId, text: fullText })
						}
						const normalizedToolCalls = toolCalls ?? (toolCall ? [toolCall] : undefined)
						resMessageIsDonePromise({ type: 'llmDone', toolCalls: normalizedToolCalls, info: { fullText, fullReasoning, anthropicReasoning } }) // resolve with tool calls
					},
					onError: async (error) => {
						this._interruptEarlyReadonlyToolCalls(earlyReadonlyToolRuns)
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						this._interruptEarlyReadonlyToolCalls(earlyReadonlyToolRuns)
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					const llmRes = await messageIsDonePromise
					const fallbackError = { message: 'There was an unexpected error when sending your chat message.', fullError: null }
					const isNonRetryableVisionError = llmRes.type === 'llmError' && llmRes.error?.message === MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT_ERROR
					const isProviderImageInputRejectedError = llmRes.type === 'llmError' && isImageInputRejectedByProviderError(llmRes.error?.message)
					const disabledImageInputs = isNonRetryableVisionError
						? this._disableImageInputsForThread(threadId, IMAGE_INPUT_UNSUPPORTED_BY_MODEL_REASON)
						: isProviderImageInputRejectedError
							? this._disableImageInputsForThread(threadId, IMAGE_INPUT_DISABLED_REASON)
							: false
					const error = isProviderImageInputRejectedError
						? { message: IMAGE_INPUT_REJECTED_BY_PROVIDER_ERROR, fullError: null }
						: llmRes.type === 'llmError'
							? llmRes.error ?? fallbackError
							: fallbackError
					this._addMessageToThread(threadId, { role: 'assistant', displayContent: error.message, reasoning: '', elapsedMs: elapsedMs(), anthropicReasoning: null })
					if (disabledImageInputs) {
						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						break
					}
					this._setStreamState(threadId, { isRunning: undefined, error })
					this._addUserCheckpoint({ threadId })
					return
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null, toolCallsSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					const isNonRetryableVisionError = llmRes.error?.message === MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT_ERROR
					const isProviderImageInputRejectedError = isImageInputRejectedByProviderError(llmRes.error?.message)
					// error, should retry
					if (!isNonRetryableVisionError && !isProviderImageInputRejectedError && nAttempts < CHAT_RETRIES) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const disabledImageInputs = isNonRetryableVisionError
							? this._disableImageInputsForThread(threadId, IMAGE_INPUT_UNSUPPORTED_BY_MODEL_REASON)
							: isProviderImageInputRejectedError
								? this._disableImageInputsForThread(threadId, IMAGE_INPUT_DISABLED_REASON)
								: false
						const error = isProviderImageInputRejectedError
							? { message: IMAGE_INPUT_REJECTED_BY_PROVIDER_ERROR, fullError: null }
							: llmRes.error
						this._flushPendingLLMStreamState(threadId)
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
						const errorMessage = error?.message ?? 'The model request failed.'
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar || errorMessage, reasoning: reasoningSoFar, elapsedMs: elapsedMs(), anthropicReasoning: null })
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						if (disabledImageInputs) {
							shouldSendAnotherMessage = true
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
							break
						}
						this._setStreamState(threadId, { isRunning: undefined, error })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				const { toolCalls, info } = llmRes

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, elapsedMs: elapsedMs(), anthropicReasoning: info.anthropicReasoning })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool if there is one
				if (toolCalls && toolCalls.length > 0) {
					const { awaitingUserApproval, interrupted, shouldSendAnotherMessage: shouldContinue, successfulToolNames } = await this._runToolCallsInOrder(threadId, toolCalls, earlyReadonlyToolRuns)
					if (interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
						if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
						else {
							if (useCustomAgentPlanRuntime) {
								this._advanceAgentPlanAfterTools(threadId, successfulToolNames ?? [])
								const currentPlanState = this._getAgentPlanState(threadId)
								if (currentPlanState && shouldContinue && !this._isAgentPlanComplete(currentPlanState)) {
									this._addInternalAgentPlanMessage(threadId, currentPlanState, 'Continue after tool result.')
								}
							}
							shouldSendAnotherMessage = !!shouldContinue
						}

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}
				else {
					this._interruptEarlyReadonlyToolCalls(earlyReadonlyToolRuns)
					if (useCustomAgentPlanRuntime) {
						shouldSendAnotherMessage = this._advanceAgentPlanAfterAssistantText(threadId, info.fullText)
					}
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

			// capture number of messages sent
			this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
			keepAgentRunOpen = !!isRunningWhenEnd
			if (!keepAgentRunOpen) {
				this._finishAgentRun(threadId, `Agent loop completed after ${nMessagesSent} message${nMessagesSent === 1 ? '' : 's'}.`)
			}
			}
			catch (error) {
				agentRunError = getErrorMessage(error)
				throw error
			}
			finally {
				if (agentRunError) {
					this._failAgentRun(threadId, agentRunError)
				}
				else if (!keepAgentRunOpen) {
					this._finishAgentRun(threadId, 'Agent loop stopped.')
				}
			}
		}


		private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
			this._runAgentHookSafely({ event: 'before_checkpoint', metadata: { threadId } })
			this._addMessageToThread(threadId, checkpoint)
			const run = this._agentRunOfThreadId.get(threadId)
			if (run) {
				this._agentBridge.emit({ type: 'checkpoint.created', sessionId: threadId, runId: run.runId, checkpointId: generateUuid() })
			}
			this._runAgentHookSafely({ event: 'after_checkpoint', metadata: { threadId } })
			// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._voidModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, attachments }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, attachments?: ImageAttachment[] }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, attachments: attachments?.length ? attachments : undefined, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, attachments }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, attachments?: ImageAttachment[] }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, attachments });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject()

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreadsImmediate(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreadsImmediate(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreadsImmediate(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const messageWithContext = message.contextMeta ? message : {
			...message,
			contextMeta: {
				id: generateUuid(),
				origin: message.role === 'user'
					? 'external-user' as const
					: message.role === 'assistant' || message.role === 'aborted_assistant'
						? 'assistant' as const
						: message.role === 'tool'
							? 'tool' as const
							: 'runtime-context' as const,
				startsRound: message.role === 'user',
			},
		} as ChatMessage
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					messageWithContext
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	private _disableImageInputsForThread(threadId: string, disabledReason: string): boolean {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return false

		let didChange = false
		const messages = oldThread.messages.map((message): ChatMessage => {
			if (message.role === 'user' && message.attachments?.some(attachment => !attachment.isLLMDisabled)) {
				didChange = true
				return {
					...message,
					attachments: message.attachments.map(attachment => attachment.isLLMDisabled ? attachment : {
						...attachment,
						isLLMDisabled: true,
						disabledReason,
					})
				}
			}

			if (message.role === 'tool' && message.type === 'success' && message.name === 'read_image') {
				const result = message.result as { attachment?: ImageAttachment }
				if (result.attachment && !result.attachment.isLLMDisabled) {
					didChange = true
					return {
						...message,
						result: {
							...result,
							attachment: {
								...result.attachment,
								isLLMDisabled: true,
								disabledReason,
							}
						}
					} as ChatMessage
				}
			}

			return message
		})

		if (!didChange) return false

		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages,
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
		return true
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
