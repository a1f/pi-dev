import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { sessionPathFor } from "./session.ts";

test("sessionPathFor maps a safe persona name to its sessions-dir path and rejects unsafe names", () => {
	// A normal name lands in <cwd>/.pi/sessions/<name>.jsonl, so each persona keeps its own session.
	assert.equal(sessionPathFor("/work", "scout"), join("/work", ".pi", "sessions", "scout.jsonl"));

	// A hostile name must never traverse out of the sessions dir: a path separator or `..` yields null.
	assert.equal(sessionPathFor("/work", "../evil"), null);
	assert.equal(sessionPathFor("/work", "a/b"), null);
});
