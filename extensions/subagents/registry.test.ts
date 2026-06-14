import assert from "node:assert/strict";
import { test } from "node:test";

import { RunRegistry } from "./registry.ts";
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
	reg.register("r1", "summarize the readme", 1000);

	const expected: RunRecord = {
		runId: "r1",
		task: "summarize the readme",
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
	reg.register("r1", "summarize the readme", 1000);
	reg.finish("r1", "done", doneState, 4500);

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
	reg.register("r2", "build the thing", 2000);
	reg.finish("r2", "error", errorState, 3000);

	const r2 = reg.get("r2");
	assert.equal(r2?.status, "error");
	assert.equal(r2?.finishedAt, 3000);
	assert.deepEqual(r2?.state, errorState);
});

test("kill terminates only a running run, firing its onKill hook, and is a no-op otherwise", () => {
	const reg = new RunRegistry();

	let r1Killed = false;
	reg.register("r1", "summarize the readme", 1000, () => {
		r1Killed = true;
	});

	assert.equal(reg.kill("r1"), true);
	assert.equal(r1Killed, true);
	assert.equal(reg.get("r1")?.status, "killed");

	assert.equal(reg.kill("unknown"), false);

	let r2Killed = false;
	reg.register("r2", "build the thing", 2000, () => {
		r2Killed = true;
	});
	const doneState: RunState = {
		toolCount: 0,
		lastLine: null,
		contextTokens: null,
		contextPct: null,
		done: true,
		malformed: 0,
	};
	reg.finish("r2", "done", doneState, 3000);

	assert.equal(reg.kill("r2"), false);
	assert.equal(r2Killed, false);
	assert.equal(reg.get("r2")?.status, "done");
});
