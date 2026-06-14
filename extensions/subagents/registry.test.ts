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
