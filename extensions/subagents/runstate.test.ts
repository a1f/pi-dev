import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reduceRunState, reduceRunStateFromString } from "./runstate.ts";

// Fixtures are schema-accurate, hand-authored streams matching the pi 0.77
// `--mode json` event shapes (not a live capture).
const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

test("toolCount counts every tool_execution_start in the stream", () => {
	const state = reduceRunStateFromString(readFixture("research-run.jsonl"));
	assert.equal(state.toolCount, 2);
});

test("lastLine is the last non-empty line of the most recent assistant text", () => {
	const state = reduceRunStateFromString(readFixture("research-run.jsonl"));
	assert.equal(state.lastLine, "Done.");
});

test("lastLine ignores messages that carry no text and keeps the latest line", () => {
	const state = reduceRunState([
		'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first\\n  \\nsecond line"}],"stopReason":"endTurn"}}',
		'{"type":"turn_end","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read","input":{}}],"stopReason":"toolUse"}}',
	]);
	assert.equal(state.lastLine, "second line");
});

test("contextTokens takes the latest usage totalTokens; contextPct needs a window", () => {
	const withWindow = reduceRunStateFromString(readFixture("research-run.jsonl"), {
		contextWindow: 200000,
	});
	assert.equal(withWindow.contextTokens, 12345);
	assert.equal(withWindow.contextPct, (12345 / 200000) * 100);

	const noWindow = reduceRunStateFromString(readFixture("research-run.jsonl"));
	assert.equal(noWindow.contextTokens, 12345);
	assert.equal(noWindow.contextPct, null);
});

test("contextTokens falls back to input+output+cacheRead+cacheWrite without totalTokens", () => {
	const state = reduceRunState([
		'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"stopReason":"endTurn","usage":{"input":100,"output":20,"cacheRead":5,"cacheWrite":3}}}',
	]);
	assert.equal(state.contextTokens, 128);
});

test("contextTokens ignores usage on aborted or error messages and keeps the latest valid one", () => {
	const state = reduceRunState([
		'{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"endTurn","usage":{"totalTokens":500}}}',
		'{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"aborted","usage":{"totalTokens":999}}}',
		'{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","usage":{"totalTokens":777}}}',
	]);
	assert.equal(state.contextTokens, 500);
});

test("contextTokens is null and contextPct is null when no usage is ever seen", () => {
	const state = reduceRunStateFromString(readFixture("summarize-readme.jsonl"), {
		contextWindow: 200000,
	});
	assert.equal(state.contextTokens, null);
	assert.equal(state.contextPct, null);
});

test("done flips true once a terminal agent_end is seen", () => {
	const state = reduceRunStateFromString(readFixture("research-run.jsonl"));
	assert.equal(state.done, true);
});

test("a willRetry agent_end is a retry boundary, not a terminal done", () => {
	const state = reduceRunState([
		'{"type":"agent_end","messages":[],"willRetry":true}',
	]);
	assert.equal(state.done, false);
});

test("a stream that never terminates is not done", () => {
	const state = reduceRunStateFromString(readFixture("early-termination.jsonl"));
	assert.equal(state.done, false);
});

test("malformed lines are counted and skipped, blank lines ignored, never thrown", () => {
	const state = reduceRunStateFromString(readFixture("noisy-run.jsonl"));
	assert.equal(state.malformed, 1);
	assert.equal(state.done, true);
	assert.equal(state.toolCount, 1);
	assert.equal(state.lastLine, "The config is valid.");
	assert.equal(state.contextTokens, 2824);
});
