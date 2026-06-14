import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPersonas, parsePersona } from "./personas.ts";

// loadPersonas scans <cwd>/.pi/agents; the fixtures provide a small workspace whose
// .pi/agents directory holds two valid personas and one malformed file.
const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "fixtures", "workspace");

/** Narrow a parse result to its persona, failing the test on an unexpected error. */
function expectOk<T>(result: { persona: T } | { error: string }): T {
	if ("error" in result) assert.fail(`expected a persona, got error: ${result.error}`);
	return result.persona;
}

test("parsePersona reads name, description and body, defaulting tools and model to null", () => {
	const content = `---
name: summarizer
description: Summarizes long documents into a few sentences.
---
You are a concise summarizer.

Keep it to three sentences.`;
	const persona = expectOk(parsePersona(content));
	assert.equal(persona.name, "summarizer");
	assert.equal(persona.description, "Summarizes long documents into a few sentences.");
	assert.equal(persona.tools, null);
	assert.equal(persona.model, null);
	assert.equal(persona.systemPrompt, "You are a concise summarizer.\n\nKeep it to three sentences.");
	assert.equal(persona.source, null);
});

test("parsePersona populates tools as a string array and model as a string", () => {
	const content = `---
name: reviewer
description: Reviews diffs for correctness and clarity.
tools:
  - read
  - grep
model: claude-opus-4
---
You are a meticulous code reviewer.`;
	const persona = expectOk(parsePersona(content, "/abs/path/reviewer.md"));
	assert.equal(persona.name, "reviewer");
	assert.deepEqual(persona.tools, ["read", "grep"]);
	assert.equal(persona.model, "claude-opus-4");
	assert.equal(persona.source, "/abs/path/reviewer.md");
});

test("parsePersona reports invalid input as an error naming the cause, without throwing", () => {
	const expectError = (result: ReturnType<typeof parsePersona>): string => {
		if (!("error" in result)) assert.fail("expected an error result, got a persona");
		return result.error;
	};

	// (a) no frontmatter fence at all.
	assert.match(expectError(parsePersona("Just a body, no frontmatter.")), /frontmatter|fence/);

	// (b) frontmatter that is not valid YAML (unterminated quote).
	assert.match(expectError(parsePersona('---\nname: "unterminated\n---\nbody')), /YAML/);

	// (c) frontmatter missing a non-empty name.
	assert.match(expectError(parsePersona("---\ndescription: has no name\n---\nbody")), /name/);

	// (d) a whitespace-only description is rejected just like an empty name.
	assert.match(expectError(parsePersona('---\nname: x\ndescription: "   "\n---\nbody')), /description/);

	// Our explicit choice: a non-sequence `tools` is an error, not silently ignored.
	assert.match(expectError(parsePersona("---\nname: x\ndescription: y\ntools: not-a-list\n---\nbody")), /tools/);

	// Our explicit choice: a non-string `model` is an error, not silently ignored.
	assert.match(expectError(parsePersona("---\nname: x\ndescription: y\nmodel:\n  - a\n---\nbody")), /model/);
});

test("loadPersonas returns valid personas in filename order and warns about a malformed file", () => {
	const { personas, warnings } = loadPersonas(workspace);
	assert.deepEqual(
		personas.map((persona) => persona.name),
		["reviewer", "summarizer"],
	);
	assert.deepEqual(personas[0]?.tools, ["read", "grep"]);
	assert.equal(personas[0]?.model, "claude-opus-4");
	assert.equal(personas[0]?.source, join(workspace, ".pi", "agents", "reviewer.md"));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /broken\.md/);
});

test("loadPersonas skips a .md entry that is a directory, warning instead of throwing", () => {
	const root = mkdtempSync(join(tmpdir(), "personas-"));
	try {
		const agents = join(root, ".pi", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, "valid.md"), "---\nname: valid\ndescription: A real persona.\n---\nBody.");
		mkdirSync(join(agents, "notapersona.md")); // a directory whose name ends in .md → readFileSync throws EISDIR

		const { personas, warnings } = loadPersonas(root);
		assert.deepEqual(
			personas.map((persona) => persona.name),
			["valid"],
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /notapersona\.md/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadPersonas returns nothing for a cwd without a .pi/agents directory", () => {
	const { personas, warnings } = loadPersonas(join(here, "fixtures", "no-such-workspace"));
	assert.deepEqual(personas, []);
	assert.deepEqual(warnings, []);
});
