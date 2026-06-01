import assert from "node:assert/strict";
import { test } from "node:test";

import { buildJinaHeaders, buildJinaUrl, clampTokens, formatReadResult, validateReadUrl } from "./read.ts";

test("clampTokens defaults, rejects non-finite, enforces floor, truncates", () => {
	assert.equal(clampTokens(undefined), 10_000);
	assert.equal(clampTokens(Number.NaN), 10_000);
	assert.equal(clampTokens(Number.POSITIVE_INFINITY), 10_000);
	assert.equal(clampTokens(100), 500);
	assert.equal(clampTokens(1234.9), 1234);
});

test("validateReadUrl accepts/normalizes http(s) and rejects blank/scheme-less/non-http", () => {
	assert.equal(validateReadUrl("  https://example.com/p  "), "https://example.com/p");
	assert.equal(validateReadUrl("http://x.test"), "http://x.test");
	assert.throws(() => validateReadUrl(""), /valid absolute URL/);
	assert.throws(() => validateReadUrl("example.com/p"), /valid absolute URL/);
	assert.throws(() => validateReadUrl("ftp://x.test"), /http\(s\)/);
	assert.throws(() => validateReadUrl("javascript:alert(1)"), /http\(s\)/);
});

test("buildJinaUrl appends the raw target to the reader base", () => {
	assert.equal(buildJinaUrl("https://example.com/p"), "https://r.jina.ai/https://example.com/p");
});

test("buildJinaHeaders omits Authorization without a key, includes it with one", () => {
	const noKey = buildJinaHeaders(10_000);
	assert.equal(noKey["X-Return-Format"], "markdown");
	assert.equal(noKey["X-Max-Tokens"], "10000");
	assert.equal(noKey["Authorization"], undefined);
	assert.equal(buildJinaHeaders(500, "secret")["Authorization"], "Bearer secret");
});

test("formatReadResult returns content + metadata and throws when empty", () => {
	const r = formatReadResult(
		{ data: { content: "body", title: "T", url: "https://x.test", usage: { tokens: 10 } } },
		10_000,
		"https://fallback.test",
	);
	assert.equal(r.text, "# T\nhttps://x.test\n\nbody");
	assert.equal(r.url, "https://x.test");
	assert.equal(r.title, "T");
	assert.equal(r.tokens, 10);
	assert.throws(() => formatReadResult({ code: 422 }, 10_000, "https://fallback.test"), /no content/);
});

test("formatReadResult appends a trimmed note at budget and falls back to the request url", () => {
	const r = formatReadResult({ data: { content: "body", usage: { tokens: 500 } } }, 500, "https://fallback.test");
	assert.match(r.text, /\[trimmed to ~500 tokens/);
	assert.equal(r.url, "https://fallback.test");
	assert.equal(r.title, undefined);
});
