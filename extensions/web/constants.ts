// Shared constants for the web tools: web_search (Brave) and web_read (Jina).

/** Brave Web Search API endpoint. */
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** Jina Reader base; the target URL is appended raw (not percent-encoded). */
export const JINA_READER_ENDPOINT = "https://r.jina.ai/";

/** Per-request timeouts. Jina renders JS pages, so reads are markedly slower. */
export const SEARCH_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 30_000;

/** Brave result-count bounds. */
export const DEFAULT_COUNT = 5;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

/** Jina token-budget bounds (the X-Max-Tokens floor is 500). */
export const DEFAULT_MAX_TOKENS = 10_000;
export const MIN_MAX_TOKENS = 500;

/** Cap on provider error-body text echoed into a thrown error. */
export const ERROR_BODY_SNIPPET_CHARS = 500;
