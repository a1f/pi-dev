import type { RunStatus } from "./registry.ts";

/** Shared so every subagent run renderer shows the same lifecycle markers. */
export const STATUS_GLYPH: Record<RunStatus, string> = {
	running: "▶",
	queued: "▷",
	done: "✓",
	error: "✗",
	killed: "⊘",
};

/** Centralizes live-versus-finished elapsed time so renderers stay byte-identical. */
export function elapsedMs(run: { readonly startedAt: number; readonly finishedAt: number | null }, now: number): number {
	return (run.finishedAt ?? now) - run.startedAt;
}

/** Centralizes display text so status rows and dashboard cards stay byte-identical. */
export function formatElapsed(ms: number | null): string {
	return ms === null ? "—" : `${Math.floor(ms / 1000)}s`;
}
