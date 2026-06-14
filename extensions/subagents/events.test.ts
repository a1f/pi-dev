import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseEvents, parseEventStream } from "./events.ts";

// Fixtures are schema-accurate, hand-authored streams matching the pi 0.77
// `--mode json` event shapes (not a live capture).
const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

test("happy-path stream is done with the final assistant text", () => {
	const result = parseEventStream(readFixture("summarize-readme.jsonl"));
	assert.equal(result.done, true);
	assert.equal(result.finalText, "The README explains how to set up the dev VM.");
	assert.equal(result.malformed, 0);
});

test("a malformed line is skipped and counted without derailing the parse", () => {
	const result = parseEventStream(readFixture("summarize-readme-malformed.jsonl"));
	assert.equal(result.done, true);
	assert.equal(result.finalText, "The README explains how to set up the dev VM.");
	assert.equal(result.malformed, 1);
});

test("a stream that never terminates is not done and has no final text", () => {
	const result = parseEventStream(readFixture("early-termination.jsonl"));
	assert.equal(result.done, false);
	assert.equal(result.finalText, null);
	assert.equal(result.malformed, 0);
});

test("a willRetry agent_end is a retry boundary, not a terminal done", () => {
	const result = parseEvents([
		'{"type":"agent_start"}',
		'{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"retrying"}]}],"willRetry":true}',
	]);
	assert.equal(result.done, false);
	assert.equal(result.finalText, null);
});
