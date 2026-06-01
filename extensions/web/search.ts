// Pure helpers for web_search (Jina Search, s.jina.ai). No network or env
// access — these are the unit-tested seam; index.ts wires them to the request.

import { DEFAULT_COUNT, JINA_SEARCH_ENDPOINT, MAX_COUNT, MIN_COUNT } from "./constants.ts";

export interface SearchResult {
	title: string;
	url: string;
	description: string;
}

/** Default to 5, reject non-finite, and clamp to the 1..20 (integer) range. */
export function clampCount(count: number | undefined): number {
	if (typeof count !== "number" || !Number.isFinite(count)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.trunc(count)));
}

export function buildJinaSearchUrl(query: string): string {
	return `${JINA_SEARCH_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
}

/**
 * `X-Respond-With: no-content` makes s.jina.ai return search results (title,
 * url, snippet) without reading each page — without it Jina fetches the full
 * content of the top hits, which is slow and token-heavy. Authorization is sent
 * only when a key is present: keyless s.jina.ai works (rate-limited), and an
 * empty bearer would be rejected.
 */
export function buildSearchHeaders(jinaKey?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"X-Respond-With": "no-content",
	};
	if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
	return headers;
}

/** Tolerant of a missing/!array `data` (Jina omits it when there are no hits). */
export function mapJinaResults(json: unknown): SearchResult[] {
	const data = (json as { data?: unknown } | null)?.data;
	const results = Array.isArray(data) ? data : [];
	return results
		.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
		.map((r) => ({
			title: typeof r["title"] === "string" ? r["title"] : "",
			url: typeof r["url"] === "string" ? r["url"] : "",
			// no-content responses carry the snippet in `description`; fall back to
			// `content` in case a result still includes a body.
			description:
				typeof r["description"] === "string"
					? r["description"]
					: typeof r["content"] === "string"
						? r["content"]
						: "",
		}));
}

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results.";
	return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n\n");
}
