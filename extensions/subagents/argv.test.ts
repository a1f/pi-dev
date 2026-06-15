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

test("a system prompt is emitted as --system-prompt, in the model slot before --no-extensions", () => {
	assert.deepEqual(buildSpawnArgv({ task: "review the diff", systemPrompt: "You are a reviewer." }), [
		"--mode",
		"json",
		"--system-prompt",
		"You are a reviewer.",
		"--no-extensions",
		"--tools",
		"read,grep,find,ls",
		"-p",
		"review the diff",
	]);
});

test("explicit extensions each emit --extension and still keep --no-extensions (recursion guard)", () => {
	assert.deepEqual(buildSpawnArgv({ task: "map the repo", extensions: ["/abs/guardrails", "/abs/other"] }), [
		"--mode",
		"json",
		"--no-extensions",
		"--extension",
		"/abs/guardrails",
		"--extension",
		"/abs/other",
		"--tools",
		"read,grep,find,ls",
		"-p",
		"map the repo",
	]);
});

test("a session path emits --session, and --continue is added only when continueSession is set", () => {
	// A continue dispatch resumes a persona's session: --session <path> --continue, placed in
	// the session slot right after --mode json (before model/system-prompt/no-extensions).
	assert.deepEqual(buildSpawnArgv({ task: "follow up", session: "/work/.pi/sessions/scout.jsonl", continueSession: true }), [
		"--mode",
		"json",
		"--session",
		"/work/.pi/sessions/scout.jsonl",
		"--continue",
		"--no-extensions",
		"--tools",
		"read,grep,find,ls",
		"-p",
		"follow up",
	]);

	// A fresh persona dispatch emits --session with no --continue: the argv carries the session flag but not the explicit-continue marker.
	assert.deepEqual(buildSpawnArgv({ task: "summarize", session: "/work/.pi/sessions/scout.jsonl" }), [
		"--mode",
		"json",
		"--session",
		"/work/.pi/sessions/scout.jsonl",
		"--no-extensions",
		"--tools",
		"read,grep,find,ls",
		"-p",
		"summarize",
	]);
});

test("a task beginning with '-' is rejected (pi would read it as a flag, not the prompt)", () => {
	assert.throws(() => buildSpawnArgv({ task: "-v" }), /-v/);
});

test("a task beginning with '@' is rejected (pi would read it as a context file, not the prompt)", () => {
	assert.throws(() => buildSpawnArgv({ task: "@.env" }), /@\.env/);
});
