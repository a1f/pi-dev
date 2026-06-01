// Block-message builders for the two modes. Pure string assembly; the wiring
// in index.ts picks which one to use based on the rules' mode.

import { LABEL } from "./constants.ts";
import type { Violation } from "./evaluate.ts";

const PREFIX = `[${LABEL}]`;

function header(toolName: string, violation: Violation, invocation: string): string {
	return `${PREFIX}: ${toolName} blocked — ${violation.reason}\n\nAttempted: ${invocation}`;
}

/** Abort mode: hard stop, tell the agent not to route around the block. */
export function abortReason(toolName: string, violation: Violation, invocation: string): string {
	return [
		header(toolName, violation, invocation),
		"",
		"Do NOT work around this — no alternative command, path, or tool that achieves the same result.",
		"Report this block to the user verbatim and ask how to proceed.",
	].join("\n");
}

/** Continue mode: the turn keeps going, so hand back guidance to adapt. */
export function continueReason(toolName: string, violation: Violation, invocation: string): string {
	return [
		header(toolName, violation, invocation),
		"",
		"Don't retry this call. Decide which case you're in and continue:",
		"",
		"→ NON-DESTRUCTIVE (e.g. reading a secret to verify it, listing a protected dir, peeking at config):",
		"   Assume the data is present and correct and move on. If you truly need a value, ask the user for it.",
		"",
		"→ DESTRUCTIVE (delete, overwrite, force-push, drop, truncate, …):",
		"   Stop and tell the user exactly what you need to finish the task, then ask how to proceed.",
		"   Do not invent a workaround with the same effect.",
	].join("\n");
}
