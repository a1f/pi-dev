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
