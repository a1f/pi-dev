import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDashboardCards, columnsForWidth, renderDashboard } from "./dashboard.ts";
import { cardFromRecord, DEFAULT_GRID_THEME, idleCard } from "./grid.ts";
import type { GridTheme } from "./grid.ts";
import type { Persona } from "./personas.ts";
import type { RunRecord } from "./registry.ts";

test("columnsForWidth fits the most fixed-width cards per row, with a floor of one", () => {
	// cardWidth 10 with the grid's 2-column gutter makes card+gutter = 12, so each extra
	// column needs another 12 columns of width. The expected points below pin that math,
	// including the floor of 1 when the terminal is narrower than a single card.
	const theme: GridTheme = { ...DEFAULT_GRID_THEME, cardWidth: 10 };

	assert.equal(columnsForWidth(9, theme), 1);
	assert.equal(columnsForWidth(10, theme), 1);
	assert.equal(columnsForWidth(21, theme), 1);
	assert.equal(columnsForWidth(22, theme), 2);
	assert.equal(columnsForWidth(34, theme), 3);
});

test("buildDashboardCards yields one titled card per persona, then a card per persona-less run", () => {
	// One representative mix: "scout" has two runs (only the LATEST may win), "critic" has no run
	// (idle), and one persona-less /agent run is appended after the persona cards.
	const scout: Persona = {
		name: "scout",
		description: "explores the codebase",
		tools: null,
		model: null,
		systemPrompt: "",
		source: null,
	};
	const critic: Persona = {
		name: "critic",
		description: "reviews the work",
		tools: null,
		model: null,
		systemPrompt: "",
		source: null,
	};

	const scoutEarlier: RunRecord = {
		runId: "scout-1",
		task: "explore the codebase",
		persona: "scout",
		status: "done",
		startedAt: 1_000,
		finishedAt: 4_000,
		state: { toolCount: 3, lastLine: "first pass", contextTokens: null, contextPct: null, done: true, malformed: 0 },
	};
	const scoutLatest: RunRecord = {
		runId: "scout-2",
		task: "explore once more",
		persona: "scout",
		status: "running",
		startedAt: 5_000,
		finishedAt: null,
		state: { toolCount: 7, lastLine: "second pass", contextTokens: null, contextPct: 42, done: false, malformed: 0 },
	};
	const personaLess: RunRecord = {
		runId: "loose-1",
		task: "summarize the readme",
		persona: null,
		status: "running",
		startedAt: 6_000,
		finishedAt: null,
		state: { toolCount: 1, lastLine: "reading", contextTokens: null, contextPct: null, done: false, malformed: 0 },
	};

	const now = 10_000;
	const cards = buildDashboardCards({
		records: [scoutEarlier, scoutLatest, personaLess],
		personas: [scout, critic],
		now,
	});

	// Persona cards first, in personas order, each titled by the persona name (not the task):
	// scout's LATEST run wins (running, 7 tools — not the earlier done run), critic is idle.
	// The persona-less run's own card, titled by its task, comes last.
	assert.deepEqual(cards, [
		{ ...cardFromRecord(scoutLatest, now), title: "scout" },
		idleCard(critic),
		cardFromRecord(personaLess, now),
	]);
});

test("buildDashboardCards keeps a card for a run whose persona is not in the roster", () => {
	// A run can be tagged with a persona the freshly-loaded roster no longer includes (its
	// .pi/agents/*.md was deleted or went malformed mid-run). That run matches no persona card
	// and is not persona-less, so it must still get its own card — a live run must never vanish.
	const scout: Persona = {
		name: "scout",
		description: "explores the codebase",
		tools: null,
		model: null,
		systemPrompt: "",
		source: null,
	};
	const ghostRun: RunRecord = {
		runId: "ghost-1",
		task: "do the thing",
		persona: "ghost",
		status: "running",
		startedAt: 1_000,
		finishedAt: null,
		state: { toolCount: 2, lastLine: "working", contextTokens: null, contextPct: 17, done: false, malformed: 0 },
	};

	const now = 5_000;
	const cards = buildDashboardCards({ records: [ghostRun], personas: [scout], now });

	// The ghost run gets its own card, titled by its task and carrying its live status...
	assert.ok(
		cards.some((card) => card.title === "do the thing" && card.status === "running"),
		`expected the ghost run's card to survive, got ${JSON.stringify(cards)}`,
	);
	// ...in addition to scout's idle card, so no run is dropped: scout idle + the ghost run.
	assert.equal(cards.length, 2, `expected scout's idle card plus the ghost run's card, got ${JSON.stringify(cards)}`);
});

test("renderDashboard packs cards into width-fitted rows and yields no lines when empty", () => {
	// A small ascii theme makes the column math predictable: cardWidth 10 + the 2-column gutter
	// is a 12-column stride, so a width of 24 fits two cards across and a width of 10 fits one.
	const theme: GridTheme = {
		glyph: { running: "R", done: "D", error: "E", killed: "K", idle: "I" },
		barFilled: "#",
		barEmpty: ".",
		barWidth: 3,
		cardWidth: 10,
	};
	const persona = (name: string): Persona => ({
		name,
		description: `${name} agent`,
		tools: null,
		model: null,
		systemPrompt: "",
		source: null,
	});
	const runningFor = (name: string): RunRecord => ({
		runId: `${name}-1`,
		task: `${name} task`,
		persona: name,
		status: "running",
		startedAt: 0,
		finishedAt: null,
		// lastLine stays null so the only place a persona name can appear is its card title line.
		state: { toolCount: 1, lastLine: null, contextTokens: null, contextPct: null, done: false, malformed: 0 },
	});

	const personas = [persona("alpha"), persona("bravo")];
	const records = [runningFor("alpha"), runningFor("bravo")];
	const now = 1_000;

	// Two columns: both persona cards share the first row, so both titles land on the first line.
	const wide = renderDashboard({ records, personas, now, width: 24, theme });
	assert.ok(Array.isArray(wide), "renderDashboard returns an array of lines");
	const firstLine = wide[0] ?? "";
	assert.ok(
		firstLine.includes("alpha") && firstLine.includes("bravo"),
		`expected both persona titles side by side on the first line, got ${JSON.stringify(wide)}`,
	);

	// One column: the same two cards stack, so no single line carries both titles.
	const narrow = renderDashboard({ records, personas, now, width: 10, theme });
	const sharedLine = narrow.find((line) => line.includes("alpha") && line.includes("bravo"));
	assert.equal(
		sharedLine,
		undefined,
		`expected the two persona titles stacked on separate lines, got ${JSON.stringify(narrow)}`,
	);

	// Nothing to show: an empty array (not [""]) so the caller can clear the widget.
	assert.deepEqual(renderDashboard({ records: [], personas: [], now: 0, width: 80 }), []);
});
