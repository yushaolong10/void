/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VoidFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
	};
}


export type ImageAttachment = {
	type: 'image';
	id: string;
	name: string;
	mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
	sizeBytes: number;
	dataUrl: string;
	width?: number;
	height?: number;
	isLLMDisabled?: boolean;
	disabledReason?: string;
}

export type ChatMessageOrigin =
	| 'external-user'
	| 'assistant'
	| 'tool'
	| 'internal-plan'
	| 'internal-controller'
	| 'runtime-context';

export type ChatMessageContextMetadata = {
	/** Stable identity used by persisted context summaries. Optional for legacy messages. */
	id: string;
	origin: ChatMessageOrigin;
	/** Only external user messages start a conversation round. */
	startsRound?: boolean;
	/** Pinned messages must remain in the verbatim working set. */
	pinned?: boolean;
	phaseId?: string;
};

// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage = (
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		attachments?: ImageAttachment[];
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}
	}
	| {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking
		elapsedMs?: number;

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
	}
	| {
		role: 'aborted_assistant';
		displayContent: string; // content received from LLM before being aborted - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM before being aborted

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry
) & {
	/** Added as an optional field so persisted threads from older versions remain valid. */
	contextMeta?: ChatMessageContextMetadata;
}


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
