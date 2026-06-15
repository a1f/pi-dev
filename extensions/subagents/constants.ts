// Shared identifiers for the subagents extension.

/** UI label and the command/tool names the extension registers. */
export const LABEL = "subagents";
export const COMMAND = "agent";
export const TOOL = "agent_dispatch";
export const STATUS_TOOL = "agent_status";
export const KILL_TOOL = "agent_kill";

/** Tool and command that resume a persona's prior session in a fresh headless child. */
export const CONTINUE_TOOL = "agent_continue";
export const CONTINUE_COMMAND = "agent-continue";

/** Command that tails the most recent run's log. */
export const LOG_COMMAND = "agent-log";

/** Widget key the live grid dashboard is pushed under, so each refresh replaces the prior footer. */
export const DASHBOARD_WIDGET = "subagents";

/** How often (ms) the dashboard re-renders while any run is live, so elapsed time animates between handler calls. */
export const DASHBOARD_REFRESH_MS = 1000;

/** Per-run JSONL logs land here, relative to the project cwd. */
export const RUNS_DIR = ".pi/runs";

/** Pidfile tracking in-flight child pids for cross-session orphan cleanup; deliberately outside `.pi/runs/` so it never collides with /agent-log's latest-`.jsonl` pick. */
export const INFLIGHT_FILE = ".pi/agent-inflight.jsonl";

/** Per-persona session files land here, relative to the project cwd, so a persona can be resumed. */
export const SESSIONS_DIR = ".pi/sessions";

/** Custom entry type for the per-run audit record persisted via pi.appendEntry. */
export const AUDIT_TYPE = "subagent_run";

/** Default number of trailing log lines /agent-log shows. */
export const TAIL_LINES = 20;

/**
 * Default per-dispatch wall-clock cap (ms) passed to the spawn wrapper, which SIGTERM→SIGKILLs
 * a child that overruns. This is the hung-child guard; timeout escalation and orphan cleanup
 * ship in slice 7.1, and the concurrency cap and FIFO queue (see DEFAULT_CONCURRENCY) ship in 7.2.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Default cap on how many subagent children run at once; the rest queue and drain FIFO (e.g. 6 dispatched at cap 4 → 2 wait their turn). */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Parse-error messages returned by parsePersona. Named so call-sites stay terse and
 * tests can assert exact equality instead of matching substrings. `invalidYaml` is a
 * prefix — the underlying YAML error is appended after it.
 */
export const PERSONA_ERRORS = {
	noFence: "missing '---' frontmatter fence",
	invalidYaml: "invalid YAML frontmatter",
	notMapping: "frontmatter is not a YAML mapping",
	noName: "frontmatter is missing a non-empty 'name'",
	noDescription: "frontmatter is missing a non-empty 'description'",
	badTools: "'tools' must be a sequence of strings",
	badModel: "'model' must be a string",
} as const;
