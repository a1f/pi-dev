// Minimal JSONL parser for a pi `--mode json` event stream.
//
// Pure: it consumes lines/strings and reports only what later PRs need — whether
// the run terminated (agent_end) and the final assistant text. It deliberately
// ignores the session header and every intermediate event, and never throws on a
// malformed line (it counts and skips them instead).

export interface ParsedRun {
	/** True once a terminal agent_end (willRetry !== true) is seen. */
	done: boolean;
	/** Concatenated text of the LAST role:"assistant" message in that agent_end, or null. */
	finalText: string | null;
	/** Count of non-empty lines that failed JSON.parse (skipped, not thrown). */
	malformed: number;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Join the `text` blocks of a message's content; null when there are none. */
export function joinTextBlocks(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const texts = content
		.filter(
			(block): block is { type: "text"; text: string } =>
				isObject(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text);
	return texts.length === 0 ? null : texts.join("");
}

/** Text of the last assistant message in an agent_end's messages[], or null. */
function lastAssistantText(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	let text: string | null = null;
	for (const message of messages) {
		if (isObject(message) && message.role === "assistant") {
			text = joinTextBlocks(message.content);
		}
	}
	return text;
}

export function parseEvents(lines: Iterable<string>): ParsedRun {
	let done = false;
	let finalText: string | null = null;
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
		if (isObject(event) && event.type === "agent_end" && event.willRetry !== true) {
			done = true;
			finalText = lastAssistantText(event.messages);
		}
	}
	return { done, finalText, malformed };
}

export function parseEventStream(raw: string): ParsedRun {
	return parseEvents(raw.split("\n"));
}
