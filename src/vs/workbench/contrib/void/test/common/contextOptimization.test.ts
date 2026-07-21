/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeTargetSummarizedRoundCount, estimateTextTokens, reduceToolResultForSummary, stableTextHash, startsExternalConversationRound } from '../../common/agent/context/ContextOptimization.js';

suite('Void context optimization', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimates CJK text more conservatively than ASCII text', () => {
		assert(estimateTextTokens('上下文压缩测试') > estimateTextTokens('context'));
	});

	test('distinguishes external user turns from internal plan continuations', () => {
		assert.strictEqual(startsExternalConversationRound({ role: 'user' }), true);
		assert.strictEqual(startsExternalConversationRound({ role: 'user', contextMeta: { origin: 'external-user', startsRound: true } }), true);
		assert.strictEqual(startsExternalConversationRound({ role: 'user', contextMeta: { origin: 'internal-plan', startsRound: false } }), false);
		assert.strictEqual(startsExternalConversationRound({ role: 'assistant' }), false);
	});

	test('tool reduction retains failures and the output tail', () => {
		const content = [
			...Array.from({ length: 80 }, (_, i) => `ordinary output ${i}`),
			'ERROR: expected 5 but received 4',
			...Array.from({ length: 20 }, (_, i) => `tail output ${i}`),
		].join('\n');
		const reduced = reduceToolResultForSummary('run_tests', content, 500);
		assert(reduced.includes('ERROR: expected 5 but received 4'));
		assert(reduced.includes('tail output 19'));
		assert(reduced.includes('result reduced from'));
	});

	test('uses high and low watermarks instead of compressing every turn', () => {
		const rounds = Array.from({ length: 10 }, () => ({ tokenCost: 100 }));
		assert.strictEqual(computeTargetSummarizedRoundCount({
			rounds: rounds.slice(0, 7),
			alreadySummarized: 0,
			historyBudgetTokens: 1_000,
			summaryTokens: 0,
		}), 0);
		assert.strictEqual(computeTargetSummarizedRoundCount({
			rounds,
			alreadySummarized: 0,
			historyBudgetTokens: 1_000,
			summaryTokens: 0,
		}), 4);
	});

	test('does not summarize through a pinned round', () => {
		const rounds = [
			{ tokenCost: 300 },
			{ tokenCost: 300, pinned: true },
			{ tokenCost: 300 },
			{ tokenCost: 300 },
			{ tokenCost: 300 },
		];
		assert.strictEqual(computeTargetSummarizedRoundCount({
			rounds,
			alreadySummarized: 0,
			historyBudgetTokens: 1_000,
			summaryTokens: 0,
		}), 1);
	});

	test('produces stable content hashes', () => {
		assert.strictEqual(stableTextHash('same'), stableTextHash('same'));
		assert.notStrictEqual(stableTextHash('same'), stableTextHash('changed'));
	});
});
