import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildBraveSearchUrl,
	clampCount,
	formatSearchResults,
	mapBraveResults,
	stripHighlightTags,
} from "./search.ts";

test("clampCount defaults, rejects non-finite, clamps and truncates", () => {
	assert.equal(clampCount(undefined), 5);
	assert.equal(clampCount(Number.NaN), 5);
	assert.equal(clampCount(Number.POSITIVE_INFINITY), 5);
	assert.equal(clampCount(0), 1);
	assert.equal(clampCount(50), 20);
	assert.equal(clampCount(7.9), 7);
});

test("buildBraveSearchUrl encodes query, sets count + text_decorations, omits absent freshness", () => {
	const url = new URL(buildBraveSearchUrl("hello world & co", 5));
	assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
	assert.equal(url.searchParams.get("q"), "hello world & co");
	assert.equal(url.searchParams.get("count"), "5");
	assert.equal(url.searchParams.get("text_decorations"), "0");
	assert.equal(url.searchParams.get("freshness"), null);
});

test("buildBraveSearchUrl includes freshness when provided", () => {
	const url = new URL(buildBraveSearchUrl("q", 3, "pw"));
	assert.equal(url.searchParams.get("freshness"), "pw");
});

test("stripHighlightTags removes strong open/close tags only", () => {
	assert.equal(stripHighlightTags("<strong>foo</strong> bar"), "foo bar");
});

test("mapBraveResults tolerates missing web/results and strips tags", () => {
	assert.deepEqual(mapBraveResults(null), []);
	assert.deepEqual(mapBraveResults({}), []);
	assert.deepEqual(mapBraveResults({ web: { results: "nope" } }), []);
	const mapped = mapBraveResults({
		web: {
			results: [
				{ title: "<strong>T</strong>", url: "https://x.test", description: "<strong>d</strong>" },
				42,
			],
		},
	});
	assert.deepEqual(mapped, [{ title: "T", url: "https://x.test", description: "d" }]);
});

test("formatSearchResults numbers entries and handles empty", () => {
	assert.equal(formatSearchResults([]), "No results.");
	const out = formatSearchResults([
		{ title: "A", url: "https://a.test", description: "da" },
		{ title: "B", url: "https://b.test", description: "db" },
	]);
	assert.match(out, /^1\. A\n {3}https:\/\/a\.test\n {3}da\n\n2\. B/);
});
