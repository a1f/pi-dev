// JSONL codec for the in-flight pidfile that tracks subagent child processes.
//
// Pure: it only converts between records and the pidfile's line format so a later
// session can detect orphaned children. The pidfile is untrusted input — a prior
// session may have crashed mid-write — so parsing is total and never throws.

import { isObject } from "./events.ts";

/** One in-flight child process, recorded in the pidfile so a later session can reap orphans. */
export interface InflightRecord {
	runId: string;
	pid: number;
	startedAt: number;
}

/** Parse the pidfile content into records, skipping any blank or malformed line rather than throwing. */
export function parseInflight(content: string): InflightRecord[] {
	const records: InflightRecord[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			isObject(parsed) &&
			typeof parsed.runId === "string" &&
			typeof parsed.pid === "number" &&
			typeof parsed.startedAt === "number"
		) {
			records.push({ runId: parsed.runId, pid: parsed.pid, startedAt: parsed.startedAt });
		}
	}
	return records;
}

/** Render records as one JSON object per line, mirroring the JSONL framing of the run logs. */
export function serializeInflight(records: readonly InflightRecord[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}
