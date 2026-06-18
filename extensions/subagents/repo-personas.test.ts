import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPersonas, type Persona } from "./personas.ts";

// The demo personas ship in the repo's own .pi/agents directory. This test file lives in
// extensions/subagents/, so the repo root (which holds .pi/agents) is two directories up;
// derive it from the module URL rather than process.cwd() so the test is location-stable.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Find a loaded persona by exact name, failing the test (not returning undefined) when absent. */
function load(personas: readonly Persona[], name: string): Persona {
	const persona = personas.find((candidate) => candidate.name === name);
	assert.ok(persona, `expected persona "${name}" to load from ${repoRoot}/.pi/agents`);
	return persona;
}

/** A persona's declared tool list, failing the test when tools were left unspecified. */
function toolsOf(persona: Persona): readonly string[] {
	assert.ok(persona.tools, `expected persona "${persona.name}" to declare a tools list`);
	return persona.tools;
}

test("repo demo personas load clean as coder/reviewer/critic with the agreed tool + prompt contract", () => {
	const { personas, warnings } = loadPersonas(repoRoot);

	// Every persona markdown file parses without error.
	assert.deepEqual(warnings, []);

	const coder = load(personas, "coder");
	const reviewer = load(personas, "reviewer");
	const critic = load(personas, "critic");

	// read is granted to all three.
	for (const persona of [coder, reviewer, critic]) {
		assert.ok(toolsOf(persona).includes("read"), `expected "${persona.name}" to grant read`);
	}

	// reviewer and critic are read-only: exactly [read, grep, ls, bash], order-insensitive.
	const readOnly = ["bash", "grep", "ls", "read"];
	assert.deepEqual([...toolsOf(reviewer)].sort(), readOnly);
	assert.deepEqual([...toolsOf(critic)].sort(), readOnly);

	// coder gets the full toolset: the read-only four plus write + edit, and nothing else.
	assert.deepEqual([...toolsOf(coder)].sort(), ["bash", "edit", "grep", "ls", "read", "write"]);

	// reviewer and critic must state that a black-letter rule violation is never waivable.
	// Collapse whitespace first so prose line-wrapping can't split a checked phrase across lines.
	const prose = (persona: Persona): string => persona.systemPrompt.replace(/\s+/g, " ");
	assert.match(prose(reviewer), /never[ -]waivable/i);
	assert.match(prose(critic), /never[ -]waivable/i);

	// all three are told the coding-rule files arrive as absolute paths in the task.
	for (const persona of [coder, reviewer, critic]) {
		assert.match(prose(persona), /absolute path/i);
	}
});
