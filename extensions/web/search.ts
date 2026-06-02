// Pure helpers for web_search (Tavily /search). No network or env access —
// these are the unit-tested seam; index.ts wires them to the live request.

import { DEFAULT_COUNT, MAX_COUNT, MIN_COUNT } from "./constants.ts";

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

/** Request body for POST /search. `basic` depth is the cheapest (1 credit). */
export function buildSearchBody(query: string, count: number): Record<string, unknown> {
	return { query, max_results: count, search_depth: "basic", include_raw_content: false };
}

/** Tolerant of a missing/!array `results` (Tavily omits it on no hits). Tavily's
 * `content` field is the snippet, which maps to our `description`. */
export function mapTavilyResults(json: unknown): SearchResult[] {
	const data = (json as { results?: unknown } | null)?.results;
	const results = Array.isArray(data) ? data : [];
	return results
		.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
		.map((r) => ({
			title: typeof r["title"] === "string" ? r["title"] : "",
			url: typeof r["url"] === "string" ? r["url"] : "",
			description: typeof r["content"] === "string" ? r["content"] : "",
		}));
}

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results.";
	return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n\n");
}
