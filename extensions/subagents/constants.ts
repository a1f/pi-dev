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
