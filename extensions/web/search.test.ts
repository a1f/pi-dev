import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSearchBody, clampCount, formatSearchResults, mapTavilyResults } from "./search.ts";

test("clampCount defaults, rejects non-finite, clamps and truncates", () => {
	assert.equal(clampCount(undefined), 5);
	assert.equal(clampCount(Number.NaN), 5);
	assert.equal(clampCount(Number.POSITIVE_INFINITY), 5);
	assert.equal(clampCount(0), 1);
	assert.equal(clampCount(50), 20);
	assert.equal(clampCount(7.9), 7);
});

test("buildSearchBody sets query, max_results, and cheap defaults", () => {
	assert.deepEqual(buildSearchBody("nodejs lts", 3), {
		query: "nodejs lts",
		max_results: 3,
		search_depth: "basic",
		include_raw_content: false,
	});
});

test("mapTavilyResults tolerates missing/non-array results and maps content->description", () => {
	assert.deepEqual(mapTavilyResults(null), []);
	assert.deepEqual(mapTavilyResults({}), []);
	assert.deepEqual(mapTavilyResults({ results: "nope" }), []);
	const mapped = mapTavilyResults({
		results: [
			{ title: "T", url: "https://x.test", content: "snippet", score: 0.9, raw_content: null },
			42,
		],
	});
	assert.deepEqual(mapped, [{ title: "T", url: "https://x.test", description: "snippet" }]);
});

test("formatSearchResults numbers entries and handles empty", () => {
	assert.equal(formatSearchResults([]), "No results.");
	const out = formatSearchResults([
		{ title: "A", url: "https://a.test", description: "da" },
		{ title: "B", url: "https://b.test", description: "db" },
	]);
	assert.match(out, /^1\. A\n {3}https:\/\/a\.test\n {3}da\n\n2\. B/);
});
