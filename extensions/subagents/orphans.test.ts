import assert from "node:assert/strict";
import { test } from "node:test";

import { type InflightRecord, parseInflight, serializeInflight } from "./orphans.ts";

// The pidfile is untrusted external input: a prior session may have crashed mid-write,
// leaving a partial or corrupt line. Its codec must therefore be a TOTAL boundary parser —
// round-trip clean records and silently drop anything malformed rather than throw. Those two
// halves are one contract, so they are pinned together here.
test("serializeInflight/parseInflight round-trips records and skips malformed pidfile lines without throwing", () => {
	const first: InflightRecord = { runId: "2026-06-15T00-00-00-abc", pid: 4242, startedAt: 1_718_409_600_000 };
	const second: InflightRecord = { runId: "2026-06-15T00-00-01-def", pid: 5151, startedAt: 1_718_409_601_000 };
	const records: readonly InflightRecord[] = [first, second];

	// Round-trip: serializing then parsing yields the originals.
	assert.deepEqual(parseInflight(serializeInflight(records)), records);

	// Totality: one valid record mixed with a blank line, non-JSON garbage, a record missing
	// `pid`, and a record whose `pid` is the wrong type parses to only the valid record —
	// returning a value at all proves the boundary parser never threw on the garbage.
	const noisy = [
		serializeInflight([first]).trimEnd(),
		"",
		"not json",
		JSON.stringify({ runId: "missing-pid", startedAt: 1_718_409_602_000 }),
		JSON.stringify({ runId: "wrong-typed-pid", pid: "5151", startedAt: 1_718_409_603_000 }),
	].join("\n");

	assert.deepEqual(parseInflight(noisy), [first]);
});
