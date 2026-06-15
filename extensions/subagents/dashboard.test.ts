import assert from "node:assert/strict";
import { test } from "node:test";

import { columnsForWidth } from "./dashboard.ts";
import { DEFAULT_GRID_THEME } from "./grid.ts";
import type { GridTheme } from "./grid.ts";

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
