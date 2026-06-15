// Injectable wrapper around child_process.spawn for headless pi children.
//
// makeSpawnExec turns a spawn + timer pair (SpawnDeps) into a SpawnExec that
// launches one child, accumulates its stdout/stderr, and resolves with the
// captured ExecResultLike on exit. The child process is the only external
// boundary, so injecting SpawnDeps keeps the wiring unit-testable with a fake
// child and fake timers — no real process, no real clock.
//
// This wrapper handles a clean exit plus SIGTERM→SIGKILL escalation driven by
// either an overrun timeout or an aborted AbortSignal (the `signal` option).

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

/** Per-run knobs; cwd, onSpawn, timeout, graceMs and signal all act this slice. */
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

			// SIGTERM the child and mark it killed at once, then SIGKILL it if it is still
			// alive when the grace window elapses; shared by the timeout and abort triggers.
			// The idempotency guard prevents a double SIGTERM + stray grace timer when both
			// a timeout and an abort signal fire for the same run.
			let terminating = false;
			const terminate = () => {
				if (terminating) return;
				terminating = true;
				killed = true;
				child.kill("SIGTERM");
				cancelGrace = deps.schedule(() => {
					child.kill("SIGKILL");
				}, options?.graceMs ?? DEFAULT_GRACE_MS);
			};

			// A run that overruns its timeout escalates exactly as an abort does.
			const timeoutMs = options?.timeout;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				cancelTimeout = deps.schedule(terminate, timeoutMs);
			}

			// Aborting the run's signal (how agent_kill stops a live child) escalates at once
			// if already aborted, otherwise when the abort fires.
			const signal = options?.signal;
			if (signal !== undefined) {
				if (signal.aborted) {
					terminate();
				} else {
					signal.addEventListener("abort", terminate, { once: true });
				}
			}

			// Cancel any pending escalation timers and drop the abort listener on exit so a
			// clean exit never triggers a late SIGKILL or leaks a listener; killed reflects
			// whether an escalation fired. The settled guard prevents a double-resolve when a
			// spawn failure emits "error" followed by a late "close" event.
			let settled = false;
			child.on("exit", (code) => {
				if (settled) return;
				settled = true;
				cancelTimeout();
				cancelGrace();
				signal?.removeEventListener("abort", terminate);
				resolve({ stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), code: code ?? 0, killed });
			});

			// A spawn failure (ENOENT/EPERM) emits "error" and never emits "exit". Without
			// this handler node re-throws the error as an uncaught exception and the promise
			// leaks; with it, we resolve to a nonzero failure result so the caller can handle it.
			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				cancelTimeout();
				cancelGrace();
				signal?.removeEventListener("abort", terminate);
				resolve({ stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") + err.message, code: 1, killed: false });
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
