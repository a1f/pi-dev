// Shared identifiers for the subagents extension.

/** UI label and the command/tool names the extension registers. */
export const LABEL = "subagents";
export const COMMAND = "agent";
export const TOOL = "agent_dispatch";

/** Command that tails the most recent run's log. */
export const LOG_COMMAND = "agent-log";

/** Per-run JSONL logs land here, relative to the project cwd. */
export const RUNS_DIR = ".pi/runs";

/** Custom entry type for the per-run audit record persisted via pi.appendEntry. */
export const AUDIT_TYPE = "subagent_run";

/** Default number of trailing log lines /agent-log shows. */
export const TAIL_LINES = 20;

/**
 * Default per-dispatch wall-clock cap (ms) handed to pi.exec, which SIGTERM→SIGKILLs
 * a child that overruns. This is only a hung-child guard; full timeout/escalation,
 * concurrency, and orphan cleanup are a later PR (slice 7).
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
