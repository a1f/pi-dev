// Run-state reducer for a pi `--mode json` event stream.
//
// Pure superset sibling of ./events.ts: it folds the JSONL event stream into a
// live snapshot (tool count, last assistant line, context usage, done) for a
// running dispatch. Like the minimal parser it ignores the session header and
// unknown events, and never throws on a malformed line (it counts and skips it).

import { isObject, joinTextBlocks } from "./events.ts";

export interface RunState {
	/** Number of tool_execution_start events seen. */
	toolCount: number;
	/** Last NON-EMPTY line of the most recent assistant text, else null. */
	lastLine: string | null;
	/** Context tokens from the latest valid assistant usage, else null. */
	contextTokens: number | null;
	/** contextTokens / contextWindow * 100, else null. */
	contextPct: number | null;
	/** True once a terminal agent_end (willRetry !== true) is seen. */
	done: boolean;
	/** Count of non-empty lines that failed JSON.parse (skipped, not thrown). */
	malformed: number;
}

export interface ReduceOptions {
	contextWindow?: number;
}

/** Last non-empty line of `text` (trimmed), or null when every line is blank. */
function lastNonEmptyLine(text: string): string | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (line) return line;
	}
	return null;
}

/** Numeric field of an object, or 0 when absent or non-numeric. */
function numberField(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** Mirror of the package's calculateContextTokens: totalTokens, else the sum. */
function usageTokens(usage: Record<string, unknown>): number {
	return (
		numberField(usage.totalTokens) ||
		numberField(usage.input) +
			numberField(usage.output) +
			numberField(usage.cacheRead) +
			numberField(usage.cacheWrite)
	);
}

/** Live-state an assistant message contributes; null fields leave the prior value unchanged. */
interface MessageSnapshot {
	/** Last non-empty assistant line, or null when the message carries no text. */
	line: string | null;
	/** Context tokens from valid (non-aborted/error) usage, or null when absent. */
	tokens: number | null;
}

/** Extract the lastLine / contextTokens an assistant message_end or turn_end event contributes. */
function assistantSnapshot(message: unknown): MessageSnapshot {
	if (!isObject(message) || message.role !== "assistant") return { line: null, tokens: null };
	const text = joinTextBlocks(message.content);
	const line = text !== null ? lastNonEmptyLine(text) : null;
	const usage = message.usage;
	const tokens =
		isObject(usage) && message.stopReason !== "aborted" && message.stopReason !== "error"
			? usageTokens(usage)
			: null;
	return { line, tokens };
}

export function reduceRunState(lines: Iterable<string>, opts?: ReduceOptions): RunState {
	let toolCount = 0;
	let lastLine: string | null = null;
	let contextTokens: number | null = null;
	let done = false;
	let malformed = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === "") continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		if (!isObject(event)) continue;
		if (event.type === "tool_execution_start") {
			toolCount += 1;
		} else if (event.type === "agent_end" && event.willRetry !== true) {
			done = true;
		} else if (event.type === "message_end" || event.type === "turn_end") {
			const snapshot = assistantSnapshot(event.message);
			if (snapshot.line !== null) lastLine = snapshot.line;
			if (snapshot.tokens !== null) contextTokens = snapshot.tokens;
		}
	}

	const contextWindow = opts?.contextWindow;
	const contextPct =
		typeof contextWindow === "number" && contextWindow > 0 && contextTokens !== null
			? (contextTokens / contextWindow) * 100
			: null;
	return { toolCount, lastLine, contextTokens, contextPct, done, malformed };
}

export function reduceRunStateFromString(raw: string, opts?: ReduceOptions): RunState {
	return reduceRunState(raw.split("\n"), opts);
}
