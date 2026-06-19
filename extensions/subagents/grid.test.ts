import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_GRID_THEME, cardFromRecord, idleCard, renderGrid } from "./grid.ts";
import type { GridCard, GridTheme } from "./grid.ts";
import type { Persona } from "./personas.ts";
import type { RunRecord } from "./registry.ts";
import type { RunState } from "./runstate.ts";

// These goldens pin the variant-A card layout (issue #26). Each card is four lines, every line
// prefixed by a status stripe + space (2 reserved columns, so total visible width stays cardWidth):
//   1. header : `${glyph} ${title} · ${status}` with elapsed right-aligned in the field
//   2. metrics: one indent space, then `${tokens}  [${bar}] ${pct}`
//   3-4. feed : running/queued show the last ≤2 activity actions (older above newer) as
//               `▸ ${tool}  ${target}`; terminal cards show `${glyph} ${lastLine}` then blank;
//               idle shows two blank lines. (malformed is carried on the card but not drawn.)
// The compact ASCII themes below make every line an exactly-computable pure function of the card.

test("cardFromRecord maps a running record to the variant-A card shape carrying contextTokens, contextPct, and activity", () => {
	const state: RunState = {
		toolCount: 3,
		lastLine: "reading files",
		contextTokens: 12345,
		contextPct: 42,
		done: false,
		malformed: 0,
		activity: [
			{ tool: "Read", target: "a.ts" },
			{ tool: "Bash", target: "npm test" },
		],
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
		contextTokens: 12345,
		contextPct: 42,
		activity: [
			{ tool: "Read", target: "a.ts" },
			{ tool: "Bash", target: "npm test" },
		],
		lastLine: "reading files",
		malformed: 0,
	});
});

test("cardFromRecord measures a finished record's elapsed against finishedAt and carries its final line", () => {
	const state: RunState = {
		toolCount: 5,
		lastLine: "0 blockers",
		contextTokens: 2000,
		contextPct: 10,
		done: true,
		malformed: 0,
		activity: [{ tool: "Edit", target: "fmt.ts" }],
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

	// elapsed comes from finishedAt (6000 − 1000), not the passed-in now.
	assert.deepEqual(cardFromRecord(record, 99999), {
		title: "build the thing",
		status: "done",
		elapsedMs: 5000,
		contextTokens: 2000,
		contextPct: 10,
		activity: [{ tool: "Edit", target: "fmt.ts" }],
		lastLine: "0 blockers",
		malformed: 0,
	});
});

test("idleCard maps a persona to the variant-A idle card shape", () => {
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
		contextTokens: null,
		contextPct: null,
		activity: [],
		lastLine: null,
		malformed: 0,
	});
});

test("renderGrid of no cards is the empty string", () => {
	assert.equal(renderGrid({ cards: [], columns: 2 }), "");
});

// Distinct per-status stripes/glyphs make a snapshot prove the renderer indexes the theme by status.
const snapshotTheme: GridTheme = {
	stripe: { running: ">", queued: "?", done: "+", error: "!", killed: "x", idle: "_" },
	glyph: { running: "R", queued: "Q", done: "D", error: "E", killed: "K", idle: "I" },
	barFilled: "#",
	barEmpty: "-",
	barWidth: 4,
	cardWidth: 28,
};

// A representative mix exercising every feed path and token magnitude: a running card with >2
// activity actions (only the last two show), a queued card with a single action (the second feed
// line blanks), a done and an error card showing their final lines (the error's malformed:2 is NOT
// drawn), and an idle card with blank feed lines.
const snapshotCards: readonly GridCard[] = [
	{ title: "scout", status: "running", elapsedMs: 3000, contextTokens: 12345, contextPct: 53, activity: [{ tool: "Read", target: "a.ts" }, { tool: "Bash", target: "npm test" }, { tool: "Edit", target: "fmt.ts" }], lastLine: "ignored while running", malformed: 0 },
	{ title: "lint", status: "queued", elapsedMs: 1000, contextTokens: 800, contextPct: 12, activity: [{ tool: "Grep", target: "TODO" }], lastLine: null, malformed: 0 },
	{ title: "build", status: "done", elapsedMs: 9000, contextTokens: 950, contextPct: 7, activity: [], lastLine: "0 blockers", malformed: 0 },
	{ title: "deploy", status: "error", elapsedMs: 2000, contextTokens: 2_500_000, contextPct: 100, activity: [], lastLine: "boom", malformed: 2 },
	{ title: "critic", status: "idle", elapsedMs: null, contextTokens: null, contextPct: null, activity: [], lastLine: null, malformed: 0 },
];

test("renderGrid stacks each card's four variant-A lines in a single column", () => {
	const expected = [
		"> R scout · running       3s",
		">  12.3k  [##--] 53%",
		">  ▸ Bash  npm test",
		">  ▸ Edit  fmt.ts",
		"? Q lint · queued         1s",
		"?  800  [----] 12%",
		"?  ▸ Grep  TODO",
		"?",
		"+ D build · done          9s",
		"+  950  [----] 7%",
		"+  D 0 blockers",
		"+",
		"! E deploy · error        2s",
		"!  2.5M  [####] 100%",
		"!  E boom",
		"!",
		"_ I critic · idle          —",
		"_  —  [----] —",
		"_",
		"_",
	].join("\n");
	assert.equal(renderGrid({ cards: snapshotCards, columns: 1, theme: snapshotTheme }), expected);
});

// A compact 20-wide theme and three short cards keep the multi-column packing goldens legible.
const packTheme: GridTheme = { ...snapshotTheme, cardWidth: 20 };
const packCards: readonly GridCard[] = [
	{ title: "a", status: "running", elapsedMs: 1000, contextTokens: 100, contextPct: 50, activity: [{ tool: "Bash", target: "go" }], lastLine: null, malformed: 0 },
	{ title: "b", status: "done", elapsedMs: 2000, contextTokens: 200, contextPct: 25, activity: [], lastLine: "ok", malformed: 0 },
	{ title: "c", status: "idle", elapsedMs: null, contextTokens: null, contextPct: null, activity: [], lastLine: null, malformed: 0 },
];

test("renderGrid zips cards into two columns, padding the partial last row", () => {
	const expected = [
		"> R a · running   1s  + D b · done      2s",
		">  100  [##--] 50%    +  200  [#---] 25%",
		">  ▸ Bash  go         +  D ok",
		">                     +",
		"_ I c · idle       —",
		"_  —  [----] —",
		"_",
		"_",
	].join("\n");
	assert.equal(renderGrid({ cards: packCards, columns: 2, theme: packTheme }), expected);
});

test("renderGrid zips cards into three columns, leaving a one-card last row", () => {
	const expected = [
		"> R a · running   1s  + D b · done      2s  _ I c · idle       —",
		">  100  [##--] 50%    +  200  [#---] 25%    _  —  [----] —",
		">  ▸ Bash  go         +  D ok               _",
		">                     +                     _",
	].join("\n");
	assert.equal(renderGrid({ cards: packCards, columns: 3, theme: packTheme }), expected);
});

test("renderGrid truncates an overflowing title, activity target, and final line with an ellipsis", () => {
	const narrow: GridTheme = { ...snapshotTheme, barWidth: 3, cardWidth: 14 };
	const cards: readonly GridCard[] = [
		{ title: "scout-the-whole-repo", status: "running", elapsedMs: 5000, contextTokens: 100, contextPct: 100, activity: [{ tool: "Bash", target: "npm run typecheck && npm test" }], lastLine: null, malformed: 0 },
		{ title: "build", status: "done", elapsedMs: 1000, contextTokens: 100, contextPct: 50, activity: [], lastLine: "this is a long output line", malformed: 0 },
	];

	const out = renderGrid({ cards, columns: 1, theme: narrow });
	// Header title, activity target, and terminal final line each truncate on overflow with a "…",
	// and none of the overflowing tails survive into the rendered footer.
	assert.ok(out.includes("R scout-t…"), out);
	assert.ok(!out.includes("scout-the-whole-repo"), out);
	assert.ok(out.includes("▸ Bash  np…"), out);
	assert.ok(!out.includes("typecheck"), out);
	assert.ok(out.includes("D this is …"), out);
	assert.ok(!out.includes("output line"), out);
});

test("renderGrid strips control characters from untrusted title, final line, and activity target", () => {
	const cards: readonly GridCard[] = [
		{ title: "task\x1b[31m\twith\rctl\x00", status: "running", elapsedMs: 1000, contextTokens: 100, contextPct: 50, activity: [{ tool: "Bash\x07", target: "out\x1b[0m\ttgt\rhere\x7f" }], lastLine: null, malformed: 0 },
		{ title: "x", status: "done", elapsedMs: 1000, contextTokens: 100, contextPct: 50, activity: [], lastLine: "fin\x1b[0m\tline\rhere\x85", malformed: 0 },
	];

	const out = renderGrid({ cards, columns: 1, theme: snapshotTheme });
	for (const line of out.split("\n")) {
		// No C0/C1 control character or DEL survives into a rendered line (escape-injection sink).
		assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line), `control char in ${JSON.stringify(line)}`);
		// Stripping happens before fitting, so the fixed-width layout stays within cardWidth.
		assert.ok(Array.from(line).length <= snapshotTheme.cardWidth, `over width: ${JSON.stringify(line)}`);
	}
});

test("renderGrid truncates the header on a whole code point, never splitting an astral character", () => {
	// cardWidth 10 puts the header truncation boundary right after the rocket ("R ab" + 🚀), where a
	// UTF-16 slice would cut between the surrogate halves and leave a lone surrogate.
	const narrow: GridTheme = { ...snapshotTheme, cardWidth: 10 };
	const card: GridCard = {
		title: "ab🚀cdef",
		status: "running",
		elapsedMs: 1000,
		contextTokens: 100,
		contextPct: 0,
		activity: [],
		lastLine: null,
		malformed: 0,
	};

	const out = renderGrid({ cards: [card], columns: 1, theme: narrow });
	const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	assert.ok(!loneSurrogate.test(out), `lone surrogate in ${JSON.stringify(out)}`);
	assert.equal(out.split("\n")[0], "> R ab🚀…1s");
});

test("renderGrid draws the default monochrome stripe and a bar that clamps unknown, non-finite, and over-range context", () => {
	const base: GridCard = {
		title: "scout",
		status: "running",
		elapsedMs: 1000,
		contextTokens: 1000,
		contextPct: 50,
		activity: [],
		lastLine: null,
		malformed: 0,
	};
	const render = (contextPct: number | null): string => renderGrid({ cards: [{ ...base, contextPct }], columns: 1, theme: DEFAULT_GRID_THEME });

	// Every default line wears the monochrome "▌" stripe in its two reserved columns.
	assert.ok((render(50).split("\n")[0] ?? "").startsWith("▌ "), render(50));
	// 50% of the default 10-cell bar → five filled, five empty.
	assert.ok(render(50).includes("█████░░░░░"), render(50));
	// Unknown and non-finite context collapse to an all-empty bar, never a zero-width one.
	assert.ok(render(null).includes("░░░░░░░░░░"), render(null));
	assert.ok(render(Number.NaN).includes("░░░░░░░░░░"), render(Number.NaN));
	// Over-range context clamps to a fully filled bar.
	assert.ok(render(150).includes("██████████"), render(150));
});

test("renderGrid clamps a non-positive column count to a single column", () => {
	// columns < 1 must clamp to one column (not loop forever); the layout matches columns: 1.
	const single = renderGrid({ cards: packCards, columns: 1, theme: packTheme });
	assert.equal(renderGrid({ cards: packCards, columns: 0, theme: packTheme }), single);
	assert.equal(renderGrid({ cards: packCards, columns: -3, theme: packTheme }), single);
});
