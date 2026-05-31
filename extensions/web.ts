// web_search tool, backed by the Brave Search API.
//
// The API key is read from BRAVE_API_KEY at call time (never baked in), so a
// session without egress / a key simply fails loud instead of leaking config.
// Pure helpers (URL building, tag stripping, result mapping/formatting) are
// factored out as named exports: the repo has no test runner, so they are the
// seam validated by reasoning, and they stay side-effect-free for that reason.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai"; // Type.Union/Literal break Google models

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 20;
const ERROR_BODY_SNIPPET_CHARS = 500;

interface SearchResult {
  title: string;
  url: string;
  description: string;
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

// Tolerant of missing web/results (Brave omits them when there are no hits).
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
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
    .join("\n\n");
}

// Generic JSON fetch: combines the caller's signal with a timeout, enforces
// res.ok, and parses the body. web_read will reuse this later.
async function fetchJson(
  url: string,
  opts: { headers: Record<string, string>; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs)].filter(
    (s): s is AbortSignal => Boolean(s),
  );
  const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.any(signals) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, ERROR_BODY_SNIPPET_CHARS);
    throw new Error(`Request failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

function clampCount(count: number | undefined): number {
  if (typeof count !== "number" || Number.isNaN(count)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.trunc(count)));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Brave Search and return a numbered list of result " +
      "titles, URLs, and snippets. Use it to find current information or to " +
      "discover URLs to read.",
    promptSnippet: "web_search — search the web (Brave) for current info and URLs",
    promptGuidelines: [
      "Use web_search to find current information or discover URLs; pair it with web_read to fetch a page.",
      "Prefer specific queries; use the freshness window when recency matters.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(
        Type.Number({ description: "Number of results to return (1-20, default 5)." }),
      ),
      freshness: Type.Optional(
        StringEnum(["pd", "pw", "pm", "py"] as const, {
          description: "Recency window: pd=past day, pw=past week, pm=past month, py=past year.",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const key = process.env.BRAVE_API_KEY;
      if (!key) {
        throw new Error("BRAVE_API_KEY is not set; web_search requires a Brave Search API key");
      }

      const count = clampCount(params.count);
      const url = buildBraveSearchUrl(params.query, count, params.freshness);
      const json = await fetchJson(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": key,
        },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      const results = mapBraveResults(json);
      return { content: [{ type: "text", text: formatSearchResults(results) }], details: { results } };
    },
  });
}
