// Pure helpers for web_read (Jina Reader). No network or env access — the
// unit-tested seam; index.ts wires them to the live request.

import { DEFAULT_MAX_TOKENS, JINA_READER_ENDPOINT, MIN_MAX_TOKENS } from "./constants.ts";

interface JinaReadData {
	title?: string;
	url?: string;
	content?: string;
	usage?: { tokens?: number };
}

export interface ReadResult {
	text: string;
	url: string;
	title: string | undefined;
	tokens: number | undefined;
}

/** Default to 10000, reject non-finite, and enforce Jina's 500-token floor. */
export function clampTokens(tokens: number | undefined): number {
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) return DEFAULT_MAX_TOKENS;
	return Math.max(MIN_MAX_TOKENS, Math.trunc(tokens));
}

/**
 * Reject blank / scheme-less / non-http(s) input with a clear local error
 * rather than forwarding it raw to Jina as an opaque upstream failure.
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

/** Jina expects the target URL appended raw (not percent-encoded) to the base. */
export function buildJinaUrl(url: string): string {
	return JINA_READER_ENDPOINT + url.trim();
}

/**
 * Authorization is only sent when a key is present: keyless r.jina.ai works,
 * and an empty bearer would be rejected, so we omit the header instead.
 */
export function buildJinaHeaders(maxTokens: number, jinaKey?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"X-Return-Format": "markdown",
		// Server-side token budget; Jina trims the body so we never truncate client-side.
		"X-Max-Tokens": String(maxTokens),
	};
	if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
	return headers;
}

/**
 * Narrow the raw JSON into the markdown body (with an optional title header)
 * plus the metadata index.ts needs for `details`, noting when Jina hit the
 * token budget. Throws when there is no content (surfacing any code/status).
 */
export function formatReadResult(json: unknown, maxTokens: number, fallbackUrl: string): ReadResult {
	const root = (json ?? {}) as { code?: number; status?: number; data?: JinaReadData };
	const data = root.data ?? {};
	const content = typeof data.content === "string" ? data.content : "";
	if (!content) {
		const detail = [root.code, root.status].filter((v) => v !== undefined).join("/");
		throw new Error(`Jina Reader returned no content${detail ? ` (${detail})` : ""}`);
	}

	const title = typeof data.title === "string" ? data.title : undefined;
	const source = typeof data.url === "string" ? data.url : "";
	const header = title ? `# ${title}\n${source}\n\n` : "";

	const tokens = typeof data.usage?.tokens === "number" ? data.usage.tokens : undefined;
	const trimmed =
		tokens !== undefined && tokens >= maxTokens
			? `\n\n[trimmed to ~${maxTokens} tokens — the page was larger]`
			: "";

	return {
		text: `${header}${content}${trimmed}`,
		url: typeof data.url === "string" ? data.url : fallbackUrl,
		title,
		tokens,
	};
}
