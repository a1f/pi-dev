import assert from "node:assert/strict";
import { test } from "node:test";

import type { Violation } from "./evaluate.ts";
import { abortReason, continueReason } from "./feedback.ts";

const violation: Violation = { category: "zeroAccess", reason: "access to protected path denied: .env", ask: false };

test("abortReason names the tool + reason + invocation and says not to work around", () => {
	const text = abortReason("read", violation, "read: .env");
	assert.match(text, /read/);
	assert.match(text, /\.env/);
	assert.match(text, /work around/i);
});

test("continueReason offers destructive vs non-destructive guidance", () => {
	const text = continueReason("bash", violation, "cat .env");
	assert.match(text, /cat \.env/);
	assert.match(text, /NON-DESTRUCTIVE/);
	assert.match(text, /DESTRUCTIVE/);
});

test("the two modes produce different text", () => {
	assert.notEqual(abortReason("read", violation, "x"), continueReason("read", violation, "x"));
});
