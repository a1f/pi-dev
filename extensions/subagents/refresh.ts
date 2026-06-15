// Throttled dashboard refresher: drives one repeating re-render while runs are live and
// self-stops once they finish, so the footer can animate a child's elapsed time between handler
// calls (exec is non-streaming, so elapsed is the only live-changing field). The timer source is
// injectable so tests fire ticks by hand without real clocks.

import { clearInterval, setInterval } from "node:timers";

/** The interval primitives the refresher needs — injected so tests drive ticks without real timers. */
export interface Scheduler {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

/** A live refresher: nudge it to (re)start polling, or stop it outright. */
export interface DashboardRefresher {
	poke(): void;
	stop(): void;
}

/** Real timers whose handle is unref'd so a running interval never keeps the process (or test runner) alive. */
const defaultScheduler: Scheduler = {
	setInterval(callback: () => void, ms: number): unknown {
		const handle = setInterval(callback, ms);
		handle.unref();
		return handle;
	},
	clearInterval(handle: unknown): void {
		clearInterval(handle as NodeJS.Timeout);
	},
};

/**
 * Build a refresher that polls `onTick` once per `intervalMs` while `isActive()` holds, runs at
 * most one interval at a time, and clears that interval on the first tick after activity ceases —
 * so poke() starts ticking when a run goes live and the loop self-stops when all runs finish.
 */
export function createDashboardRefresher(opts: {
	intervalMs: number;
	isActive: () => boolean;
	onTick: () => void;
	scheduler?: Scheduler;
}): DashboardRefresher {
	const { intervalMs, isActive, onTick, scheduler = defaultScheduler } = opts;
	let handle: unknown = null;

	const stop = (): void => {
		if (handle === null) return;
		scheduler.clearInterval(handle);
		handle = null;
	};

	const tick = (): void => {
		if (isActive()) onTick();
		else stop();
	};

	const poke = (): void => {
		if (!isActive() || handle !== null) return;
		handle = scheduler.setInterval(tick, intervalMs);
	};

	return { poke, stop };
}
