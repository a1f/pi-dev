// Shared constants for the web tools: web_search and web_read, both on Tavily.

/** Tavily search endpoint (POST, Bearer auth). */
export const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
/** Tavily extract (page-read) endpoint (POST, Bearer auth). */
export const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";

/** Per-request timeouts. Extract fetches + parses a page, so it's slower. */
export const SEARCH_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 30_000;

/** Result-count bounds for search (Tavily max_results is 0..20). */
export const DEFAULT_COUNT = 5;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

/** Char bounds for read. Tavily has no server-side cap, so we truncate the
 * returned content client-side to keep the context window bounded (~4 chars/
 * token, so 40k chars ≈ 10k tokens). */
export const DEFAULT_MAX_CHARS = 40_000;
export const MIN_MAX_CHARS = 1_000;

/** Cap on provider error-body text echoed into a thrown error. */
export const ERROR_BODY_SNIPPET_CHARS = 500;
