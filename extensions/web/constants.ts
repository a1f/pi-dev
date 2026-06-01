// Shared constants for the web tools: web_search and web_read, both on Jina.

/** Jina Search base; the query is passed as the `q` parameter. */
export const JINA_SEARCH_ENDPOINT = "https://s.jina.ai/";
/** Jina Reader base; the target URL is appended raw (not percent-encoded). */
export const JINA_READER_ENDPOINT = "https://r.jina.ai/";

/** Per-request timeouts. Reads render JS pages; searches query an engine. */
export const SEARCH_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 30_000;

/** Result-count bounds (applied client-side by slicing the result list). */
export const DEFAULT_COUNT = 5;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

/** Jina token-budget bounds (the X-Max-Tokens floor is 500). */
export const DEFAULT_MAX_TOKENS = 10_000;
export const MIN_MAX_TOKENS = 500;

/** Cap on provider error-body text echoed into a thrown error. */
export const ERROR_BODY_SNIPPET_CHARS = 500;
