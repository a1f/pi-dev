import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { makeSpawnExec } from "./spawn.ts";
import type { SpawnDeps } from "./spawn.ts";

// The child process is the external boundary, so the fake spawn returns a child built
// from plain EventEmitters: stdout fires "data" and the child fires "exit" synchronously,
// letting the test drive one clean run deterministically without a real process or real
// timers (mirroring how runner.test.ts injects a fake ExecLike).
const FAKE_PID = 4242;

test("makeSpawnExec captures stdout and reports the child's pid on a clean exit", async () => {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const child = Object.assign(new EventEmitter(), {
		pid: FAKE_PID,
		killed: false,
		exitCode: null,
		stdout,
		stderr,
		kill: () => true,
	});

	const onSpawnPids: number[] = [];
	const deps: SpawnDeps = {
		spawn: () => child,
		// Escalation timers never arm on a clean exit, so schedule is an inert canceller here.
		schedule: () => () => {},
	};

	const run = makeSpawnExec(deps);
	const resultPromise = run("pi", ["--mode", "json"], {
		onSpawn: (pid: number) => {
			onSpawnPids.push(pid);
		},
	});

	// Handlers are attached synchronously while run() builds its promise, so driving the
	// child now exercises the data-then-exit path the runner accumulates and resolves on.
	stdout.emit("data", Buffer.from("hello\n"));
	child.emit("exit", 0);

	const result = await resultPromise;

	assert.deepEqual(result, { stdout: "hello\n", stderr: "", code: 0, killed: false });
	assert.deepEqual(onSpawnPids, [FAKE_PID]);
});

// The child and the timer are the external boundary, so a fake schedule RECORDS every
// (run, ms) it is handed — letting the test fire the timeout and grace callbacks by hand
// instead of waiting on a real clock — and the fake child records each kill signal but
// never exits on its own, so the runner's SIGTERM→SIGKILL escalation is observable purely
// through the injected deps.
test("makeSpawnExec escalates from SIGTERM to SIGKILL and resolves killed when a child overruns its timeout", async () => {
	const killSignals: (NodeJS.Signals | number | undefined)[] = [];
	const child = Object.assign(new EventEmitter(), {
		pid: FAKE_PID,
		killed: false,
		exitCode: null,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: (signal?: NodeJS.Signals | number) => {
			killSignals.push(signal);
			return true;
		},
	});

	const scheduled: { run: () => void; ms: number }[] = [];
	const deps: SpawnDeps = {
		spawn: () => child,
		schedule: (run, ms) => {
			scheduled.push({ run, ms });
			return () => {};
		},
	};

	const fire = (ms: number) => {
		const timer = scheduled.find((entry) => entry.ms === ms);
		assert.ok(timer, `expected a callback scheduled at ms=${ms}`);
		timer.run();
	};

	const run = makeSpawnExec(deps);
	const resultPromise = run("pi", ["-p", "x"], { timeout: 5000, graceMs: 2000 });

	// Overrunning the timeout signals SIGTERM at once and arms the grace timer.
	fire(5000);
	assert.deepEqual(killSignals, ["SIGTERM"]);

	// The child is still alive when the grace window elapses, so SIGKILL follows.
	fire(2000);
	assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);

	// The child finally exits after being killed; the result reports it was killed.
	child.emit("exit", null);
	const result = await resultPromise;
	assert.equal(result.killed, true);
});
