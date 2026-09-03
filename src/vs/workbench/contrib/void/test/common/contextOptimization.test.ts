/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeReservedOutputTokens, computeTargetSummarizedRoundCount, estimateTextTokens, getEffectiveAgentContextWindow, getReadFileContextChars, normalizeReadFileMaxChars, paginateContiguousSource, reduceSourceResultForContext, reduceToolResultForSummary, stableTextHash, startsExternalConversationRound } from '../../common/agent/context/ContextOptimization.js';

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

	test('paginates source contiguously without dropping middle lines', () => {
		const content = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n');
		const pages = paginateContiguousSource(content, 101, 24);
		assert(pages.length > 1);
		assert.strictEqual(pages.map(page => page.content).join(''), content);
		assert.deepStrictEqual(
			pages.map(page => [page.startLine, page.endLine]),
			[[101, 103], [104, 106], [107, 109], [110, 112]],
		);
		assert(pages.every(page => !page.startsMidLine && !page.endsMidLine));
	});

	test('read_file defaults to 64K chars', () => {
		assert.strictEqual(normalizeReadFileMaxChars(undefined), 64_000);
	});

	test('read_file max_chars is clamped between 8K and 128K', () => {
		assert.strictEqual(normalizeReadFileMaxChars(1_000), 8_000);
		assert.strictEqual(normalizeReadFileMaxChars('96_000'), 64_000);
		assert.strictEqual(normalizeReadFileMaxChars('96000'), 96_000);
		assert.strictEqual(normalizeReadFileMaxChars(256_000), 128_000);
	});

	test('recent read_file preserves requested context while old reads are reduced', () => {
		const content = `${'x'.repeat(127_000)}TAIL_SENTINEL`;
		const recent = reduceSourceResultForContext('read_file', content, getReadFileContextChars('128000', true));
		const old = reduceSourceResultForContext('read_file', content, getReadFileContextChars('128000', false));

		assert(recent.includes('TAIL_SENTINEL'));
		assert.strictEqual(old.length, 16_000);
		assert(!old.includes('TAIL_SENTINEL'));
	});

	test('splits an unusually long source line without appending a misleading tail', () => {
		const content = `first\n${'x'.repeat(40)}\nlast`;
		const pages = paginateContiguousSource(content, 7, 12);
		assert.strictEqual(pages.map(page => page.content).join(''), content);
		assert(pages.some(page => page.startsMidLine || page.endsMidLine));

		const reduced = reduceSourceResultForContext('read_file', `first\n${'middle\n'.repeat(100)}TAIL_SENTINEL`, 200);
		assert(reduced.includes('truncated contiguously'));
		assert(!reduced.includes('TAIL_SENTINEL'));
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

	test('caps GPT-5.6 agent working context without changing other models', () => {
		assert.strictEqual(getEffectiveAgentContextWindow('gpt-5.6-sol', 1_050_000), 220_000);
		assert.strictEqual(getEffectiveAgentContextWindow('vendor/gpt-5-6', 1_050_000), 220_000);
		assert.strictEqual(getEffectiveAgentContextWindow('gpt-4.1', 1_047_576), 1_047_576);
	});

	test('reserves configured output without discarding half the context by default', () => {
		assert.strictEqual(computeReservedOutputTokens(128_000, 8_192), 16_000);
		assert.strictEqual(computeReservedOutputTokens(128_000, 32_000), 32_000);
		assert.strictEqual(computeReservedOutputTokens(4_096, 8_192), 2_096);
	});
});
