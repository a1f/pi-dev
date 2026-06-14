import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSpawnArgv } from "./argv.ts";
import { type ExecLike, formatReply, runAgent } from "./runner.ts";

// The fake exec returns the shared happy-path fixture (the same schema-accurate
// stream events.test.ts asserts against) instead of spawning a real pi child,
// so this test pins runAgent's wiring: argv built, exec invoked, stream parsed.
const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

test("runAgent dispatches a pi child and reports the happy-path outcome", async () => {
	const calls: { command: string; args: string[] }[] = [];
	const fakeExec: ExecLike = async (command, args) => {
		calls.push({ command, args });
		return { stdout: readFixture("summarize-readme.jsonl"), stderr: "", code: 0, killed: false };
	};

	const result = await runAgent("summarize the README", fakeExec);

	assert.equal(result.ok, true);
	assert.equal(result.finalText, "The README explains how to set up the dev VM.");
	assert.equal(result.code, 0);
	assert.equal(result.malformed, 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.command, "pi");
	assert.deepEqual(calls[0]?.args, buildSpawnArgv({ task: "summarize the README" }));
});

test("runAgent reports failure when the child exits nonzero despite a complete stream", async () => {
	// A child that flushed a terminal agent_end but still exited nonzero (crashed or
	// was killed) is not a trustworthy result: ok must be gated on the exit code.
	const crashedExec: ExecLike = async () => ({
		stdout: readFixture("summarize-readme.jsonl"),
		stderr: "boom",
		code: 1,
		killed: false,
	});

	const crashed = await runAgent("summarize the README", crashedExec);

	assert.equal(crashed.ok, false);
	assert.equal(crashed.code, 1);

	// Regression guard: a zero exit with no terminal agent_end is also not ok.
	const truncatedExec: ExecLike = async () => ({
		stdout: '{"type":"agent_start"}\n',
		stderr: "",
		code: 0,
		killed: false,
	});

	const truncated = await runAgent("summarize the README", truncatedExec);

	assert.equal(truncated.ok, false);
});

test("runAgent rejects an invalid task without spawning and reports the reason", async () => {
	// A '@'-leading task makes buildSpawnArgv throw (pi would read it as a context
	// file, not the prompt). runAgent must stay total over the pi adapter: resolve
	// with ok:false and a reason, and never spawn a child for a task it can't launch.
	const calls: { command: string; args: string[] }[] = [];
	const fakeExec: ExecLike = async (command, args) => {
		calls.push({ command, args });
		return { stdout: readFixture("summarize-readme.jsonl"), stderr: "", code: 0, killed: false };
	};

	const result = await runAgent("@.env", fakeExec);

	assert.equal(result.ok, false);
	assert.equal(calls.length, 0, "an invalid task must not spawn a child");
	assert.ok(result.error && result.error.length > 0, "the failure must explain the reason");
});

test("formatReply quotes the task and answer on success, and signals failure with the exit code", () => {
	// Success: the follow-up message tells the parent what the subagent found, so it
	// must carry both the original task and the subagent's verbatim answer.
	const ok = formatReply("summarize the README", {
		ok: true,
		finalText: "The README explains the setup.",
		malformed: 0,
		code: 0,
	});

	assert.ok(ok.includes("summarize the README"), "success reply should quote the task");
	assert.ok(ok.includes("The README explains the setup."), "success reply should include the answer");

	// Failure: a null finalText must not throw, the message must surface the exit code,
	// and it must not read as a successful answer.
	const bad = formatReply("do the thing", {
		ok: false,
		finalText: null,
		malformed: 0,
		code: 1,
	});

	assert.ok(bad.includes("1"), "failure reply should include the exit code");
	assert.ok(!/\bsuccess\b/i.test(bad), "failure reply must not present as a success");
});
