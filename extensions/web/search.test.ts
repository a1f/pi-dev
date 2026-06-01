import assert from "node:assert/strict";
import { test } from "node:test";

import { buildJinaSearchUrl, buildSearchHeaders, clampCount, formatSearchResults, mapJinaResults } from "./search.ts";

test("clampCount defaults, rejects non-finite, clamps and truncates", () => {
	assert.equal(clampCount(undefined), 5);
	assert.equal(clampCount(Number.NaN), 5);
	assert.equal(clampCount(Number.POSITIVE_INFINITY), 5);
	assert.equal(clampCount(0), 1);
	assert.equal(clampCount(50), 20);
	assert.equal(clampCount(7.9), 7);
});

test("buildJinaSearchUrl encodes the query as the q parameter", () => {
	const url = new URL(buildJinaSearchUrl("hello world & co"));
	assert.equal(url.origin + url.pathname, "https://s.jina.ai/");
	assert.equal(url.searchParams.get("q"), "hello world & co");
});

test("buildSearchHeaders requests results-only JSON, omits Authorization without a key", () => {
	const noKey = buildSearchHeaders();
	assert.equal(noKey["Accept"], "application/json");
	assert.equal(noKey["X-Respond-With"], "no-content");
	assert.equal(noKey["Authorization"], undefined);
	assert.equal(buildSearchHeaders("secret")["Authorization"], "Bearer secret");
});

test("mapJinaResults tolerates missing/non-array data and maps the fields", () => {
	assert.deepEqual(mapJinaResults(null), []);
	assert.deepEqual(mapJinaResults({}), []);
	assert.deepEqual(mapJinaResults({ data: "nope" }), []);
	const mapped = mapJinaResults({
		data: [
			{ title: "T", url: "https://x.test", description: "d" },
			{ title: "C", url: "https://y.test", content: "from-content" },
			42,
		],
	});
	assert.deepEqual(mapped, [
		{ title: "T", url: "https://x.test", description: "d" },
		{ title: "C", url: "https://y.test", description: "from-content" },
	]);
});

test("formatSearchResults numbers entries and handles empty", () => {
	assert.equal(formatSearchResults([]), "No results.");
	const out = formatSearchResults([
		{ title: "A", url: "https://a.test", description: "da" },
		{ title: "B", url: "https://b.test", description: "db" },
	]);
	assert.match(out, /^1\. A\n {3}https:\/\/a\.test\n {3}da\n\n2\. B/);
});
