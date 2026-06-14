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
	let result: string | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line !== "") result = line;
	}
	return result;
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
			const message = event.message;
			if (!isObject(message) || message.role !== "assistant") continue;
			const text = joinTextBlocks(message.content);
			if (text !== null) {
				const candidate = lastNonEmptyLine(text);
				if (candidate !== null) lastLine = candidate;
			}
			const usage = message.usage;
			if (isObject(usage) && message.stopReason !== "aborted" && message.stopReason !== "error") {
				contextTokens = usageTokens(usage);
			}
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
