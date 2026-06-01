import assert from "node:assert/strict";
import { test } from "node:test";

import { compileRules, ruleCount } from "./rules.ts";

test("invalid bash regex is dropped with a warning; valid ones compile", () => {
	const result = compileRules(
		{
			bashToolPatterns: [
				{ pattern: "(", reason: "broken" },
				{ pattern: "\\brm\\b", reason: "rm" },
			],
		},
		null,
	);
	assert.equal(result.rules.bashToolPatterns.length, 1);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0] ?? "", /invalid bash pattern/);
});

test("mode defaults to continue unless explicitly abort", () => {
	assert.equal(compileRules({}, null).rules.mode, "continue");
	assert.equal(compileRules({ mode: "abort" }, null).rules.mode, "abort");
});

test("ask defaults to false and is preserved when set", () => {
	const { rules } = compileRules(
		{ bashToolPatterns: [{ pattern: "a", reason: "a" }, { pattern: "b", reason: "b", ask: true }] },
		null,
	);
	assert.equal(rules.bashToolPatterns[0]?.ask, false);
	assert.equal(rules.bashToolPatterns[1]?.ask, true);
});

test("ruleCount sums all buckets", () => {
	const { rules } = compileRules({ zeroAccessPaths: ["a", "b"], readOnlyPaths: ["c"] }, null);
	assert.equal(ruleCount(rules), 3);
});
