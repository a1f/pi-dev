import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDashboardCards, columnsForWidth } from "./dashboard.ts";
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
