// Dispatch a headless one-shot pi child and report its parsed outcome.
//
// Thin wiring over the pure pieces: buildSpawnArgv computes the launch argv, the
// injected exec runs the child, and parseEventStream reads its JSON event stream.
// Injecting exec keeps runAgent unit-testable without spawning a real pi.

import { buildSpawnArgv } from "./argv.ts";
import { parseEventStream } from "./events.ts";

/** The subset of a child-process result that runAgent consumes. */
export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** Runs a command and resolves with its captured result; injected so tests can fake the child. */
export type ExecLike = (
	command: string,
	args: string[],
	options?: { timeout?: number; signal?: AbortSignal; cwd?: string },
) => Promise<ExecResultLike>;

/** The dispatched child's outcome: whether it terminated, its final text, malformed-line count, and exit code. */
export interface DispatchResult {
	ok: boolean;
	finalText: string | null;
	malformed: number;
	code: number;
	/** Why the dispatch could not run at all (empty/invalid task); absent on a normal run. */
	error?: string;
}

/** Render the subagent's outcome as a follow-up message for the parent conversation. */
export function formatReply(task: string, result: DispatchResult): string {
	if (result.ok) {
		return `Subagent finished "${task}":\n\n${result.finalText ?? ""}`;
	}
	if (result.error !== undefined) {
		return `Subagent for "${task}" could not run: ${result.error}`;
	}
	return `Subagent for "${task}" did not complete (exit ${result.code}).`;
}

/** Dispatch a one-shot pi child for `task` and report its parsed outcome. */
export async function runAgent(
	task: string,
	exec: ExecLike,
	options?: { timeoutMs?: number; cwd?: string },
): Promise<DispatchResult> {
	// Stay total over the pi adapter: a task we cannot launch must resolve with a
	// reason, never spawn a child or throw. Empty and argv-rejected tasks short-circuit.
	if (task.trim() === "") {
		return { ok: false, finalText: null, malformed: 0, code: 1, error: "task is required" };
	}
	let argv: string[];
	try {
		argv = buildSpawnArgv({ task });
	} catch (error) {
		const reason: string = error instanceof Error ? error.message : String(error);
		return { ok: false, finalText: null, malformed: 0, code: 1, error: reason };
	}
	const result = await exec("pi", argv, { timeout: options?.timeoutMs, cwd: options?.cwd });
	const parsed = parseEventStream(result.stdout);
	return { ok: parsed.done && result.code === 0, finalText: parsed.finalText, malformed: parsed.malformed, code: result.code };
}
