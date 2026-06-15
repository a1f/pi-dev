import assert from "node:assert/strict";
import { test } from "node:test";

import { createDashboardRefresher } from "./refresh.ts";
import type { Scheduler } from "./refresh.ts";

test("refresher polls onTick each tick while active, starts at most one interval, and stops once runs finish", () => {
	// A fake scheduler captures each started interval's tick callback + ms + handle and records
	// every cleared handle, so the test can fire ticks by hand and assert start/stop — no real timers.
	type StartedInterval = { tick: () => void; ms: number; handle: number };
	const started: StartedInterval[] = [];
	const cleared: unknown[] = [];
	let nextHandle = 1;
	const scheduler: Scheduler = {
		setInterval(cb: () => void, ms: number): unknown {
			const handle = nextHandle++;
			started.push({ tick: cb, ms, handle });
			return handle;
		},
		clearInterval(handle: unknown): void {
			cleared.push(handle);
		},
	};

	let active = true;
	let ticks = 0;
	const refresher = createDashboardRefresher({
		intervalMs: 250,
		isActive: () => active,
		onTick: () => {
			ticks += 1;
		},
		scheduler,
	});

	// (a) poke() while active starts exactly one interval, at intervalMs.
	refresher.poke();
	const first = started[0];
	assert.ok(first, "poke() while active should start one interval");
	assert.equal(started.length, 1);
	assert.equal(first.ms, 250);

	// (c) a second poke() while one is already running starts no further interval.
	refresher.poke();
	assert.equal(started.length, 1);

	// (b) firing the captured tick while active calls onTick.
	first.tick();
	assert.equal(ticks, 1);

	// (d) once runs finish (isActive false), the next tick neither calls onTick again nor
	// leaves the interval running — it clears the handle so polling ceases.
	active = false;
	first.tick();
	assert.equal(ticks, 1);
	assert.deepEqual(cleared, [first.handle]);
});
