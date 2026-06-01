// web_search (Jina Search, s.jina.ai) and web_read (Jina Reader, r.jina.ai): two
// tools the agent can call to find current information and read page content.
// Both work keyless; JINA_API_KEY is read from the environment at call time and,
// when present, only raises rate limits. No key is required.
//
// All request-shaping/parsing logic lives in the pure, unit-tested helpers in
// search.ts / read.ts / http.ts; this file only wires them to pi's tool API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { READ_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "./constants.ts";
import { fetchJson } from "./http.ts";
import { buildJinaSearchUrl, buildSearchHeaders, clampCount, formatSearchResults, mapJinaResults } from "./search.ts";
import { buildJinaHeaders, buildJinaUrl, clampTokens, formatReadResult, validateReadUrl } from "./read.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Jina Search and return a numbered list of result titles, URLs, and " +
			"snippets. Use it to find current information or to discover URLs to read.",
		promptSnippet: "web_search — search the web (Jina) for current info and URLs",
		promptGuidelines: [
			"Use web_search to find current information or discover URLs; pair it with web_read to fetch a page.",
			"Prefer specific queries; lower count to keep results focused.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
			count: Type.Optional(Type.Number({ description: "Number of results to return (1-20, default 5)." })),
		}),
		async execute(_toolCallId, params, signal) {
			if (!params.query.trim()) throw new Error("web_search requires a non-empty query");
			// JINA_API_KEY is optional: keyless s.jina.ai works, so we never throw on absence.
			const key = process.env["JINA_API_KEY"];
			const json = await fetchJson(buildJinaSearchUrl(params.query), {
				headers: buildSearchHeaders(key),
				signal,
				timeoutMs: SEARCH_TIMEOUT_MS,
			});

			const results = mapJinaResults(json).slice(0, clampCount(params.count));
			return { content: [{ type: "text", text: formatSearchResults(results) }], details: { results } };
		},
	});

	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Read a web page via Jina Reader and return its main content as clean markdown (JS-rendered " +
			"pages included). Use it to fetch and read a URL, typically one surfaced by web_search.",
		promptSnippet: "web_read — fetch a URL and read it as clean markdown (Jina Reader)",
		promptGuidelines: [
			"Use web_read to fetch a specific URL's content; pair it with web_search to discover URLs.",
			"Lower max_tokens to keep large pages within budget; Jina trims server-side.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The page URL to read." }),
			max_tokens: Type.Optional(
				Type.Number({ description: "Token budget for the returned content (min 500, default 10000)." }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const target = validateReadUrl(params.url);
			// JINA_API_KEY is optional: keyless r.jina.ai works, so we never throw on absence.
			const key = process.env["JINA_API_KEY"];
			const maxTokens = clampTokens(params.max_tokens);
			const json = await fetchJson(buildJinaUrl(target), {
				headers: buildJinaHeaders(maxTokens, key),
				signal,
				timeoutMs: READ_TIMEOUT_MS,
			});

			const result = formatReadResult(json, maxTokens, target);
			return {
				content: [{ type: "text", text: result.text }],
				details: { url: result.url, title: result.title, tokens: result.tokens },
			};
		},
	});
}
