// Shared string constants for the guardrails extension.

/**
 * Built-in pi tool names. `as const` preserves the literal types so they still
 * narrow `isToolCallEventType(...)` in adapter.ts.
 */
export const TOOLS = {
	BASH: "bash",
	READ: "read",
	WRITE: "write",
	EDIT: "edit",
	GREP: "grep",
	FIND: "find",
	LS: "ls",
} as const;

/** Bash verbs implying an in-place modification — gate for the readOnly bucket. */
export const MUTATING_VERBS = ["rm", "mv", "cp", "dd", "tee", "truncate", "sed", "chmod", "chown"] as const;

/** Bash verbs that delete or move — gate for the noDelete bucket. */
export const DELETE_VERBS = ["rm", "mv", "rmdir", "shred", "unlink"] as const;

/** UI label and audit-log entry type. */
export const LABEL = "guardrails";
export const LOG_TYPE = "guardrails-log";
