export interface ShellSandboxPolicy {
	readonly cwd: string;
	readonly env?: Record<string, string>;
	readonly allowNetwork?: boolean;
	readonly timeoutMs?: number;
}

export class ShellSandboxService {
	describe(policy: ShellSandboxPolicy): string {
		return JSON.stringify(policy);
	}
}
