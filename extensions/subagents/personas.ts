// Persona frontmatter parser + project-scoped directory scan for subagents.
//
// Pure and total, mirroring guardrails/rules.ts (load → parse → warn): parsePersona
// maps a markdown string to a Persona or an error and never throws on bad input, and
// loadPersonas reads <cwd>/.pi/agents/*.md, skipping malformed files with a warning.
// No pi runtime, no child_process, no mutation — it only reads from disk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Subdirectory of `<cwd>/.pi/` that holds persona markdown files. */
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
	if (split === null) return { error: "missing '---' frontmatter fence" };
	let parsed: unknown;
	try {
		parsed = parseYaml(split.yaml);
	} catch (error) {
		return { error: `invalid YAML frontmatter: ${messageOf(error)}` };
	}
	if (!isMapping(parsed)) return { error: "frontmatter is not a YAML mapping" };
	const { name, description } = parsed;
	if (typeof name !== "string" || name.trim() === "") {
		return { error: "frontmatter is missing a non-empty 'name'" };
	}
	if (typeof description !== "string" || description.trim() === "") {
		return { error: "frontmatter is missing a non-empty 'description'" };
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
 * Load every persona under `<cwd>/.pi/agents/*.md` in filename order (project-scoped,
 * no homedir fallback). A missing directory yields no personas and no warnings;
 * malformed files are skipped and reported in `warnings`.
 */
export function loadPersonas(cwd: string): { personas: Persona[]; warnings: string[] } {
	const dir = join(cwd, ".pi", AGENTS_DIRNAME);
	if (!existsSync(dir)) return { personas: [], warnings: [] };
	const personas: Persona[] = [];
	const warnings: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		// .pi/agents is a file, unreadable, or otherwise unlistable: warn rather than throw.
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
	return { error: "'tools' must be a sequence of strings" };
}

/** An optional `model:` field: absent → null, a string → that string, anything else → error. */
function readModel(value: unknown): FieldResult<string | null> {
	if (value === undefined || value === null) return { value: null };
	if (typeof value === "string") return { value };
	return { error: "'model' must be a string" };
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
