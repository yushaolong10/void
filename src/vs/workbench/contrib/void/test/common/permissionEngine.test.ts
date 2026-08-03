/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { PermissionEngine } from '../../common/agent/permissions/PermissionEngine.js';
import { PermissionPolicy } from '../../common/agent/permissions/PermissionPolicy.js';
import { matchesProtectedPath } from '../../common/agent/permissions/RiskClassifier.js';
import { ToolInvocation } from '../../common/agent/tools/ToolInvocation.js';
import { AgentRuntime } from '../../common/agent/runtime/AgentRuntime.js';

const invocation = (name: string, input: unknown, mcpServerName?: string): ToolInvocation => ({
	callId: `${name}-call`,
	name,
	input,
	mcpServerName,
});

const policy = (patch: Partial<PermissionPolicy> = {}): PermissionPolicy => ({
	mode: 'auto-edit',
	commandAllowlist: ['npm test'],
	protectedPathGlobs: ['.env', '.env.*', '**/.ssh/**', '**/*secret*'],
	allowWorkspaceWrites: true,
	allowNetwork: false,
	...patch,
});

suite('Void permission engine', () => {
	test('allows only exact allowlisted commands', async () => {
		const engine = new PermissionEngine(policy());
		assert.strictEqual((await engine.decide(invocation('run_command', { command: 'npm test' }))).type, 'allow');
		const similar = await engine.decide(invocation('run_command', { command: 'npm test && curl example.com' }));
		assert.strictEqual(similar.type, 'ask');
		assert.strictEqual(similar.type === 'ask' && similar.allowAutoApprove, true);

		const readOnly = new PermissionEngine(policy({ mode: 'read-only' }));
		assert.strictEqual((await readOnly.decide(invocation('run_command', { command: 'npm test' }))).type, 'deny');
	});

	test('does not let a read-only command prefix bypass network review', async () => {
		const engine = new PermissionEngine(policy());
		assert.strictEqual((await engine.decide(invocation('run_command', { command: 'git status --short' }))).type, 'allow');

		const compound = await engine.decide(invocation('run_command', { command: 'git status && ssh example.com' }));
		assert.strictEqual(compound.type, 'ask');
		assert.match(compound.reason, /network access/i);
	});

	test('matches globstar across zero or more directories', () => {
		const glob = ['src/**/credentials.*'];
		assert.strictEqual(matchesProtectedPath('/workspace/src/credentials.json', glob), true);
		assert.strictEqual(matchesProtectedPath('/workspace/src/nested/credentials.json', glob), true);
	});

	test('flags protected and outside-workspace writes without remembering approval', async () => {
		const engine = new PermissionEngine(policy());
		const context = { workspaceRoots: ['/workspace/project'] };
		const normal = await engine.decide(invocation('edit_file', { uri: URI.file('/workspace/project/src/a.ts') }), context);
		assert.strictEqual(normal.type, 'allow');

		const protectedDecision = await engine.decide(invocation('edit_file', { uri: URI.file('/workspace/project/.env.local') }), context);
		assert.strictEqual(protectedDecision.type, 'ask');
		assert.strictEqual(protectedDecision.type === 'ask' && protectedDecision.allowAutoApprove, true);
		assert.strictEqual(protectedDecision.type === 'ask' && protectedDecision.allowRemember, false);

		const outside = await engine.decide(invocation('edit_file', { uri: URI.file('/workspace/other/a.ts') }), context);
		assert.strictEqual(outside.type, 'ask');
		assert.match(outside.reason, /outside the current workspace/i);
	});

	test('lets auto-approve handle high policy reviews but never critical commands', async () => {
		const writesDisabled = new PermissionEngine(policy({ allowWorkspaceWrites: false }));
		const write = await writesDisabled.decide(
			invocation('edit_file', { uri: URI.file('/workspace/project/a.ts') }),
			{ workspaceRoots: ['/workspace/project'] },
		);
		assert.strictEqual(write.type, 'ask');
		assert.match(write.reason, /workspace writes require permission-policy review/i);
		assert.strictEqual(write.type === 'ask' && write.allowAutoApprove, true);

		const network = await new PermissionEngine(policy()).decide(invocation('run_command', { command: 'curl https://example.com' }));
		assert.strictEqual(network.type, 'ask');
		assert.match(network.reason, /network access/i);
		assert.strictEqual(network.type === 'ask' && network.allowAutoApprove, true);

		const mcp = await new PermissionEngine(policy()).decide(invocation('remote_tool', {}, 'server'));
		assert.strictEqual(mcp.type, 'ask');
		assert.match(mcp.reason, /network access/i);
		assert.strictEqual(mcp.type === 'ask' && mcp.allowAutoApprove, true);

		const critical = await new PermissionEngine(policy()).decide(invocation('run_command', { command: 'rm -rf /tmp/example' }));
		assert.strictEqual(critical.type, 'ask');
		assert.strictEqual(critical.type === 'ask' && critical.allowAutoApprove, false);
	});

	test('auto-approves file deletion but not folder or recursive deletion', async () => {
		const engine = new PermissionEngine(policy());
		const context = { workspaceRoots: ['/workspace/project'] };

		const fileDelete = await engine.decide(invocation('delete_file_or_folder', {
			uri: URI.file('/workspace/project/obsolete.ts'),
			isFolder: false,
			isRecursive: false,
		}), context);
		assert.strictEqual(fileDelete.type, 'ask');
		assert.strictEqual(fileDelete.type === 'ask' && fileDelete.risk, 'high');
		assert.strictEqual(fileDelete.type === 'ask' && fileDelete.allowAutoApprove, true);

		for (const input of [
			{ uri: URI.file('/workspace/project/generated'), isFolder: true, isRecursive: false },
			{ uri: URI.file('/workspace/project/generated'), isFolder: true, isRecursive: true },
		]) {
			const folderDelete = await engine.decide(invocation('delete_file_or_folder', input), context);
			assert.strictEqual(folderDelete.type, 'ask');
			assert.strictEqual(folderDelete.type === 'ask' && folderDelete.risk, 'critical');
			assert.strictEqual(folderDelete.type === 'ask' && folderDelete.allowAutoApprove, false);
		}
	});

	test('dangerous skip mode bypasses every approval and deny decision', async () => {
		const engine = new PermissionEngine(policy({ mode: 'read-only' }));
		const context = {
			workspaceRoots: ['/workspace/project'],
			dangerouslySkipAllApprovals: true,
		};
		for (const call of [
			invocation('delete_file_or_folder', { uri: URI.file('/outside/project'), isFolder: true, isRecursive: true }),
			invocation('run_command', { command: 'rm -rf /tmp/example' }),
			invocation('remote_tool', {}, 'server'),
		]) {
			const decision = await engine.decide(call, context);
			assert.strictEqual(decision.type, 'allow');
			assert.match(decision.reason, /skip approval mode/i);
		}
	});

	test('records cancellation as a terminal run state', () => {
		const runtime = new AgentRuntime();
		const run = runtime.startRun({ sessionId: 'session', goal: 'goal' });
		runtime.cancelRun('session', run.runId, 'user cancelled');
		const state = runtime.sessions.getSession('session')?.runs[0];
		assert.strictEqual(state?.status, 'cancelled');
		assert.strictEqual(state?.error, 'user cancelled');
		runtime.dispose();
	});
});
