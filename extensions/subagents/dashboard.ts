// Layout math for the subagents dashboard footer.
//
// Decides how many fixed-width grid cards fit across a terminal of a given width, so the
// footer can pick a column count before handing cards to grid.ts's renderGrid. Pure and
// deterministic; the gutter is shared with the renderer so packing never drifts from layout.

import { CARD_GUTTER, DEFAULT_GRID_THEME } from "./grid.ts";
import type { GridTheme } from "./grid.ts";

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
