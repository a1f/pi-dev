// Path and command matching for guardrails.
//
// Pure helpers, no pi coupling, so the policy can be unit-tested in isolation.
// All matching is heuristic by design: the threat model is the agent's own
// honest mistakes (not an adversary), and a VM is the real isolation boundary.

import { basename, isAbsolute, normalize, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { DELETE_VERBS, MUTATING_VERBS } from "./constants.ts";

/** Expand a leading `~` and any `$HOME` / `${HOME}` to the home directory. */
export function expandHome(input: string, home: string = homedir()): string {
	const tildeExpanded = input === "~" || input.startsWith("~/") ? home + input.slice(1) : input;
	return tildeExpanded.replace(/\$\{HOME\}|\$HOME/g, home);
}

/** Resolve a user-supplied path (possibly `~`, `$HOME`, or relative) to an absolute path. */
export function resolvePath(input: string, cwd: string, home: string = homedir()): string {
	return resolve(cwd, expandHome(input, home));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

const globRegExpCache = new Map<string, RegExp>();

/** Compile a single-segment glob (`*` = any run of non-`/` chars) to an anchored RegExp, memoized. */
function globToRegExp(glob: string): RegExp {
	let regex = globRegExpCache.get(glob);
	if (regex === undefined) {
		regex = new RegExp(`^${escapeRegExp(glob).replace(/\*/g, "[^/]*")}$`);
		globRegExpCache.set(glob, regex);
	}
	return regex;
}

/** Match a value against a literal or `*`-glob. Literals must match exactly — no substring. */
function globMatch(value: string, pattern: string): boolean {
	return pattern.includes("*") ? globToRegExp(pattern).test(value) : value === pattern;
}

// Segments come from splitting on "/", so none contains "/"; wrapping both sides
// in "/" makes this an exact contiguous-run check (e.g. `.git` at any depth).
function containsSegmentSequence(segments: readonly string[], needle: readonly string[]): boolean {
	if (needle.length === 0) return false;
	return `/${segments.join("/")}/`.includes(`/${needle.join("/")}/`);
}

/**
 * Does an absolute target path match a rule pattern? Supports directory patterns
 * (trailing `/`), absolute paths, relative paths, bare filenames, and `*` globs.
 * `~` / `$HOME` are expanded in the pattern first.
 */
export function matchPath(absoluteTarget: string, pattern: string, cwd: string, home: string = homedir()): boolean {
	const pat = expandHome(pattern.trim(), home);
	if (pat === "") return false;

	if (pat.endsWith("/")) {
		const dir = pat.slice(0, -1);
		if (isAbsolute(dir)) {
			const absDir = normalize(dir);
			return absoluteTarget === absDir || absoluteTarget.startsWith(`${absDir}/`);
		}
		const relSegments = relative(cwd, absoluteTarget).split("/");
		const needle = dir.split("/").filter((segment) => segment.length > 0);
		return containsSegmentSequence(relSegments, needle);
	}

	if (isAbsolute(pat)) return globMatch(absoluteTarget, pat);
	if (pat.includes("/")) return globMatch(relative(cwd, absoluteTarget), pat);
	return globMatch(basename(absoluteTarget), pat);
}

/** First pattern that matches the target, or null. */
export function firstMatch(
	absoluteTarget: string,
	patterns: readonly string[],
	cwd: string,
	home: string = homedir(),
): string | null {
	return patterns.find((pattern) => matchPath(absoluteTarget, pattern, cwd, home)) ?? null;
}

/** Split a shell command into candidate path tokens (best-effort). */
export function tokenizeCommand(command: string): string[] {
	return command.split(/[\s;|&><(){}'"`=]+/).filter((token) => token.length > 0);
}

function buildVerbRegExp(verbs: readonly string[]): RegExp {
	// Verb must stand alone as a word so `npm run format` is not read as `rm`.
	return new RegExp(`(?:^|[\\s;|&(])(?:${verbs.map(escapeRegExp).join("|")})(?=\\s|$)`);
}

const MUTATING_VERB_RE = buildVerbRegExp(MUTATING_VERBS);
const DELETE_VERB_RE = buildVerbRegExp(DELETE_VERBS);

/** Does the command appear to modify a file in place or via redirect? */
export function commandMutates(command: string): boolean {
	return MUTATING_VERB_RE.test(command) || command.includes(">");
}

/** Does the command appear to delete or move a file? */
export function commandDeletes(command: string): boolean {
	return DELETE_VERB_RE.test(command);
}
