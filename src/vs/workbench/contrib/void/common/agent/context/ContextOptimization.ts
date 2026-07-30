/*---------------------------------------------------------------------------------------------
 * Context optimization primitives. These functions are deliberately provider-independent and
 * deterministic so they can be tested without starting an LLM request.
 *--------------------------------------------------------------------------------------------*/

export const CONTEXT_BUDGET_DEFAULTS = {
	highWatermark: 0.80,
	lowWatermark: 0.60,
	minRecentRounds: 3,
	toolResultMaxCharsForSummary: 4_000,
} as const;

export interface HistoryRoundCost {
	readonly tokenCost: number;
	readonly pinned?: boolean;
}

export const startsExternalConversationRound = (message: {
	readonly role: string;
	readonly contextMeta?: { readonly origin?: string; readonly startsRound?: boolean };
}): boolean => message.role === 'user'
	&& (message.contextMeta?.startsRound ?? message.contextMeta?.origin !== 'internal-plan');

export const estimateTextTokens = (value: string): number => {
	let ascii = 0;
	let nonAscii = 0;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) <= 0x7f) ascii++;
		else nonAscii++;
	}
	// Code and English usually average close to four characters/token. CJK text is
	// substantially denser, so count it more conservatively.
	return Math.ceil(ascii / 4 + nonAscii / 1.5);
};

export const stableTextHash = (value: string): string => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
};

export const computeReservedOutputTokens = (
	contextWindow: number,
	configured: number | null | undefined,
): number => {
	const desired = Math.max(configured ?? 4_096, Math.min(32_768, Math.floor(contextWindow * 0.125)));
	return Math.min(desired, Math.max(1_024, contextWindow - 2_000));
};

const importantToolLine = (line: string): boolean =>
	/(error|failed|failure|exception|warning|warn|exit code|not found|cannot|can't|expected|received|passed|tests?)/i.test(line);

export const reduceToolResultForSummary = (toolName: string, content: string, maxChars: number = CONTEXT_BUDGET_DEFAULTS.toolResultMaxCharsForSummary): string => {
	if (content.length <= maxChars) return content;

	const lines = content.split(/\r?\n/);
	const important = lines.filter(importantToolLine).slice(0, 40);
	const head = lines.slice(0, 20);
	const tail = lines.slice(-30);
	const importantText = important.filter((line, index) => important.indexOf(line) === index).join('\n').slice(0, Math.floor(maxChars * 0.55));
	const edgeLines = [...head, ...tail]
		.filter(line => !important.includes(line))
		.filter((line, index, all) => all.indexOf(line) === index);
	const edgeText = edgeLines.join('\n');
	const edgeBudget = Math.max(0, maxChars - importantText.length - 80);
	const edgeHalf = Math.floor(edgeBudget / 2);
	const reducedEdges = edgeText.length <= edgeBudget
		? edgeText
		: `${edgeText.slice(0, edgeHalf)}\n... omitted ...\n${edgeText.slice(-edgeHalf)}`;
	const reduced = [
		reducedEdges ? `Output edges:\n${reducedEdges}` : '',
		importantText ? `Important lines:\n${importantText}` : '',
	].filter(Boolean).join('\n')
	return `[${toolName} result reduced from ${content.length} chars]\n${reduced}`;
};

/**
 * Returns the number of oldest rounds that should be summarized. Existing frozen
 * rounds are never expanded again. Compression only starts above the high-water
 * mark and targets the low-water mark to avoid compressing on every request.
 */
export const computeTargetSummarizedRoundCount = ({
	rounds,
	alreadySummarized,
	historyBudgetTokens,
	summaryTokens,
}: {
	rounds: readonly HistoryRoundCost[];
	alreadySummarized: number;
	historyBudgetTokens: number;
	summaryTokens: number;
}): number => {
	const high = Math.max(1, Math.floor(historyBudgetTokens * CONTEXT_BUDGET_DEFAULTS.highWatermark));
	const low = Math.max(1, Math.floor(historyBudgetTokens * CONTEXT_BUDGET_DEFAULTS.lowWatermark));
	const rawUnsummarizedTokens = rounds.slice(alreadySummarized).reduce((sum, round) => sum + round.tokenCost, 0);
	if (summaryTokens + rawUnsummarizedTokens <= high) return alreadySummarized;

	const maxTarget = Math.max(alreadySummarized, rounds.length - CONTEXT_BUDGET_DEFAULTS.minRecentRounds);
	let target = alreadySummarized;
	let remaining = summaryTokens + rawUnsummarizedTokens;
	while (target < maxTarget && remaining > low) {
		if (rounds[target].pinned) break;
		remaining -= rounds[target].tokenCost;
		target++;
	}
	return target;
};
