import assert from "node:assert/strict";
import { test } from "node:test";

import { STATUS_GLYPH, elapsedMs, formatElapsed } from "./format.ts";
import type { RunStatus } from "./registry.ts";

test("formats shared run status glyphs and elapsed time", () => {
	const expectedGlyphs: Record<RunStatus, string> = {
		running: "▶",
		queued: "▷",
		done: "✓",
		error: "✗",
		killed: "⊘",
	};

	assert.deepEqual(STATUS_GLYPH, expectedGlyphs);
	assert.equal(elapsedMs({ startedAt: 1000, finishedAt: null }, 4567), 3567);
	assert.equal(elapsedMs({ startedAt: 1000, finishedAt: 2500 }, 9999), 1500);
	assert.equal(formatElapsed(3567), "3s");
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(null), "—");
});
