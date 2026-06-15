import assert from "node:assert/strict";
import { test } from "node:test";

import { createLimiter } from "./queue.ts";

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: (value: void) => void;
	readonly reject: (reason: unknown) => void;
}

// A promise whose settlement the test triggers by hand, so it controls exactly when each
// task finishes (resolving or rejecting) and can observe how the limiter schedules the rest
// between settlements.
function defer(): Deferred {
	let resolve!: (value: void) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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

test("a rejected task propagates its rejection yet frees the slot so the queue keeps draining", async () => {
	const limiter = createLimiter(1);
	const started: number[] = [];
	const d0 = defer();
	const d1 = defer();
	const d2 = defer();

	const run0 = limiter.run(() => {
		started.push(0);
		return d0.promise;
	});
	const run1 = limiter.run(() => {
		started.push(1);
		return d1.promise;
	});
	const run2 = limiter.run(() => {
		started.push(2);
		return d2.promise;
	});

	// Three tasks submitted, cap is 1: only task 0 runs, the rest wait.
	await flush();
	assert.deepEqual(started, [0]);
	assert.equal(limiter.active, 1);
	assert.equal(limiter.queued, 2);

	// Task 0 rejecting must both surface on its run() promise and release the slot (the try/finally),
	// so the failure is observable yet the limiter does not lose a slot to it.
	const boom = new Error("boom");
	d0.reject(boom);
	await assert.rejects(run0, boom);

	// The freed slot is handed to the oldest waiter (task 1), so a rejection never wedges the queue.
	await flush();
	assert.deepEqual(started, [0, 1]);
	assert.equal(limiter.active, 1);
	assert.equal(limiter.queued, 1);

	// Draining the rest runs the last queued task and empties the limiter.
	d1.resolve();
	d2.resolve();
	await Promise.all([run1, run2]);
	assert.deepEqual(started, [0, 1, 2]);
	assert.equal(limiter.active, 0);
	assert.equal(limiter.queued, 0);
});

test("run starts an under-cap task synchronously (fn runs before run() returns control)", () => {
	// The under-cap fast path must invoke fn during the run() call, not after a microtask, so a
	// caller can observe fn's synchronous side effects the instant it dispatches a slot-free task.
	let ran = false;
	void createLimiter(2).run(async () => {
		ran = true;
	});
	assert.equal(ran, true, "an under-cap task must run synchronously, before run() returns control");
});

test("createLimiter(0) floors the cap to 1 so tasks run one at a time instead of deadlocking", async () => {
	const limiter = createLimiter(0);
	const started: number[] = [];
	const d0 = defer();
	const d1 = defer();

	const runs = [d0, d1].map((deferred, index) =>
		limiter.run(() => {
			started.push(index);
			return deferred.promise;
		}),
	);

	// Cap floored to 1: only the first task runs while the second waits.
	await flush();
	assert.deepEqual(started, [0]);
	assert.equal(limiter.active, 1);
	assert.equal(limiter.queued, 1);

	// The first task settling lets the second start; the two never overlap.
	d0.resolve();
	await flush();
	assert.deepEqual(started, [0, 1]);
	assert.equal(limiter.active, 1);
	assert.equal(limiter.queued, 0);

	// Settling the second empties the limiter.
	d1.resolve();
	await Promise.all(runs);
	assert.equal(limiter.active, 0);
	assert.equal(limiter.queued, 0);
});
