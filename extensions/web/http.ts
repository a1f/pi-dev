// Generic JSON fetch shared by web_search and web_read: combines the caller's
// signal with a timeout, enforces res.ok, and parses the body. Error messages
// carry only the host and provider response — never request headers/keys.

import { ERROR_BODY_SNIPPET_CHARS } from "./constants.ts";

export async function fetchJson(
	url: string,
	opts: { headers: Record<string, string>; signal: AbortSignal | undefined; timeoutMs: number },
): Promise<unknown> {
	const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs)].filter(
		(s): s is AbortSignal => Boolean(s),
	);
	const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.any(signals) });
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
