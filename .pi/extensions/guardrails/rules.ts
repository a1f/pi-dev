// Rule types + loading/compilation for guardrails.
//
// Rules live in `<cwd>/.pi/guardrails.yaml` (project) with a fallback to
// `~/.pi/guardrails.yaml` (global). Bash regexes are compiled once, and a bad
// pattern is dropped with a warning rather than crashing the agent.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Mode = "abort" | "continue";

export interface BashPatternRule {
	readonly pattern: string;
	readonly reason: string;
	readonly ask?: boolean;
}

/** Raw rules-file shape as parsed from YAML. Every field is optional. */
export interface RulesFile {
	readonly mode?: Mode;
	readonly bashToolPatterns?: readonly BashPatternRule[];
	readonly zeroAccessPaths?: readonly string[];
	readonly readOnlyPaths?: readonly string[];
	readonly noDeletePaths?: readonly string[];
}

export interface CompiledBashPattern {
	readonly regex: RegExp;
	readonly reason: string;
	readonly ask: boolean;
}

export interface CompiledRules {
	readonly mode: Mode;
	readonly bashToolPatterns: readonly CompiledBashPattern[];
	readonly zeroAccessPaths: readonly string[];
	readonly readOnlyPaths: readonly string[];
	readonly noDeletePaths: readonly string[];
}

export interface LoadResult {
	readonly rules: CompiledRules;
	/** Absolute path the rules were loaded from, or null when no file was found. */
	readonly source: string | null;
	readonly warnings: readonly string[];
}

export const RULES_FILENAME = "guardrails.yaml";

export const EMPTY_RULES: CompiledRules = {
	mode: "continue",
	bashToolPatterns: [],
	zeroAccessPaths: [],
	readOnlyPaths: [],
	noDeletePaths: [],
};

/** Total rule count across all buckets — for the status line. */
export function ruleCount(rules: CompiledRules): number {
	return (
		rules.bashToolPatterns.length +
		rules.zeroAccessPaths.length +
		rules.readOnlyPaths.length +
		rules.noDeletePaths.length
	);
}

/** Load rules from the project location, falling back to the global one. */
export function loadRules(cwd: string, home: string = homedir()): LoadResult {
	const candidates = [join(cwd, ".pi", RULES_FILENAME), join(home, ".pi", RULES_FILENAME)];
	const source = candidates.find((path) => existsSync(path)) ?? null;
	if (source === null) return { rules: EMPTY_RULES, source: null, warnings: [] };
	try {
		const parsed = parseYaml(readFileSync(source, "utf8")) as RulesFile | null;
		return compileRules(parsed ?? {}, source);
	} catch (error) {
		return { rules: EMPTY_RULES, source, warnings: [`failed to parse ${source}: ${messageOf(error)}`] };
	}
}

/** Compile a parsed rules file: precompile bash regexes once, dropping invalid ones with a warning. */
export function compileRules(file: RulesFile, source: string | null): LoadResult {
	const warnings: string[] = [];
	const bashToolPatterns: CompiledBashPattern[] = [];
	for (const rule of file.bashToolPatterns ?? []) {
		try {
			bashToolPatterns.push({ regex: new RegExp(rule.pattern), reason: rule.reason, ask: rule.ask ?? false });
		} catch (error) {
			warnings.push(`ignoring invalid bash pattern /${rule.pattern}/: ${messageOf(error)}`);
		}
	}
	const rules: CompiledRules = {
		mode: file.mode === "abort" ? "abort" : "continue",
		bashToolPatterns,
		zeroAccessPaths: file.zeroAccessPaths ?? [],
		readOnlyPaths: file.readOnlyPaths ?? [],
		noDeletePaths: file.noDeletePaths ?? [],
	};
	return { rules, source, warnings };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
