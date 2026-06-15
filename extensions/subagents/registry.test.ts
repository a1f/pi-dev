import assert from "node:assert/strict";
import { test } from "node:test";

import { RunRegistry, renderRows } from "./registry.ts";
import type { RunRecord } from "./registry.ts";
import type { RunState } from "./runstate.ts";

// The zero/empty RunState a freshly registered run starts from.
const emptyRunState: RunState = {
	toolCount: 0,
	lastLine: null,
	contextTokens: null,
	contextPct: null,
	done: false,
	malformed: 0,
};

test("register creates a running record retrievable by id and present in the list", () => {
	const reg = new RunRegistry();
	reg.register({ runId: "r1", task: "summarize the readme", startedAt: 1000 });

	const expected: RunRecord = {
		runId: "r1",
		task: "summarize the readme",
		persona: null,
		status: "running",
		startedAt: 1000,
		finishedAt: null,
		state: emptyRunState,
	};

	assert.deepEqual(reg.get("r1"), expected);

	const all = reg.list();
	assert.equal(all.length, 1);
	assert.deepEqual(all[0], expected);
});

test("register tags a run with its dispatched persona, defaulting to null when none is given", () => {
	const reg = new RunRegistry();

	reg.register({ runId: "r1", task: "scout the repo", startedAt: 1000, persona: "scout" });
	assert.equal(reg.get("r1")?.persona, "scout");

	reg.register({ runId: "r2", task: "build the thing", startedAt: 2000 });
	assert.equal(reg.get("r2")?.persona, null);
});

test("finish records the terminal status, final state, and finish time for both done and error", () => {
	const reg = new RunRegistry();

	const doneState: RunState = {
		toolCount: 3,
		lastLine: "Done.",
		contextTokens: 1200,
		contextPct: 0.6,
		done: true,
		malformed: 0,
	};
	reg.register({ runId: "r1", task: "summarize the readme", startedAt: 1000 });
	reg.finish({ runId: "r1", status: "done", state: doneState, finishedAt: 4500 });

	const r1 = reg.get("r1");
	assert.equal(r1?.status, "done");
	assert.equal(r1?.finishedAt, 4500);
	assert.deepEqual(r1?.state, doneState);

	const errorState: RunState = {
		toolCount: 1,
		lastLine: "boom",
		contextTokens: 500,
		contextPct: null,
		done: false,
		malformed: 2,
	};
	reg.register({ runId: "r2", task: "build the thing", startedAt: 2000 });
	reg.finish({ runId: "r2", status: "error", state: errorState, finishedAt: 3000 });

	const r2 = reg.get("r2");
	assert.equal(r2?.status, "error");
	assert.equal(r2?.finishedAt, 3000);
	assert.deepEqual(r2?.state, errorState);
});

test("kill terminates only a running run, firing its onKill hook, and is a no-op otherwise", () => {
	const reg = new RunRegistry();

	let r1Killed = false;
	reg.register({
		runId: "r1",
		task: "summarize the readme",
		startedAt: 1000,
		onKill: () => {
			r1Killed = true;
		},
	});

	assert.equal(reg.kill("r1"), true);
	assert.equal(r1Killed, true);
	assert.equal(reg.get("r1")?.status, "killed");

	assert.equal(reg.kill("unknown"), false);

	let r2Killed = false;
	reg.register({
		runId: "r2",
		task: "build the thing",
		startedAt: 2000,
		onKill: () => {
			r2Killed = true;
		},
	});
	const doneState: RunState = {
		toolCount: 0,
		lastLine: null,
		contextTokens: null,
		contextPct: null,
		done: true,
		malformed: 0,
	};
	reg.finish({ runId: "r2", status: "done", state: doneState, finishedAt: 3000 });

	assert.equal(reg.kill("r2"), false);
	assert.equal(r2Killed, false);
	assert.equal(reg.get("r2")?.status, "done");
});

test("renderRows renders one line per run with its glyph, task, elapsed seconds, tool count, context, and last line", () => {
	const reg = new RunRegistry();
	reg.register({ runId: "r1", task: "scout repo", startedAt: 1000 });

	const doneState: RunState = {
		toolCount: 5,
		lastLine: "All set.",
		contextTokens: 24000,
		contextPct: 12,
		done: true,
		malformed: 0,
	};
	reg.register({ runId: "r2", task: "summarize", startedAt: 1000 });
	reg.finish({ runId: "r2", status: "done", state: doneState, finishedAt: 2000 });

	const out = renderRows(reg.list(), 4500);
	const lines = out.split("\n");
	assert.equal(lines.length, 2);

	const runningLine = lines.find((line) => line.includes("▶"));
	assert.ok(runningLine, "expected a running row marked with ▶");
	assert.ok(runningLine.includes("scout repo"));
	assert.ok(runningLine.includes("3s"));
	assert.ok(runningLine.includes("0 tools"));
	assert.ok(runningLine.includes("—"));

	const doneLine = lines.find((line) => line.includes("✓"));
	assert.ok(doneLine, "expected a done row marked with ✓");
	assert.ok(doneLine.includes("summarize"));
	assert.ok(doneLine.includes("1s"));
	assert.ok(doneLine.includes("5 tools"));
	assert.ok(doneLine.includes("12%"));
	assert.ok(doneLine.includes("All set."));
});

test("start flips a queued run to running once, restamping its start time, and is a no-op otherwise", () => {
	const reg = new RunRegistry();

	reg.register({ runId: "q1", task: "scout repo", startedAt: 1000, status: "queued" });
	assert.equal(reg.get("q1")?.status, "queued");
	assert.equal(reg.get("q1")?.startedAt, 1000);

	// Acquiring a slot starts the run: status becomes running and the start time is
	// restamped so elapsed measures run time, not queue wait.
	assert.equal(reg.start({ runId: "q1", startedAt: 5000 }), true);
	assert.equal(reg.get("q1")?.status, "running");
	assert.equal(reg.get("q1")?.startedAt, 5000);

	// Starting an already-running run changes nothing.
	assert.equal(reg.start({ runId: "q1", startedAt: 9000 }), false);
	assert.equal(reg.get("q1")?.status, "running");
	assert.equal(reg.get("q1")?.startedAt, 5000);

	// Starting an unknown run changes nothing.
	assert.equal(reg.start({ runId: "nope", startedAt: 1 }), false);
});
