// Shared HTTP helpers for the web tools. fetchJson combines the caller's signal
// with a timeout, enforces res.ok, and parses the body. Error messages carry
// only the host and provider response — never the Authorization header / key.

import { ERROR_BODY_SNIPPET_CHARS } from "./constants.ts";

/** Bearer + JSON headers shared by the Tavily search and extract calls. */
export function bearerJsonHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function fetchJson(
	url: string,
	opts: {
		method?: string;
		headers: Record<string, string>;
		body?: string;
		signal: AbortSignal | undefined;
		timeoutMs: number;
	},
): Promise<unknown> {
	const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs)].filter(
		(s): s is AbortSignal => Boolean(s),
	);
	const res = await fetch(url, {
		method: opts.method ?? "GET",
		headers: opts.headers,
		body: opts.body,
		signal: AbortSignal.any(signals),
	});
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, ERROR_BODY_SNIPPET_CHARS);
		throw new Error(`Request failed: ${res.status} ${res.statusText} ${body}`);
	}
	try {
		return await res.json();
	} catch {
		// A 200 with an empty/non-JSON body otherwise surfaces as a raw SyntaxError.
		throw new Error(`Invalid JSON response from ${new URL(url).host} (${res.status})`);
	}
}
