import { ToolInvocation } from '../tools/ToolInvocation.js';
import { PermissionDecision } from './PermissionDecision.js';
import { defaultPermissionPolicy, PermissionPolicy } from './PermissionPolicy.js';
import { RiskClassifier } from './RiskClassifier.js';
import { safeStringify } from '../tools/safeSerialize.js';

export class PermissionEngine {
	constructor(
		private readonly policy: PermissionPolicy = defaultPermissionPolicy,
		private readonly riskClassifier = new RiskClassifier(),
	) { }

	async decide(call: ToolInvocation): Promise<PermissionDecision> {
		const risk = this.riskClassifier.classify(call.name, call.input);

		if (this.policy.mode === 'dangerous-skip-approval') {
			return { type: 'allow', reason: 'Dangerous skip approval mode is enabled.' };
		}

		if (this.policy.mode === 'chat-only') {
			return { type: 'deny', reason: 'Tool calls are disabled in chat-only mode.' };
		}

		if (risk === 'low') {
			return { type: 'allow', reason: 'Read-only tool calls are allowed.' };
		}

		if (this.policy.mode === 'read-only') {
			return { type: 'deny', reason: 'This permission mode only allows read-only tools.' };
		}

		if (risk === 'medium' && (this.policy.mode === 'auto-edit' || this.policy.mode === 'workspace-auto')) {
			return { type: 'allow', reason: 'Workspace edit policy allows this tool.' };
		}

		return {
			type: 'ask',
			reason: `Tool "${call.name}" requires approval.`,
			risk,
			preview: {
				type: 'code',
				language: 'json',
				value: safeStringify(call.input, 2),
			},
		};
	}
}
