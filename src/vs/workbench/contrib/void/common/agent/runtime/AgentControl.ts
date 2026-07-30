import { ChatMessage } from '../../chatThreadServiceTypes.js';

export const MAX_AGENT_TURNS = 640;
export const MAX_AGENT_TOOL_CALLS = 640;

export interface AgentRunBudget {
	turns: number;
	toolCalls: number;
	verificationGateMutationIndex: number | null;
	startedAtMessageIndex: number;
}

export const createAgentRunBudget = (startedAtMessageIndex = 0): AgentRunBudget => ({
	turns: 0,
	toolCalls: 0,
	verificationGateMutationIndex: null,
	startedAtMessageIndex,
});

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
