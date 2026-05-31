// web_search (Brave Search API) and web_read (Jina Reader) tools.
//
// API keys are read at call time (never baked in): BRAVE_API_KEY is required
// for search, JINA_API_KEY is optional for read (keyless r.jina.ai works). A
// session without egress / a required key simply fails loud, not silently.
// Pure helpers (URL building, tag stripping, result mapping/formatting) are
// factored out as named exports: the repo has no test runner, so they are the
// seam validated by reasoning, and they stay side-effect-free for that reason.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai"; // Type.Union/Literal break Google models

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const JINA_READER_ENDPOINT = "https://r.jina.ai/";
const REQUEST_TIMEOUT_MS = 10_000;
// Jina renders JS pages server-side, so reads are markedly slower than search.
const READ_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 20;
const DEFAULT_MAX_TOKENS = 10_000;
const MIN_MAX_TOKENS = 500; // Jina's floor; smaller budgets are ignored upstream.
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

export function clampTokens(tokens: number | undefined): number {
  if (typeof tokens !== "number" || Number.isNaN(tokens)) return DEFAULT_MAX_TOKENS;
  return Math.max(MIN_MAX_TOKENS, Math.trunc(tokens));
}

// Jina expects the target URL appended raw (not percent-encoded) to the base.
export function buildJinaUrl(url: string): string {
  return JINA_READER_ENDPOINT + url.trim();
}

// Authorization is only sent when a key is present: keyless r.jina.ai works,
// and an empty bearer would be rejected, so we omit the header instead.
export function buildJinaHeaders(maxTokens: number, jinaKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Return-Format": "markdown",
    // Server-side token budget; Jina trims the body so we never truncate client-side.
    "X-Max-Tokens": String(maxTokens),
  };
  if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
  return headers;
}

interface JinaReadData {
  title?: string;
  url?: string;
  content?: string;
  usage?: { tokens?: number };
}

// Narrows the raw JSON, returns the markdown body (with an optional title
// header), and notes when Jina hit the token budget. Throws when there is no
// content, surfacing whatever code/status/message the response carried.
export function formatReadResult(json: unknown, maxTokens: number): string {
  const root = (json ?? {}) as { code?: number; status?: number; data?: JinaReadData };
  const data = root.data ?? {};
  const content = typeof data.content === "string" ? data.content : "";
  if (!content) {
    const detail = [root.code, root.status].filter((v) => v !== undefined).join("/");
    throw new Error(`Jina Reader returned no content${detail ? ` (${detail})` : ""}`);
  }

  const title = typeof data.title === "string" ? data.title : "";
  const source = typeof data.url === "string" ? data.url : "";
  const header = title ? `# ${title}\n${source}\n\n` : "";

  const tokens = data.usage?.tokens;
  const trimmed =
    typeof tokens === "number" && tokens >= maxTokens
      ? `\n\n[trimmed to ~${maxTokens} tokens — the page was larger]`
      : "";

  return `${header}${content}${trimmed}`;
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
      if (!params.query.trim()) throw new Error("web_search requires a non-empty query");

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

  pi.registerTool({
    name: "web_read",
    label: "Web Read",
    description:
      "Read a web page via Jina Reader and return its main content as clean " +
      "markdown (JS-rendered pages included). Use it to fetch and read a URL, " +
      "typically one surfaced by web_search.",
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!params.url.trim()) throw new Error("web_read requires a non-empty url");
      // JINA_API_KEY is optional: keyless r.jina.ai works, so we never throw on absence.
      const key = process.env.JINA_API_KEY;
      const maxTokens = clampTokens(params.max_tokens);
      const url = buildJinaUrl(params.url);
      const json = await fetchJson(url, {
        headers: buildJinaHeaders(maxTokens, key),
        signal,
        timeoutMs: READ_TIMEOUT_MS,
      });

      const text = formatReadResult(json, maxTokens);
      const data = (json as { data?: JinaReadData } | null)?.data ?? {};
      return {
        content: [{ type: "text", text }],
        details: { url: data.url ?? params.url, title: data.title, tokens: data.usage?.tokens },
      };
    },
  });
}
