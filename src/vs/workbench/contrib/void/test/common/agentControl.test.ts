/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildResourceDependencies, createAgentRunBudget, findLastUnverifiedMutationIndex, MAX_AGENT_TOOL_CALLS, reserveAgentToolCalls } from '../../common/agent/runtime/AgentControl.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';

suite('Void agent control', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('enforces a cumulative tool-call budget', () => {
		const budget = createAgentRunBudget();
		assert.strictEqual(reserveAgentToolCalls(budget, MAX_AGENT_TOOL_CALLS - 2), MAX_AGENT_TOOL_CALLS - 2);
		assert.strictEqual(reserveAgentToolCalls(budget, 10), 2);
		assert.strictEqual(reserveAgentToolCalls(budget, 1), 0);
		assert.strictEqual(budget.toolCalls, MAX_AGENT_TOOL_CALLS);
	});

	test('builds ordered dependencies only for the same resource', () => {
		assert.deepStrictEqual(
			buildResourceDependencies(['file:a', 'file:b', 'file:a', 'file:c', 'file:b']),
			[null, null, 0, null, 1],
		);
	});

	test('requires successful verification after the latest mutation', () => {
		const uri = URI.file('/repo/file.ts');
		const edit = {
			role: 'tool', name: 'edit_file', type: 'success', id: 'edit', content: 'changed', rawParams: {}, mcpServerName: undefined,
			params: { uri, searchReplaceBlocks: '' }, result: { lintErrors: null },
		} as ChatMessage;
		const failedLint = {
			role: 'tool', name: 'read_lint_errors', type: 'success', id: 'lint-failed', content: 'error', rawParams: {}, mcpServerName: undefined,
			params: { uri }, result: { lintErrors: [{ message: 'error' }] },
		} as ChatMessage;
		const passingTests = {
			role: 'tool', name: 'run_tests', type: 'success', id: 'tests', content: 'ok', rawParams: {}, mcpServerName: undefined,
			params: { command: 'npm test', cwd: null, terminalId: 'terminal' },
			result: { result: 'ok', resolveReason: { type: 'done', exitCode: 0 } },
		} as ChatMessage;

		assert.strictEqual(findLastUnverifiedMutationIndex([edit]), 0);
		assert.strictEqual(findLastUnverifiedMutationIndex([edit, failedLint]), 0);
		assert.strictEqual(findLastUnverifiedMutationIndex([edit, passingTests]), null);
		assert.strictEqual(findLastUnverifiedMutationIndex([edit, passingTests, edit]), 2);
	});

	test('does not treat git apply check-only as a mutation', () => {
		const checkOnly = {
			role: 'tool', name: 'git_apply_patch', type: 'success', id: 'check', content: 'ok', rawParams: {}, mcpServerName: undefined,
			params: { cwd: null, patch: '', checkOnly: true },
			result: { result: '', resolveReason: { type: 'done', exitCode: 0 } },
		} as ChatMessage;
		assert.strictEqual(findLastUnverifiedMutationIndex([checkOnly]), null);
	});
});
