// web_search (Tavily /search) and web_read (Tavily /extract): two tools the
// agent can call to find current information and read page content. Both use a
// single TAVILY_API_KEY, read from the environment at call time and required —
// a session without it fails loud. Get a free key (no credit card) at
// https://app.tavily.com.
//
// All request-shaping/parsing logic lives in the pure, unit-tested helpers in
// search.ts / read.ts / http.ts; this file only wires them to pi's tool API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { READ_TIMEOUT_MS, SEARCH_TIMEOUT_MS, TAVILY_EXTRACT_ENDPOINT, TAVILY_SEARCH_ENDPOINT } from "./constants.ts";
import { bearerJsonHeaders, fetchJson } from "./http.ts";
import { buildSearchBody, clampCount, formatSearchResults, mapTavilyResults } from "./search.ts";
import { buildExtractBody, clampChars, formatReadResult, validateReadUrl } from "./read.ts";

function requireKey(): string {
	const key = process.env["TAVILY_API_KEY"];
	if (!key) {
		throw new Error("TAVILY_API_KEY is not set; the web tools need a free Tavily key (no card): https://app.tavily.com");
	}
	return key;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Tavily and return a numbered list of result titles, URLs, and snippets. " +
			"Use it to find current information or to discover URLs to read.",
		promptSnippet: "web_search — search the web (Tavily) for current info and URLs",
		promptGuidelines: [
			"Use web_search to find current information or discover URLs; pair it with web_read to fetch a page.",
			"Prefer specific queries; lower count to keep results focused.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
			count: Type.Optional(Type.Number({ description: "Number of results to return (1-20, default 5)." })),
		}),
		async execute(_toolCallId, params, signal) {
			const key = requireKey();
			if (!params.query.trim()) throw new Error("web_search requires a non-empty query");

			const json = await fetchJson(TAVILY_SEARCH_ENDPOINT, {
				method: "POST",
				headers: bearerJsonHeaders(key),
				body: JSON.stringify(buildSearchBody(params.query, clampCount(params.count))),
				signal,
				timeoutMs: SEARCH_TIMEOUT_MS,
			});

			const results = mapTavilyResults(json);
			return { content: [{ type: "text", text: formatSearchResults(results) }], details: { results } };
		},
	});

	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Read a web page via Tavily and return its main content as clean markdown. Use it to fetch " +
			"and read a URL, typically one surfaced by web_search.",
		promptSnippet: "web_read — fetch a URL and read it as clean markdown (Tavily)",
		promptGuidelines: [
			"Use web_read to fetch a specific URL's content; pair it with web_search to discover URLs.",
			"Lower max_chars to keep large pages within budget; the content is truncated client-side.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The page URL to read." }),
			max_chars: Type.Optional(
				Type.Number({ description: "Max characters of content to return (min 1000, default 40000)." }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const key = requireKey();
			const target = validateReadUrl(params.url);
			const maxChars = clampChars(params.max_chars);
			const json = await fetchJson(TAVILY_EXTRACT_ENDPOINT, {
				method: "POST",
				headers: bearerJsonHeaders(key),
				body: JSON.stringify(buildExtractBody(target)),
				signal,
				timeoutMs: READ_TIMEOUT_MS,
			});

			const result = formatReadResult(json, maxChars, target);
			return {
				content: [{ type: "text", text: result.text }],
				details: { url: result.url, title: result.title, chars: result.chars },
			};
		},
	});
}
