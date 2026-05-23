/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalResolveReason } from './toolsServiceTypes.js';

export interface ISpawnCommandOptions {
	/** The shell command to run (passed to `sh -lc` on unix, `cmd /c` on windows) */
	command: string;
	/** Working directory, defaults to process cwd if null */
	cwd: string | null;
	/** Maximum character limit for the returned output */
	maxChars: number;
	/** Idle timeout in seconds – resolves early if no output for this duration */
	idleTimeout: number;
	/** Total timeout in seconds – force-kills after this duration */
	totalTimeout: number;
	/** Unique ID for this command, used to support abort via abortCommand() */
	commandId: string;
}

export interface ISpawnCommandResult {
	result: string;
	resolveReason: TerminalResolveReason;
	commandId: string;
}

export interface IVoidSpawnCommandService {
	readonly _serviceBrand: undefined;
	/**
	 * Run a shell command using child_process.spawn instead of the VS Code terminal.
	 * Output is captured with a ring buffer (head + tail) to avoid unbounded memory
	 * usage, and the process is force-killed on timeout.
	 *
	 * Returns a result that includes a commandId which can be passed to abortCommand().
	 */
	runCommand(opts: ISpawnCommandOptions): Promise<ISpawnCommandResult>;

	/**
	 * Abort a running spawn command by its ID. Safe to call even if the command
	 * has already completed – it will be a no-op.
	 */
	abortCommand(commandId: string): Promise<void>;
}

export const IVoidSpawnCommandService = createDecorator<IVoidSpawnCommandService>('voidSpawnCommandService');