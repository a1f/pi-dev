import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_GRID_THEME, cardFromRecord, idleCard, renderGrid } from "./grid.ts";
import type { GridCard, GridTheme } from "./grid.ts";
import type { Persona } from "./personas.ts";
import type { RunRecord } from "./registry.ts";
import type { RunState } from "./runstate.ts";

test("cardFromRecord maps a running record, deriving elapsed from now", () => {
	const state: RunState = {
		toolCount: 3,
		lastLine: "reading files",
		contextTokens: 1000,
		contextPct: 42,
		done: false,
		malformed: 0,
	};
	const record: RunRecord = {
		runId: "r1",
		task: "scout the repo",
		persona: null,
		status: "running",
		startedAt: 1000,
		finishedAt: null,
		state,
	};

	assert.deepEqual(cardFromRecord(record, 4000), {
		title: "scout the repo",
		status: "running",
		elapsedMs: 3000,
		toolCount: 3,
		contextPct: 42,
		lastLine: "reading files",
	});
});

test("cardFromRecord measures a finished record's elapsed against finishedAt, not now", () => {
	const state: RunState = {
		toolCount: 5,
		lastLine: "done",
		contextTokens: 2000,
		contextPct: 10,
		done: true,
		malformed: 0,
	};
	const record: RunRecord = {
		runId: "r2",
		task: "build the thing",
		persona: null,
		status: "done",
		startedAt: 1000,
		finishedAt: 6000,
		state,
	};

	assert.equal(cardFromRecord(record, 99999).elapsedMs, 5000);
});

test("idleCard maps a persona to an idle card with no run metrics", () => {
	const persona: Persona = {
		name: "critic",
		description: "reviews a diff",
		tools: null,
		model: null,
		systemPrompt: "you review code",
		source: null,
	};

	assert.deepEqual(idleCard(persona), {
		title: "critic",
		status: "idle",
		elapsedMs: null,
		toolCount: 0,
		contextPct: null,
		lastLine: null,
	});
});

test("renderGrid of no cards is the empty string", () => {
	assert.equal(renderGrid({ cards: [], columns: 2 }), "");
});

test("renderGrid fills the context bar proportionally and empties it when unknown", () => {
	const half: GridCard = {
		title: "scout",
		status: "running",
		elapsedMs: 1000,
		toolCount: 1,
		contextPct: 50,
		lastLine: "x",
	};
	// 50% over the default bar width of 10 → 5 filled + 5 empty.
	assert.ok(renderGrid({ cards: [half], columns: 1, theme: DEFAULT_GRID_THEME }).includes("█████░░░░░"));

	const unknown: GridCard = { ...half, contextPct: null };
	// Unknown context → a placeholder bar of all-empty cells.
	assert.ok(renderGrid({ cards: [unknown], columns: 1, theme: DEFAULT_GRID_THEME }).includes("░░░░░░░░░░"));
});

// A compact ASCII theme keeps the layout goldens readable and exactly computable.
const snapshotTheme: GridTheme = {
	glyph: { running: "R", done: "D", error: "E", killed: "K", idle: "I" },
	barFilled: "#",
	barEmpty: ".",
	barWidth: 4,
	cardWidth: 20,
};

// A representative mix: a running, a done, an error, and an idle card.
const snapshotCards: readonly GridCard[] = [
	{ title: "scout", status: "running", elapsedMs: 3000, toolCount: 2, contextPct: 50, lastLine: "reading files" },
	{ title: "build", status: "done", elapsedMs: 1000, toolCount: 5, contextPct: 25, lastLine: "done" },
	{ title: "deploy", status: "error", elapsedMs: 2000, toolCount: 1, contextPct: null, lastLine: "boom" },
	{ title: "critic", status: "idle", elapsedMs: null, toolCount: 0, contextPct: null, lastLine: null },
];

test("renderGrid stacks every card in a single column", () => {
	const expected =
		"R scout\n" +
		"3s · 2 tools · ##..\n" +
		"reading files\n" +
		"D build\n" +
		"1s · 5 tools · #...\n" +
		"done\n" +
		"E deploy\n" +
		"2s · 1 tools · ....\n" +
		"boom\n" +
		"I critic\n" +
		"— · 0 tools · ....\n";
	assert.equal(renderGrid({ cards: snapshotCards, columns: 1, theme: snapshotTheme }), expected);
});

test("renderGrid lays cards into two columns, padding the partial last row", () => {
	const expected =
		`R scout${" ".repeat(15)}D build\n` +
		`3s · 2 tools · ##..${" ".repeat(3)}1s · 5 tools · #...\n` +
		`reading files${" ".repeat(9)}done\n` +
		`E deploy${" ".repeat(14)}I critic\n` +
		`2s · 1 tools · ....${" ".repeat(3)}— · 0 tools · ....\n` +
		"boom";
	assert.equal(renderGrid({ cards: snapshotCards, columns: 2, theme: snapshotTheme }), expected);
});

test("renderGrid lays cards into three columns, leaving a one-card last row", () => {
	const expected =
		`R scout${" ".repeat(15)}D build${" ".repeat(15)}E deploy\n` +
		`3s · 2 tools · ##..${" ".repeat(3)}1s · 5 tools · #...${" ".repeat(3)}2s · 1 tools · ....\n` +
		`reading files${" ".repeat(9)}done${" ".repeat(18)}boom\n` +
		"I critic\n" +
		"— · 0 tools · ....\n";
	assert.equal(renderGrid({ cards: snapshotCards, columns: 3, theme: snapshotTheme }), expected);
});

test("renderGrid truncates a title and last line that overflow cardWidth with an ellipsis", () => {
	const narrow: GridTheme = {
		glyph: { running: "R", done: "D", error: "E", killed: "K", idle: "I" },
		barFilled: "#",
		barEmpty: ".",
		barWidth: 3,
		cardWidth: 10,
	};
	const card: GridCard = {
		title: "scout-the-whole-repo",
		status: "running",
		elapsedMs: 5000,
		toolCount: 2,
		contextPct: 100,
		lastLine: "this is a long output line",
	};

	const out = renderGrid({ cards: [card], columns: 1, theme: narrow });
	assert.ok(out.includes("R scout-t…"));
	assert.ok(out.includes("this is a…"));
	assert.ok(!out.includes("scout-the-whole-repo"));
	assert.ok(!out.includes("long output line"));
});

test("renderGrid strips control characters from untrusted title and last line", () => {
	const card: GridCard = {
		title: "task\x1b[31m\twith\rcontrols",
		status: "running",
		elapsedMs: 1000,
		toolCount: 1,
		contextPct: 50,
		lastLine: "out\x1b[0m\tline\rhere",
	};

	const out = renderGrid({ cards: [card], columns: 1, theme: snapshotTheme });
	for (const line of out.split("\n")) {
		// No C0/C1 control character or DEL survives into a rendered line.
		assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line), `control char in ${JSON.stringify(line)}`);
		// Stripping happens before padding, so the fixed-width layout is intact.
		assert.ok(Array.from(line).length <= snapshotTheme.cardWidth);
	}
});

test("renderGrid truncates on a whole code point, never splitting an astral character", () => {
	// cardWidth 10 puts the truncation boundary mid-emoji ("R scoutX" + 🚀), which a
	// UTF-16 slice would cut into a lone surrogate.
	const narrow: GridTheme = { ...snapshotTheme, cardWidth: 10 };
	const card: GridCard = {
		title: "scoutX🚀tail-goes-on",
		status: "running",
		elapsedMs: 1000,
		toolCount: 1,
		contextPct: 0,
		lastLine: null,
	};

	const out = renderGrid({ cards: [card], columns: 1, theme: narrow });
	const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	assert.ok(!loneSurrogate.test(out), `lone surrogate in ${JSON.stringify(out)}`);
	assert.ok(out.split("\n")[0]?.endsWith("…"));
});

test("renderGrid renders a full-width context bar for a non-finite or over-range context", () => {
	const base: GridCard = {
		title: "x",
		status: "running",
		elapsedMs: 0,
		toolCount: 0,
		contextPct: Number.NaN,
		lastLine: null,
	};

	// NaN context must not collapse the bar to zero cells — it stays full width, all empty.
	assert.ok(renderGrid({ cards: [base], columns: 1 }).includes("░░░░░░░░░░"));
	// Over-range context clamps to a fully filled bar.
	assert.ok(renderGrid({ cards: [{ ...base, contextPct: 150 }], columns: 1 }).includes("██████████"));
});

test("renderGrid clamps a non-positive column count to a single column", () => {
	// columns < 1 must clamp to one column (not loop forever); the layout matches columns: 1.
	const single = renderGrid({ cards: snapshotCards, columns: 1, theme: snapshotTheme });
	assert.equal(renderGrid({ cards: snapshotCards, columns: 0, theme: snapshotTheme }), single);
	assert.equal(renderGrid({ cards: snapshotCards, columns: -3, theme: snapshotTheme }), single);
});
