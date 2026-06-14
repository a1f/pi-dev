import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRunLog, pickLatestLogName, renderLogTail, runLogName } from "./log.ts";

test("formatRunLog brackets the verbatim child events with valid-JSON run_start/run_end records", () => {
	const events = '{"type":"agent_start"}\n{"type":"agent_end","willRetry":false}\n';
	const content = formatRunLog({
		runId: "run-1",
		task: "summarize the README",
		argv: ["--mode", "json", "-p", "summarize the README"],
		events,
		exitCode: 0,
		durationMs: 1234,
		malformed: 2,
	});

	const lines = content.split("\n").filter((line) => line.trim() !== "");
	// Every emitted line must be valid JSON so the log file is machine-readable.
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line) as unknown);

	const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	assert.equal(header.type, "run_start");
	assert.equal(header.runId, "run-1");
	assert.equal(header.task, "summarize the README");
	assert.deepEqual(header.argv, ["--mode", "json", "-p", "summarize the README"]);

	const footer = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
	assert.equal(footer.type, "run_end");
	assert.equal(footer.exitCode, 0);
	assert.equal(footer.durationMs, 1234);
	assert.equal(footer.malformed, 2);

	// The child events appear verbatim, bracketed between header and footer.
	assert.deepEqual(lines.slice(1, -1), ['{"type":"agent_start"}', '{"type":"agent_end","willRetry":false}']);
	assert.ok(content.endsWith("\n"), "the log content must end with a trailing newline");
});

test("renderLogTail returns the last N non-empty lines and tolerates short and empty input", () => {
	// Blank lines are skipped; only the last N content lines survive.
	assert.equal(renderLogTail("a\n\nb\nc\nd\n", 2), "c\nd");
	// Fewer content lines than N → all of them.
	assert.equal(renderLogTail("only\n", 5), "only");
	// Empty content → empty string.
	assert.equal(renderLogTail("", 3), "");
});

test("runLogName derives a run's log filename from its id", () => {
	assert.equal(runLogName("2024-06-01T00-00-00"), "2024-06-01T00-00-00.jsonl");
});

test("pickLatestLogName returns the greatest .jsonl name, ignoring others, or null when none", () => {
	// runIds are timestamp-prefixed, so lexical order is chronological order.
	assert.equal(pickLatestLogName(["2024-01-01.jsonl", "2024-06-01.jsonl", "2024-03-01.jsonl"]), "2024-06-01.jsonl");
	// Non-.jsonl entries are ignored.
	assert.equal(pickLatestLogName(["2024-06-01.jsonl", "notes.txt"]), "2024-06-01.jsonl");
	// No logs → null.
	assert.equal(pickLatestLogName(["notes.txt", "README.md"]), null);
	assert.equal(pickLatestLogName([]), null);
});
