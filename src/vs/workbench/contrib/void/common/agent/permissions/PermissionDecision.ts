import { AgentVisualBlock } from '../tools/ToolResult.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionDecision =
	| { type: 'allow'; reason: string }
	| { type: 'deny'; reason: string }
	| {
		type: 'ask';
		reason: string;
		risk: RiskLevel;
		preview?: AgentVisualBlock;
		/** Security-policy decisions may require a fresh, explicit approval. */
		allowAutoApprove?: boolean;
		allowRemember?: boolean;
	};
