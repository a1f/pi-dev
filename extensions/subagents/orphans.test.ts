import assert from "node:assert/strict";
import { test } from "node:test";

import { type InflightRecord, type ReapDeps, parseInflight, reapOrphans, serializeInflight } from "./orphans.ts";

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

// Liveness ("is this pid still running AND still our subagent, not a reused one") and the kill are
// real OS effects, so reapOrphans takes them as injected deps. The fake isAlive marks exactly the
// children that outlived their parent session; the fake kill records every pid it is told to
// terminate. Alive and dead records are interleaved so the outcome is driven by liveness, not by
// position: reapOrphans must kill and return precisely the live orphans and leave the already-gone
// (stale) entries untouched.
test("reapOrphans force-kills and returns only the in-flight records whose process is still alive", () => {
	const aliveA: InflightRecord = { runId: "2026-06-15T00-00-00-aaa", pid: 4242, startedAt: 1_718_409_600_000 };
	const deadA: InflightRecord = { runId: "2026-06-15T00-00-01-bbb", pid: 5151, startedAt: 1_718_409_601_000 };
	const aliveB: InflightRecord = { runId: "2026-06-15T00-00-02-ccc", pid: 6262, startedAt: 1_718_409_602_000 };
	const deadB: InflightRecord = { runId: "2026-06-15T00-00-03-ddd", pid: 7373, startedAt: 1_718_409_603_000 };
	const records: readonly InflightRecord[] = [aliveA, deadA, aliveB, deadB];

	const live = new Set<InflightRecord>([aliveA, aliveB]);
	const killedPids: number[] = [];
	const deps: ReapDeps = {
		isAlive: (record: InflightRecord) => live.has(record),
		kill: (pid: number) => {
			killedPids.push(pid);
		},
	};

	const reaped = reapOrphans(records, deps);

	// Exactly the live orphans are returned and killed; the dead (stale) entries are left alone —
	// an extra or a missing pid here would fail the equality.
	assert.deepEqual(reaped, [aliveA, aliveB]);
	assert.deepEqual(killedPids, [aliveA.pid, aliveB.pid]);
});
