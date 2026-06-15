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

/** Per-run JSONL logs land here, relative to the project cwd. */
export const RUNS_DIR = ".pi/runs";

/** Per-persona session files land here, relative to the project cwd, so a persona can be resumed. */
export const SESSIONS_DIR = ".pi/sessions";

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
