// Pure helpers for web_search (Brave Search API). No network or env access —
// these are the unit-tested seam; index.ts wires them to the live request.

import { BRAVE_SEARCH_ENDPOINT, DEFAULT_COUNT, MAX_COUNT, MIN_COUNT } from "./constants.ts";

export interface SearchResult {
	title: string;
	url: string;
	description: string;
}

/** Default to 5, reject non-finite, and clamp to Brave's 1..20 (integer) range. */
export function clampCount(count: number | undefined): number {
	if (typeof count !== "number" || !Number.isFinite(count)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.trunc(count)));
}

export function buildBraveSearchUrl(query: string, count: number, freshness?: string): string {
	const params = new URLSearchParams({
		q: query,
		count: String(count),
		// Suppress <strong> highlight markup in snippets (paired with stripHighlightTags).
		text_decorations: "0",
	});
	if (freshness) params.set("freshness", freshness);
	return `${BRAVE_SEARCH_ENDPOINT}?${params.toString()}`;
}

export function stripHighlightTags(s: string): string {
	return s.replace(/<\/?strong>/g, "");
}

/** Tolerant of missing web/results (Brave omits them when there are no hits). */
export function mapBraveResults(json: unknown): SearchResult[] {
	const web = (json as { web?: { results?: unknown } } | null)?.web;
	const results = Array.isArray(web?.results) ? web.results : [];
	return results
		.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
		.map((r) => ({
			title: stripHighlightTags(typeof r.title === "string" ? r.title : ""),
			url: typeof r.url === "string" ? r.url : "",
			description: stripHighlightTags(typeof r.description === "string" ? r.description : ""),
		}));
}

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results.";
	return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n\n");
}
