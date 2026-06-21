// Dispatch a headless one-shot pi child and report its parsed outcome.
//
// Thin wiring over the pure pieces: buildSpawnArgv computes the launch argv, the
// injected exec runs the child, and parseEventStream reads its JSON event stream.
// Injecting exec keeps runAgent unit-testable without spawning a real pi.

import { join } from "node:path";

import { buildSpawnArgv } from "./argv.ts";
import type { SpawnArgvOptions } from "./argv.ts";
import { DEFAULT_CONTEXT_WINDOW, RUNS_DIR } from "./constants.ts";
import { parseEventStream } from "./events.ts";
import { formatRunLog, isSafeRunId, runLogName } from "./log.ts";
import { reduceRunStateFromString, type RunState } from "./runstate.ts";

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
	/** Marks a run terminated by its own timeout — distinct from a normal failure or an operator kill — so the reply can name a timeout. */
	timedOut: boolean;
	/** State folded from the child's event stream, so the registry can show the run's progress. */
	state: RunState;
	/** The run's id and log path when a child actually spawned; null on early-return paths. */
	runId: string | null;
	logPath: string | null;
	/** Wall-clock spent in exec (ms); 0 when no child spawned. */
	durationMs: number;
	/** Why the dispatch could not run at all (empty/invalid task); absent on a normal run. */
	error?: string;
}

/** Persists a run's log content to a path; injected so runAgent stays free of node:fs. */
export type LogWriter = (logPath: string, content: string) => Promise<void>;

/** Render the subagent's outcome as a follow-up message; it needs only the outcome, not the run's folded progress state. */
export function formatReply(task: string, result: Omit<DispatchResult, "state">): string {
	if (result.ok) {
		return `Subagent finished "${task}":\n\n${result.finalText ?? ""}`;
	}
	if (result.error !== undefined) {
		return `Subagent for "${task}" could not run: ${result.error}`;
	}
	if (result.timedOut) {
		return `Subagent for "${task}" timed out before it finished.`;
	}
	return `Subagent for "${task}" did not complete (exit ${result.code}).`;
}

/** No-op writer: the default so runAgent never needs node:fs unless a real writer is injected. */
const noopWriteLog: LogWriter = async () => {};

/** The zero RunState reported on early-return paths, before any child stream is folded; exported so the dispatch adapter reuses it for a run cancelled before it ever spawned. */
export const EMPTY_RUN_STATE: RunState = {
	toolCount: 0,
	lastLine: null,
	contextTokens: null,
	contextPct: null,
	done: false,
	malformed: 0,
	activity: [],
};

/** Per-process counter so two same-millisecond dispatches never derive the same run id. */
let runSeq = 0;

/**
 * A sortable, filesystem-safe run id: a millisecond wall-clock timestamp (so lexical
 * order stays chronological) plus a per-process sequence suffix, so concurrent or
 * same-millisecond dispatches get distinct ids — and thus distinct, non-clobbering log paths.
 */
export function defaultRunId(): string {
	runSeq += 1;
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${runSeq}`;
}

/**
 * runAgent's knobs: dispatch controls (timeout, cwd, log writer, run id) plus the spawn
 * options forwarded verbatim into buildSpawnArgv (tools/model/system prompt/extensions/session),
 * so the adapter can apply a persona, the guardrails extension, and a resumable session to the
 * child. The spawn subset is picked straight from SpawnArgvOptions so those fields stay defined
 * in exactly one place.
 */
export interface RunAgentOptions extends Pick<SpawnArgvOptions, "tools" | "model" | "systemPrompt" | "extensions" | "session" | "continueSession"> {
	timeoutMs?: number;
	cwd?: string;
	writeLog?: LogWriter;
	runId?: string;
	/** Cancels the child when aborted, so agent_kill can stop a running run. */
	signal?: AbortSignal;
	/** Context-window size (tokens) for the run's contextPct denominator; falls back to DEFAULT_CONTEXT_WINDOW when the caller resolves no model window. */
	contextWindow?: number;
}

/** Dispatch a one-shot pi child for `task` and report its parsed outcome. */
export async function runAgent(task: string, exec: ExecLike, options?: RunAgentOptions): Promise<DispatchResult> {
	// Stay total over the pi adapter: a task we cannot launch must resolve with a
	// reason, never spawn a child or throw. Empty and argv-rejected tasks short-circuit
	// before any run id or log exists, so they report null run/log and zero duration.
	if (task.trim() === "") {
		return { ok: false, finalText: null, malformed: 0, code: 1, timedOut: false, runId: null, logPath: null, durationMs: 0, state: EMPTY_RUN_STATE, error: "task is required" };
	}
	// Split dispatch controls from the spawn knobs; `spawn` is exactly SpawnArgvOptions minus
	// `task`, so it forwards into buildSpawnArgv as-is without re-listing each field.
	const { timeoutMs, cwd, writeLog = noopWriteLog, runId: requestedRunId, signal, contextWindow, ...spawn } = options ?? {};
	let argv: string[];
	try {
		argv = buildSpawnArgv({ task, ...spawn });
	} catch (error) {
		const reason: string = error instanceof Error ? error.message : String(error);
		return { ok: false, finalText: null, malformed: 0, code: 1, timedOut: false, runId: null, logPath: null, durationMs: 0, state: EMPTY_RUN_STATE, error: reason };
	}
	const runId = requestedRunId ?? defaultRunId();
	const logPath = join(cwd ?? ".", RUNS_DIR, runLogName(runId));
	const startedAt = Date.now();
	const result = await exec("pi", argv, { timeout: timeoutMs, cwd, signal });
	const durationMs = Date.now() - startedAt;
	// A killed child is a timeout only when the operator did not abort it: agent_kill aborts the
	// signal first, so an un-aborted signal on a killed child means the run hit its own timeout.
	const timedOut = result.killed && !(signal?.aborted);
	const parsed = parseEventStream(result.stdout);
	const state = reduceRunStateFromString(result.stdout, { contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW });
	// Best-effort logging: a write failure must never derail the dispatch result, and an
	// unsafe (path-traversing) runId is skipped rather than allowed to escape RUNS_DIR.
	if (isSafeRunId(runId)) {
		try {
			const content = formatRunLog({
				runId,
				task,
				argv,
				events: result.stdout,
				exitCode: result.code,
				durationMs,
				malformed: parsed.malformed,
			});
			await writeLog(logPath, content);
		} catch {
			// Swallow: the run already happened; its outcome stands regardless of logging.
		}
	}
	return { ok: parsed.done && result.code === 0, finalText: parsed.finalText, malformed: parsed.malformed, code: result.code, timedOut, runId, logPath, durationMs, state };
}
