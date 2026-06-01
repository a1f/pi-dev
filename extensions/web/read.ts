// Pure helpers for web_read (Tavily /extract). No network or env access — the
// unit-tested seam; index.ts wires them to the live request.

import { DEFAULT_MAX_CHARS, MIN_MAX_CHARS } from "./constants.ts";

interface TavilyExtractResult {
	url?: string;
	title?: string;
	raw_content?: string;
}

export interface ReadResult {
	text: string;
	url: string;
	title: string | undefined;
	chars: number;
}

/** Default to 40000, reject non-finite, and enforce a small floor. */
export function clampChars(chars: number | undefined): number {
	if (typeof chars !== "number" || !Number.isFinite(chars)) return DEFAULT_MAX_CHARS;
	return Math.max(MIN_MAX_CHARS, Math.trunc(chars));
}

/**
 * Reject blank / scheme-less / non-http(s) input with a clear local error
 * rather than forwarding it raw to the provider as an opaque upstream failure.
 */
export function validateReadUrl(url: string): string {
	const target = url.trim();
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		throw new Error("web_read requires a valid absolute URL (e.g. https://example.com/page)");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("web_read only supports http(s) URLs");
	}
	return target;
}

/** Request body for POST /extract. `basic` depth is the cheapest (1 credit). */
export function buildExtractBody(url: string): Record<string, unknown> {
	return { urls: [url], format: "markdown", extract_depth: "basic" };
}

/**
 * Narrow the extract response into the page content (with an optional title
 * header) plus the metadata index.ts needs for `details`, truncating to
 * maxChars (Tavily has no server-side cap). Throws when the page could not be
 * extracted, surfacing the failed_results error when present.
 */
export function formatReadResult(json: unknown, maxChars: number, fallbackUrl: string): ReadResult {
	const root = (json ?? {}) as {
		results?: unknown;
		failed_results?: unknown;
	};
	const results = Array.isArray(root.results) ? root.results : [];
	const first = results.find((r): r is TavilyExtractResult => typeof r === "object" && r !== null);
	const content = typeof first?.raw_content === "string" ? first.raw_content : "";
	if (!content) {
		const failed = Array.isArray(root.failed_results) ? root.failed_results : [];
		const firstFailed = failed.find((f): f is { error?: string } => typeof f === "object" && f !== null);
		const reason = typeof firstFailed?.error === "string" ? `: ${firstFailed.error}` : "";
		throw new Error(`Tavily could not extract content from the URL${reason}`);
	}

	const truncated = content.length > maxChars;
	const body = truncated ? content.slice(0, maxChars) : content;
	const note = truncated ? `\n\n[truncated to ${maxChars} chars — the page was larger]` : "";

	const title = typeof first?.title === "string" ? first.title : undefined;
	const source = typeof first?.url === "string" ? first.url : fallbackUrl;
	const header = title ? `# ${title}\n${source}\n\n` : "";

	return {
		text: `${header}${body}${note}`,
		url: source,
		title,
		chars: body.length,
	};
}
