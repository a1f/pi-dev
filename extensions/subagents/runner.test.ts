import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSpawnArgv } from "./argv.ts";
import { DEFAULT_CONTEXT_WINDOW, RUNS_DIR } from "./constants.ts";
import { runLogName } from "./log.ts";
import { type ExecLike, formatReply, type LogWriter, runAgent } from "./runner.ts";

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

test("runAgent forwards tools, model, system prompt and extensions into the spawned argv", async () => {
	// The adapter passes a persona's tools/model/system prompt and the guardrails extension
	// through runAgent; the argv handed to exec must reflect all of them (and is what gets logged).
	const calls: { command: string; args: string[] }[] = [];
	const fakeExec: ExecLike = async (command, args) => {
		calls.push({ command, args });
		return { stdout: readFixture("summarize-readme.jsonl"), stderr: "", code: 0, killed: false };
	};

	await runAgent("review the diff", fakeExec, {
		tools: ["read", "grep"],
		model: "opus",
		systemPrompt: "You are a reviewer.",
		extensions: ["/abs/guardrails"],
	});

	assert.equal(calls.length, 1);
	assert.deepEqual(
		calls[0]?.args,
		buildSpawnArgv({ task: "review the diff", tools: ["read", "grep"], model: "opus", systemPrompt: "You are a reviewer.", extensions: ["/abs/guardrails"] }),
	);
});

test("runAgent forwards session and continueSession into the spawned argv", async () => {
	// The adapter resumes a persona by passing its session path and the continue flag through
	// runAgent; the argv handed to exec must carry both, deep-equal to buildSpawnArgv's contract.
	const calls: { command: string; args: string[] }[] = [];
	const fakeExec: ExecLike = async (command, args) => {
		calls.push({ command, args });
		return { stdout: readFixture("summarize-readme.jsonl"), stderr: "", code: 0, killed: false };
	};

	await runAgent("follow up", fakeExec, {
		tools: ["read", "grep"],
		model: "opus",
		extensions: ["/abs/guardrails"],
		session: "/work/.pi/sessions/scout.jsonl",
		continueSession: true,
	});

	assert.equal(calls.length, 1);
	assert.deepEqual(
		calls[0]?.args,
		buildSpawnArgv({ task: "follow up", tools: ["read", "grep"], model: "opus", extensions: ["/abs/guardrails"], session: "/work/.pi/sessions/scout.jsonl", continueSession: true }),
	);
});

test("runAgent writes the formatted run log via the injected writer at the expected path", async () => {
	const writes: { logPath: string; content: string }[] = [];
	const writeLog: LogWriter = async (logPath, content) => {
		writes.push({ logPath, content });
	};
	const fakeExec: ExecLike = async () => ({
		stdout: readFixture("summarize-readme.jsonl"),
		stderr: "",
		code: 0,
		killed: false,
	});

	const result = await runAgent("summarize the README", fakeExec, {
		writeLog,
		runId: "2024-01-02T03-04-05",
		cwd: "/work",
	});

	assert.equal(writes.length, 1, "a spawned run must write exactly one log");
	const write = writes[0];
	assert.ok(write);
	assert.equal(write.logPath, join("/work", RUNS_DIR, runLogName("2024-01-02T03-04-05")));
	assert.equal(result.runId, "2024-01-02T03-04-05");
	assert.equal(result.logPath, write.logPath);

	// The written content is the formatted log: valid-JSON run_start/run_end framing.
	const lines = write.content.split("\n").filter((line) => line.trim() !== "");
	const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	assert.equal(header.type, "run_start");
	assert.equal(header.runId, "2024-01-02T03-04-05");
	const footer = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
	assert.equal(footer.type, "run_end");
	assert.equal(footer.exitCode, 0);
});

test("a rejecting log writer does not break the dispatch result (best-effort logging)", async () => {
	// Logging is auxiliary: a write failure must never throw out of runAgent or
	// change the run's ok/finalText.
	const writeLog: LogWriter = async () => {
		throw new Error("disk full");
	};
	const fakeExec: ExecLike = async () => ({
		stdout: readFixture("summarize-readme.jsonl"),
		stderr: "",
		code: 0,
		killed: false,
	});

	const result = await runAgent("summarize the README", fakeExec, { writeLog, runId: "r1" });

	assert.equal(result.ok, true);
	assert.equal(result.finalText, "The README explains how to set up the dev VM.");
});

test("successive default-runId dispatches get distinct log paths (no same-millisecond collision)", async () => {
	// Two dispatches that start within the same millisecond must not derive the same
	// runId: identical ids share a logPath, and the second write truncates the first,
	// silently corrupting the per-run audit trail. The default id must be per-call unique.
	const fakeExec: ExecLike = async () => ({
		stdout: readFixture("summarize-readme.jsonl"),
		stderr: "",
		code: 0,
		killed: false,
	});

	const logPaths = new Set<string>();
	for (let i = 0; i < 100; i++) {
		const result = await runAgent("summarize the README", fakeExec, { cwd: "/work" });
		assert.ok(result.logPath, "a spawned run must report a log path");
		logPaths.add(result.logPath);
	}

	assert.equal(logPaths.size, 100, "every dispatch must derive a distinct run log path");
});

test("an unsafe runId is skipped rather than written outside the runs dir (best-effort)", async () => {
	// runId is a public option; a traversal value like "../../escape" would join to a
	// path outside RUNS_DIR. The writer must skip an unsafe id rather than escape, and
	// the dispatch result must still stand.
	const writes: { logPath: string; content: string }[] = [];
	const writeLog: LogWriter = async (logPath, content) => {
		writes.push({ logPath, content });
	};
	const fakeExec: ExecLike = async () => ({
		stdout: readFixture("summarize-readme.jsonl"),
		stderr: "",
		code: 0,
		killed: false,
	});

	const result = await runAgent("summarize the README", fakeExec, { writeLog, runId: "../../escape", cwd: "/work" });

	assert.equal(writes.length, 0, "an unsafe runId must not trigger a write");
	assert.equal(result.ok, true, "the run's outcome stands regardless of the skipped log");
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
		timedOut: false,
		runId: "r1",
		logPath: "/work/.pi/runs/r1.jsonl",
		durationMs: 5,
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
		timedOut: false,
		runId: null,
		logPath: null,
		durationMs: 0,
	});

	assert.ok(bad.includes("1"), "failure reply should include the exit code");
	assert.ok(!/\bsuccess\b/i.test(bad), "failure reply must not present as a success");
});

test("runAgent flags a timeout-killed child as timedOut and formatReply surfaces it, but an operator-aborted kill is not", async () => {
	// A child the runner kills on its own timeout and one an operator kills via agent_kill both
	// resolve as a killed child (exec returns killed:true). They are told apart by the run's
	// AbortSignal: a timeout fires with the signal un-aborted, while agent_kill aborts it first.
	const killedExec: ExecLike = async () => ({ stdout: "", stderr: "", code: 143, killed: true });

	// Timeout: killed with no operator abort -> timedOut, and a timed-out run is not a success.
	const timeoutRun = await runAgent("summarize the README", killedExec);
	assert.equal(timeoutRun.timedOut, true, "a killed child whose signal never aborted timed out");
	assert.equal(timeoutRun.ok, false, "a timed-out run did not complete");

	// The follow-up message must read as a timeout, not as a bare nonzero exit (formatReply takes
	// the outcome minus state; the full result is assignable, as index.ts passes it).
	const reply = formatReply("summarize the README", timeoutRun);
	assert.ok(/timed out|timeout/i.test(reply), "the reply must read as a timeout");
	assert.ok(!/did not complete \(exit/.test(reply), "a timeout must not read as a plain nonzero exit");

	// Operator kill: the same killed child, but the run's signal was aborted first -> not a timeout.
	const killController = new AbortController();
	killController.abort();
	const operatorKill = await runAgent("summarize the README", killedExec, { signal: killController.signal });
	assert.equal(operatorKill.timedOut, false, "an operator-aborted kill is not a timeout");
});

test("runAgent populates contextPct from the default context window when the stream carries usage", async () => {
	// The live dispatch path must fold the child stream against a default context window, so a run
	// whose usage reports tokens yields a real contextPct — the denominator the dashboard's token
	// bar needs. Pinned to DEFAULT_CONTEXT_WINDOW rather than a literal percentage so the window's
	// magnitude can change without rewriting this test. The research-run fixture carries assistant
	// usage (totalTokens 12345), so contextTokens is non-null and a percentage is computable.
	const fakeExec: ExecLike = async () => ({
		stdout: readFixture("research-run.jsonl"),
		stderr: "",
		code: 0,
		killed: false,
	});

	const result = await runAgent("research the codebase", fakeExec);

	const { contextTokens, contextPct } = result.state;
	assert.ok(contextTokens !== null, "the research-run fixture must carry assistant usage");
	assert.notEqual(contextPct, null, "the live path must inject a default window so usage yields a percentage");
	assert.equal(contextPct, (contextTokens / DEFAULT_CONTEXT_WINDOW) * 100);
});
