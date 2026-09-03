import { ChatMessage } from '../../chatThreadServiceTypes.js';

export const MAX_AGENT_TURNS = 640;
export const MAX_AGENT_TOOL_CALLS = 640;

export interface AgentRunBudget {
	turns: number;
	toolCalls: number;
	verificationGateMutationIndex: number | null;
	consecutiveVerificationFailures: number;
	repeatedActionCount: number;
	lastActionFingerprint?: string;
	lastFailureFingerprint?: string;
	startedAtMessageIndex: number;
}

export const createAgentRunBudget = (startedAtMessageIndex = 0): AgentRunBudget => ({
	turns: 0,
	toolCalls: 0,
	verificationGateMutationIndex: null,
	consecutiveVerificationFailures: 0,
	repeatedActionCount: 0,
	startedAtMessageIndex,
});

const stableFingerprint = (value: string): string => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
};

const normalizedFailure = (value: string): string => value
	.toLowerCase()
	.replace(/\b\d+(?:\.\d+)?\b/g, '#')
	.replace(/\s+/g, ' ')
	.trim();

const isVerificationTool = (message: ChatMessage): boolean => message.role === 'tool' && (
	message.name === 'read_lint_errors'
	|| message.name === 'run_tests'
	|| (message.name === 'run_command' && 'params' in message && /(test|lint|typecheck|type-check|tsc|build|check|compile)/i.test(String((message.params as { command?: unknown } | undefined)?.command ?? '')))
);

const verificationSucceeded = (message: ChatMessage): boolean => {
	if (message.role !== 'tool' || message.type !== 'success') return false;
	if (message.name === 'read_lint_errors') {
		return !((message.result as { lintErrors?: unknown[] | null } | null)?.lintErrors?.length);
	}
	return terminalSucceeded(message);
};

export const recordAgentProgress = (budget: AgentRunBudget, messages: readonly ChatMessage[]): boolean => {
	let shouldReplan = false;
	for (const message of messages) {
		if (message.role !== 'tool') continue;
		const actionFingerprint = stableFingerprint(`${message.name}:${JSON.stringify(message.rawParams ?? {})}`);
		budget.repeatedActionCount = actionFingerprint === budget.lastActionFingerprint ? budget.repeatedActionCount + 1 : 1;
		budget.lastActionFingerprint = actionFingerprint;
		if (budget.repeatedActionCount >= 3) shouldReplan = true;

		if (!isVerificationTool(message)) continue;
		if (verificationSucceeded(message)) {
			budget.consecutiveVerificationFailures = 0;
			budget.lastFailureFingerprint = undefined;
			continue;
		}
		budget.consecutiveVerificationFailures += 1;
		const failureFingerprint = stableFingerprint(normalizedFailure(message.content));
		if (failureFingerprint === budget.lastFailureFingerprint && budget.consecutiveVerificationFailures >= 3) shouldReplan = true;
		budget.lastFailureFingerprint = failureFingerprint;
	}
	return shouldReplan;
};

export const getAgentReasoningEffort = (budget: AgentRunBudget): 'medium' | 'high' | 'xhigh' => {
	if (budget.consecutiveVerificationFailures >= 2) return 'xhigh';
	if (budget.consecutiveVerificationFailures >= 1) return 'high';
	return 'medium';
};

export const reserveAgentToolCalls = (budget: AgentRunBudget, requested: number): number => {
	const reserved = Math.min(Math.max(0, requested), Math.max(0, MAX_AGENT_TOOL_CALLS - budget.toolCalls));
	budget.toolCalls += reserved;
	return reserved;
};

export const buildResourceDependencies = (resourceKeys: readonly string[]): Array<number | null> => {
	const lastCallByResource = new Map<string, number>();
	return resourceKeys.map((resourceKey, index) => {
		const dependency = lastCallByResource.get(resourceKey) ?? null;
		lastCallByResource.set(resourceKey, index);
		return dependency;
	});
};

const mutatingTools = new Set([
	'create_file_or_folder',
	'delete_file_or_folder',
	'edit_file',
	'rewrite_file',
	'git_apply_patch',
	'install_dependencies',
]);

const terminalSucceeded = (message: ChatMessage): boolean => {
	if (message.role !== 'tool' || message.type !== 'success') return false;
	const resolveReason = (message.result as { resolveReason?: { type?: string; exitCode?: number } } | null)?.resolveReason;
	return resolveReason?.type === 'done' && resolveReason.exitCode === 0;
};

const isMutation = (message: ChatMessage): boolean => {
	if (message.role !== 'tool' || message.type !== 'success' || !mutatingTools.has(message.name)) return false;
	if (message.name === 'git_apply_patch') {
		return !(message.params as { checkOnly?: boolean }).checkOnly;
	}
	return true;
};

const isVerification = (message: ChatMessage): boolean => {
	if (message.role !== 'tool' || message.type !== 'success') return false;
	if (message.name === 'read_lint_errors') {
		const lintErrors = (message.result as { lintErrors?: unknown[] | null } | null)?.lintErrors;
		return !lintErrors || lintErrors.length === 0;
	}
	if (message.name === 'run_tests' || message.name === 'git_diff' || message.name === 'review_snapshot') {
		return terminalSucceeded(message);
	}
	if (message.name === 'run_command') {
		const command = String((message.params as { command?: unknown }).command ?? '');
		return /(test|lint|typecheck|type-check|tsc|build|check|compile)/i.test(command) && terminalSucceeded(message);
	}
	return false;
};

/**
 * Returns the last successful workspace mutation that has no successful
 * verification after it. A null result means the controller may finish.
 */
export const findLastUnverifiedMutationIndex = (messages: readonly ChatMessage[]): number | null => {
	let lastMutation = -1;
	let lastVerification = -1;
	for (let index = 0; index < messages.length; index++) {
		if (isMutation(messages[index])) lastMutation = index;
		if (isVerification(messages[index])) lastVerification = index;
	}
	return lastMutation > lastVerification ? lastMutation : null;
};
