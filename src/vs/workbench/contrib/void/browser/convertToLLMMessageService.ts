import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Schemas } from '../../../../base/common/network.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage, CHAT_HISTORY_COMPRESSION, compressHistoryPrompt } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj, ServiceSendLLMMessageParams } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';

export const EMPTY_MESSAGE = '(empty message)'

const OPEN_FILE_SCHEMES = new Set([
	Schemas.file,
	Schemas.vscodeRemote,
	Schemas.vscodeUserData,
])



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	reasoning: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120
const DIRECTORY_STR_CACHE_TTL_MS = 30_000
const VOID_RULES_CACHE_TTL_MS = 30_000




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			if (currMsg.role === 'assistant') {
				newMessages.push({
					role: 'assistant',
					content: currMsg.content,
					reasoning_content: currMsg.reasoning || undefined,
				})
				continue
			}
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: currMsg.content,
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]
				prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	// Shallow-clone each message to avoid mutating the caller's objects.
	// We only mutate `.content` (string primitives), so a shallow copy is sufficient.
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = messages_.map(m => ({ ...m }))

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voidrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// Pre-compute weights once (O(n)), sort (O(n log n)), then trim in order.
	// We use message count from outside the closure for O(1) access.
	const msgCount = messages.length

	const weight = (message: MesType, idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (msgCount - 1 - idx) / msgCount // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= msgCount - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN,
		5_000
	)

	if (charsNeedToTrim > 0) {
		// Build a sorted list of indices by weight descending
		const indicesWithWeight: { idx: number; weight: number }[] = []
		for (let i = 0; i < messages.length; i += 1) {
			indicesWithWeight.push({ idx: i, weight: weight(messages[i], i) })
		}
		indicesWithWeight.sort((a, b) => b.weight - a.weight) // highest weight first

		let remainingCharsToTrim = charsNeedToTrim

		for (const { idx } of indicesWithWeight) {
			if (remainingCharsToTrim <= 0) break

			const m = messages[idx]
			const trimmedLen = TRIM_TO_LEN - '...'.length
			const numCharsWillTrim = m.content.length - trimmedLen

			// If trimming this message to TRIM_TO_LEN is more than enough, do a partial trim and finish
			if (numCharsWillTrim > remainingCharsToTrim) {
				m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
				break
			}

			// Trim the entire message to TRIM_TO_LEN
			remainingCharsToTrim -= numCharsWillTrim
			m.content = m.content.substring(0, trimmedLen) + '...'
		}
	}


	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			// OpenAI-compatible assistant tool calls may legitimately have empty content.
			if (currMsg.role === 'assistant' && ('tool_calls' in currMsg) && currMsg.tool_calls?.length) {
				continue
			}
			if (nextMsg?.role === 'tool') continue
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareAgentRunPromptContext: (opts: { chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ systemMessage: string, aiInstructions: string }>
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, promptContextOverride?: { systemMessage: string, aiInstructions: string }, threadId: string }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	private _directoryStrCache: {
		key: string;
		value: string;
		expiresAt: number;
		inFlight: Promise<string> | null;
	} = {
		key: '',
		value: '',
		expiresAt: 0,
		inFlight: null,
	}

	private _voidRulesCache: {
		key: string;
		value: string;
		expiresAt: number;
		inFlight: Promise<string> | null;
	} = {
		key: '',
		value: '',
		expiresAt: 0,
		inFlight: null,
	}

	// Cache for the full system message used in prepareLLMChatMessages (agent mode)
	// Key encodes all dynamic inputs; cache is valid as long as nothing changes.
	private _systemMessageCache: {
		key: string;
		value: string;
	} | null = null;

	// History compression state, keyed by threadId.
	// `summarizedRoundCount` is the number of rounds that have been compressed into summaries.
	// `summaryList` is the array of per-chunk compressed summaries, in order (oldest first).
	private _summaryBySession = new Map<string, {
		summarizedRoundCount: number;
		summaryList: string[];
	}>();

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
	) {
		super()
	}

	// Read .voidrules files from workspace folders
	private _getVoidRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voidRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.voidrules')
				const { model } = this.voidModelService.getModel(uri)
				if (!model) continue
				voidRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return voidRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	private async _getVoidRulesFileContentsAsync(): Promise<string> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const cacheKey = workspaceFolders.map(folder => folder.uri.toString()).join('\n');
		const now = Date.now();

		if (
			this._voidRulesCache.key === cacheKey &&
			this._voidRulesCache.expiresAt > now
		) {
			return this._voidRulesCache.value;
		}
		if (this._voidRulesCache.key === cacheKey && this._voidRulesCache.inFlight) {
			return this._voidRulesCache.inFlight;
		}

		const computePromise = (async () => {
		try {
			const contents = await Promise.all(workspaceFolders.map(async folder => {
				try {
					const uri = URI.joinPath(folder.uri, '.voidrules');
					const fileContent = await this.fileService.readFile(uri);
					return fileContent.value.toString();
				}
				catch {
					return '';
				}
			}));

			return contents
				.filter(Boolean)
				.join('\n\n')
				.trim();
		}
		catch (e) {
			return '';
		}
		})();

		this._voidRulesCache.key = cacheKey;
		this._voidRulesCache.inFlight = computePromise;

		const value = await computePromise;
		this._voidRulesCache.value = value;
		this._voidRulesCache.expiresAt = Date.now() + VOID_RULES_CACHE_TTL_MS;
		this._voidRulesCache.inFlight = null;
		return value;
	}

	// Get combined AI instructions from settings and .voidrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}

	private async _getCombinedAIInstructionsAsync(): Promise<string> {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = await this._getVoidRulesFileContentsAsync();

		const ans: string[] = [];
		if (globalAIInstructions) ans.push(globalAIInstructions);
		if (voidRulesFileContent) ans.push(voidRulesFileContent);
		return ans.join('\n\n');
	}

	private async _getDirectoryStrCached(chatMode: ChatMode): Promise<string> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const cutOffMessage = chatMode === 'agent' || chatMode === 'gather' ?
			`...Directories string cut off, use tools to read more...`
			: `...Directories string cut off, ask user for more if necessary...`;
		const cacheKey = JSON.stringify({
			workspaceFolders: workspaceFolders.map(folder => folder.uri.toString()),
			cutOffMessage,
		});
		const now = Date.now();

		if (
			this._directoryStrCache.key === cacheKey &&
			this._directoryStrCache.expiresAt > now
		) {
			return this._directoryStrCache.value;
		}
		if (this._directoryStrCache.key === cacheKey && this._directoryStrCache.inFlight) {
			return this._directoryStrCache.inFlight;
		}

		const computePromise = this.directoryStrService.getAllDirectoriesStr({ cutOffMessage });
		this._directoryStrCache.key = cacheKey;
		this._directoryStrCache.inFlight = computePromise;

		const value = await computePromise;
		this._directoryStrCache.value = value;
		this._directoryStrCache.expiresAt = Date.now() + DIRECTORY_STR_CACHE_TTL_MS;
		this._directoryStrCache.inFlight = null;
		return value;
	}


	// system message with caching: only recompute when inputs change
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = [...new Set(
			this.modelService.getModels()
				.filter(m => m.isAttachedToEditor())
				.map(m => m.uri)
				.filter(uri => OPEN_FILE_SCHEMES.has(uri.scheme))
				.map(uri => uri.fsPath)
		)];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this._getDirectoryStrCached(chatMode)

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()

		// Build a cache key that covers all dynamic inputs.
		// Include the full directory string so system-message cache invalidation
		// exactly tracks the directory snapshot produced by _getDirectoryStrCached.
		const cacheKey = JSON.stringify({
			workspaceFolders,
			openedURIs,
			activeURI,
			directoryStr,
			persistentTerminalIDs,
			mcpToolsSummary: mcpTools?.map(t => ({ name: t.name, server: t.mcpServerName, paramsKeys: Object.keys(t.params).sort() })),
			chatMode,
			includeXMLToolDefinitions,
		})

		if (this._systemMessageCache?.key === cacheKey) {
			return this._systemMessageCache.value
		}

		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions })
		this._systemMessageCache = { key: cacheKey, value: systemMessage }
		return systemMessage
	}




	// ================ History compression ================

	// Split SimpleLLMMessage[] into rounds. Each round starts with a `user` message
	// and includes all subsequent non-user messages until the next `user` (exclusive).
	private _splitIntoRounds(messages: SimpleLLMMessage[]): SimpleLLMMessage[][] {
		const rounds: SimpleLLMMessage[][] = []
		let currentRound: SimpleLLMMessage[] | null = null
		for (const m of messages) {
			if (m.role === 'user') {
				if (currentRound) rounds.push(currentRound)
				currentRound = [m]
			} else if (currentRound) {
				currentRound.push(m)
			}
			// If the first message is not a user message (edge case), skip it
		}
		if (currentRound) rounds.push(currentRound)
		return rounds
	}

	// Build a prompt from a single round for compression.
	// Returns a compact string representation.
	private _roundToCompressionPrompt(round: SimpleLLMMessage[]): string {
		const parts: string[] = []
		for (const m of round) {
			if (m.role === 'user') {
				parts.push(`User: ${m.content}`)
			} else if (m.role === 'assistant') {
				parts.push(`Assistant: ${m.content}`)
			} else if (m.role === 'tool') {
				const resultLen = m.content?.length ?? 0
				parts.push(`Tool[${m.name}]: (${resultLen} chars result)`)
			}
		}
		return parts.join('\n')
	}

	// Synchronously compress a list of rounds using LLM (or fallback to rule-based summary).
	// Returns a single compact summary string for all the given rounds.
	private async _llmCompress(rounds: SimpleLLMMessage[][], modelSelection: ModelSelection): Promise<string> {
		const dialogStr = rounds.map(r => this._roundToCompressionPrompt(r)).join('\n\n---\n\n')

		const prompt = `${compressHistoryPrompt}\n\n${dialogStr}\n\nSummary:`

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		try {
			// Use sendLLMMessage with the user's chat model for compression.
			// We construct a minimal single-turn chat completion request.
			const res = await new Promise<string>((resolve, reject) => {
				const requestId = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode: 'agent',
					messages: [
						{ role: 'user', content: prompt }
					],
					modelSelection: modelSelection,
					modelSelectionOptions: modelSelectionOptions,
					overridesOfModel: this.voidSettingsService.state?.overridesOfModel,
					logging: { loggingName: 'History Compression' },
					separateSystemMessage: undefined,
					onText: () => { /* no-op, we only care about final */ },
					onFinalMessage: async ({ fullText }) => {
						resolve(fullText)
					},
					onError: async (error) => {
						reject(error)
					},
					onAbort: () => {
						reject(new Error('Compression was aborted'))
					},
				} as ServiceSendLLMMessageParams)

				if (!requestId) {
					reject(new Error('Could not start compression request'))
					return
				}
			})
			return res.trim() || '[compression produced empty result]'
		} catch (e) {
			// Fallback: rule-based summary
			const fallbackParts = rounds.map((r, ri) => {
				const userMsg = r.find(m => m.role === 'user')
				const assistantMsg = r.find(m => m.role === 'assistant')
				const toolMsgs = r.filter(m => m.role === 'tool')
				const userPreview = userMsg ? userMsg.content.substring(0, 80).replace(/\n/g, ' ') : ''
				const assistantPreview = assistantMsg ? assistantMsg.content.substring(0, 120).replace(/\n/g, ' ') : ''
				const toolInfo = toolMsgs.length > 0 ? `[${toolMsgs.map(t => t.name).join(', ')}]` : ''
				return `Round ${ri + 1}: User: "${userPreview}" | Assistant: "${assistantPreview}" ${toolInfo}`
			})
			return fallbackParts.join('\n')
		}
	}

	// Get or create compressed summaries for a thread.
	// Returns the summary string to prepend to system message, and the filtered messages.
	// The number of full rounds to keep is CHAT_HISTORY_COMPRESSION.maxFullRounds.
	private async _getOrCreateCompressedSummaries(
		threadId: string,
		messages: SimpleLLMMessage[],
		modelSelection: ModelSelection,
	): Promise<{
		summaryStr: string; // the full summary string (multiple blocks concatenated), or empty if no compression needed
		filteredMessages: SimpleLLMMessage[]; // messages after removing summarized rounds
	}> {
		const rounds = this._splitIntoRounds(messages)
		const { maxFullRounds, roundsPerSummaryChunk, maxSummaryChars } = CHAT_HISTORY_COMPRESSION

		// Freeze-mode compression:
		// - Always keep the latest `maxFullRounds` rounds verbatim.
		// - Only create a new summary when the older, unsummarized portion has grown
		//   by a full `roundsPerSummaryChunk`.
		// - Existing summaries are never recomputed.
		const targetSummarizedRoundCount = Math.max(
			0,
			Math.floor((rounds.length - maxFullRounds) / roundsPerSummaryChunk) * roundsPerSummaryChunk
		)

		const existingData = this._summaryBySession.get(threadId)
		let summarizedRoundCount = existingData?.summarizedRoundCount ?? 0
		let summaryList = existingData?.summaryList.slice() ?? []

		// If the thread history shrank, drop trailing summaries instead of recomputing.
		if (targetSummarizedRoundCount < summarizedRoundCount) {
			summarizedRoundCount = targetSummarizedRoundCount
			summaryList = summaryList.slice(0, summarizedRoundCount / roundsPerSummaryChunk)
		}

		// Only append brand-new frozen chunks.
		if (targetSummarizedRoundCount > summarizedRoundCount) {
			for (let start = summarizedRoundCount; start < targetSummarizedRoundCount; start += roundsPerSummaryChunk) {
				const chunk = rounds.slice(start, start + roundsPerSummaryChunk)
				const compressed = await this._llmCompress(chunk, modelSelection)
				summaryList.push(compressed)
			}
			summarizedRoundCount = targetSummarizedRoundCount
		}

		this._summaryBySession.set(threadId, {
			summarizedRoundCount,
			summaryList,
		})

		if (summarizedRoundCount === 0) {
			return { summaryStr: '', filteredMessages: messages }
		}

		const fullRounds = rounds.slice(summarizedRoundCount)

		// Build the summary string
		let summaryStr = ''
		if (summaryList.length > 0) {
			summaryStr = summaryList.map((s, i) => `\`\`\`\nSummary ${i + 1}:\n${s}\n\`\`\``).join('\n\n')
			// Trim if exceeds maxSummaryChars (trim from the beginning to preserve latest summaries)
			if (summaryStr.length > maxSummaryChars) {
				const trimmed = summaryStr.slice(-maxSummaryChars)
				summaryStr = `...(earlier summaries truncated)\n${trimmed}`
			}
		}

		// The filtered messages = only the full rounds
		const filteredMessages = fullRounds.flat()

		return { summaryStr, filteredMessages }
	}

	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {

		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'aborted_assistant') {
				// mark aborted content so the LLM knows not to continue it
					simpleLLMMessages.push({
						role: 'assistant',
						content: '[The previous response was interrupted by the user. Ignore the above and continue with the latest question.]',
						reasoning: '',
						anthropicReasoning: null,
					})
					continue
				}
				if (m.role === 'assistant') {
					simpleLLMMessages.push({
						role: m.role,
						content: m.displayContent,
						reasoning: m.reasoning,
						anthropicReasoning: m.anthropicReasoning,
					})
				}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareAgentRunPromptContext: IConvertToLLMMessageService['prepareAgentRunPromptContext'] = async ({ chatMode, modelSelection }) => {
		if (modelSelection === null) return { systemMessage: '', aiInstructions: '' }

		const { overridesOfModel } = this.voidSettingsService.state
		const { providerName, modelName } = modelSelection
		const { specialToolFormat } = getModelCapabilities(providerName, modelName, overridesOfModel)
		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings

		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage
		const aiInstructions = await this._getCombinedAIInstructionsAsync()

		return { systemMessage, aiInstructions }
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, promptContextOverride, threadId }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const promptContext = promptContextOverride ?? await this.prepareAgentRunPromptContext({ chatMode, modelSelection })
		const systemMessage = promptContext.systemMessage

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		const aiInstructions = promptContext.aiInstructions
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages)

		// Apply history compression if needed
		let effectiveSystemMessage = systemMessage
		let effectiveMessages = llmMessages

		if (threadId) {
			const { summaryStr, filteredMessages } = await this._getOrCreateCompressedSummaries(threadId, llmMessages, modelSelection)
			if (summaryStr) {
				effectiveSystemMessage = systemMessage + '\n\n--- Earlier Conversation History ---\n' + summaryStr
				effectiveMessages = filteredMessages
			}
		}

		// On-the-fly token-level compression (safety net)
		if (effectiveMessages.length > 0) {
			// Keep only the last `maxFullRounds * N` messages for safety
			const userCount = effectiveMessages.filter(m => m.role === 'user').length
			if (userCount > CHAT_HISTORY_COMPRESSION.maxFullRounds * 3) {
				// Extreme edge case: even after summary, too many user messages.
				// Trim to the last few round groups even after summary, as a final safety net.
				const rounds = this._splitIntoRounds(effectiveMessages)
				effectiveMessages = rounds.slice(-CHAT_HISTORY_COMPRESSION.maxFullRounds * CHAT_HISTORY_COMPRESSION.roundsPerSummaryChunk).flat()
			}
		}

		const { messages, separateSystemMessage } = prepareMessages({
			messages: effectiveMessages,
			systemMessage: effectiveSystemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/
