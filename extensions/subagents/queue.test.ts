import assert from "node:assert/strict";
import { test } from "node:test";

import { createLimiter } from "./queue.ts";

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: (value: void) => void;
}

// A promise whose settlement the test triggers by hand, so it controls exactly when each
// task finishes and can observe how the limiter schedules the rest between settlements.
function defer(): Deferred {
	let resolve!: (value: void) => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// Drain pending microtasks (a settled task hands its slot to the next via a .then), so the
// limiter reaches a steady state before we assert on its ordering and counts.
function flush(): Promise<void> {
	return new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

test("runs up to the cap concurrently and starts queued tasks in FIFO order as slots free", async () => {
	const limiter = createLimiter(2);
	const started: number[] = [];
	const d0 = defer();
	const d1 = defer();
	const d2 = defer();
	const d3 = defer();

	const runs = [d0, d1, d2, d3].map((deferred, index) =>
		limiter.run(() => {
			started.push(index);
			return deferred.promise;
		}),
	);

	// Four tasks submitted, cap is 2: only the first two run, the rest wait.
	await flush();
	assert.deepEqual(started, [0, 1]);
	assert.equal(limiter.active, 2);
	assert.equal(limiter.queued, 2);

	// The first task settling frees one slot for the oldest waiter (task 2), never task 3.
	d0.resolve();
	await flush();
	assert.deepEqual(started, [0, 1, 2]);
	assert.equal(limiter.active, 2);
	assert.equal(limiter.queued, 1);

	// Draining the rest runs every remaining task in strict FIFO and empties the limiter.
	d1.resolve();
	d2.resolve();
	d3.resolve();
	await Promise.all(runs);
	assert.deepEqual(started, [0, 1, 2, 3]);
	assert.equal(limiter.active, 0);
	assert.equal(limiter.queued, 0);
});
