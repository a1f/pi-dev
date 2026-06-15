// Injectable wrapper around child_process.spawn for headless pi children.
//
// makeSpawnExec turns a spawn + timer pair (SpawnDeps) into a SpawnExec that
// launches one child, accumulates its stdout/stderr, and resolves with the
// captured ExecResultLike on exit. The child process is the only external
// boundary, so injecting SpawnDeps keeps the wiring unit-testable with a fake
// child and fake timers — no real process, no real clock.
//
// This slice handles a clean exit and timeout-driven SIGTERM→SIGKILL
// escalation; AbortSignal handling (the `signal` option) is a later slice
// with its own test.

import { spawn as nodeSpawn } from "node:child_process";

import type { ExecResultLike } from "./runner.ts";

/** Default SIGTERM→SIGKILL grace window when a caller omits graceMs, matching pi.exec's prior 5s grace. */
const DEFAULT_GRACE_MS = 5000;

/** A stdout/stderr stream narrowed to the one `.on("data", …)` this wrapper reads. */
export interface ReadableLike {
	on(event: "data", listener: (chunk: Buffer) => void): this;
}

/** The slice of a node ChildProcess this wrapper touches, so a fake child and a real ChildProcess are interchangeable. */
export interface ChildLike {
	pid?: number;
	killed: boolean;
	exitCode: number | null;
	stdout: ReadableLike | null;
	stderr: ReadableLike | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "exit", listener: (code: number | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
}

/** Per-run knobs; cwd, onSpawn, timeout and graceMs act this slice, signal is the stable surface the abort slice will consume. */
export interface SpawnExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
	onSpawn?: (pid: number) => void;
	graceMs?: number;
}

/** Launches a command and resolves with its captured result, like ExecLike but backed by a real spawn. */
export type SpawnExec = (command: string, args: readonly string[], options?: SpawnExecOptions) => Promise<ExecResultLike>;

/** The boundary makeSpawnExec depends on, injected so tests can fake the child and the timer deterministically. */
export interface SpawnDeps {
	spawn(command: string, args: readonly string[], options: { cwd?: string }): ChildLike;
	schedule(run: () => void, ms: number): () => void;
}

/** Build a SpawnExec over injected deps so the spawn/timer boundary stays fakeable in tests. */
export function makeSpawnExec(deps: SpawnDeps): SpawnExec {
	return (command, args, options) =>
		new Promise<ExecResultLike>((resolve) => {
			const child = deps.spawn(command, args, { cwd: options?.cwd });
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];
			let killed = false;
			let cancelTimeout: () => void = () => {};
			let cancelGrace: () => void = () => {};

			// Report the pid once, as soon as it exists, so callers can track the live run.
			if (child.pid !== undefined) {
				options?.onSpawn?.(child.pid);
			}

			child.stdout?.on("data", (chunk) => {
				stdoutChunks.push(chunk.toString());
			});
			child.stderr?.on("data", (chunk) => {
				stderrChunks.push(chunk.toString());
			});

			// A run that overruns its timeout is SIGTERMed and marked killed at once, then
			// SIGKILLed if it is still alive when the grace window elapses.
			const timeoutMs = options?.timeout;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				cancelTimeout = deps.schedule(() => {
					killed = true;
					child.kill("SIGTERM");
					cancelGrace = deps.schedule(() => {
						child.kill("SIGKILL");
					}, options?.graceMs ?? DEFAULT_GRACE_MS);
				}, timeoutMs);
			}

			// Cancel any pending escalation timers on exit so a clean exit never triggers a
			// late SIGKILL; killed reflects whether the timeout path fired.
			child.on("exit", (code) => {
				cancelTimeout();
				cancelGrace();
				resolve({ stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), code: code ?? 0, killed });
			});
		});
}

/** Real spawn/timer wiring for production dispatch: a piped child with stdin ignored and no shell, plus a setTimeout-backed cancellable schedule. */
export const defaultSpawnDeps: SpawnDeps = {
	spawn: (command, args, options) => nodeSpawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false }),
	schedule: (run, ms) => {
		const timer = setTimeout(run, ms);
		return () => {
			clearTimeout(timer);
		};
	},
};
