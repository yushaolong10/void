import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Schemas } from '../../../../base/common/network.js';
import { ChatMessage, ChatMessageContextMetadata, ImageAttachment } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage, CHAT_HISTORY_COMPRESSION, compressHistoryPrompt } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, AnthropicUserContentPart, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, OpenAIUserContentPart, RawToolParamsObj, ServiceSendLLMMessageParams } from '../common/sendLLMMessageTypes.js';
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
import { IAgentExtensionService } from './agent/AgentExtensionService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { computeTargetSummarizedRoundCount, CONTEXT_BUDGET_DEFAULTS, estimateTextTokens, reduceToolResultForSummary, stableTextHash, startsExternalConversationRound } from '../common/agent/context/ContextOptimization.js';

export const EMPTY_MESSAGE = '(empty message)'

const OPEN_FILE_SCHEMES = new Set([
	Schemas.file,
	Schemas.vscodeRemote,
	Schemas.vscodeUserData,
])



type SimpleUserPart =
	| { type: 'text'; text: string }
	| { type: 'image'; mimeType: ImageAttachment['mimeType']; dataUrl: string; name: string }

type SimpleLLMMessage = ({
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
	imageAttachment?: ImageAttachment;
} | {
	role: 'user';
	content: string;
	parts?: SimpleUserPart[];
} | {
	role: 'assistant';
	content: string;
	reasoning: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}) & {
	contextMeta?: ChatMessageContextMetadata;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120
const DIRECTORY_STR_CACHE_TTL_MS = 30_000
const VOID_RULES_CACHE_TTL_MS = 30_000
const AGENT_MANIFEST_FILENAMES = ['AGENTS.md', 'VOID.md', 'CLAUDE.md', '.voidrules'] as const
const MAX_IMAGE_PAYLOAD_MESSAGES_IN_HISTORY = 2
const OLDER_IMAGE_OMITTED_REASON = 'older image omitted from LLM context to reduce cost'
const HISTORY_SUMMARY_STORAGE_KEY = 'void.agent.historySummaries.v2'

interface HistorySummaryChunk {
	readonly startRound: number;
	readonly endRound: number;
	readonly sourceHash: string;
	readonly summary: string;
}

interface ThreadHistorySummaryState {
	readonly chunks: readonly HistorySummaryChunk[];
}

const dataUrlToBase64 = (dataUrl: string) => {
	const commaIdx = dataUrl.indexOf(',')
	return commaIdx === -1 ? dataUrl : dataUrl.slice(commaIdx + 1)
}

const simpleUserPartsToOpenAIContent = (msg: SimpleLLMMessage & { role: 'user' }): string | OpenAIUserContentPart[] => {
	if (!msg.parts?.length) return msg.content
	return msg.parts.map((part): OpenAIUserContentPart => {
		if (part.type === 'text') return { type: 'text', text: part.text }
		return { type: 'image_url', image_url: { url: part.dataUrl } }
	})
}

const simpleUserPartsToAnthropicContent = (msg: SimpleLLMMessage & { role: 'user' }): string | AnthropicUserContentPart[] => {
	if (!msg.parts?.length) return msg.content
	return msg.parts.map((part): AnthropicUserContentPart => {
		if (part.type === 'text') return { type: 'text', text: part.text }
		return {
			type: 'image',
			source: {
				type: 'base64',
				media_type: part.mimeType,
				data: dataUrlToBase64(part.dataUrl),
			}
		}
	})
}

const imageAttachmentToOpenAIContent = (attachment: ImageAttachment, text: string): OpenAIUserContentPart[] => [
	{ type: 'text', text },
	{ type: 'image_url', image_url: { url: attachment.dataUrl } }
]

const imageAttachmentToAnthropicContent = (attachment: ImageAttachment, text: string): AnthropicUserContentPart[] => [
	{ type: 'text', text },
	{
		type: 'image',
		source: {
			type: 'base64',
			media_type: attachment.mimeType,
			data: dataUrlToBase64(attachment.dataUrl),
		}
	}
]

const disabledImageAttachmentText = (attachment: ImageAttachment) =>
	`[Image not sent to model: ${attachment.name}${attachment.disabledReason ? ` (${attachment.disabledReason})` : ''}]`

const syncTrimmedUserContentToParts = (msg: SimpleLLMMessage | { role: 'system', content: string }) => {
	if (msg.role !== 'user' || !msg.parts?.length) return
	const firstTextPart = msg.parts.find(part => part.type === 'text')
	if (firstTextPart?.type === 'text') firstTextPart.text = msg.content
}




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
				const assistantMsg: OpenAILLMChatMessage = {
					role: 'assistant',
					content: currMsg.content,
					reasoning_content: currMsg.reasoning || undefined,
				}
				const toolCalls: { type: 'function'; id: string; function: { name: string; arguments: string; } }[] = []
				for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) {
					const toolMsg = messages[j] as SimpleLLMMessage & { role: 'tool' }
					toolCalls.push({
						type: 'function',
						id: toolMsg.id,
						function: {
							name: toolMsg.name,
							arguments: JSON.stringify(toolMsg.rawParams)
						}
					})
				}
				if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
				newMessages.push(assistantMsg)
				continue
			}
			if (currMsg.role === 'user') {
				newMessages.push({
					role: 'user',
					content: simpleUserPartsToOpenAIContent(currMsg),
				})
				continue
			}
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			const toolCall = {
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			} as const
			if (!prevMsg.tool_calls?.some(t => t.id === currMsg.id)) {
				prevMsg.tool_calls = [...(prevMsg.tool_calls ?? []), toolCall]
			}
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
		const nextMsg = messages[i + 1]
		if (nextMsg?.role !== 'tool') {
			let firstToolIdx = i
			while (firstToolIdx > 0 && messages[firstToolIdx - 1].role === 'tool') firstToolIdx -= 1
			for (let j = firstToolIdx; j <= i; j += 1) {
				const toolMsg = messages[j]
				if (toolMsg.role !== 'tool' || !toolMsg.imageAttachment) continue
				const text = toolMsg.imageAttachment.isLLMDisabled
					? disabledImageAttachmentText(toolMsg.imageAttachment)
					: `Image read from tool result: ${toolMsg.imageAttachment.name}`
				newMessages.push({
					role: 'user',
					content: toolMsg.imageAttachment.isLLMDisabled
						? text
						: imageAttachmentToOpenAIContent(toolMsg.imageAttachment, text),
				})
			}
		}
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
			const assistantMsg = newMessages[i]
			if (assistantMsg.role === 'assistant') {
				if (typeof assistantMsg.content === 'string') assistantMsg.content = [{ type: 'text', text: assistantMsg.content }]
				for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) {
					const toolMsg = messages[j] as SimpleLLMMessage & { role: 'tool' }
					if (!assistantMsg.content.some(c => c.type === 'tool_use' && c.id === toolMsg.id)) {
						assistantMsg.content.push({ type: 'tool_use', id: toolMsg.id, name: toolMsg.name, input: toolMsg.rawParams })
					}
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: simpleUserPartsToAnthropicContent(currMsg),
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]
				if (!prevMsg.content.some(c => c.type === 'tool_use' && c.id === currMsg.id)) {
					prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
				}
			}

			// turn each tool into a user message with tool results at the end
			const imageContent = currMsg.imageAttachment
				? currMsg.imageAttachment.isLLMDisabled
					? [{ type: 'text' as const, text: disabledImageAttachmentText(currMsg.imageAttachment) }]
					: imageAttachmentToAnthropicContent(currMsg.imageAttachment, `Image read from tool result: ${currMsg.imageAttachment.name}`)
				: []
			newMessages[i] = {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content },
					...imageContent
				]
			}
			continue
		}

	}

	// we just removed the tools
	const mergedMessages: AnthropicLLMChatMessage[] = []
	for (const message of newMessages as AnthropicLLMChatMessage[]) {
		const previous = mergedMessages[mergedMessages.length - 1]
		if (previous?.role === 'user' && message.role === 'user' && Array.isArray(previous.content) && Array.isArray(message.content)) {
			previous.content.push(...message.content)
		}
		else {
			mergedMessages.push(message)
		}
	}
	return mergedMessages
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			const toolXMLStrings: string[] = []
			for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) {
				const toolMsg = messages[j] as SimpleLLMMessage & { role: 'tool' }
				toolXMLStrings.push(reParsedToolXMLString(toolMsg.name, toolMsg.rawParams))
			}
			if (toolXMLStrings.length > 0) {
				content = `${content}\n\n${toolXMLStrings.join('\n\n')}`
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
			if (c.role === 'user' && c.parts?.length) {
				const textContent = c.content
				const imageLabels = c.parts.filter(part => part.type === 'image').map(part => `[Image: ${part.name}]`)
				c.content = [textContent, ...imageLabels].filter(Boolean).join('\n\n')
			}
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
	// User parts are updated when text is trimmed, so clone the nested array as well.
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = messages_.map(m => m.role === 'user'
		? { ...m, parts: m.parts?.map(part => ({ ...part })) }
		: { ...m })

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voidrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => {
		const next = { ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }
		syncTrimmedUserContentToParts(next)
		return next
	})

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
				syncTrimmedUserContentToParts(m)
				break
			}

			// Trim the entire message to TRIM_TO_LEN
			remainingCharsToTrim -= numCharsWillTrim
			m.content = m.content.substring(0, trimmedLen) + '...'
			syncTrimmedUserContentToParts(m)
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
		const firstContent = llmMessages[0].content
		const newFirstMessage = (Array.isArray(firstContent)
			? {
				role: 'user',
				content: [{ type: 'text', text: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>` }, ...firstContent] as AnthropicUserContentPart[] | OpenAIUserContentPart[]
			}
			: {
				role: 'user',
				content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${firstContent}`
			}) as AnthropicOrOpenAILLMMessage
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
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, promptContextOverride?: { systemMessage: string, aiInstructions: string }, threadId: string, onWillCompress?: () => void }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
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

	// Frozen summaries are persisted and guarded by a hash of their source rounds.
	// A thread edit invalidates only the affected chunk and everything after it.
	private readonly _summaryBySession = new Map<string, ThreadHistorySummaryState>();

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
		@IAgentExtensionService private readonly _agentExtensionService: IAgentExtensionService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super()
		this._loadHistorySummaries()
	}

	private _loadHistorySummaries(): void {
		const raw = this._storageService.get(HISTORY_SUMMARY_STORAGE_KEY, StorageScope.WORKSPACE)
		if (!raw) return
		try {
			const parsed = JSON.parse(raw) as Record<string, ThreadHistorySummaryState>
			for (const [threadId, state] of Object.entries(parsed)) {
				if (Array.isArray(state?.chunks)) this._summaryBySession.set(threadId, state)
			}
		}
		catch {
			// Corrupt or old summary state is safe to discard; source chat messages remain persisted.
		}
	}

	private _storeHistorySummaries(): void {
		this._storageService.store(
			HISTORY_SUMMARY_STORAGE_KEY,
			JSON.stringify(Object.fromEntries(this._summaryBySession)),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		)
	}

		// Read agent instruction files from workspace folders.
		private _getVoidRulesFileContents(): string {
			try {
				const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
				let voidRules = '';
				for (const folder of workspaceFolders) {
					for (const filename of AGENT_MANIFEST_FILENAMES) {
						const uri = URI.joinPath(folder.uri, filename)
						const { model } = this.voidModelService.getModel(uri)
						if (!model) continue
						voidRules += `# ${filename}\n${model.getValue(EndOfLinePreference.LF)}\n\n`;
					}
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
				const contents = await Promise.all(workspaceFolders.flatMap(folder => AGENT_MANIFEST_FILENAMES.map(async filename => {
					try {
						const uri = URI.joinPath(folder.uri, filename);
						const fileContent = await this.fileService.readFile(uri);
						return `# ${filename}\n${fileContent.value.toString()}`;
					}
					catch {
						return '';
					}
				})));

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
		const skillInstructions = this._getSkillInstructions();

		const ans: string[] = [];
		if (globalAIInstructions) ans.push(globalAIInstructions);
		if (voidRulesFileContent) ans.push(voidRulesFileContent);
		if (skillInstructions) ans.push(skillInstructions);
		return ans.join('\n\n');
	}

	private _getSkillInstructions(): string {
		const skills = this._agentExtensionService.listSkills();
		if (!skills.length) return '';
		return [
			'# Available Void Skills',
			'Use these workspace skills when the user task matches their description. Respect each skill tool list and context.',
			...[...skills].sort((a, b) => a.name.localeCompare(b.name)).map(skill => {
				const tools = skill.tools.length ? skill.tools.join(', ') : 'any appropriate tool';
				const body = skill.body.trim().slice(0, 4000);
				return `## ${skill.name}\nDescription: ${skill.description || '(none)'}\nContext: ${skill.context}\nTools: ${tools}\n${body}`;
			}),
		].join('\n\n');
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
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, supportsVision?: boolean) => {
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
			mcpToolsHash: stableTextHash(JSON.stringify([...(mcpTools ?? [])]
				.sort((a, b) => `${a.mcpServerName}:${a.name}`.localeCompare(`${b.mcpServerName}:${b.name}`))
				.map(tool => ({ ...tool, params: Object.fromEntries(Object.entries(tool.params).sort(([a], [b]) => a.localeCompare(b))) })))),
			chatMode,
			includeXMLToolDefinitions,
			supportsVision,
		})

		if (this._systemMessageCache?.key === cacheKey) {
			return this._systemMessageCache.value
		}

		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions, supportsVision })
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
			if (startsExternalConversationRound(m)) {
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
				const label = m.contextMeta?.origin === 'internal-plan' ? 'Internal plan update' : 'User'
				parts.push(`${label}: ${m.content}`)
			} else if (m.role === 'assistant') {
				parts.push(`Assistant: ${m.content}`)
			} else if (m.role === 'tool') {
				const params = JSON.stringify(m.rawParams)
				const result = reduceToolResultForSummary(m.name, m.content)
				parts.push(`Tool[${m.name}] params=${params}:\n${result}`)
			}
		}
		return parts.join('\n')
	}

	private _roundHash(rounds: readonly SimpleLLMMessage[][]): string {
		return stableTextHash(rounds.map(round => round.map(message => {
			if (message.role === 'tool') return `${message.role}:${message.name}:${JSON.stringify(message.rawParams)}:${message.content}`
			return `${message.role}:${message.content}:${message.contextMeta?.origin ?? ''}`
		}).join('\n')).join('\n---\n'))
	}

	private _roundTokenCost(round: readonly SimpleLLMMessage[]): number {
		return round.reduce((sum, message) => {
			let cost = estimateTextTokens(message.content)
			if (message.role === 'tool') cost += estimateTextTokens(JSON.stringify(message.rawParams)) + 12
			if (message.role === 'assistant') cost += estimateTextTokens(message.reasoning ?? '')
			return sum + cost + 4
		}, 0)
	}

	// Synchronously compress a list of rounds using LLM (or fallback to rule-based summary).
	// Returns a single compact summary string for all the given rounds.
	private async _llmCompress(rounds: SimpleLLMMessage[][], modelSelection: ModelSelection): Promise<string> {
		const dialogStr = rounds.map(r => this._roundToCompressionPrompt(r)).join('\n\n---\n\n')

		const prompt = `${compressHistoryPrompt}\n\n${dialogStr}\n\nSummary:`

		try {
			// Use sendLLMMessage with the user's chat model for compression.
			// We construct a minimal single-turn chat completion request.
			const res = await new Promise<string>((resolve, reject) => {
				const requestId = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode: null,
					messages: [
						{ role: 'user', content: prompt }
					],
					modelSelection: modelSelection,
					modelSelectionOptions: undefined,
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
	// Returns memory to prepend to the oldest retained user turn and the filtered messages.
	private async _getOrCreateCompressedSummaries(
		threadId: string,
		messages: SimpleLLMMessage[],
		modelSelection: ModelSelection,
		historyBudgetTokens: number,
		onWillCompress?: () => void,
	): Promise<{
		summaryStr: string; // the full summary string (multiple blocks concatenated), or empty if no compression needed
		filteredMessages: SimpleLLMMessage[]; // messages after removing summarized rounds
	}> {
		const rounds = this._splitIntoRounds(messages)
		const { maxSummaryChars } = CHAT_HISTORY_COMPRESSION
		const existingChunks = this._summaryBySession.get(threadId)?.chunks ?? []
		const validChunks: HistorySummaryChunk[] = []
		for (const chunk of existingChunks) {
			if (chunk.startRound !== (validChunks[validChunks.length - 1]?.endRound ?? 0)) break
			if (chunk.endRound > rounds.length) break
			if (this._roundHash(rounds.slice(chunk.startRound, chunk.endRound)) !== chunk.sourceHash) break
			validChunks.push(chunk)
		}

		let summarizedRoundCount = validChunks[validChunks.length - 1]?.endRound ?? 0
		const summaryTokens = validChunks.reduce((sum, chunk) => sum + estimateTextTokens(chunk.summary), 0)
		const targetSummarizedRoundCount = computeTargetSummarizedRoundCount({
			rounds: rounds.map(round => ({
				tokenCost: this._roundTokenCost(round),
				pinned: round.some(message => message.contextMeta?.pinned),
			})),
			alreadySummarized: summarizedRoundCount,
			historyBudgetTokens,
			summaryTokens,
		})

		if (summarizedRoundCount < targetSummarizedRoundCount) onWillCompress?.()
		while (summarizedRoundCount < targetSummarizedRoundCount) {
			const endRound = Math.min(
				targetSummarizedRoundCount,
				summarizedRoundCount + CONTEXT_BUDGET_DEFAULTS.maxRoundsPerSummaryChunk,
			)
			const sourceRounds = rounds.slice(summarizedRoundCount, endRound)
			const compressed = await this._llmCompress(sourceRounds, modelSelection)
			validChunks.push({
				startRound: summarizedRoundCount,
				endRound,
				sourceHash: this._roundHash(sourceRounds),
				summary: compressed,
			})
			summarizedRoundCount = endRound
		}

		this._summaryBySession.set(threadId, { chunks: validChunks })
		this._storeHistorySummaries()

		if (summarizedRoundCount === 0) {
			return { summaryStr: '', filteredMessages: messages }
		}

		const fullRounds = rounds.slice(summarizedRoundCount)

		// Build the summary string
		let summaryStr = ''
		if (validChunks.length > 0) {
			const blocks = validChunks.map((chunk, i) => `Summary ${i + 1} (rounds ${chunk.startRound + 1}-${chunk.endRound}):\n${chunk.summary}`)
			summaryStr = blocks.join('\n\n')
			if (summaryStr.length > maxSummaryChars) {
				const first = blocks[0].slice(0, Math.min(1_500, maxSummaryChars))
				const latest: string[] = []
				let used = first.length + 80
				for (let i = blocks.length - 1; i > 0; i--) {
					if (used + blocks[i].length > maxSummaryChars) break
					latest.unshift(blocks[i])
					used += blocks[i].length + 2
				}
				summaryStr = `${first}\n\n[Some intermediate summaries omitted]\n\n${latest.join('\n\n')}`.slice(0, maxSummaryChars)
			}
		}

		// The filtered messages = only the full rounds
		const filteredMessages = fullRounds.flat()

		return { summaryStr, filteredMessages }
	}

	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {

		const simpleLLMMessages: SimpleLLMMessage[] = []
		const imagePayloadMessageIdxs = new Set<number>()
		for (let i = chatMessages.length - 1; i >= 0 && imagePayloadMessageIdxs.size < MAX_IMAGE_PAYLOAD_MESSAGES_IN_HISTORY; i -= 1) {
			const message = chatMessages[i]
			const hasEnabledUserImage = message.role === 'user' && !!message.attachments?.some(attachment => !attachment.isLLMDisabled)
			const hasEnabledToolImage = message.role === 'tool'
				&& message.type === 'success'
				&& message.name === 'read_image'
				&& !!(message.result as { attachment?: ImageAttachment }).attachment
				&& !(message.result as { attachment?: ImageAttachment }).attachment?.isLLMDisabled
			if (hasEnabledUserImage || hasEnabledToolImage) imagePayloadMessageIdxs.add(i)
		}

		for (let i = 0; i < chatMessages.length; i += 1) {
			const m = chatMessages[i]
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'aborted_assistant') {
				// mark aborted content so the LLM knows not to continue it
				simpleLLMMessages.push({
					role: 'assistant',
					contextMeta: m.contextMeta,
					content: '[The previous response was interrupted by the user. Ignore the above and continue with the latest question.]',
					reasoning: '',
					anthropicReasoning: null,
				})
				continue
			}
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					contextMeta: m.contextMeta,
					content: m.displayContent,
					reasoning: m.reasoning,
					anthropicReasoning: m.anthropicReasoning,
					})
				}
				else if (m.role === 'tool') {
					const imageAttachment = m.type === 'success' && m.name === 'read_image'
						? (m.result as { attachment?: ImageAttachment }).attachment
						: undefined
					const imageAttachmentForLLM = imageAttachment && !imagePayloadMessageIdxs.has(i) && !imageAttachment.isLLMDisabled
						? { ...imageAttachment, isLLMDisabled: true, disabledReason: OLDER_IMAGE_OMITTED_REASON }
						: imageAttachment
				simpleLLMMessages.push({
					role: m.role,
					contextMeta: m.contextMeta,
						content: m.content,
						name: m.name,
						id: m.id,
						rawParams: m.rawParams,
						imageAttachment: imageAttachmentForLLM,
					})
				}
				else if (m.role === 'user') {
					const attachments = m.attachments ?? []
					const attachmentsForLLM = imagePayloadMessageIdxs.has(i)
						? attachments
						: attachments.map(attachment => attachment.isLLMDisabled ? attachment : {
							...attachment,
							isLLMDisabled: true,
							disabledReason: OLDER_IMAGE_OMITTED_REASON,
						})
					const enabledAttachments = attachmentsForLLM.filter(attachment => !attachment.isLLMDisabled)
					const content = [
						m.content,
						...attachmentsForLLM.filter(attachment => attachment.isLLMDisabled).map(disabledImageAttachmentText)
					].filter(Boolean).join('\n\n')
				simpleLLMMessages.push({
					role: m.role,
					contextMeta: m.contextMeta,
						content,
						parts: enabledAttachments.length ? [
							{ type: 'text', text: content },
							...enabledAttachments.map((attachment): SimpleUserPart => ({
								type: 'image',
								mimeType: attachment.mimeType,
								dataUrl: attachment.dataUrl,
								name: attachment.name,
							}))
						] : undefined,
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
		const { specialToolFormat, supportsVision } = getModelCapabilities(providerName, modelName, overridesOfModel)
		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings

		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, supportsVision)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage
		const aiInstructions = await this._getCombinedAIInstructionsAsync()

		return { systemMessage, aiInstructions }
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, promptContextOverride, threadId, onWillCompress }) => {
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
		let effectiveMessages = llmMessages

		if (threadId) {
			const reservedForBudget = Math.max(contextWindow * 1 / 2, reservedOutputTokenSpace ?? 4_096)
			const fixedPromptTokens = estimateTextTokens(`${aiInstructions}\n${systemMessage}`) + 2_048 // native tool schemas
			const historyBudgetTokens = Math.max(2_000, contextWindow - reservedForBudget - fixedPromptTokens)
			const { summaryStr, filteredMessages } = await this._getOrCreateCompressedSummaries(threadId, llmMessages, modelSelection, historyBudgetTokens, onWillCompress)
			if (summaryStr) {
				effectiveMessages = filteredMessages.map(message => message.role === 'user'
					? { ...message, parts: message.parts?.map(part => ({ ...part })) }
					: { ...message })
				const firstUser = effectiveMessages.find(message => message.role === 'user')
				if (firstUser?.role === 'user') {
					firstUser.content = `[Earlier conversation memory]\n${summaryStr}\n[End earlier conversation memory]\n\n${firstUser.content}`
					syncTrimmedUserContentToParts(firstUser)
				}
			}
		}

		const { messages, separateSystemMessage } = prepareMessages({
			messages: effectiveMessages,
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
