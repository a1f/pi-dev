// Pure renderer for the subagents TUI footer.
//
// Turns this session's runs (and idle personas) into a grid of fixed-width cards.
// Pure and deterministic: the look-and-feel (stripe, glyphs, bar characters, widths) is an
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
	contextTokens: number | null;
	contextPct: number | null;
	activity: ReadonlyArray<{ tool: string; target: string }>;
	lastLine: string | null;
	malformed: number;
}

/** A run record → card. `now` is injected so elapsed is deterministic. */
export function cardFromRecord(record: RunRecord, now: number): GridCard {
	const { state } = record;
	return {
		title: record.task,
		status: record.status,
		elapsedMs: (record.finishedAt ?? now) - record.startedAt,
		contextTokens: state.contextTokens,
		contextPct: state.contextPct,
		activity: state.activity,
		lastLine: state.lastLine,
		malformed: state.malformed,
	};
}

/** Injected look-and-feel — keeps renderGrid pure and snapshot-stable. */
export interface GridTheme {
	stripe: Record<CardStatus, string>;
	glyph: Record<CardStatus, string>;
	barFilled: string;
	barEmpty: string;
	barWidth: number;
	cardWidth: number;
}

/** Defaults: a monochrome stripe (per-status color is a later slice) and registry.ts's row glyphs (▶ ▷ ✓ ✗ ⊘); idle gets its own marker. */
export const DEFAULT_GRID_THEME: GridTheme = {
	stripe: { running: "▌", queued: "▌", done: "▌", error: "▌", killed: "▌", idle: "▌" },
	glyph: { running: "▶", queued: "▷", done: "✓", error: "✗", killed: "⊘", idle: "○" },
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
		contextTokens: null,
		contextPct: null,
		activity: [],
		lastLine: null,
		malformed: 0,
	};
}

/** Elapsed as whole seconds (matching registry.ts), or an em dash when never started. */
function elapsedText(card: GridCard): string {
	return card.elapsedMs === null ? "—" : `${Math.floor(card.elapsedMs / 1000)}s`;
}

/** Context tokens as a compact magnitude (—, raw, k, or M) so the metrics line stays inside one tight column. */
function formatTokens(tokens: number | null): string {
	if (tokens === null) return "—";
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Context usage as a rounded percentage, or an em dash when unknown. */
function formatPct(pct: number | null): string {
	return pct === null ? "—" : `${Math.round(pct)}%`;
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
	return text.replace(/\p{Cc}/gu, "");
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
const CARD_HEIGHT = 4;

/** Columns each rendered line reserves up front for the status stripe and its trailing space. */
const STRIPE_COLUMNS = 2;

/** Blank columns between adjacent cards in a row. Exported so layout math (columnsForWidth) packs cards with the exact gutter the renderer draws. */
export const CARD_GUTTER = 2;
const GUTTER = " ".repeat(CARD_GUTTER);

/** Header content: `glyph title · status` with elapsed flush right, the left ellipsis-truncated when the two would collide. */
function headerContent(card: GridCard, theme: GridTheme): string {
	const field = theme.cardWidth - STRIPE_COLUMNS;
	const left = `${theme.glyph[card.status]} ${sanitize(card.title)} · ${card.status}`;
	const elapsed = elapsedText(card);
	return fit(left, field - Array.from(elapsed).length) + elapsed;
}

/** Metrics content: a compact token count, the context bar in brackets, then a percentage (one indent space). */
function metricsContent(card: GridCard, theme: GridTheme): string {
	return ` ${formatTokens(card.contextTokens)}  [${contextBar(card, theme)}] ${formatPct(card.contextPct)}`;
}

/** One activity action as a feed line, or a blank line when the slot holds no action. */
function activityLine(action: { tool: string; target: string } | undefined): string {
	return action === undefined ? "" : ` ▸ ${sanitize(action.tool)}  ${sanitize(action.target)}`;
}

/** A terminal card's single feed line — its glyph and final output — or blank when it produced none. */
function terminalLine(card: GridCard, theme: GridTheme): string {
	return card.lastLine === null ? "" : ` ${theme.glyph[card.status]} ${sanitize(card.lastLine)}`;
}

/**
 * The card's two feed lines (upper, lower): running/queued show their last ≤2 activity actions
 * oldest-above-newest, terminal cards show their final line then a blank, idle shows two blanks.
 */
function feedLines(card: GridCard, theme: GridTheme): readonly [string, string] {
	switch (card.status) {
		case "running":
		case "queued": {
			const recent = card.activity.slice(-2);
			return [activityLine(recent[0]), activityLine(recent[1])];
		}
		case "done":
		case "error":
		case "killed":
			return [terminalLine(card, theme), ""];
		case "idle":
			return ["", ""];
		default: {
			const _exhaustive: never = card.status;
			return _exhaustive;
		}
	}
}

/** The fixed CARD_HEIGHT lines of one card: header, metrics, and a two-line activity/output feed. */
function cardLines(card: GridCard, theme: GridTheme): readonly string[] {
	const stripe = theme.stripe[card.status];
	const field = theme.cardWidth - STRIPE_COLUMNS;
	const [feedUpper, feedLower] = feedLines(card, theme);
	const contents = [headerContent(card, theme), metricsContent(card, theme), feedUpper, feedLower];
	// Every line wears the status stripe + a space in its first STRIPE_COLUMNS columns, so content
	// is fitted to the remaining width and the total visible width stays cardWidth.
	return contents.map((content) => `${stripe} ${fit(content, field)}`);
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
