// Pure renderer for the subagents TUI footer.
//
// Turns this session's runs (and idle personas) into a grid of fixed-width cards.
// Pure and deterministic: the look-and-feel (glyphs, bar characters, widths) is an
// injected theme and the clock is passed in, so the layout is fully snapshot-stable.
// No pi runtime, no I/O — slice 4.2 wires the output into a live footer.

import type { Persona } from "./personas.ts";
import type { RunRecord, RunStatus } from "./registry.ts";

/** A card's status: a run's lifecycle, plus "idle" for a persona with no active run. */
export type CardStatus = RunStatus | "idle";

/** The minimal, render-ready view of one card — derived once, then laid out. */
export interface GridCard {
	title: string;
	status: CardStatus;
	elapsedMs: number | null;
	toolCount: number;
	contextPct: number | null;
	lastLine: string | null;
}

/** A run record → card. `now` is injected so elapsed is deterministic. */
export function cardFromRecord(record: RunRecord, now: number): GridCard {
	const { state } = record;
	return {
		title: record.task,
		status: record.status,
		elapsedMs: (record.finishedAt ?? now) - record.startedAt,
		toolCount: state.toolCount,
		contextPct: state.contextPct,
		lastLine: state.lastLine,
	};
}

/** Injected look-and-feel — keeps renderGrid pure and snapshot-stable. */
export interface GridTheme {
	glyph: Record<CardStatus, string>;
	barFilled: string;
	barEmpty: string;
	barWidth: number;
	cardWidth: number;
}

/** Defaults consistent with registry.ts row glyphs (▶ ✓ ✗ ⊘); idle gets its own marker. */
export const DEFAULT_GRID_THEME: GridTheme = {
	glyph: { running: "▶", done: "✓", error: "✗", killed: "⊘", idle: "○" },
	barFilled: "█",
	barEmpty: "░",
	barWidth: 10,
	cardWidth: 28,
};

/** A persona with no active run → an idle card (started nothing, did nothing). */
export function idleCard(persona: Persona): GridCard {
	return {
		title: persona.name,
		status: "idle",
		elapsedMs: null,
		toolCount: 0,
		contextPct: null,
		lastLine: null,
	};
}

/** Elapsed as whole seconds (matching registry.ts), or an em dash when never started. */
function elapsedText(card: GridCard): string {
	return card.elapsedMs === null ? "—" : `${Math.floor(card.elapsedMs / 1000)}s`;
}

/** A bar of `barWidth` cells, filled in proportion to context usage; all-empty when unknown. */
function contextBar(card: GridCard, theme: GridTheme): string {
	const raw = card.contextPct === null ? 0 : card.contextPct / 100;
	// A non-finite percentage (NaN/Infinity, admitted by the public number type) would propagate
	// through Math.round and collapse the bar to zero cells; treat it as 0 so width stays exact.
	const ratio = Number.isFinite(raw) ? raw : 0;
	const exact = Math.round(ratio * theme.barWidth);
	const filled = exact < 0 ? 0 : exact > theme.barWidth ? theme.barWidth : exact;
	return theme.barFilled.repeat(filled) + theme.barEmpty.repeat(theme.barWidth - filled);
}

/**
 * Strip C0/C1 control characters and DEL from untrusted text (task titles, child output).
 * They are a terminal-escape-injection sink and CR/TAB silently corrupt the fixed-width layout,
 * so they must not reach the footer string slice 4.2 prints.
 */
function sanitize(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Pad `content` to exactly `width`, or replace its tail with an ellipsis when it overflows. */
function fit(content: string, width: number): string {
	// Truncate on whole code points (not UTF-16 units) so a surrogate pair is never split into a
	// lone surrogate. Display-width awareness (wide CJK counted as 2) is a deliberate future enhancement.
	const chars = Array.from(content);
	if (chars.length > width) return `${chars.slice(0, width - 1).join("")}…`;
	return content.padEnd(width, " ");
}

/** Lines every card occupies — the cards in a row are zipped this many lines deep. */
const CARD_HEIGHT = 3;

/** Blank columns between adjacent cards in a row. Exported so layout math (columnsForWidth) packs cards with the exact gutter the renderer draws. */
export const CARD_GUTTER = 2;
const GUTTER = " ".repeat(CARD_GUTTER);

/** The fixed lines of one card: title, metrics + bar, last output line. */
function cardLines(card: GridCard, theme: GridTheme): readonly string[] {
	const { cardWidth } = theme;
	// title and lastLine are untrusted (task text, child output): sanitize before measuring/padding.
	const title = sanitize(card.title);
	const lastLine = sanitize(card.lastLine ?? "");
	return [
		fit(`${theme.glyph[card.status]} ${title}`, cardWidth),
		fit(`${elapsedText(card)} · ${card.toolCount} tools · ${contextBar(card, theme)}`, cardWidth),
		fit(lastLine, cardWidth),
	];
}

/** Render one row of cards side by side: zip their lines, gutter-join, trim each line's tail. */
function renderRow(row: readonly GridCard[], theme: GridTheme): string {
	const blocks = row.map((card) => cardLines(card, theme));
	const lines: string[] = [];
	for (let line = 0; line < CARD_HEIGHT; line++) {
		lines.push(blocks.map((block) => block[line] ?? "").join(GUTTER).trimEnd());
	}
	return lines.join("\n");
}

/**
 * Lay out the cards into `columns` columns, returning the full multi-line grid string.
 * No cards yields an empty string; `columns` is clamped to at least one.
 * An options object keeps the slice 4.2 entry point consistent with registry's register/finish.
 */
export function renderGrid(opts: { cards: readonly GridCard[]; columns: number; theme?: GridTheme }): string {
	const { cards, columns, theme = DEFAULT_GRID_THEME } = opts;
	const perRow = columns < 1 ? 1 : Math.floor(columns);
	const rows: string[] = [];
	for (let start = 0; start < cards.length; start += perRow) {
		rows.push(renderRow(cards.slice(start, start + perRow), theme));
	}
	return rows.join("\n");
}
