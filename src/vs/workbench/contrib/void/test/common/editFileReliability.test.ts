/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { rewriteFallbackPolicyError } from '../../common/agent/tools/EditToolPolicy.js';
import { decodeSearchReplaceXMLEntities, extractSearchReplaceBlocks, normalizeSearchReplaceBlocks } from '../../common/helpers/extractCodeFromResult.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';

suite('Void edit_file reliability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes common SEARCH and REPLACE markers and code fences', () => {
		const normalized = normalizeSearchReplaceBlocks(`\`\`\`diff\n<<<<<<< SEARCH\nconst x = 1\n=======\nconst x = 2\n>>>>>>> REPLACE\n\`\`\``)
		const blocks = extractSearchReplaceBlocks(normalized)
		assert.strictEqual(blocks.length, 1)
		assert.deepStrictEqual(blocks[0], { state: 'done', orig: 'const x = 1', final: 'const x = 2' })
	})

	test('decodes one XML escaping layer for JSX edit blocks', () => {
		assert.strictEqual(decodeSearchReplaceXMLEntities('&lt;Panel title=&quot;A&quot;&gt;&amp;&lt;/Panel&gt;'), '<Panel title="A">&</Panel>')
	})

	test('allows rewrite only after refreshed edit retries', () => {
		const uri = URI.file('/repo/file.ts')
		const tool = (name: 'edit_file' | 'read_file', type: 'tool_error' | 'success'): ChatMessage => ({
			role: 'tool', name, type, id: `${name}-${type}`, content: '', rawParams: { uri: uri.toString() }, mcpServerName: undefined,
			params: name === 'edit_file' ? { uri, searchReplaceBlocks: '' } : { uri, startLine: null, endLine: null, pageNumber: 1 },
			result: type === 'success' ? (name === 'read_file' ? { content: '', hasNextPage: false } : { lintErrors: null }) : 'not found',
		} as ChatMessage)
		const user = { role: 'user', content: 'edit', displayContent: 'edit', selections: null, state: { stagingSelections: [], isBeingEdited: false } } as ChatMessage
		assert(rewriteFallbackPolicyError([user, tool('edit_file', 'tool_error')], uri.fsPath))
		assert.strictEqual(rewriteFallbackPolicyError([
			user,
			tool('edit_file', 'tool_error'),
			tool('read_file', 'success'),
			tool('edit_file', 'tool_error'),
		], uri.fsPath), null)
	})
})
