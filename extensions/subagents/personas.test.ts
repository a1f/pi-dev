import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PERSONA_ERRORS } from "./constants.ts";
import { loadPersonas, parsePersona, resolveDispatch, splitFirstToken } from "./personas.ts";

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
	assert.equal(expectError(parsePersona("Just a body, no frontmatter.")), PERSONA_ERRORS.noFence);

	// (b) frontmatter that is not valid YAML (unterminated quote): a prefix plus the underlying error.
	assert.ok(expectError(parsePersona('---\nname: "unterminated\n---\nbody')).startsWith(PERSONA_ERRORS.invalidYaml));

	// (c) frontmatter missing a non-empty name.
	assert.equal(expectError(parsePersona("---\ndescription: has no name\n---\nbody")), PERSONA_ERRORS.noName);

	// (d) a whitespace-only description is rejected just like an empty name.
	assert.equal(expectError(parsePersona('---\nname: x\ndescription: "   "\n---\nbody')), PERSONA_ERRORS.noDescription);

	// Our explicit choice: a non-sequence `tools` is an error, not silently ignored.
	assert.equal(expectError(parsePersona("---\nname: x\ndescription: y\ntools: not-a-list\n---\nbody")), PERSONA_ERRORS.badTools);

	// Our explicit choice: a non-string `model` is an error, not silently ignored.
	assert.equal(expectError(parsePersona("---\nname: x\ndescription: y\nmodel:\n  - a\n---\nbody")), PERSONA_ERRORS.badModel);
});

test("splitFirstToken splits the leading whitespace token from the trimmed remainder", () => {
	// Surrounding and interior whitespace collapses: head is the first token, rest is the trimmed tail.
	assert.deepEqual(splitFirstToken("  scout  map the repo "), { head: "scout", rest: "map the repo" });
	// A bare single token has no remainder.
	assert.deepEqual(splitFirstToken("scout"), { head: "scout", rest: "" });
	// All-whitespace input yields an empty head (the caller treats that as a usage error).
	assert.deepEqual(splitFirstToken("   "), { head: "", rest: "" });
	// A head may contain a path separator (e.g. an unsafe persona name); it is still a single token.
	assert.deepEqual(splitFirstToken("a/b do it"), { head: "a/b", rest: "do it" });
});

test("resolveDispatch matches the first token to a persona name and returns the remainder as the task", () => {
	const scout = expectOk(parsePersona("---\nname: scout\ndescription: Maps the repo.\n---\nYou are scout."));
	const reviewer = expectOk(parsePersona("---\nname: reviewer\ndescription: Reviews diffs.\n---\nYou are a reviewer."));

	const resolved = resolveDispatch("scout  map the repo ", [reviewer, scout]);
	assert.equal(resolved.persona, scout);
	assert.equal(resolved.task, "map the repo");
});

test("resolveDispatch returns an empty task for a bare persona name", () => {
	const scout = expectOk(parsePersona("---\nname: scout\ndescription: Maps the repo.\n---\nYou are scout."));

	// A bare persona name with no remainder leaves the task empty (caller treats that as a usage error).
	assert.deepEqual(resolveDispatch("scout", [scout]), { persona: scout, task: "" });
});

test("resolveDispatch treats an unrecognized first token as part of the task, not a persona", () => {
	const scout = expectOk(parsePersona("---\nname: scout\ndescription: Maps the repo.\n---\nYou are scout."));
	assert.deepEqual(resolveDispatch("summarize the readme", [scout]), { persona: null, task: "summarize the readme" });
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

test("loadPersonas loads a persona from the global agent dir when the project has no .pi/agents", () => {
	const root = mkdtempSync(join(tmpdir(), "personas-"));
	try {
		// A project cwd that exists but has no .pi/agents of its own — the only source is the global one.
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });

		// pi's global agent root holds one valid persona under its agents/ subdirectory.
		const agentDir = join(root, "agent");
		const globalAgents = join(agentDir, "agents");
		mkdirSync(globalAgents, { recursive: true });
		writeFileSync(
			join(globalAgents, "globalcoder.md"),
			"---\nname: globalcoder\ndescription: A globally-installed coder.\n---\nYou are a coder.",
		);

		const { personas, warnings } = loadPersonas(cwd, agentDir);
		assert.deepEqual(
			personas.map((persona) => persona.name),
			["globalcoder"],
		);
		assert.deepEqual(warnings, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadPersonas prefers the project persona on a name collision and lists it only once", () => {
	const root = mkdtempSync(join(tmpdir(), "personas-"));
	try {
		// Both the project and the global agent dir define a persona named "shared"; project wins.
		const cwd = join(root, "project");
		const projectAgents = join(cwd, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			join(projectAgents, "shared.md"),
			"---\nname: shared\ndescription: Project shared persona.\n---\nProject body.",
		);

		const agentDir = join(root, "agent");
		const globalAgents = join(agentDir, "agents");
		mkdirSync(globalAgents, { recursive: true });
		writeFileSync(
			join(globalAgents, "shared.md"),
			"---\nname: shared\ndescription: Global shared persona.\n---\nGlobal body.",
		);
		writeFileSync(
			join(globalAgents, "globalonly.md"),
			"---\nname: globalonly\ndescription: A global-only persona.\n---\nGlobal-only body.",
		);

		const { personas } = loadPersonas(cwd, agentDir);

		// The colliding name yields exactly one persona, resolved to the project file.
		assert.equal(personas.filter((persona) => persona.name === "shared").length, 1);
		const shared = personas.find((persona) => persona.name === "shared");
		assert.equal(shared?.source, join(cwd, ".pi", "agents", "shared.md"));

		// A persona that exists only in the global dir still loads.
		assert.ok(personas.some((persona) => persona.name === "globalonly"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
