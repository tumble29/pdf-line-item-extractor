/**
 * Tests for src/lib/engine/table.ts: finding the table on a page from the
 * layout of its rows.
 *
 * Three kinds of input:
 *   - Hand-made pieces (tests/fixtures/items.ts), so a test can set exact
 *     positions and gaps for one rule. At font size 9 each character is
 *     4.5 pt wide, and the thresholds are:
 *       column edges line up   within 0.35 x 9 = 3.15 pt
 *       wrapped first row      less than 1.3 x 9 = 11.7 pt below it
 *       wrapped later row      less than 0.8 x row gap (13.6 pt at 17 pt)
 *       header                 at most max(2 x row gap, 3 x 9) above the body
 *       second header line     less than 1.3 x 9 = 11.7 pt above the header
 *   - The language and layout fixtures (tests/fixtures/languages.ts) and the
 *     rule fixtures (tests/fixtures/build.ts): real PDFs read with pdf.js.
 *     Their expected headers and rows come from the fixture files.
 *   - The six sample PDFs, when the samples folder exists. Only counts are
 *     checked, so no sample text appears here.
 *
 * All text in the hand-made cases is invented.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NOTES } from "@/lib/contract/notes";
import { classifyPage } from "@/lib/engine/classify-page";
import { openDocument } from "@/lib/engine/open";
import { readPage, type TextPiece } from "@/lib/engine/read-page";
import { buildRows, type Row } from "@/lib/engine/rows";
import {
  ALIGN_TOL,
  CONT_GAP,
  HEADER_LINE_GAP,
  MIN_CELLS,
  NUMERIC_KIND_SHARE,
  columnKey,
  findTable,
  type PageLayout,
} from "@/lib/engine/table";

import {
  DOCKET_COLUMNS,
  DOCKET_ROWS,
  MULTI_PAGE,
  SHIFTED_AFTER_LINE,
  SHIFTED_COLUMNS,
  SHIFTED_ROWS,
  TITLED_PAGES_LABEL_LINE,
  docket,
  multiPage,
  rotatedStamp,
  shiftedColumns,
  titledPages,
} from "../fixtures/build";
import { piece } from "../fixtures/items";
import { LANGUAGE_FIXTURES, NO_TABLE_KEY_VALUES, asReadBack, type LanguageFixtureName } from "../fixtures/languages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A line of cells: each cell is its text and its left edge. */
type Line = [text: string, x: number][];

/** The pieces of one line of cells at baseline `y`, font size 9. */
function line(y: number, cells: Line): TextPiece[] {
  return cells.map(([text, x]) => piece(text, x, y));
}

/** The header of the hand-made table. */
const HEADER: Line = [
  ["No", 50],
  ["Item name", 80],
  ["Qty", 300],
  ["Price", 360],
  ["Amount", 440],
];

/** The three item rows of the hand-made table. Every row multiplies. */
const ITEMS: Line[] = [
  [["1", 50], ["Cedar post 2.4m", 80], ["4", 300], ["$12.00", 360], ["$48.00", 440]],
  [["2", 50], ["Wire staple box", 80], ["2", 300], ["$7.50", 360], ["$15.00", 440]],
  [["3", 50], ["Gate latch", 80], ["1", 300], ["$21.00", 360], ["$21.00", 440]],
];

/** Where the first item row sits, and the gap between rows. */
const FIRST_Y = 200;
const PITCH = 17;

/**
 * The pieces of a hand-made page: a title line at y = 100, the header 22 pt
 * above the first row (as in the samples), and the item rows 17 pt apart.
 * So without extra lines the rows are: 0 title, 1 header, 2.. items.
 */
function page(options: { header?: Line | null; headerGap?: number; items?: Line[]; extra?: TextPiece[] } = {}): TextPiece[] {
  const pieces = line(100, [["Invented Fencing Ltd", 50]]);
  const header = options.header === undefined ? HEADER : options.header;
  if (header) pieces.push(...line(FIRST_Y - (options.headerGap ?? 22), header));
  (options.items ?? ITEMS).forEach((cells, i) => pieces.push(...line(FIRST_Y + i * PITCH, cells)));
  pieces.push(...(options.extra ?? []));
  return pieces;
}

/** Finds the table on hand-made pieces. */
function layoutOf(pieces: TextPiece[], pageNumber = 1): PageLayout {
  return findTable(buildRows(pieces), pageNumber);
}

/** The texts of some rows. */
function texts(rows: readonly Row[]): string[] {
  return rows.map((row) => row.text);
}

/** The layout of a table, as numbers only: what must not change when the letters change. */
function signature(layout: PageLayout) {
  const table = layout.table;
  return {
    table: table
      ? {
          columns: table.columns.map((column) => ({ kind: column.kind, x0: column.x0, x1: column.x1, hasHeader: column.header !== null })),
          headerRows: table.headerRows.map((row) => row.index),
          body: table.body.map((bodyRow) => ({
            row: bodyRow.row.index,
            continuations: bodyRow.continuations.map((row) => row.index),
            filled: bodyRow.cells.map((cell) => cell !== null),
          })),
        }
      : null,
    above: layout.above.map((row) => row.index),
    below: layout.below.map((row) => row.index),
    notes: layout.notes.length,
  };
}

/** One page of a PDF, as the engine sees it before table detection. */
interface ReadPage {
  page: number;
  /** The upright pieces (null for a page that is not a text page). */
  pieces: TextPiece[] | null;
}

/** Opens a PDF and reads every page, keeping the pieces classify-page.ts would pass on. */
async function readPages(bytes: Uint8Array): Promise<ReadPage[]> {
  const opened = await openDocument(bytes);
  if (!opened.ok) throw new Error(`PDF did not open: ${opened.refusal.code}`);
  try {
    const pages: ReadPage[] = [];
    for (let n = 1; n <= opened.doc.numPages; n++) {
      const classified = classifyPage(await readPage(opened.doc, opened.pdfjs, n));
      pages.push({ page: n, pieces: classified.kind === "text" ? classified.pieces : null });
    }
    return pages;
  } finally {
    await opened.doc.loadingTask.destroy();
  }
}

/** The pieces of the first page of a one-page fixture. */
async function firstPagePieces(build: () => Promise<Uint8Array>): Promise<TextPiece[]> {
  const [first] = await readPages(await build());
  if (!first.pieces) throw new Error("the fixture's first page is not a text page");
  return first.pieces;
}

/** The pieces that make up some rows (rows.ts keeps the piece objects in each cell). */
function piecesOf(rows: readonly Row[]): Set<TextPiece> {
  return new Set(rows.flatMap((row) => row.cells.flatMap((cell) => cell.pieces)));
}

/**
 * A fixed pseudo-random number generator (the Park-Miller one the prototype
 * used), so a jitter test gives the same positions on every run.
 */
function randomFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/**
 * Replaces every letter with a Cyrillic letter, keeping the case and keeping
 * digits, punctuation, symbols and spaces. The piece keeps its position and
 * width, so only the words change, never the layout.
 */
function scramble(text: string): string {
  return text.replace(/\p{L}/gu, (letter) => {
    const code = letter.codePointAt(0) as number;
    const upper = letter !== letter.toLowerCase();
    return String.fromCodePoint((upper ? 0x410 : 0x430) + (code % 32));
  });
}

/** The table fixtures of languages.ts (every one except the page with no table). */
const TABLE_FIXTURES = (Object.keys(LANGUAGE_FIXTURES) as LanguageFixtureName[]).filter((name) => name !== "noTable");

// ---------------------------------------------------------------------------
// Constants and keys
// ---------------------------------------------------------------------------

describe("findTable: the constants", () => {
  it("uses the values from the plan", () => {
    expect(ALIGN_TOL).toBe(0.35);
    expect(MIN_CELLS).toBe(3);
    expect(CONT_GAP).toBe(0.8);
    expect(HEADER_LINE_GAP).toBe(1.3);
    expect(NUMERIC_KIND_SHARE).toBe(0.5);
  });
});

describe("columnKey", () => {
  it.each([
    ["Unit Price", 4, "unitPrice"],
    ["QTY.", 2, "qty"],
    ["Line Total", 5, "lineTotal"],
    ["Disc %", 5, "disc"],
    ["Part No.", 1, "partNo"],
    ["Prix unitaire", 4, "prixUnitaire"],
    ["Mô tả", 1, "môTả"],
    ["  Unit   Price  ", 4, "unitPrice"],
    ["#", 0, "col1"],
    ["%", 3, "col4"],
    ["", 2, "col3"],
  ])("turns %j at position %i into %s", (header, position, key) => {
    expect(columnKey(header, position)).toBe(key);
  });

  it("gives col{n} with n = position + 1 when there is no header", () => {
    expect(columnKey(null, 0)).toBe("col1");
    expect(columnKey(null, 5)).toBe("col6");
  });

  it("uses the NFC form, so a decomposed accent gives the same key", () => {
    const decomposed = "Désignation";
    expect(columnKey(decomposed, 1)).toBe("désignation");
    expect(columnKey(decomposed, 1)).toBe(columnKey("Désignation", 1));
  });

  it("numbers repeated keys from the left, and skips a number that is already taken", () => {
    const header: Line = [["Item name", 80], ["Weight", 200], ["Weight 2", 250], ["Weight", 310], ["Qty", 360]];
    const rows: Line[] = [
      [["Cedar post", 80], ["12kg", 200], ["24kg", 250], ["36kg", 310], ["3", 360]],
      [["Gate latch", 80], ["1kg", 200], ["2kg", 250], ["3kg", 310], ["3", 360]],
    ];
    const table = layoutOf(page({ header, items: rows })).table;
    expect(table?.columns.map((column) => column.key)).toEqual(["itemName", "weight", "weight2", "weight3", "qty"]);
  });
});

// ---------------------------------------------------------------------------
// Hand-made pages: one rule at a time
// ---------------------------------------------------------------------------

describe("findTable: the basic table", () => {
  it("finds the columns, the header, the body and the rows around it", () => {
    const layout = layoutOf(page({ extra: line(FIRST_Y + 2 * PITCH + 34, [["Total:", 360], ["$84.00", 440]]) }));
    const table = layout.table;
    expect(table).not.toBeNull();
    expect(table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Price", "Amount"]);
    expect(table?.columns.map((column) => column.key)).toEqual(["no", "itemName", "qty", "price", "amount"]);
    expect(table?.columns.map((column) => column.kind)).toEqual(["numeric", "text", "numeric", "numeric", "numeric"]);
    expect(table?.columns.map((column) => column.position)).toEqual([0, 1, 2, 3, 4]);
    expect(texts(table?.headerRows ?? [])).toEqual(["No Item name Qty Price Amount"]);
    expect(table?.body.map((bodyRow) => bodyRow.row.index)).toEqual([2, 3, 4]);
    expect(table?.body[1].cells.map((cell) => cell?.text ?? null)).toEqual(["2", "Wire staple box", "2", "$7.50", "$15.00"]);
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd"]);
    expect(texts(layout.below)).toEqual(["Total: $84.00"]);
    expect(layout.notes).toEqual([]);
  });

  it("returns every row of the page and doesn't change its input", () => {
    const rows = buildRows(page());
    const copy = structuredClone(rows);
    const layout = findTable(rows, 1);
    expect(layout.rows).toEqual(rows);
    expect(layout.rows).not.toBe(rows);
    expect(rows).toEqual(copy);
  });

  it("gives touching bands: each border is halfway across the gap between two columns", () => {
    const columns = layoutOf(page()).table?.columns ?? [];
    // Qty cells and header span 300..313.5 ("Qty" is 13.5 pt wide); Price cells span 360..387.
    expect(columns[2].x1).toBeCloseTo((313.5 + 360) / 2, 5);
    expect(columns[3].x0).toBe(columns[2].x1);
    // The first band starts at the first column's left edge, the last ends at the last column's right edge.
    expect(columns[0].x0).toBe(50);
    expect(columns[4].x1).toBe(440 + 27);
    for (const column of columns) expect(column.x0).toBeLessThan(column.x1);
  });

  it("gives no table on an empty page", () => {
    expect(findTable([], 1)).toEqual({ rows: [], table: null, above: [], below: [], notes: [] });
  });
});

describe("findTable: when rows are a table", () => {
  it("needs at least 3 cells per row, so a two-column key/value block is not a table", () => {
    const pairs: Line[] = [
      [["Subtotal", 300], ["$84.00", 440]],
      [["GST", 300], ["$12.60", 440]],
      [["Total", 300], ["$96.60", 440]],
    ];
    const layout = layoutOf(page({ header: null, items: pairs }));
    expect(layout.table).toBeNull();
    expect(layout.above).toHaveLength(4);
    expect(layout.below).toEqual([]);
  });

  it("needs 2 body rows when there is no header", () => {
    expect(layoutOf(page({ header: null, items: ITEMS.slice(0, 1) })).table).toBeNull();
    expect(layoutOf(page({ header: null, items: ITEMS.slice(0, 2) })).table?.body).toHaveLength(2);
  });

  it("reads a single item when a header is attached", () => {
    const table = layoutOf(page({ items: ITEMS.slice(0, 1) })).table;
    expect(table?.body).toHaveLength(1);
    expect(table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Price", "Amount"]);
  });

  it("needs a number in every body row, so a row of text ends the body", () => {
    const textRow: Line = [["x", 50], ["Hinge", 80], ["pair", 300], ["n/a", 360], ["n/a", 440]];
    const layout = layoutOf(page({ items: [ITEMS[0], ITEMS[1], textRow] }));
    expect(layout.table?.body).toHaveLength(2);
    expect(texts(layout.below)).toEqual(["x Hinge pair n/a n/a"]);
    // Close case: the same row with a number in it joins the body.
    const numberRow: Line = [["4", 50], ["Hinge", 80], ["pair", 300], ["n/a", 360], ["n/a", 440]];
    expect(layoutOf(page({ items: [ITEMS[0], ITEMS[1], numberRow] })).table?.body).toHaveLength(3);
  });

  it("builds the columns from the body, so a header over no body cells becomes a header-only column", () => {
    const table = layoutOf(page({ header: [...HEADER, ["Notes", 520]] })).table;
    expect(table?.columns).toHaveLength(6);
    const notes = table?.columns[5];
    expect(notes).toMatchObject({ position: 5, header: "Notes", key: "notes", kind: "text" });
    for (const bodyRow of table?.body ?? []) expect(bodyRow.cells[5]).toBeNull();
  });
});

describe("findTable: growing the body", () => {
  it("lets one cell per row start a new column when it overlaps no existing column", () => {
    const withDiscount: Line = [["2", 50], ["Wire staple box", 80], ["2", 300], ["$7.50", 360], ["10%", 400], ["$13.50", 440]];
    const table = layoutOf(page({ header: [...HEADER, ["Disc", 400]], items: [ITEMS[0], withDiscount, ITEMS[2]] })).table;
    expect(table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Price", "Disc", "Amount"]);
    expect(table?.body).toHaveLength(3);
    expect(table?.body.map((bodyRow) => bodyRow.cells[4]?.text ?? null)).toEqual([null, "10%", null]);
    expect(table?.columns[4].kind).toBe("numeric");
  });

  it("does not let a row with two new cells join the body", () => {
    const twoNew: Line = [["2", 50], ["Wire staple box", 80], ["2", 300], ["$7.50", 360], ["10%", 400], ["$13.50", 440], ["A", 500]];
    const layout = layoutOf(page({ items: [ITEMS[0], twoNew] }));
    expect(layout.table?.body.map((bodyRow) => bodyRow.row.index)).toEqual([2]);
  });

  it("does not let a cell between two columns join (a cell off by more than the tolerance)", () => {
    // "$17.50" (as wide as "$12.00" above it) moved 4 pt right: its left edge, right edge and
    // centre are each 4 pt away, more than 0.35 x 9 = 3.15 pt,
    // and the cell overlaps the Price band, so it can't start a new column either.
    const shifted: Line = [["2", 50], ["Wire staple box", 80], ["2", 300], ["$17.50", 364], ["$35.00", 440]];
    expect(layoutOf(page({ items: [ITEMS[0], shifted] })).table?.body).toHaveLength(1);
    // Close case: 3 pt is within the tolerance.
    const close: Line = [["2", 50], ["Wire staple box", 80], ["2", 300], ["$17.50", 363], ["$35.00", 440]];
    expect(layoutOf(page({ items: [ITEMS[0], close] })).table?.body).toHaveLength(2);
  });

  it("matches right-aligned and centred cells by their right edge or centre", () => {
    // Each column's cells share only a right edge (Qty, Amount) or a centre (No).
    const rows: Line[] = [
      [["1", 52], ["Cedar post 2.4m", 80], ["40", 300], ["$12.00", 360], ["$480.00", 440]],
      [["12", 49.75], ["Wire staple box", 80], ["2", 304.5], ["$7.50", 360], ["$15.00", 444.5]],
    ];
    const table = layoutOf(page({ items: rows })).table;
    expect(table?.body).toHaveLength(2);
    expect(table?.columns).toHaveLength(5);
  });
});

describe("findTable: column kinds", () => {
  it.each([
    [["4", "n/a", "POA"], "text", "1 of 3 cells is a number"],
    [["4", "n/a", "2"], "numeric", "2 of 3 cells are numbers"],
    [["4", "n/a"], "numeric", "1 of 2 cells is exactly half"],
  ])("gives a column with %j the kind %s (%s)", (quantities, kind) => {
    const items = quantities.map((qty, i) => ITEMS[i].map(([text, x]) => [x === 300 ? qty : text, x] as [string, number]));
    const table = layoutOf(page({ items })).table;
    expect(table?.columns[2].kind).toBe(kind);
  });
});

describe("findTable: continuation lines (wrapped descriptions)", () => {
  it("joins a wrapped line under the first row when it is less than 1.3 x the font size below", () => {
    const layout = layoutOf(page({ items: ITEMS.slice(0, 1), extra: line(FIRST_Y + 11, [["treated, H4 grade", 80]]) }));
    expect(layout.table?.body[0].continuations.map((row) => row.text)).toEqual(["treated, H4 grade"]);
    expect(layout.below).toEqual([]);
  });

  it("does not join a line under the first row that is 12 pt below (more than 11.7 pt)", () => {
    const layout = layoutOf(page({ items: ITEMS.slice(0, 1), extra: line(FIRST_Y + 12, [["treated, H4 grade", 80]]) }));
    expect(layout.table?.body[0].continuations).toEqual([]);
    expect(texts(layout.below)).toEqual(["treated, H4 grade"]);
  });

  it("joins a wrapped line under a later row when it is less than 0.8 x the row gap below", () => {
    // Rows are 17 pt apart, so the limit is 13.6 pt.
    const layout = layoutOf(page({ extra: line(FIRST_Y + 2 * PITCH + 13, [["zinc, with screws", 80]]) }));
    expect(layout.table?.body[2].continuations.map((row) => row.text)).toEqual(["zinc, with screws"]);
    expect(layout.below).toEqual([]);
  });

  it("does not join a line under a later row that is 14 pt below (more than 13.6 pt)", () => {
    const layout = layoutOf(page({ extra: line(FIRST_Y + 2 * PITCH + 14, [["zinc, with screws", 80]]) }));
    expect(layout.table?.body[2].continuations).toEqual([]);
    expect(texts(layout.below)).toEqual(["zinc, with screws"]);
  });

  it("does not join a close line that sits under a numeric column", () => {
    const layout = layoutOf(page({ items: ITEMS.slice(0, 1), extra: line(FIRST_Y + 10, [["each", 300]]) }));
    expect(layout.table?.body[0].continuations).toEqual([]);
    expect(texts(layout.below)).toEqual(["each"]);
  });

  it("does not join a close line that starts a new column", () => {
    const layout = layoutOf(page({ items: ITEMS.slice(0, 1), extra: line(FIRST_Y + 10, [["see note", 520]]) }));
    expect(layout.table?.body[0].continuations).toEqual([]);
  });

  it("keeps the wrapped line out of the row's cells", () => {
    const table = layoutOf(page({ items: ITEMS.slice(0, 1), extra: line(FIRST_Y + 10, [["treated, H4 grade", 80]]) })).table;
    expect(table?.body[0].cells[1]?.text).toBe("Cedar post 2.4m");
  });
});

describe("findTable: the header", () => {
  it("is attached up to max(2 x row gap, 3 x font size) above the first body row", () => {
    // Rows are 17 pt apart, so the limit is 34 pt.
    expect(layoutOf(page({ headerGap: 34 })).table?.headerRows).toHaveLength(1);
    const layout = layoutOf(page({ headerGap: 35 }));
    expect(layout.table?.headerRows).toEqual([]);
    expect(layout.table?.columns.every((column) => column.header === null)).toBe(true);
    expect(texts(layout.above)).toContain("No Item name Qty Price Amount");
  });

  it("uses 3 x the font size (27 pt) when there is only one body row", () => {
    expect(layoutOf(page({ items: ITEMS.slice(0, 1), headerGap: 27 })).table?.headerRows).toHaveLength(1);
    expect(layoutOf(page({ items: ITEMS.slice(0, 1), headerGap: 28 })).table).toBeNull();
  });

  it("is not a row with a number in it (that row lines up, so it becomes the first body row)", () => {
    const numbered: Line = [["No", 50], ["Item name", 80], ["Qty", 300], ["Price", 360], ["2026", 440]];
    const table = layoutOf(page({ header: numbered })).table;
    expect(table?.headerRows).toEqual([]);
    expect(table?.body.map((bodyRow) => bodyRow.row.index)).toEqual([1, 2, 3, 4]);
  });

  it("is not a row with a number in it, also when that row can't start a body (2 cells)", () => {
    const table = layoutOf(page({ header: [["Item name", 80], ["2026", 440]] })).table;
    expect(table?.headerRows).toEqual([]);
    expect(table?.columns.every((column) => column.header === null)).toBe(true);
  });

  it("needs at least 2 cells", () => {
    const table = layoutOf(page({ header: [["Items", 80]] })).table;
    expect(table?.headerRows).toEqual([]);
    expect(table?.columns.map((column) => column.key)).toEqual(["col1", "col2", "col3", "col4", "col5"]);
  });

  it("is absent on a headerless table: every header is null and keys are col{n}", () => {
    const layout = layoutOf(page({ header: null }));
    expect(layout.table?.columns.map((column) => column.header)).toEqual([null, null, null, null, null]);
    expect(layout.table?.columns.map((column) => column.key)).toEqual(["col1", "col2", "col3", "col4", "col5"]);
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd"]);
  });

  it("gives col1 to a '#' header", () => {
    const table = layoutOf(page({ header: [["#", 50], ...HEADER.slice(1)] })).table;
    expect(table?.columns[0]).toMatchObject({ header: "#", key: "col1" });
  });

  it("joins two header cells over one column band with one space, in x order", () => {
    const header: Line = [["No", 50], ["Item name", 80], ["Qty", 300], ["Unit", 360], ["cost", 382.5], ["Amount", 440]];
    const table = layoutOf(page({ header })).table;
    expect(table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Unit cost", "Amount"]);
    expect(table?.columns[3].key).toBe("unitCost");
    // The same pieces in another order give the same header.
    const reversed = layoutOf(page({ header: [...header].reverse() })).table;
    expect(reversed?.columns[3].header).toBe("Unit cost");
  });

  it("merges a second header line less than 1.3 x the font size above, top line first", () => {
    const top = line(FIRST_Y - 22 - 10, [["Unit", 360], ["Line", 440]]);
    const layout = layoutOf(page({ extra: top }));
    expect(layout.table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Unit Price", "Line Amount"]);
    expect(layout.table?.headerRows.map((row) => row.text)).toEqual(["Unit Line", "No Item name Qty Price Amount"]);
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd"]);
  });

  it("does not merge a line 12 pt above the header (more than 11.7 pt)", () => {
    const top = line(FIRST_Y - 22 - 12, [["Unit", 360], ["Line", 440]]);
    const layout = layoutOf(page({ extra: top }));
    expect(layout.table?.columns[3].header).toBe("Price");
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd", "Unit Line"]);
  });

  it("does not merge a line above when one of its cells overlaps no header cell", () => {
    const top = line(FIRST_Y - 22 - 10, [["Unit", 360], ["Stock", 520]]);
    const layout = layoutOf(page({ extra: top }));
    expect(layout.table?.headerRows).toHaveLength(1);
    expect(texts(layout.above)).toContain("Unit Stock");
  });
});

describe("findTable: carried-forward lines", () => {
  it("sets a carried-forward line aside with a note, and still attaches the header above it", () => {
    // The carried-forward line sits where the first row would be; the items start one row lower.
    // Without the carried-forward line, the header would be 22 + 17 = 39 pt above the first
    // item, more than the 34 pt limit. Measured to the carried-forward line it is 22 pt.
    const pieces = [
      ...line(100, [["Invented Fencing Ltd", 50]]),
      ...line(FIRST_Y - 22, HEADER),
      ...line(FIRST_Y, [["Brought forward", 80], ["$310.00", 440]]),
      ...ITEMS.flatMap((cells, i) => line(FIRST_Y + (i + 1) * PITCH, cells)),
    ];
    const layout = layoutOf(pieces, 2);
    expect(layout.notes).toEqual([NOTES.carriedForwardSkipped(2, "Brought forward $310.00")]);
    expect(layout.table?.headerRows).toHaveLength(1);
    expect(layout.table?.body.map((bodyRow) => bodyRow.cells[0]?.text)).toEqual(["1", "2", "3"]);
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd"]);
    expect(layout.below).toEqual([]);
    expect(texts(layout.rows)).toContain("Brought forward $310.00");
  });

  it("sets aside a 'b/f' line inside the table and a 'Carried forward' line below it", () => {
    const layout = layoutOf(
      page({
        items: [ITEMS[0], [["b/f", 80], ["$95.00", 440]], ITEMS[1], ITEMS[2]],
        extra: line(FIRST_Y + 3 * PITCH + 34, [["Carried forward", 80], ["$179.00", 440]]),
      }),
    );
    expect(layout.notes.map((note) => note.text)).toEqual([
      NOTES.carriedForwardSkipped(1, "b/f $95.00").text,
      NOTES.carriedForwardSkipped(1, "Carried forward $179.00").text,
    ]);
    expect(layout.table?.body).toHaveLength(3);
    expect(layout.below).toEqual([]);
  });

  it("keeps a line with the words but no amount as normal text", () => {
    const layout = layoutOf(page({ extra: line(130, [["Brought forward from order 7", 50]]) }));
    expect(layout.notes).toEqual([]);
    expect(texts(layout.above)).toContain("Brought forward from order 7");
  });

  it("only looks at the first cell, so the words in a description don't count", () => {
    const row: Line = [["4", 50], ["Carried forward crate", 80], ["1", 300], ["$9.00", 360], ["$9.00", 440]];
    const layout = layoutOf(page({ items: [...ITEMS, row] }));
    expect(layout.notes).toEqual([]);
    expect(layout.table?.body).toHaveLength(4);
  });
});

describe("findTable: more than one run of rows on a page", () => {
  it("continues the table after a section heading when the next run lines up with its columns", () => {
    const heading = line(FIRST_Y + 3 * PITCH + 10, [["Stage 2 - Gates", 80]]);
    const more: Line[] = [
      [["4", 50], ["Gate hinge set", 80], ["2", 300], ["$18.00", 360], ["$36.00", 440]],
      [["5", 50], ["Drop bolt", 80], ["1", 300], ["$14.50", 360], ["$14.50", 440]],
    ];
    const secondY = FIRST_Y + 3 * PITCH + 30;
    const layout = layoutOf(page({ extra: [...heading, ...more.flatMap((cells, i) => line(secondY + i * PITCH, cells))] }), 3);
    expect(layout.table?.body.map((bodyRow) => bodyRow.cells[0]?.text)).toEqual(["1", "2", "3", "4", "5"]);
    expect(layout.notes).toEqual([NOTES.sectionHeading(3, "Stage 2 - Gates")]);
    expect(texts(layout.above)).toEqual(["Invented Fencing Ltd"]);
    expect(layout.below).toEqual([]);
  });

  it("continues the table across a short line with a number when the rows keep the table's spacing", () => {
    const subtotal = line(FIRST_Y + 3 * PITCH + 10, [["Stage 1 subtotal", 80], ["$84.00", 440]]);
    const more: Line[] = [
      [["4", 50], ["Gate hinge set", 80], ["2", 300], ["$18.00", 360], ["$36.00", 440]],
      [["5", 50], ["Drop bolt", 80], ["1", 300], ["$14.50", 360], ["$14.50", 440]],
    ];
    const secondY = FIRST_Y + 3 * PITCH + 30;
    const layout = layoutOf(page({ extra: [...subtotal, ...more.flatMap((cells, i) => line(secondY + i * PITCH, cells))] }));
    expect(layout.table?.body.map((bodyRow) => bodyRow.cells[0]?.text)).toEqual(["1", "2", "3", "4", "5"]);
    expect(layout.notes).toEqual([NOTES.shortLineInTable(1, "Stage 1 subtotal $84.00")]);
    expect(layout.below).toEqual([]);
  });

  it("does not continue the table across a line with a number when a clear gap follows it", () => {
    const subtotal = line(FIRST_Y + 3 * PITCH + 10, [["Stage 1 subtotal", 80], ["$84.00", 440]]);
    const more: Line[] = [
      [["4", 50], ["Gate hinge set", 80], ["2", 300], ["$18.00", 360], ["$36.00", 440]],
      [["5", 50], ["Drop bolt", 80], ["1", 300], ["$14.50", 360], ["$14.50", 440]],
    ];
    const secondY = FIRST_Y + 3 * PITCH + 90;
    const layout = layoutOf(page({ extra: [...subtotal, ...more.flatMap((cells, i) => line(secondY + i * PITCH, cells))] }));
    expect(layout.table?.body).toHaveLength(3);
    expect(layout.notes).toEqual([NOTES.otherTableNotRead(1, "4 Gate hinge set 2 $18.00 $36.00")]);
    expect(texts(layout.below)).toEqual(["Stage 1 subtotal $84.00", "4 Gate hinge set 2 $18.00 $36.00", "5 Drop bolt 1 $14.50 $14.50"]);
  });

  it("does not continue the table across a line with a number that doesn't line up with its columns", () => {
    const stray = line(FIRST_Y + 3 * PITCH, [["Stage 1 subtotal", 80], ["$84.00", 400]]);
    const more: Line[] = [
      [["4", 50], ["Gate hinge set", 80], ["2", 300], ["$18.00", 360], ["$36.00", 440]],
      [["5", 50], ["Drop bolt", 80], ["1", 300], ["$14.50", 360], ["$14.50", 440]],
    ];
    const secondY = FIRST_Y + 4 * PITCH;
    const layout = layoutOf(page({ extra: [...stray, ...more.flatMap((cells, i) => line(secondY + i * PITCH, cells))] }));
    expect(layout.table?.body).toHaveLength(3);
    expect(layout.notes).toEqual([NOTES.otherTableNotRead(1, "4 Gate hinge set 2 $18.00 $36.00")]);
  });

  it("does not read a second table whose columns don't line up, and warns about it", () => {
    const second: Line[] = [
      [["Account", 60], ["Terms", 250], ["Balance", 400]],
      [["Fern Trust", 60], ["7 days", 250], ["$115.00", 400]],
      [["Rimu Holdings", 60], ["20th", 250], ["$0.00", 400]],
    ];
    const startY = FIRST_Y + 2 * PITCH + 60;
    const layout = layoutOf(page({ extra: second.flatMap((cells, i) => line(startY + i * PITCH, cells)) }), 2);
    expect(layout.table?.body).toHaveLength(3);
    expect(layout.table?.columns).toHaveLength(5);
    expect(layout.notes).toEqual([NOTES.otherTableNotRead(2, "Fern Trust 7 days $115.00")]);
    expect(texts(layout.below)).toEqual(["Account Terms Balance", "Fern Trust 7 days $115.00", "Rimu Holdings 20th $0.00"]);
  });

  it("gives no warning for later rows that are not a table (one row, no header)", () => {
    const lonely = line(FIRST_Y + 2 * PITCH + 60, [["Freight", 60], ["1", 250], ["$25.00", 400]]);
    const layout = layoutOf(page({ extra: lonely }));
    expect(layout.notes).toEqual([]);
    expect(texts(layout.below)).toEqual(["Freight 1 $25.00"]);
  });

  it("reads the table with the most number columns, not the first one, and keeps the other out of the title", () => {
    // A small block above the items, like a payment schedule: it is a table
    // too (3 cells, a number), but with fewer number columns.
    const first: Line[] = [
      [["Payment stage", 60], ["Due", 250], ["Amount", 400]],
      [["Deposit on acceptance", 60], ["14 days", 250], ["$124.05", 400]],
      [["Balance on delivery", 60], ["30 days", 250], ["$289.45", 400]],
    ];
    const pieces = [
      ...first.flatMap((cells, i) => line(60 + i * PITCH, cells)),
      ...line(FIRST_Y - 22, HEADER),
      ...ITEMS.flatMap((cells, i) => line(FIRST_Y + i * PITCH, cells)),
    ];
    const layout = layoutOf(pieces);
    expect(layout.table?.columns.map((column) => column.header)).toEqual(HEADER.map(([text]) => text));
    expect(layout.table?.body).toHaveLength(3);
    expect(layout.notes).toEqual([NOTES.otherTableNotRead(1, "Deposit on acceptance 14 days $124.05")]);
    expect(layout.above).toEqual([]);
  });

  it("reads the first of two tables with as many number columns", () => {
    const first: Line[] = [
      [["Fern Trust", 60], ["7 days", 250], ["$115.00", 400]],
      [["Rimu Holdings", 60], ["20th", 250], ["$0.00", 400]],
    ];
    const second: Line[] = [
      [["Kauri Group", 60], ["14 days", 250], ["$96.00", 400]],
      [["Totara Ltd", 60], ["5th", 250], ["$12.00", 400]],
    ];
    const pieces = [
      ...first.flatMap((cells, i) => line(60 + i * PITCH, cells)),
      ...second.flatMap((cells, i) => line(300 + i * PITCH, cells.map(([text, x]) => [text, x + 20]))),
    ];
    const layout = layoutOf(pieces);
    expect(layout.table?.body.map((bodyRow) => bodyRow.row.text)).toEqual(["Fern Trust 7 days $115.00", "Rimu Holdings 20th $0.00"]);
    expect(layout.notes).toEqual([NOTES.otherTableNotRead(1, "Kauri Group 14 days $96.00")]);
  });
});

describe("findTable: long descriptions, headings beside their column, and joined cells", () => {
  it("keeps every wrapped line of a description on three lines", () => {
    // Each wrapped line is 8 pt below the line above it, so the second one is
    // 16 pt below the row: too far from the row, but close to the line above.
    const pieces = [
      ...line(100, [["Invented Fencing Ltd", 50]]),
      ...line(FIRST_Y - 22, HEADER),
      ...line(FIRST_Y, ITEMS[0]),
      ...line(FIRST_Y + 8, [["treated pine, H4", 80]]),
      ...line(FIRST_Y + 16, [["sold per length", 80]]),
      ...line(FIRST_Y + 34, ITEMS[1]),
      ...line(FIRST_Y + 51, ITEMS[2]),
    ];
    const layout = layoutOf(pieces);
    expect(layout.table?.body).toHaveLength(3);
    expect(texts(layout.table?.body[0].continuations ?? [])).toEqual(["treated pine, H4", "sold per length"]);
  });

  it("gives a heading that overlaps no column to the headerless column next to it", () => {
    // Headings at the left of each column, numbers at the right, so they don't overlap.
    const right = (text: string, edge: number): [string, number] => [text, edge - text.length * 4.5];
    const header: Line = [["No", 50], ["Item name", 80], ["Qty", 290], ["Price", 350], ["Amount", 430]];
    const rows: Line[] = [
      [["1", 50], ["Cedar post 2.4m", 80], right("4", 330), right("$12.00", 410), right("$48.00", 500)],
      [["2", 50], ["Wire staple box", 80], right("12", 330), right("$7.50", 410), right("$90.00", 500)],
      [["3", 50], ["Gate latch", 80], right("1", 330), right("$21.00", 410), right("$21.00", 500)],
    ];
    const layout = layoutOf(page({ header, items: rows }));
    expect(layout.table?.columns.map((column) => column.header)).toEqual(["No", "Item name", "Qty", "Price", "Amount"]);
  });

  it("marks the spaces of a number cell that reaches into the next column, so '2 150.00' is never one number", () => {
    // pdf.js joins a quantity "2" and a price "150.00" drawn close together into one piece.
    const header: Line = [["No", 50], ["Item name", 80], ["Qty", 300], ["Price", 322], ["Amount", 440]];
    const rows: Line[] = [
      [["1", 50], ["Cedar post 2.4m", 80], ["12", 300], ["$15.50", 322], ["$186.00", 440]],
      [["2", 50], ["Wire staple box", 80], ["8", 300], ["$22.25", 322], ["$1 178.00", 440]],
      [["3", 50], ["Joist hanger", 80], ["2 150.00", 300], ["$300.00", 440]],
    ];
    const layout = layoutOf(page({ header, items: rows }));
    const joined = layout.table?.body[2].cells[2];
    expect(joined?.text).toBe("2 150.00");
    expect(joined?.joinSpaces).toEqual([1]);
    // The row itself is not changed; only the table's copy of the cell is.
    expect(layout.table?.body[2].row.cells[2].joinSpaces).toEqual([]);
    // A number with a space that stays inside its own column is not marked.
    expect(layout.table?.body[1].cells[4]?.joinSpaces).toEqual([]);
  });

  it("finds the table on a page with 400 rows and 25 number columns in well under a second", () => {
    const pieces: TextPiece[] = [piece("Description", 20, 50)];
    for (let c = 0; c < 25; c++) pieces.push(piece(`H${c}`, 120 + c * 45, 50));
    for (let r = 0; r < 400; r++) {
      const y = 70 + r * 12;
      pieces.push(piece(`Widget number ${r}`, 20, y));
      for (let c = 0; c < 25; c++) pieces.push(piece(`${((r * 7 + c * 13) % 97) + 2}.${(r + c) % 10}0`, 120 + c * 45, y));
    }
    const rows = buildRows(pieces);
    const started = performance.now();
    const layout = findTable(rows, 1);
    const took = performance.now() - started;
    expect(layout.table?.body).toHaveLength(400);
    // When every comparison sorted the column's edges again, this took about 8 seconds.
    expect(took).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Real PDFs: the language and layout fixtures
// ---------------------------------------------------------------------------

describe("findTable on the language and layout fixtures", () => {
  it.each(TABLE_FIXTURES)("%s: finds the header, the columns, the rows and the lines below", async (name) => {
    const expected = LANGUAGE_FIXTURES[name];
    const layout = findTable(buildRows(await firstPagePieces(expected.build)), 1);
    const table = layout.table;
    expect(table).not.toBeNull();
    expect(table?.columns.map((column) => column.header)).toEqual(expected.headers.map(asReadBack));
    expect(table?.columns).toHaveLength(expected.headers.length);
    expect(table?.body).toHaveLength(expected.rowCount);
    expect(table?.body.map((bodyRow) => bodyRow.cells.map((cell) => cell?.text ?? ""))).toEqual(
      expected.rows.map((row) => row.map(asReadBack)),
    );
    const wrapped = table?.body.flatMap((bodyRow, row) =>
      bodyRow.continuations.length > 0 ? [{ row, lines: texts(bodyRow.continuations) }] : [],
    );
    expect(wrapped).toEqual(expected.wrapped);
    expect(texts(layout.below)).toEqual(expected.after.map(asReadBack));
    expect(layout.notes).toEqual([]);
  });

  it("noTable: gives no table, and keeps every row as text above", async () => {
    const rows = buildRows(await firstPagePieces(LANGUAGE_FIXTURES.noTable.build));
    const layout = findTable(rows, 1);
    expect(layout.table).toBeNull();
    expect(layout.above).toEqual(rows);
    expect(layout.below).toEqual([]);
    for (const [label, value] of NO_TABLE_KEY_VALUES) expect(texts(layout.above)).toContain(`${label} ${value}`);
  });

  it("twoLineHeader: keeps both header lines, top line first", async () => {
    const layout = findTable(buildRows(await firstPagePieces(LANGUAGE_FIXTURES.twoLineHeader.build)), 1);
    expect(texts(layout.table?.headerRows ?? [])).toEqual(["Unit Line", "Item Description Qty Unit Price Total"]);
  });

  it("gives the keys from the headers (prixUnitaire, unitPrice, qty)", async () => {
    const french = findTable(buildRows(await firstPagePieces(LANGUAGE_FIXTURES.french.build)), 1);
    expect(french.table?.columns.map((column) => column.key)).toContain("prixUnitaire");
    const english = findTable(buildRows(await firstPagePieces(LANGUAGE_FIXTURES.reorderedRightAligned.build)), 1);
    expect(english.table?.columns.map((column) => column.key)).toEqual(["description", "code", "qty", "unit", "lineTotal", "unitPrice"]);
  });
});

describe("findTable: the scrambled-letters test", () => {
  it.each([...TABLE_FIXTURES, "noTable" as const])(
    "%s: gives the same layout when every letter is replaced by a Cyrillic letter",
    async (name) => {
      const pieces = await firstPagePieces(LANGUAGE_FIXTURES[name].build);
      const scrambled = pieces.map((p) => ({ ...p, str: scramble(p.str) }));
      // The scramble really changed the words.
      expect(scrambled.some((p, i) => p.str !== pieces[i].str)).toBe(true);
      expect(scrambled.every((p) => !/[A-Za-z]/u.test(p.str))).toBe(true);
      expect(signature(layoutOf(scrambled))).toEqual(signature(layoutOf(pieces)));
    },
  );
});

describe("findTable: layout changes on the fixtures", () => {
  // One piece per word, centred headers and two-line headers are fixtures of
  // their own (see above). These change the pieces of every table fixture.

  it.each(TABLE_FIXTURES)("%s: with the header removed, finds the same body with col{n} keys", async (name) => {
    const pieces = await firstPagePieces(LANGUAGE_FIXTURES[name].build);
    const before = layoutOf(pieces);
    const headerPieces = piecesOf(before.table?.headerRows ?? []);
    const after = layoutOf(pieces.filter((p) => !headerPieces.has(p)));
    const columns = after.table?.columns ?? [];
    expect(columns.map((column) => column.header)).toEqual(columns.map(() => null));
    expect(columns.map((column) => column.key)).toEqual(columns.map((_, i) => `col${i + 1}`));
    expect(after.table?.body.map((bodyRow) => bodyRow.row.text)).toEqual(before.table?.body.map((bodyRow) => bodyRow.row.text));
    // A column that only its header made (Disc % is empty in the first rows) is still found from the one row that fills it.
    expect(columns).toHaveLength(before.table?.columns.length ?? -1);
  });

  it.each(TABLE_FIXTURES)("%s: with a single item, still finds the header and all columns", async (name) => {
    const pieces = await firstPagePieces(LANGUAGE_FIXTURES[name].build);
    const before = layoutOf(pieces);
    const later = (before.table?.body ?? []).slice(1).flatMap((bodyRow) => [bodyRow.row, ...bodyRow.continuations]);
    const dropped = piecesOf(later);
    const after = layoutOf(pieces.filter((p) => !dropped.has(p)));
    expect(after.table?.body).toHaveLength(1);
    expect(after.table?.columns.map((column) => column.header)).toEqual(before.table?.columns.map((column) => column.header));
    expect(after.table?.body[0].continuations.map((row) => row.text)).toEqual(
      before.table?.body[0].continuations.map((row) => row.text),
    );
  });

  it.each(TABLE_FIXTURES)("%s: with the body baselines moved by up to 1.5 pt, finds the same table", async (name) => {
    const pieces = await firstPagePieces(LANGUAGE_FIXTURES[name].build);
    const before = layoutOf(pieces);
    const body = piecesOf((before.table?.body ?? []).map((bodyRow) => bodyRow.row));
    const random = randomFrom(7);
    const jittered = pieces.map((p) => (body.has(p) ? { ...p, y: p.y + (random() * 3 - 1.5) } : p));
    expect(jittered.some((p, i) => p.y !== pieces[i].y)).toBe(true);
    const after = layoutOf(jittered);
    expect(after.table?.columns.map((column) => column.header)).toEqual(before.table?.columns.map((column) => column.header));
    expect(after.table?.body.map((bodyRow) => bodyRow.cells.map((cell) => cell?.text ?? null))).toEqual(
      before.table?.body.map((bodyRow) => bodyRow.cells.map((cell) => cell?.text ?? null)),
    );
    expect(texts(after.below)).toEqual(texts(before.below));
  });
});

// ---------------------------------------------------------------------------
// Real PDFs: the rule fixtures
// ---------------------------------------------------------------------------

describe("findTable on the rule fixtures", () => {
  it("docket: finds a three-column table with no prices", async () => {
    const table = findTable(buildRows(await firstPagePieces(docket)), 1).table;
    expect(table?.columns.map((column) => column.header)).toEqual(DOCKET_COLUMNS.map((column) => column.header));
    expect(table?.body.map((bodyRow) => bodyRow.cells.map((cell) => cell?.text))).toEqual(DOCKET_ROWS);
  });

  it("shiftedColumns: reads the columns from their own positions", async () => {
    const layout = findTable(buildRows(await firstPagePieces(shiftedColumns)), 1);
    const table = layout.table;
    expect(table?.columns.map((column) => column.header)).toEqual(SHIFTED_COLUMNS.map((column) => column.header));
    SHIFTED_COLUMNS.forEach((spec, i) => {
      const column = table?.columns[i];
      expect(spec.x).toBeGreaterThanOrEqual(column?.x0 ?? Infinity);
      expect(spec.x).toBeLessThan(column?.x1 ?? -Infinity);
    });
    expect(table?.body.map((bodyRow) => bodyRow.cells.map((cell) => cell?.text))).toEqual(SHIFTED_ROWS);
    expect(texts(layout.below)).toEqual([SHIFTED_AFTER_LINE]);
  });

  it("multiPage: sets the carried-forward row aside with a note and reads every item once", async () => {
    const pages = await readPages(await multiPage());
    const layouts = pages.map((p) => findTable(buildRows(p.pieces ?? []), p.page));
    expect(layouts.map((layout) => layout.table?.body.length)).toEqual([3, 3, 3]);
    expect(layouts.reduce((sum, layout) => sum + (layout.table?.body.length ?? 0), 0)).toBe(MULTI_PAGE.itemCount);
    expect(layouts.map((layout) => layout.table?.headerRows.length)).toEqual([1, 1, 1]);
    const carried = `Carried forward ${MULTI_PAGE.carriedForward}`;
    expect(layouts[1].notes).toEqual([NOTES.carriedForwardSkipped(2, carried)]);
    expect(layouts[0].notes).toEqual([]);
    expect(layouts[2].notes).toEqual([]);
    for (const layout of layouts) {
      const tableRows = (layout.table?.body ?? []).map((bodyRow) => bodyRow.row);
      expect(texts([...tableRows, ...layout.above, ...layout.below])).not.toContain(carried);
    }
    expect(texts(layouts[2].below)).toEqual([MULTI_PAGE.subtotalLine]);
  });

  it("rotatedStamp: finds the normal table once the stamp is set aside", async () => {
    const table = findTable(buildRows(await firstPagePieces(rotatedStamp)), 1).table;
    expect(table?.columns).toHaveLength(6);
    expect(table?.body).toHaveLength(3);
  });

  it("titledPages: keeps the label line above the header, not in it", async () => {
    const pages = await readPages(await titledPages());
    const last = pages[pages.length - 1];
    const layout = findTable(buildRows(last.pieces ?? []), last.page);
    expect(texts(layout.above)).toContain(TITLED_PAGES_LABEL_LINE);
    expect(layout.table?.headerRows).toHaveLength(1);
    expect(texts(layout.table?.headerRows ?? [])).not.toContain(TITLED_PAGES_LABEL_LINE);
  });
});

// ---------------------------------------------------------------------------
// The six samples (counts only)
// ---------------------------------------------------------------------------

/**
 * What every text page of each sample must give: its column count and its
 * body row count (from the Part 1 survey). Pages that are not text pages
 * (scans) are listed as null.
 */
const SAMPLES: [file: string, pages: ({ columns: number; rows: number } | null)[]][] = [
  ["KBS-10234.pdf", [{ columns: 6, rows: 5 }]],
  ["KBS-10241.pdf", [null]],
  ["KBS-10255.pdf", [{ columns: 5, rows: 4 }]],
  ["KBS-10262.pdf", [{ columns: 6, rows: 3 }]],
  ["KBS-10270.pdf", [{ columns: 6, rows: 4 }]],
  ["KBS-DR118.pdf", [1, 2, 3, 4, 5, 6, 7, 8].map((n) => (n === 4 ? null : { columns: 6, rows: 3 }))],
];

describe.skipIf(!existsSync("samples"))("findTable on the sample PDFs", () => {
  it.each(SAMPLES)("%s: every text page has a table with the expected column and row counts", async (file, expected) => {
    const pages = await readPages(new Uint8Array(readFileSync(`samples/${file}`)));
    const found = pages.map((p) => {
      if (!p.pieces) return null;
      const layout = findTable(buildRows(p.pieces), p.page);
      return { columns: layout.table?.columns.length ?? 0, rows: layout.table?.body.length ?? 0, notes: layout.notes.length };
    });
    expect(found).toEqual(expected.map((e) => (e ? { ...e, notes: 0 } : null)));
  });
});
