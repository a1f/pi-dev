// The single path-traversal guard for operator-authored names embedded as path segments.
//
// One security decision in one place: a persona name (session.ts → its session file) and a
// runId (log.ts → its run log file) are each embedded as a single filesystem path segment, so
// both must reject a separator or `..` before they reach disk. Keeping the predicate here means
// a future tightening of the charset updates every consumer at once, never just one of them.

/** Whether a name is safe to embed as a single path segment: the safe charset only, and no `..` traversal. */
export function isSafePathSegment(name: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}
