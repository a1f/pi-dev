// Policy evaluation: given a normalized tool call and the compiled rules,
// decide whether it is a violation. Pure and pi-decoupled (see adapter.ts for
// the mapping from pi's ToolCallEvent to NormalizedCall).

import { commandDeletes, commandMutates, firstMatch, resolvePath, tokenizeCommand } from "./match.ts";
import type { CompiledRules } from "./rules.ts";

export type ViolationCategory = "zeroAccess" | "readOnly" | "noDelete" | "bashPattern";

export interface Violation {
	readonly category: ViolationCategory;
	readonly reason: string;
	readonly ask: boolean;
}

/** A tool call reduced to just what the policy needs, decoupled from pi's event types. */
export type NormalizedCall =
	| { readonly kind: "bash"; readonly command: string }
	| { readonly kind: "paths"; readonly paths: readonly string[]; readonly write: boolean }
	| { readonly kind: "ignore" };

export function evaluateNormalized(call: NormalizedCall, rules: CompiledRules, cwd: string, home?: string): Violation | null {
	if (call.kind === "bash") return evaluateBash(call.command, rules, cwd, home);
	if (call.kind === "paths") return evaluatePaths(call.paths, call.write, rules, cwd, home);
	return null;
}

/** First token matching any pattern in the bucket, turned into a Violation. */
function scan(
	absoluteTokens: readonly string[],
	patterns: readonly string[],
	category: ViolationCategory,
	reasonPrefix: string,
	cwd: string,
	home: string | undefined,
): Violation | null {
	for (const token of absoluteTokens) {
		const matched = firstMatch(token, patterns, cwd, home);
		if (matched !== null) return { category, reason: `${reasonPrefix}${matched}`, ask: false };
	}
	return null;
}

function evaluatePaths(
	paths: readonly string[],
	write: boolean,
	rules: CompiledRules,
	cwd: string,
	home?: string,
): Violation | null {
	const tokens = paths.map((path) => resolvePath(path, cwd, home));
	const zero = scan(tokens, rules.zeroAccessPaths, "zeroAccess", "access to protected path denied: ", cwd, home);
	if (zero !== null) return zero;
	if (write) return scan(tokens, rules.readOnlyPaths, "readOnly", "write to read-only path denied: ", cwd, home);
	return null;
}

function evaluateBash(command: string, rules: CompiledRules, cwd: string, home?: string): Violation | null {
	for (const rule of rules.bashToolPatterns) {
		if (rule.regex.test(command)) return { category: "bashPattern", reason: rule.reason, ask: rule.ask };
	}

	// Resolve every path-like token once, then test the buckets against it.
	const tokens = tokenizeCommand(command).map((token) => resolvePath(token, cwd, home));

	const zero = scan(tokens, rules.zeroAccessPaths, "zeroAccess", "command references protected path: ", cwd, home);
	if (zero !== null) return zero;
	if (commandMutates(command)) {
		const readOnly = scan(tokens, rules.readOnlyPaths, "readOnly", "command may modify read-only path: ", cwd, home);
		if (readOnly !== null) return readOnly;
	}
	if (commandDeletes(command)) {
		return scan(tokens, rules.noDeletePaths, "noDelete", "command may delete or move protected path: ", cwd, home);
	}
	return null;
}
