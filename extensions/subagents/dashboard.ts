// Layout math for the subagents dashboard footer.
//
// Decides how many fixed-width grid cards fit across a terminal of a given width, so the
// footer can pick a column count before handing cards to grid.ts's renderGrid. Pure and
// deterministic; the gutter is shared with the renderer so packing never drifts from layout.

import { CARD_GUTTER, cardFromRecord, DEFAULT_GRID_THEME, idleCard, renderGrid } from "./grid.ts";
import type { GridCard, GridTheme } from "./grid.ts";
import type { Persona } from "./personas.ts";
import type { RunRecord } from "./registry.ts";

/**
 * How many fixed-width cards fit in `width` columns, with a floor of one so a terminal
 * narrower than a single card still renders something. Each extra card costs cardWidth + the
 * inter-card gutter; the leading `+ CARD_GUTTER` accounts for the gutter the last card omits.
 */
export function columnsForWidth(width: number, theme: GridTheme = DEFAULT_GRID_THEME): number {
	const stride = theme.cardWidth + CARD_GUTTER;
	const columns = Math.floor((width + CARD_GUTTER) / stride);
	return columns < 1 ? 1 : columns;
}

/**
 * Build the footer's cards: one per persona (titled by persona name, showing its latest run or
 * an idle placeholder), followed by one card per persona-less run. Every known persona is shown
 * up front even when it has no run, so the dashboard reflects the roster, not just live activity.
 */
export function buildDashboardCards(opts: {
	records: readonly RunRecord[];
	personas: readonly Persona[];
	now: number;
}): GridCard[] {
	const { records, personas, now } = opts;
	const personaCards = personas.map((persona) => {
		const latest = records.findLast((record) => record.persona === persona.name);
		return latest === undefined ? idleCard(persona) : { ...cardFromRecord(latest, now), title: persona.name };
	});
	const looseCards = records.filter((record) => record.persona === null).map((record) => cardFromRecord(record, now));
	return [...personaCards, ...looseCards];
}

/**
 * Render the footer's cards into width-fitted rows of lines. Returns an empty array (not a blank
 * line) when there is nothing to show, so the caller can clear the widget instead of printing a
 * stray row; the theme defaults to DEFAULT_GRID_THEME consistently in the grid layer.
 */
export function renderDashboard(opts: {
	records: readonly RunRecord[];
	personas: readonly Persona[];
	now: number;
	width: number;
	theme?: GridTheme;
}): string[] {
	const { records, personas, now, width, theme } = opts;
	const cards = buildDashboardCards({ records, personas, now });
	if (cards.length === 0) return [];
	const columns = columnsForWidth(width, theme);
	return renderGrid({ cards, columns, theme }).split("\n");
}
