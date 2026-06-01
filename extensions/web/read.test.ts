import assert from "node:assert/strict";
import { test } from "node:test";

import { buildExtractBody, clampChars, formatReadResult, validateReadUrl } from "./read.ts";

test("clampChars defaults, rejects non-finite, enforces floor, truncates", () => {
	assert.equal(clampChars(undefined), 40_000);
	assert.equal(clampChars(Number.NaN), 40_000);
	assert.equal(clampChars(Number.POSITIVE_INFINITY), 40_000);
	assert.equal(clampChars(100), 1_000);
	assert.equal(clampChars(5_000.9), 5_000);
});

test("validateReadUrl accepts/normalizes http(s) and rejects blank/scheme-less/non-http", () => {
	assert.equal(validateReadUrl("  https://example.com/p  "), "https://example.com/p");
	assert.equal(validateReadUrl("http://x.test"), "http://x.test");
	assert.throws(() => validateReadUrl(""), /valid absolute URL/);
	assert.throws(() => validateReadUrl("example.com/p"), /valid absolute URL/);
	assert.throws(() => validateReadUrl("ftp://x.test"), /http\(s\)/);
	assert.throws(() => validateReadUrl("javascript:alert(1)"), /http\(s\)/);
});

test("buildExtractBody requests markdown at basic depth for the url", () => {
	assert.deepEqual(buildExtractBody("https://x.test"), {
		urls: ["https://x.test"],
		format: "markdown",
		extract_depth: "basic",
	});
});

test("formatReadResult returns content + metadata, throws with the failure reason", () => {
	const r = formatReadResult(
		{ results: [{ url: "https://x.test", title: "T", raw_content: "body" }], failed_results: [] },
		40_000,
		"https://fallback.test",
	);
	assert.equal(r.text, "# T\nhttps://x.test\n\nbody");
	assert.equal(r.url, "https://x.test");
	assert.equal(r.title, "T");
	assert.equal(r.chars, 4);
	assert.throws(
		() => formatReadResult({ results: [], failed_results: [{ url: "u", error: "blocked" }] }, 40_000, "u"),
		/could not extract content.*blocked/,
	);
});

test("formatReadResult truncates to max_chars with a note and falls back to the request url", () => {
	const r = formatReadResult({ results: [{ raw_content: "abcdefghij" }] }, 4, "https://fallback.test");
	assert.match(r.text, /^abcd\n\n\[truncated to 4 chars/);
	assert.equal(r.url, "https://fallback.test");
	assert.equal(r.title, undefined);
	assert.equal(r.chars, 4);
});
