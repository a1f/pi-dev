// Pure formatting and derivation for per-run subagent logs and audit entries.
//
// No I/O here: this module only computes strings and plain objects so the log
// format, tail rendering, and "latest run" selection stay unit-testable. The fs
// writer is injected into runner.ts and the real fs reads live in index.ts.

import { isSafePathSegment } from "./paths.ts";

/** Everything needed to render a run's JSONL log file. */
export interface RunLogInput {
	runId: string;
	task: string;
	argv: string[];
	/** The child's raw event stream, teed verbatim into the log. */
	events: string;
	exitCode: number;
	durationMs: number;
	malformed: number;
}

/** Split text into its non-empty (non-whitespace-only) lines. */
function nonEmptyLines(content: string): string[] {
	return content.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Render the full JSONL log file content: a valid-JSON run_start header, the
 * child's event lines verbatim (empty lines dropped), and a valid-JSON run_end
 * footer. Newline-separated with a trailing newline.
 */
export function formatRunLog(input: RunLogInput): string {
	const header = JSON.stringify({ type: "run_start", runId: input.runId, task: input.task, argv: input.argv });
	const footer = JSON.stringify({
		type: "run_end",
		exitCode: input.exitCode,
		durationMs: input.durationMs,
		malformed: input.malformed,
	});
	return [header, ...nonEmptyLines(input.events), footer].join("\n") + "\n";
}

/**
 * Return the last `maxLines` non-empty lines of `content`, joined by "\n".
 * Fewer lines than `maxLines` yields all of them; empty content yields "".
 */
export function renderLogTail(content: string, maxLines: number): string {
	return nonEmptyLines(content).slice(-maxLines).join("\n");
}

/** The serializable record of one subagent run, persisted in the parent session. */
export interface SubagentRunAudit {
	runId: string;
	task: string;
	ok: boolean;
	exitCode: number;
	durationMs: number;
	logPath: string;
	malformed: number;
}

/**
 * Whether a runId is safe to embed in a filesystem path. runId is a public option,
 * so a value with a path separator or `..` could escape RUNS_DIR; the writer skips
 * an unsafe id rather than letting it traverse out. Delegates to the shared segment
 * guard so the runId and persona-name checks can never drift apart.
 */
export function isSafeRunId(runId: string): boolean {
	return isSafePathSegment(runId);
}

/** The log filename for a run (runId is timestamp-prefixed for lexical = chronological order). */
export function runLogName(runId: string): string {
	return `${runId}.jsonl`;
}

/**
 * Given a directory listing, return the lexicographically-greatest `.jsonl` name
 * (= the most recent run, since runIds are timestamp-prefixed), or null if none.
 */
export function pickLatestLogName(names: string[]): string | null {
	const logs = names.filter((name) => name.endsWith(".jsonl"));
	if (logs.length === 0) return null;
	return logs.reduce((latest, name) => (name > latest ? name : latest));
}
