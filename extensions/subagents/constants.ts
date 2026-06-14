// Shared identifiers for the subagents extension.

/** UI label and the command/tool names the extension registers. */
export const LABEL = "subagents";
export const COMMAND = "agent";
export const TOOL = "agent_dispatch";

/**
 * Default per-dispatch wall-clock cap (ms) handed to pi.exec, which SIGTERM→SIGKILLs
 * a child that overruns. This is only a hung-child guard; full timeout/escalation,
 * concurrency, and orphan cleanup are a later PR (slice 7).
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
