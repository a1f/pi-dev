// FIFO concurrency limiter, kept pure (no clock, no IO) so tests can settle tasks by hand and
// watch how queued work gets scheduled. The subtle invariant: a freed slot is handed straight to
// the oldest waiter rather than released back to the pool, so submission order survives even when
// a fresh run() races a settling task for the slot. An under-cap task takes the fast path and is
// invoked synchronously during run() (no microtask delay), so a caller can observe its synchronous
// side effects before run() returns control; only an at-cap task is deferred until a slot frees.

/** Bounds how many async tasks run at once and queues the rest, draining queued work FIFO. */
export interface ConcurrencyLimiter {
	/** Run fn now if under cap; otherwise queue it and run when a slot frees. Resolves/rejects with fn's outcome. */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** Number of tasks currently executing (never exceeds cap). */
	readonly active: number;
	/** Number of tasks waiting for a slot. */
	readonly queued: number;
}

/** Build a ConcurrencyLimiter, flooring `cap` to at least 1 so a non-positive cap can't deadlock. */
export function createLimiter(cap: number): ConcurrencyLimiter {
	const limit = Math.max(1, cap);
	let active = 0;
	const waiters: Array<() => void> = [];

	// Give the freed slot to the oldest waiter without dropping `active` (a direct handoff, so no
	// concurrent run() can grab it); only when nobody waits does the slot truly close.
	const release = (): void => {
		const next = waiters.shift();
		if (next !== undefined) {
			next();
		} else {
			active -= 1;
		}
	};

	// Run fn under the held slot and release it on every outcome — resolution, async rejection, or a
	// synchronous throw turned into a rejected promise — so a failing task never wedges the queue.
	const settle = <T>(fn: () => Promise<T>): Promise<T> => {
		let started: Promise<T>;
		try {
			started = fn(); // invoked synchronously to preserve run()'s under-cap fast path
		} catch (error) {
			release();
			return Promise.reject(error);
		}
		return started.finally(release);
	};

	// Take a free slot and invoke fn synchronously when one is open AND nobody is already queued;
	// otherwise wait for release() to hand over a slot — so a newcomer can never jump an earlier
	// waiter — and run fn once it arrives.
	const run = <T>(fn: () => Promise<T>): Promise<T> => {
		if (active < limit && waiters.length === 0) {
			active += 1;
			return settle(fn);
		}
		return new Promise<void>((resolve) => {
			waiters.push(() => resolve());
		}).then(() => settle(fn));
	};

	return {
		run,
		get active(): number {
			return active;
		},
		get queued(): number {
			return waiters.length;
		},
	};
}
