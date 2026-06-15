// Per-persona session file paths for resuming a subagent's conversation.
//
// Pure (no I/O): maps a persona name to the session file pi reads and writes via
// --session, so a follow-up dispatch can --continue the same conversation. A persona
// name is operator-authored, so it is path-safety checked here via the shared segment
// guard (the same one log.ts uses for runIds) — a hostile name can never traverse out
// of SESSIONS_DIR.

import { join } from "node:path";

import { SESSIONS_DIR } from "./constants.ts";
import { isSafePathSegment } from "./paths.ts";

/**
 * The session file a persona persists to and resumes from, or null when the persona name
 * is unsafe to embed in a path — so the caller dispatches without a session rather than
 * letting the name escape SESSIONS_DIR.
 */
export function sessionPathFor(cwd: string, personaName: string): string | null {
	if (!isSafePathSegment(personaName)) return null;
	return join(cwd, SESSIONS_DIR, `${personaName}.jsonl`);
}
