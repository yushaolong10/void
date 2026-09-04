/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, isOpenAICompatibleProviderName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo, PROMPT_CACHE_BREAKPOINT } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
	threadId?: string;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`
const LLM_STREAM_STALL_TIMEOUT_MS = 120_000

const createLLMStreamWatchdog = ({
	providerName,
	modelName,
	onError,
	onAbort,
}: {
	providerName: ProviderName;
	modelName: string;
	onError: OnError;
	onAbort: () => void;
}) => {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null
	let didFire = false

	const clear = () => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle)
			timeoutHandle = null
		}
	}

	const schedule = () => {
		clear()
		timeoutHandle = setTimeout(() => {
			if (didFire) return
			didFire = true
			try { onAbort() } catch { }
			onError({
				message: `Void: ${displayInfoOfProviderName(providerName).title} model "${modelName}" stopped streaming for ${Math.floor(LLM_STREAM_STALL_TIMEOUT_MS / 1000)} seconds, so the request was aborted.`,
				fullError: null
			})
		}, LLM_STREAM_STALL_TIMEOUT_MS)
	}

	return {
		bump: () => {
			if (didFire) return
			schedule()
		},
		clear,
		get didFire() {
			return didFire
		}
	}
}

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://voideditor.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'Void', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (isOpenAICompatibleProviderName(providerName)) {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`Void providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


const strictSchemaOfTool = (toolInfo: InternalToolInfo) => {
	const properties = Object.fromEntries(
		Object.entries(toolInfo.params)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, param]) => {
				const isOptional = param.required === false || /^optional\./i.test(param.description)
				return [name, {
					description: param.description,
					type: isOptional ? [param.type ?? 'string', 'null'] : param.type ?? 'string',
					...(param.enum ? { enum: isOptional ? [...param.enum, null] : [...param.enum] } : {}),
				}]
			}),
	)
	return {
		type: 'object' as const,
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	}
}

const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => ({
	type: 'function' as const,
	function: {
		name: toolInfo.name,
		description: toolInfo.description,
		strict: true,
		parameters: strictSchemaOfTool(toolInfo),
	}
}) satisfies OpenAI.Chat.Completions.ChatCompletionTool

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, options?: { supportsVision?: boolean }) => {
	const allowedTools = availableTools(chatMode, mcpTools, options)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const tool of [...allowedTools].sort((a, b) => a.name.localeCompare(b.name))) {
		// MCP schemas may contain constructs that are not accepted by OpenAI strict mode.
		openAITools.push(tool.mcpServerName ? {
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: {
					type: 'object',
					properties: Object.fromEntries(Object.entries(tool.params).map(([name, param]) => [name, { type: param.type ?? 'string', description: param.description }])),
				},
			},
		} : toOpenAICompatibleTool(tool))
	}
	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}

type StreamingOpenAIToolCall = {
	name: string;
	paramsStr: string;
	id: string;
}

const partialRawToolCallsOfOpenAIToolCalls = (toolCallsByIndex: Map<number, StreamingOpenAIToolCall>): RawToolCallObj[] => {
	return [...toolCallsByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.filter(([, toolCall]) => !!toolCall.name)
		.map(([index, toolCall]) => ({
			name: toolCall.name,
			rawParams: {},
			doneParams: [],
			isDone: false,
			id: toolCall.id || `tool_call_${index}`,
		}))
}

const rawToolCallsOfOpenAIToolCalls = (toolCallsByIndex: Map<number, StreamingOpenAIToolCall>): RawToolCallObj[] => {
	return [...toolCallsByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, toolCall]) => rawToolCallObjOfParamsStr(toolCall.name, toolCall.paramsStr, toolCall.id || generateUuid()))
		.filter((toolCall): toolCall is RawToolCallObj => !!toolCall)
}


type ResponsesThreadState = {
	previousResponseId: string;
	nextMessageIndex: number;
	providerName: ProviderName;
	modelName: string;
	endpoint?: string;
	messagePrefix: string[];
}

const responsesStateByThread = new Map<string, ResponsesThreadState>()

const responsesMessageFingerprint = (message: LLMChatMessage): string => JSON.stringify(message)

const toResponsesInput = (messages: LLMChatMessage[]): any[] => {
	const input: any[] = []
	for (const message of messages as any[]) {
		if (message.role === 'tool') {
			input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
			continue
		}
		if (message.role === 'assistant' && message.tool_calls?.length) {
			if (message.content) input.push({ role: 'assistant', content: message.content })
			for (const toolCall of message.tool_calls) {
				input.push({
					type: 'function_call',
					call_id: toolCall.id,
					name: toolCall.function.name,
					arguments: toolCall.function.arguments,
				})
			}
			continue
		}
		if (message.role === 'user' && Array.isArray(message.content)) {
			input.push({
				role: 'user',
				content: message.content.map((part: any) => part.type === 'image_url'
					? { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
					: { type: 'input_text', text: part.text ?? '' }),
			})
			continue
		}
		input.push(message)
	}
	return input
}

const toResponsesTool = (toolInfo: InternalToolInfo): OpenAI.Responses.FunctionTool => ({
	type: 'function',
	name: toolInfo.name,
	description: toolInfo.description,
	parameters: toolInfo.mcpServerName ? {
		type: 'object',
		properties: Object.fromEntries(Object.entries(toolInfo.params).map(([name, param]) => [name, { type: param.type ?? 'string', description: param.description }])),
	} : strictSchemaOfTool(toolInfo),
	strict: !toolInfo.mcpServerName,
})

const _sendOpenAIResponsesChat = async (params: SendChatParams_Internal) => {
	let { messages, onText, onFinalMessage, onError } = params
	const { providerName, modelName: modelName_, settingsOfProvider, modelSelectionOptions, overridesOfModel, chatMode, mcpTools, _setAborter, threadId, separateSystemMessage } = params
	const { modelName, supportsVision } = getModelCapabilities(providerName, modelName_, overridesOfModel)
const supportsParallelToolCalls = isOpenAICompatibleProviderName(providerName)
		? settingsOfProvider[providerName].supportsParallelToolCalls === 'true'
		: false
	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	const endpoint = settingsOfProvider[providerName].endpoint
	const state = threadId ? responsesStateByThread.get(threadId) : undefined
	const canContinue = !!state
		&& state.providerName === providerName
		&& state.modelName === modelName
		&& state.endpoint === endpoint
		&& state.nextMessageIndex <= messages.length
		&& state.messagePrefix.every((fingerprint, index) => responsesMessageFingerprint(messages[index]) === fingerprint)
	if (canContinue) messages = messages.slice(state.nextMessageIndex)
	else if (threadId && state) responsesStateByThread.delete(threadId)

	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel)
	const effort = reasoningInfo?.isReasoningEnabled && reasoningInfo.type === 'effort_slider_value'
		? reasoningInfo.reasoningEffort
		: undefined
	const tools = availableTools(chatMode, mcpTools, { supportsVision })?.map(toResponsesTool)
	const stream = openai.responses.stream({
		model: modelName,
		input: toResponsesInput(messages),
		...(separateSystemMessage ? { instructions: separateSystemMessage } : {}),
		...(tools?.length ? { tools } : {}),
		...(supportsParallelToolCalls && !!tools?.length ? { parallel_tool_calls: true } : {}),
		...(effort ? { reasoning: { effort } } : {}),
		...(canContinue ? { previous_response_id: state.previousResponseId } : {}),
		...(threadId ? { prompt_cache_key: `${threadId}:${modelName}` } : {}),
	} as any)
	_setAborter(() => stream.abort())

	let fullText = ''
	let completedResponse: any
	let responseFailure: any
	const toolCallsByIndex = new Map<number, StreamingOpenAIToolCall>()
	const watchdog = createLLMStreamWatchdog({ providerName, modelName, onError, onAbort: () => stream.abort() })
	watchdog.bump()
	try {
		for await (const event of stream) {
			watchdog.bump()
			if (event.type === 'response.output_text.delta') fullText += event.delta
			else if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
				toolCallsByIndex.set(event.output_index, { name: event.item.name, paramsStr: event.item.arguments, id: event.item.call_id })
			}
			else if (event.type === 'response.completed') completedResponse = event.response
			else if ((event as any).type === 'response.failed' || (event as any).type === 'response.incomplete') {
				responseFailure = (event as any).response ?? event
			}
			const partialToolCalls = partialRawToolCallsOfOpenAIToolCalls(toolCallsByIndex)
			onText({ fullText, fullReasoning: '', toolCall: partialToolCalls[0], toolCalls: partialToolCalls.length ? partialToolCalls : undefined })
		}
		if (responseFailure) {
			throw new Error(`OpenAI Responses request ${responseFailure.status ?? 'failed'}: ${responseFailure.error?.message ?? responseFailure.incomplete_details?.reason ?? 'unknown error'}`)
		}
		if (!completedResponse) completedResponse = await stream.finalResponse()
		if (completedResponse?.status && completedResponse.status !== 'completed') {
			throw new Error(`OpenAI Responses request ${completedResponse.status}: ${completedResponse.error?.message ?? completedResponse.incomplete_details?.reason ?? 'unknown error'}`)
		}
		if (threadId && completedResponse?.id) {
			responsesStateByThread.set(threadId, {
				previousResponseId: completedResponse.id,
				nextMessageIndex: params.messages.length + 1,
				providerName,
				modelName,
				endpoint,
				messagePrefix: params.messages.map(responsesMessageFingerprint),
			})
		}
		const toolCalls = rawToolCallsOfOpenAIToolCalls(toolCallsByIndex)
		if (!fullText && toolCalls.length === 0) {
			onError({ message: 'Void: Response from model was empty.', fullError: null })
			return
		}
		const usage = completedResponse?.usage
		onFinalMessage({
			fullText,
			fullReasoning: '',
			anthropicReasoning: null,
			...(toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}),
			usage: usage ? {
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
				cacheReadTokens: usage.input_tokens_details?.cached_tokens,
			} : undefined,
		})
	} catch (error) {
		if ((error as any)?.name === 'AbortError') return
		if (threadId) responsesStateByThread.delete(threadId)
		if (error instanceof OpenAI.APIError && error.status === 401) onError({ message: invalidApiKeyMessage(providerName), fullError: error })
		else onError({ message: error + '', fullError: error as Error })
	} finally {
		watchdog.clear()
	}
}

const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async (params: SendChatParams_Internal) => {
	const { messages, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, overridesOfModel, mcpTools } = params
	let { onText, onFinalMessage } = params
	const apiMode = isOpenAICompatibleProviderName(providerName) ? settingsOfProvider[providerName].apiMode : undefined
	if ((providerName === 'openAI' && /gpt[-.]5[.-]6/i.test(modelName_)) || apiMode === 'responses') {
		return _sendOpenAIResponsesChat(params)
	}
	const {
		modelName,
		specialToolFormat: modelSpecialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
		supportsVision,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)
	const supportsParallelToolCalls = isOpenAICompatibleProviderName(providerName)
		? settingsOfProvider[providerName].supportsParallelToolCalls === 'true'
		: false
	const configuredResponseFormat = isOpenAICompatibleProviderName(providerName)
		? settingsOfProvider[providerName].responseFormat
		: undefined
	const specialToolFormat = configuredResponseFormat === 'tool-call'
		? 'openai-style'
		: configuredResponseFormat === 'xml'
			? undefined
			: modelSpecialToolFormat

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools, { supportsVision })
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messages as any,
		stream: true,
		...(providerName === 'openAI' ? { stream_options: { include_usage: true } } : {}),
		...nativeToolsObj,
		...(supportsParallelToolCalls && specialToolFormat === 'openai-style' && !!potentialTools?.length ? { parallel_tool_calls: true } : {}),
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, { supportsVision })
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''
	let finalUsage: OpenAI.Completions.CompletionUsage | undefined

	const toolCallsByIndex = new Map<number, StreamingOpenAIToolCall>()

	openai.chat.completions
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())
			const watchdog = createLLMStreamWatchdog({
				providerName,
				modelName,
				onError,
				onAbort: () => response.controller.abort(),
			})
			watchdog.bump()
			try {
				// when receive text
				for await (const chunk of response) {
					watchdog.bump()
					if (chunk.usage) finalUsage = chunk.usage
					// message
					const newText = chunk.choices[0]?.delta?.content ?? ''
					fullTextSoFar += newText

					// tool call
					for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
						const index = tool.index
						const current = toolCallsByIndex.get(index) ?? { name: '', paramsStr: '', id: '' }
						current.name += tool.function?.name ?? ''
						current.paramsStr += tool.function?.arguments ?? '';
						current.id += tool.id ?? ''
						toolCallsByIndex.set(index, current)
					}


					// reasoning
					let newReasoning = ''
					if (nameOfReasoningFieldInDelta) {
						// @ts-ignore
						newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
						fullReasoningSoFar += newReasoning
					}

					// call onText
					const partialToolCalls = partialRawToolCallsOfOpenAIToolCalls(toolCallsByIndex)
					onText({
						fullText: fullTextSoFar,
						fullReasoning: fullReasoningSoFar,
						toolCall: partialToolCalls[0],
						toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
					})

				}
				// on final
				if (!fullTextSoFar && !fullReasoningSoFar && toolCallsByIndex.size === 0) {
					onError({ message: 'Void: Response from model was empty.', fullError: null })
				}
				else {
					const toolCalls = rawToolCallsOfOpenAIToolCalls(toolCallsByIndex)
					const toolCallObj = toolCalls.length > 0 ? { toolCall: toolCalls[0], toolCalls } : {}
					onFinalMessage({
						fullText: fullTextSoFar,
						fullReasoning: fullReasoningSoFar,
						anthropicReasoning: null,
						usage: finalUsage ? {
							inputTokens: finalUsage.prompt_tokens,
							outputTokens: finalUsage.completion_tokens,
							reasoningTokens: finalUsage.completion_tokens_details?.reasoning_tokens,
							cacheReadTokens: finalUsage.prompt_tokens_details?.cached_tokens,
						} : undefined,
						...toolCallObj,
					});
				}
			} finally {
				watchdog.clear()
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if ((error as any)?.name === 'AbortError') return
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) { paramsWithType[key] = { ...value, type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, options?: { supportsVision?: boolean }) => {
	const allowedTools = availableTools(chatMode, mcpTools, options)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const tool of [...allowedTools].sort((a, b) => a.name.localeCompare(b.name))) {
		anthropicTools.push(toAnthropicTool(tool))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		supportsVision,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools, { supportsVision })
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true
	});

	const systemBlocks = separateSystemMessage
		? separateSystemMessage.split(PROMPT_CACHE_BREAKPOINT).map((text, index, parts) => ({
			type: 'text' as const,
			text: text.trim(),
			...(index === 0 || (parts.length === 1 && index === parts.length - 1)
				? { cache_control: { type: 'ephemeral' as const } }
				: {}),
		})).filter(block => !!block.text)
		: undefined
	const stream = anthropic.messages.stream({
		system: systemBlocks,
		messages: messages as AnthropicLLMChatMessage[],
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, { supportsVision })
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	let fullToolName = ''
	let fullToolParams = ''


	const runOnText = () => {
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams: {}, isDone: false, doneParams: [], id: 'dummy' },
		})
	}
	const watchdog = createLLMStreamWatchdog({
		providerName,
		modelName,
		onError,
		onAbort: () => stream.controller.abort(),
	})
	watchdog.bump()
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		watchdog.bump()
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				fullToolName += e.content_block.name ?? '' // anthropic gives us the tool name in the start block
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				fullToolParams += e.delta.partial_json ?? '' // anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		watchdog.clear()
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter(c => c.type === 'tool_use')
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))
		const toolCalls = tools
			.map(tool => rawToolCallObjOfAnthropicParams(tool))
			.filter((toolCall): toolCall is RawToolCallObj => !!toolCall)
		const toolCallObj = toolCalls.length > 0 ? { toolCall: toolCalls[0], toolCalls } : {}

		onFinalMessage({
			fullText,
			fullReasoning,
			anthropicReasoning,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
				cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
				cacheWriteTokens: response.usage.cache_creation_input_tokens ?? undefined,
			},
			...toolCallObj,
		})
	})
	// on error
	stream.on('error', (error) => {
		watchdog.clear()
		if ((error as any)?.name === 'AbortError') return
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, options?: { supportsVision?: boolean }): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools, options)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const tool of [...allowedTools].sort((a, b) => a.name.localeCompare(b.name))) {
		functionDecls.push(toGeminiFunctionDecl(tool))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		supportsVision,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools, { supportsVision })
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, { supportsVision })
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''
	let finalUsageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined

	let toolName = ''
	let toolParamsStr = ''
	let toolId = ''


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });
			const watchdog = createLLMStreamWatchdog({
				providerName,
				modelName,
				onError,
				onAbort: () => { stream.return(fullTextSoFar); },
			})
			watchdog.bump()
			try {
				// Process the stream
				for await (const chunk of stream) {
					watchdog.bump()
					if (chunk.usageMetadata) finalUsageMetadata = chunk.usageMetadata
					// message
					const newText = chunk.text ?? ''
					fullTextSoFar += newText

					// tool call
					const functionCalls = chunk.functionCalls
					if (functionCalls && functionCalls.length > 0) {
						const functionCall = functionCalls[0] // Get the first function call
						toolName = functionCall.name ?? ''
						toolParamsStr = JSON.stringify(functionCall.args ?? {})
						toolId = functionCall.id ?? ''
					}

					// (do not handle reasoning yet)

					// call onText
					onText({
						fullText: fullTextSoFar,
						fullReasoning: fullReasoningSoFar,
						toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
					})
				}

				// on final
				if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
					onError({ message: 'Void: Response from model was empty.', fullError: null })
				} else {
					if (!toolId) toolId = generateUuid() // ids are empty, but other providers might expect an id
					const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
					const toolCallObj = toolCall ? { toolCall } : {}
					onFinalMessage({
						fullText: fullTextSoFar,
						fullReasoning: fullReasoningSoFar,
						anthropicReasoning: null,
						usage: finalUsageMetadata ? {
							inputTokens: finalUsageMetadata.promptTokenCount,
							outputTokens: finalUsageMetadata.candidatesTokenCount,
							cacheReadTokens: finalUsageMetadata.cachedContentTokenCount,
						} : undefined,
						...toolCallObj,
					});
				}
			} finally {
				watchdog.clear()
			}
		})
		.catch(error => {
			if ((error as any)?.name === 'AbortError') return
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openAICompatible1: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openAICompatible2: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openAICompatible3: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
