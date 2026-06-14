export type PermissionMode =
	| 'chat-only'
	| 'read-only'
	| 'edit-with-approval'
	| 'auto-edit'
	| 'execute-with-approval'
	| 'workspace-auto'
	| 'dangerous-skip-approval';

export interface PermissionPolicy {
	readonly mode: PermissionMode;
	readonly commandAllowlist?: readonly string[];
	readonly protectedPathGlobs?: readonly string[];
	readonly allowWorkspaceWrites?: boolean;
	readonly allowNetwork?: boolean;
}

export const defaultPermissionPolicy: PermissionPolicy = {
	mode: 'edit-with-approval',
	commandAllowlist: ['git status', 'git diff', 'npm test', 'npm run test'],
	protectedPathGlobs: ['.env', '.env.*', '**/.ssh/**', '**/*token*', '**/*secret*'],
	allowWorkspaceWrites: true,
	allowNetwork: false,
};
