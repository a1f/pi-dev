import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSpawnArgv } from "./argv.ts";

test("default argv streams JSON with extensions off and the read-only tool allowlist", () => {
	assert.deepEqual(buildSpawnArgv({ task: "summarize the README" }), [
		"--mode",
		"json",
		"--no-extensions",
		"--tools",
		"read,grep,find,ls",
		"-p",
		"summarize the README",
	]);
});

test("custom tools join with commas and a model is inserted right after json", () => {
	assert.deepEqual(buildSpawnArgv({ task: "fix the bug", tools: ["read", "bash"], model: "opus" }), [
		"--mode",
		"json",
		"--model",
		"opus",
		"--no-extensions",
		"--tools",
		"read,bash",
		"-p",
		"fix the bug",
	]);
});

test("a task beginning with '-' is rejected (pi would read it as a flag, not the prompt)", () => {
	assert.throws(() => buildSpawnArgv({ task: "-v" }), /-v/);
});

test("a task beginning with '@' is rejected (pi would read it as a context file, not the prompt)", () => {
	assert.throws(() => buildSpawnArgv({ task: "@.env" }), /@\.env/);
});
