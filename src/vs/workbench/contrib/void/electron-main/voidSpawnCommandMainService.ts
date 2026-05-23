/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ISpawnCommandOptions, ISpawnCommandResult, IVoidSpawnCommandService } from '../common/voidSpawnCommandTypes.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';

/**
 * Spawn-based command runner for non-interactive agent commands.
 *
 * Unlike the VS Code terminal (pty host → IPC → xterm buffer), this uses
 * child_process.spawn directly with a ring-buffer (head + tail) approach.
 * This avoids the pty host IPC forwarding chain that is the primary hotspot
 * identified in performance profiling for high-output commands.
 */

const HARD_OUTPUT_LIMIT = 2_000_000; // 2MB hard limit – force kill if exceeded

function getShellCommand(command: string): { shell: string; shellArgs: string[] } {
	if (process.platform === 'win32') {
		return { shell: 'cmd.exe', shellArgs: ['/c', command] };
	}
	return { shell: '/bin/sh', shellArgs: ['-lc', command] };
}

interface ActiveCommand {
	child: ChildProcess;
	doResolve: (reason: TerminalResolveReason) => void;
}

export class VoidSpawnCommandService implements IVoidSpawnCommandService {
	readonly _serviceBrand: undefined;

	private readonly _activeCommands = new Map<string, ActiveCommand>();

	async abortCommand(commandId: string): Promise<void> {
		const cmd = this._activeCommands.get(commandId);
		if (!cmd) return; // already completed or never existed
		this._activeCommands.delete(commandId);
		cmd.doResolve({ type: 'aborted' });
	}

	async runCommand(opts: ISpawnCommandOptions): Promise<ISpawnCommandResult> {
		const { command, cwd, maxChars, idleTimeout, totalTimeout, commandId } = opts;
		const { shell, shellArgs } = getShellCommand(command);

		const env: Record<string, string | undefined> = { ...process.env };
		// Only set TERM on Unix – setting it on Windows can confuse native tools.
		if (process.platform !== 'win32') {
			env.TERM = process.env.TERM || 'xterm-256color';
		}

		const child: ChildProcess = spawn(shell, shellArgs, {
			cwd: cwd ?? undefined,
			env: env as Record<string, string>,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		return new Promise<ISpawnCommandResult>((resolve) => {
			let resolved = false;

			// --- Ring buffer: head (first half) + tail (last half) ---
			const half = Math.floor(maxChars / 2);
			const headChunks: string[] = [];
			const tailChunks: string[] = [];
			let headChars = 0;
			let tailChars = 0;
			let totalChars = 0;

			// --- Timeout management ---
			let idleTimerId: ReturnType<typeof setTimeout> | null = null;
			let totalTimerId: ReturnType<typeof setTimeout> | null = null;

			const clearTimers = () => {
				if (idleTimerId !== null) { clearTimeout(idleTimerId); idleTimerId = null; }
				if (totalTimerId !== null) { clearTimeout(totalTimerId); totalTimerId = null; }
			};

			const doResolve = (reason: TerminalResolveReason) => {
				if (resolved) return;
				resolved = true;
				clearTimers();
				this._activeCommands.delete(commandId);

				// Kill the child process if still running
				if (child.exitCode === null && child.killed === false) {
					try {
						child.kill('SIGTERM');
						// On Windows, SIGTERM may not work, force kill after short delay
						setTimeout(() => {
							if (child.exitCode === null && child.killed === false) {
								try { child.kill('SIGKILL'); } catch { /* ignore */ }
							}
						}, 2000);
					} catch { /* ignore */ }
				}

				// Build result from ring buffer
				const cleanedHead = headChunks.map(removeAnsiEscapeCodes);
				const cleanedTail = tailChunks.map(removeAnsiEscapeCodes);

				let result: string;
				if (totalChars <= maxChars) {
					// Full output fits: tail (older) + head (newer) in chronological order
					result = [...cleanedTail, ...cleanedHead].join('');
				} else {
					// Truncated: beginning (oldest from tail) + separator + end (newest from head)
					result = cleanedTail.join('') + '\n...\n' + cleanedHead.join('');
				}

				resolve({ result, resolveReason: reason, commandId });
			};

			// Register for abort
			this._activeCommands.set(commandId, { child, doResolve });

			const resetIdleTimer = () => {
				if (idleTimerId !== null) clearTimeout(idleTimerId);
				idleTimerId = setTimeout(() => {
					doResolve({ type: 'idle_timeout' });
				}, idleTimeout * 1000);
			};

			const startTimers = () => {
				// Total timeout starts immediately – bounds the overall execution time.
				totalTimerId = setTimeout(() => {
					doResolve({ type: 'total_timeout' });
				}, totalTimeout * 1000);
				// Idle timeout starts only after first output, to avoid killing
				// commands that are slow to start (compilation, install, etc.).
			};

			let idleTimerStarted = false;
			const maybeStartIdleTimer = () => {
				if (!idleTimerStarted) {
					idleTimerStarted = true;
					resetIdleTimer();
				}
			};

			const onChunk = (chunk: Buffer) => {
				const str = chunk.toString();
				totalChars += str.length;

				// Ring buffer: tail = beginning of output (first `half` chars),
				// head = end of output (sliding window of last `half` chars).
				if (tailChars < half) {
					// Still filling tail (beginning of output)
					const tailSpace = half - tailChars;
					const toTail = str.slice(0, tailSpace);
					tailChunks.push(toTail);
					tailChars += toTail.length;

					// Remaining goes to head (sliding window)
					const remaining = str.slice(tailSpace);
					if (remaining.length > 0) {
						headChunks.push(remaining);
						headChars += remaining.length;
						// Trim head from the beginning if overflowed
						while (headChars > half && headChunks.length > 0) {
							const excess = headChars - half;
							if (headChunks[0].length <= excess) {
								headChars -= headChunks[0].length;
								headChunks.shift();
							} else {
								headChunks[0] = headChunks[0].slice(excess);
								headChars -= excess;
							}
						}
					}
				} else {
					// Tail is full, all new data goes to head (sliding window)
					headChunks.push(str);
					headChars += str.length;
					// Trim head from the beginning if overflowed
					while (headChars > half && headChunks.length > 0) {
						const excess = headChars - half;
						if (headChunks[0].length <= excess) {
							headChars -= headChunks[0].length;
							headChunks.shift();
						} else {
							headChunks[0] = headChunks[0].slice(excess);
							headChars -= excess;
						}
					}
				}

				// Hard output limit – force kill to prevent runaway memory
				if (totalChars > HARD_OUTPUT_LIMIT) {
					doResolve({ type: 'total_timeout' });
					return;
				}

				maybeStartIdleTimer();
				resetIdleTimer();
			};

			// Attach listeners synchronously after spawn. Node.js child process
			// events are always emitted asynchronously, so there is no race.
			child.stdout?.on('data', onChunk);
			child.stderr?.on('data', onChunk);

			// Handle stream errors to prevent unhandled exceptions
			const onStreamError = (err: Error) => {
				if (!resolved) {
					const errorMsg = `Stream error: ${err.message}`;
					headChunks.push(errorMsg);
					headChars += errorMsg.length;
					totalChars += errorMsg.length;
					doResolve({ type: 'done', exitCode: 1 });
				}
			};
			child.stdout?.on('error', onStreamError);
			child.stderr?.on('error', onStreamError);

			child.on('error', (err) => {
				if (!resolved) {
					const errorMsg = `Spawn error: ${err.message}`;
					headChunks.push(errorMsg);
					headChars += errorMsg.length;
					totalChars += errorMsg.length;
					doResolve({ type: 'done', exitCode: 1 });
				}
			});

			child.on('close', (exitCode) => {
				if (!resolved) {
					doResolve({ type: 'done', exitCode: exitCode ?? 0 });
				}
			});

			startTimers();
		});
	}
}