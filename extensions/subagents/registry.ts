// In-memory registry of subagent runs for the parent session.
//
// Holds the live record of every dispatched run — its task, lifecycle status,
// timing, and latest folded RunState — keyed by runId so the parent can look one
// up or list them all. Pure in-memory bookkeeping: no I/O lives here.

import type { RunState } from "./runstate.ts";

/** Lifecycle of a run: live, finished cleanly or with an error, or killed. */
export type RunStatus = "running" | "done" | "error" | "killed";

/** Single-glyph status marker shown at the head of each rendered row. */
const STATUS_GLYPH: Record<RunStatus, string> = {
	running: "▶",
	done: "✓",
	error: "✗",
	killed: "⊘",
};

/** The live record the registry keeps for one dispatched run. */
export interface RunRecord {
	runId: string;
	task: string;
	/** Persona the run was dispatched under, or null when none was named. */
	persona: string | null;
	status: RunStatus;
	startedAt: number;
	/** Wall-clock end time, or null while the run is still running. */
	finishedAt: number | null;
	/** Latest snapshot folded from the child's event stream. */
	state: RunState;
}

/** The zero RunState a run starts from, before any child events are folded in. */
function emptyRunState(): RunState {
	return { toolCount: 0, lastLine: null, contextTokens: null, contextPct: null, done: false, malformed: 0 };
}

export class RunRegistry {
	readonly #records = new Map<string, RunRecord>();
	/** Per-run cancellation hooks, kept off the public record so callers can't fire them. */
	readonly #onKill = new Map<string, () => void>();

	/** Record a newly dispatched run as running, with an empty initial state. */
	register(run: { runId: string; task: string; startedAt: number; persona?: string | null; onKill?: () => void }): void {
		const { runId, task, startedAt, persona, onKill } = run;
		this.#records.set(runId, {
			runId,
			task,
			persona: persona ?? null,
			status: "running",
			startedAt,
			finishedAt: null,
			state: emptyRunState(),
		});
		if (onKill !== undefined) this.#onKill.set(runId, onKill);
	}

	/** Mark a still-running run terminal with its final status, folded state, and end time; a missing or already-terminal runId is a no-op, so a killed run is never overwritten by a late completion. */
	finish(update: { runId: string; status: "done" | "error"; state: RunState; finishedAt: number }): void {
		const { runId, status, state, finishedAt } = update;
		const record = this.#records.get(runId);
		if (record === undefined || record.status !== "running") return;
		record.status = status;
		record.state = state;
		record.finishedAt = finishedAt;
	}

	/** Cancel a still-running run, firing its onKill hook; unknown or already-terminal runId is a no-op returning false. */
	kill(runId: string): boolean {
		const record = this.#records.get(runId);
		if (record === undefined || record.status !== "running") return false;
		this.#onKill.get(runId)?.();
		record.status = "killed";
		return true;
	}

	get(runId: string): RunRecord | undefined {
		return this.#records.get(runId);
	}

	list(): RunRecord[] {
		return [...this.#records.values()];
	}
}

/** Render one run as a single status line; omits the last-line cell when the run has produced none. */
function renderRow(record: RunRecord, now: number): string {
	const { state } = record;
	const elapsedMs = (record.finishedAt ?? now) - record.startedAt;
	const context = state.contextPct === null ? "—" : `${Math.round(state.contextPct)}%`;
	const cells = [
		STATUS_GLYPH[record.status],
		record.task,
		`${Math.floor(elapsedMs / 1000)}s`,
		`${state.toolCount} tools`,
		context,
	];
	if (state.lastLine !== null) cells.push(state.lastLine);
	return cells.join(" · ");
}

/** Render the registry as one human-readable status line per run, in list order, joined by newlines. */
export function renderRows(records: readonly RunRecord[], now: number): string {
	return records.map((record) => renderRow(record, now)).join("\n");
}
