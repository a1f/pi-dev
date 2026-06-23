// Persona frontmatter parser + agent-directory scan (global + project) for subagents.
//
// Pure and total, mirroring guardrails/rules.ts (load → parse → warn): parsePersona
// maps a markdown string to a Persona or an error and never throws on bad input, and
// loadPersonas reads *.md from the global agent dir and <cwd>/.pi/agents, skipping
// malformed files with a warning.
// resolveDispatch (pure, no I/O) splits a `/agent` argument into a persona + task.
// No pi runtime, no child_process, no mutation — it only reads from disk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { PERSONA_ERRORS } from "./constants.ts";

/** Name of the directory that holds persona markdown files, under both `<cwd>/.pi/` and the global agent dir. */
export const AGENTS_DIRNAME = "agents";

export interface Persona {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[] | null; // null = unspecified → caller falls back to defaults
	readonly model: string | null; // null = unspecified → child inherits the parent's model
	readonly systemPrompt: string; // markdown body, trimmed
	readonly source: string | null; // absolute file path, or null when parsed from a raw string
}

/** Parse a persona markdown file (`---` YAML frontmatter + body) into a Persona, never throwing. */
export function parsePersona(content: string, source?: string): { persona: Persona } | { error: string } {
	const split = splitFrontmatter(content);
	if (split === null) return { error: PERSONA_ERRORS.noFence };
	let parsed: unknown;
	try {
		parsed = parseYaml(split.yaml);
	} catch (error) {
		return { error: `${PERSONA_ERRORS.invalidYaml}: ${messageOf(error)}` };
	}
	if (!isMapping(parsed)) return { error: PERSONA_ERRORS.notMapping };
	const { name, description } = parsed;
	if (typeof name !== "string" || name.trim() === "") {
		return { error: PERSONA_ERRORS.noName };
	}
	if (typeof description !== "string" || description.trim() === "") {
		return { error: PERSONA_ERRORS.noDescription };
	}
	const tools = readTools(parsed.tools);
	if ("error" in tools) return tools;
	const model = readModel(parsed.model);
	if ("error" in model) return model;
	const persona: Persona = {
		name,
		description,
		tools: tools.value,
		model: model.value,
		systemPrompt: split.body.trim(),
		source: source ?? null,
	};
	return { persona };
}

/**
 * Split a `/agent` argument string into its leading whitespace-delimited token and the trimmed
 * remainder — the one place the `/agent [head] rest` grammar lives, shared by resolveDispatch
 * (persona + task) and the /agent-continue handler (persona + follow-up). `head` is "" only for
 * an all-whitespace input; `rest` is "" when the input is a bare single token.
 */
export function splitFirstToken(args: string): { head: string; rest: string } {
	const trimmed = args.trim();
	const space = trimmed.search(/\s/);
	if (space === -1) return { head: trimmed, rest: "" };
	return { head: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

/**
 * Resolve a `/agent` argument string into a persona + task. The first whitespace-delimited
 * token selects a persona by exact name and the trimmed remainder becomes the task; an
 * unrecognized first token means no persona, so the whole trimmed string is the task. A bare
 * persona name leaves the task empty for the caller to reject as a usage error.
 */
export function resolveDispatch(args: string, personas: readonly Persona[]): { persona: Persona | null; task: string } {
	const { head, rest } = splitFirstToken(args);
	const persona = personas.find((candidate) => candidate.name === head) ?? null;
	if (persona === null) return { persona: null, task: args.trim() };
	return { persona, task: rest };
}

/**
 * Load personas from pi's two agent roots — the global agent dir and the project's `<cwd>/.pi/`.
 * On a name collision the project persona wins, so each name appears exactly once; warnings from
 * both roots are concatenated (global first). Each directory is scanned independently:
 * a missing one contributes nothing; malformed files are skipped and reported in `warnings`.
 * `agentDir` defaults to pi core's getAgentDir resolution: the `PI_CODING_AGENT_DIR` override, else
 * `~/.pi/agent`.
 */
export function loadPersonas(
	cwd: string,
	agentDir: string = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): { personas: Persona[]; warnings: string[] } {
	const fromGlobal = loadPersonasFromDir(join(agentDir, AGENTS_DIRNAME));
	const fromProject = loadPersonasFromDir(join(cwd, ".pi", AGENTS_DIRNAME));
	// Dedupe by name with project precedence: seed the map with the global personas, then let the
	// project personas overwrite any shared name, so a collision resolves to the project file and
	// each name appears exactly once.
	const byName = new Map<string, Persona>();
	for (const persona of fromGlobal.personas) byName.set(persona.name, persona);
	for (const persona of fromProject.personas) byName.set(persona.name, persona);
	return {
		personas: [...byName.values()],
		warnings: [...fromGlobal.warnings, ...fromProject.warnings],
	};
}

/**
 * Scan a single `agents/` directory for `*.md` personas in filename order. A missing directory
 * yields no personas and no warnings; an unlistable directory or a malformed/unreadable file is
 * skipped and reported in `warnings`.
 */
function loadPersonasFromDir(dir: string): { personas: Persona[]; warnings: string[] } {
	if (!existsSync(dir)) return { personas: [], warnings: [] };
	const personas: Persona[] = [];
	const warnings: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		// dir is a file, unreadable, or otherwise unlistable: warn rather than throw.
		return { personas, warnings: [`skipping ${dir}: ${messageOf(error)}`] };
	}
	for (const file of entries.filter((name) => name.endsWith(".md")).sort()) {
		const path = join(dir, file);
		try {
			const result = parsePersona(readFileSync(path, "utf8"), path);
			if ("error" in result) warnings.push(`skipping ${path}: ${result.error}`);
			else personas.push(result.persona);
		} catch (error) {
			// A .md entry that is a directory (EISDIR), a broken symlink (ENOENT), or unreadable (EACCES).
			warnings.push(`skipping ${path}: ${messageOf(error)}`);
		}
	}
	return { personas, warnings };
}

type FieldResult<T> = { value: T } | { error: string };

/** An optional `tools:` sequence: absent → null, a string sequence → that array, anything else → error. */
function readTools(value: unknown): FieldResult<readonly string[] | null> {
	if (value === undefined || value === null) return { value: null };
	if (isStringArray(value)) return { value };
	return { error: PERSONA_ERRORS.badTools };
}

/** An optional `model:` field: absent → null, a string → that string, anything else → error. */
function readModel(value: unknown): FieldResult<string | null> {
	if (value === undefined || value === null) return { value: null };
	if (typeof value === "string") return { value };
	return { error: PERSONA_ERRORS.badModel };
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Split content into its YAML frontmatter and body, or null when the `---` fence is absent. */
function splitFrontmatter(content: string): { yaml: string; body: string } | null {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
	if (match === null) return null;
	return { yaml: match[1] ?? "", body: match[2] ?? "" };
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
