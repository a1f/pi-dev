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

// When a real node ChildProcess fails to start (ENOENT/EPERM), the OS fires an "error"
// event and NEVER fires "exit". With no "error" listener, node's EventEmitter re-throws
// the error as an uncaught exception (crashing the parent pi session) and the SpawnExec
// promise hangs forever because resolve() is never called. This test pins the missing
// behavior: the promise must settle to a nonzero failure result on "error", not crash or hang.
test("makeSpawnExec resolves with a nonzero failure result when the child emits an error event instead of exiting", async () => {
	const child = Object.assign(new EventEmitter(), {
		pid: FAKE_PID,
		killed: false,
		exitCode: null,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: (): boolean => true,
	});

	const deps: SpawnDeps = {
		spawn: () => child,
		// Escalation timers never arm: the error fires before any timeout can be set up.
		schedule: () => () => {},
	};

	const run = makeSpawnExec(deps);
	const resultPromise = run("pi", ["-p", "x"]);

	// A standard EventEmitter throws "error" events that have no listener, mirroring the
	// real node ChildProcess runtime. In RED, makeSpawnExec registers no "error" handler,
	// so the emit throws; we catch it so the test body reaches the assertion rather than
	// crashing with the raw re-throw. In GREEN, makeSpawnExec registers a handler, the
	// emit calls it, and no throw occurs.
	const spawnError = new Error("spawn pi ENOENT");
	try {
		child.emit("error", spawnError);
	} catch {
		// In RED: the throw here proves makeSpawnExec has no "error" listener.
	}

	// Race the SpawnExec promise against a 100 ms sentinel so the test stays deterministic
	// and yields a clean assertion failure rather than hanging when the promise never settles
	// (because "error" fired and no handler ever called resolve()).
	type ExecResult = Awaited<ReturnType<typeof run>>;
	let resolved: ExecResult | undefined;
	await Promise.race([
		resultPromise.then((r) => {
			resolved = r;
		}),
		new Promise<void>((settle) => {
			setTimeout(settle, 100);
		}),
	]);

	// In RED: the promise never settled (no "error" handler → resolve was never called),
	// so resolved is still undefined and this assertion fires as the clean RED failure.
	assert.ok(resolved !== undefined, "makeSpawnExec must resolve the promise when the child emits 'error'");
	assert.notEqual(resolved.code, 0, "spawn error must produce a nonzero exit code");
	assert.equal(resolved.killed, false, "a spawn failure is not a process kill");
	assert.ok(resolved.stderr.includes("spawn pi ENOENT"), "spawn error message must appear in stderr");
});

// Aborting the run's signal is how agent_kill stops a live child, so an abort mid-run must
// drive the SAME SIGTERM-now, SIGKILL-after-grace escalation as a timeout — observed purely
// through the fake child's recorded kills and the recorded grace callback. No timeout is set,
// so the abort signal is the sole trigger, isolating it from the timeout path.
test("makeSpawnExec escalates from SIGTERM to SIGKILL and resolves killed when its abort signal fires", async () => {
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

	const controller = new AbortController();
	const run = makeSpawnExec(deps);
	const resultPromise = run("pi", ["-p", "x"], { signal: controller.signal, graceMs: 2000 });

	// Aborting mid-run signals SIGTERM at once and arms the grace timer.
	controller.abort();
	assert.deepEqual(killSignals, ["SIGTERM"]);

	// The child is still alive when the grace window elapses, so SIGKILL follows.
	fire(2000);
	assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);

	// The child finally exits after being killed; the result reports it was killed.
	child.emit("exit", null);
	const result = await resultPromise;
	assert.equal(result.killed, true);
});
