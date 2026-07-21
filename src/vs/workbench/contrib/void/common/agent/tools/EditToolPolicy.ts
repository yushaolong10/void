/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { ChatMessage } from '../../chatThreadServiceTypes.js';

const toolMessageURIPath = (message: ChatMessage): string | null => {
	if (message.role !== 'tool') return null
	const paramsURI = message.type !== 'invalid_params' ? (message.params as { uri?: URI }).uri : undefined
	if (paramsURI instanceof URI) return paramsURI.fsPath
	const rawURI = message.rawParams.uri
	if (typeof rawURI === 'string') {
		try { return URI.parse(rawURI).fsPath } catch { return rawURI }
	}
	return null
}

/**
 * Existing files may only be rewritten after edit_file was retried with fresh
 * context. Newly created files are intentionally exempt.
 */
export const rewriteFallbackPolicyError = (messages: ChatMessage[], targetPath: string): string | null => {
	let roundStart = 0
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]
		if (message.role === 'user' && message.contextMeta?.origin !== 'internal-plan') {
			roundStart = i
			break
		}
	}
	const roundMessages = messages.slice(roundStart)
	const sameTarget = (message: ChatMessage) => toolMessageURIPath(message) === targetPath
	const createdThisRound = roundMessages.some(message => message.role === 'tool'
		&& message.name === 'create_file_or_folder'
		&& message.type === 'success'
		&& sameTarget(message))
	if (createdThisRound) return null

	const failedEditIndices: number[] = []
	for (let i = 0; i < roundMessages.length; i += 1) {
		const message = roundMessages[i]
		if (message.role === 'tool'
			&& message.name === 'edit_file'
			&& (message.type === 'tool_error' || message.type === 'invalid_params')
			&& sameTarget(message)) {
			failedEditIndices.push(i)
		}
	}
	if (failedEditIndices.length < 2) {
		return `rewrite_file is reserved as a fallback for existing files. Re-read the smallest relevant range of ${targetPath} and retry edit_file with smaller, exact, unique ORIGINAL text. Two failed edit_file attempts are required before whole-file replacement.`
	}

	const refreshedBetweenAttempts = roundMessages.some((message, index) => index > failedEditIndices[0]
		&& index < failedEditIndices[1]
		&& message.role === 'tool'
		&& message.name === 'read_file'
		&& message.type === 'success'
		&& sameTarget(message))
	if (!refreshedBetweenAttempts) {
		return `Before falling back to rewrite_file, read fresh context from ${targetPath} and make one more targeted edit_file attempt using exact text from that read.`
	}
	return null
}
