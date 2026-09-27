/**
 * Tests for src/lib/engine/items.ts: turning a table's body rows into line
 * items, and refusing the rows that can't be read safely.
 *
 * Two kinds of input:
 *   - Hand-made tables, built directly as `Table` objects, with the roles
 *     given by hand (a hand-made RoleDecision). So a test sets exactly the
 *     cells and roles one rule looks at, without depending on roles.ts.
 *   - Fixture PDFs (tests/fixtures/build.ts and languages.ts), read the way
 *     the pipeline reads them: readPage, buildRows, findTable, the document's
 *     number conventions, decideRoles, then buildItems.
 *
 * Every item is checked against the LineItem schema, and every refusal and
 * note against its schema, in `expectValid`.
 *
 * All text in the hand-made tables is invented.
 */
import { describe, expect, it } from "vitest";

import { refusalMessage } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import { LineItem, Note, Refusal, type Column, type Role } from "@/lib/contract/schema";
import { classifyPage } from "@/lib/engine/classify-page";
import { arithmeticTolerance, buildItems, type ItemsResult } from "@/lib/engine/items";
import { CONVENTIONS, analyseNumber, conventionsFor, isNumericColumn, type Convention } from "@/lib/engine/numbers";
import { openDocument } from "@/lib/engine/open";
import { readPage } from "@/lib/engine/read-page";
import { decideRoles, type RoleDecision } from "@/lib/engine/roles";
import { buildRows, type Cell, type Row } from "@/lib/engine/rows";
import { cellShape } from "@/lib/engine/shapes";
import { columnKey, findTable, type PageLayout, type Table, type TableRow } from "@/lib/engine/table";

import {
  DEFAULT_ROWS,
  MISMATCH_ROW_INDEX,
  NUMBERS_ONLY_ROW,
  SHIFTED_ROWS,
  UNPARSEABLE_PRICE,
  buildPdf,
  mismatchRow,
  multiPage,
  numbersOnlyRow,
  shiftedColumns,
  unparseableCell,
} from "../fixtures/build";
import { LANGUAGE_FIXTURES, asReadBack } from "../fixtures/languages";

// ---------------------------------------------------------------------------
// Hand-made tables
// ---------------------------------------------------------------------------

/** The width of one column in a hand-made table, in points. */
const COLUMN_WIDTH = 80;
/** The width of one character in a hand-made cell, in points. Only used for x positions. */
const CHARACTER_WIDTH = 2;
/** The distance between two hand-made rows, in points. */
const ROW_GAP = 17;

/**
 * A hand-made row: its cells as text, "" for an empty cell. Cells are placed
 * in their column's band and joined by single spaces into the row's text, the
 * way rows.ts does it.
 */
function rowOf(index: number, texts: readonly string[], y = 100 + index * ROW_GAP): { row: Row; cells: (Cell | null)[] } {
  const cells: (Cell | null)[] = [];
  const filled: Cell[] = [];
  let offset = 0;
  texts.forEach((text, position) => {
    if (text === "") {
      cells.push(null);
      return;
    }
    const start = filled.length === 0 ? 0 : offset + 1;
    const x0 = position * COLUMN_WIDTH;
    const cell: Cell = {
      text,
      x0,
      x1: x0 + text.length * CHARACTER_WIDTH,
      pieces: [],
      joinSpaces: [],
      shape: cellShape(text),
      start,
      end: start + text.length,
    };
    offset = cell.end;
    filled.push(cell);
    cells.push(cell);
  });
  const row: Row = { index, y, fontSize: 9, cells: filled, text: filled.map((cell) => cell.text).join(" ") };
  return { row, cells };
}

/** A body row of a hand-made table, with optional wrapped lines (each given as its cells, "" for empty). */
interface HandRow {
  cells: readonly string[];
  wrap?: readonly (readonly string[])[];
}

/**
 * A hand-made table. `headers` null means no header row; a null inside the
 * list means that column has no heading. The header is row 0, and the body
 * rows (with their wrapped lines) are numbered after it.
 */
function makeTable(headers: readonly (string | null)[] | null, rows: readonly (readonly string[] | HandRow)[]): Table {
  const handRows: HandRow[] = rows.map((row) => ("cells" in row ? (row as HandRow) : { cells: row as readonly string[] }));
  const width = headers?.length ?? handRows[0].cells.length;
  const headerRows = headers ? [rowOf(0, headers.map((header) => header ?? "")).row] : [];
  let index = headerRows.length;
  let y = 100 + index * ROW_GAP;
  const body: TableRow[] = handRows.map((handRow) => {
    const { row, cells } = rowOf(index++, handRow.cells, y);
    const continuations = (handRow.wrap ?? []).map((line) => rowOf(index++, line, y + 9).row);
    y += ROW_GAP + continuations.length * 9;
    return { row, continuations, cells };
  });
  const columns = Array.from({ length: width }, (_, position) => {
    const header = headers?.[position] ?? null;
    const numeric = body.filter((bodyRow) => bodyRow.cells[position] && bodyRow.cells[position]?.shape !== "TEXT").length;
    return {
      position,
      header,
      key: columnKey(header, position),
      kind: numeric / body.length >= 0.5 ? ("numeric" as const) : ("text" as const),
      x0: position * COLUMN_WIDTH,
      x1: (position + 1) * COLUMN_WIDTH,
    };
  });
  return { columns, headerRows, body };
}

/** A role decision given by hand: one role per column, source "both", no notes. */
function decisionFor(table: Table, roles: readonly (Role | null)[], refusal: Refusal | null = null): RoleDecision {
  const columns: Column[] = table.columns.map((column) => ({
    header: column.header,
    key: column.key,
    role: roles[column.position] ?? null,
    roleSource: roles[column.position] ? "both" : null,
    kind: column.kind,
  }));
  return { columns, refusal, notes: [] };
}

/** The document's conventions for some tables, found the way the pipeline finds them. */
function conventionsOf(tables: readonly Table[]): Convention[] {
  const columns = tables.flatMap((table) =>
    table.columns.map((column) =>
      table.body.map((bodyRow) => {
        const cell = bodyRow.cells[column.position];
        return analyseNumber(cell?.text ?? "", cell?.joinSpaces ?? []);
      }),
    ),
  );
  return conventionsFor(columns.filter(isNumericColumn));
}

/** Every item, refusal and note passes its contract schema. */
function expectValid(result: ItemsResult): void {
  for (const item of result.items) {
    const parsed = LineItem.safeParse(item);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  }
  for (const refusal of result.refusals) expect(Refusal.safeParse(refusal).success).toBe(true);
  for (const note of result.notes) expect(Note.safeParse(note).success).toBe(true);
}

/** Builds the items of a hand-made table with hand-given roles, and checks them against the contract. */
function items(
  headers: readonly (string | null)[] | null,
  rows: readonly (readonly string[] | HandRow)[],
  roles: readonly (Role | null)[],
  options: { page?: number; conventions?: readonly Convention[]; refusal?: Refusal | null } = {},
): ItemsResult {
  const table = makeTable(headers, rows);
  const conventions = options.conventions ?? conventionsOf([table]);
  const result = buildItems(options.page ?? 1, table, decisionFor(table, roles, options.refusal ?? null), conventions);
  expectValid(result);
  return result;
}

/** The six standard headers and their roles. */
const HEADERS = ["Item", "Description", "Qty", "Unit", "Unit Price", "Line Total"];
const ROLES: Role[] = ["itemNo", "description", "quantity", "unit", "unitPrice", "lineTotal"];

/** Three rows that multiply correctly. */
const ROWS = [
  ["1", "Cedar post 2.4m treated", "4", "ea", "$12.00", "$48.00"],
  ["2", "Wire staple box 500", "2", "box", "$7.50", "$15.00"],
  ["3", "Gate latch galvanised", "3", "ea", "$21.00", "$63.00"],
];

/** The standard table with one row replaced. */
function withRow(index: number, row: readonly string[]): string[][] {
  return ROWS.map((original, i) => (i === index ? [...row] : [...original]));
}

/** Every field of every item points at exactly its raw text in the item's sourceText. */
function expectSpansSliceBack(result: ItemsResult): void {
  for (const item of result.items) {
    for (const field of Object.values(item.fields)) {
      expect(field?.span).toBeDefined();
      const [start, end] = field?.span ?? [0, 0];
      expect(item.sourceText.slice(start, end)).toBe(field?.raw);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture PDFs
// ---------------------------------------------------------------------------

/** One page of a fixture, read through the whole pipeline up to buildItems. */
interface FixturePage {
  layout: PageLayout;
  table: Table;
  decision: RoleDecision;
  result: ItemsResult;
}

/**
 * Reads every page of a fixture PDF the way the pipeline does: pass 1 finds
 * each page's table, then the document's conventions come from every table,
 * then pass 2 decides the roles and builds the items of each page.
 */
async function fixturePages(build: () => Promise<Uint8Array>): Promise<FixturePage[]> {
  const opened = await openDocument(await build());
  if (!opened.ok) throw new Error(`PDF did not open: ${opened.refusal.code}`);
  const layouts: { page: number; layout: PageLayout; table: Table }[] = [];
  try {
    for (let page = 1; page <= opened.doc.numPages; page++) {
      const classified = classifyPage(await readPage(opened.doc, opened.pdfjs, page));
      if (classified.kind !== "text") throw new Error(`page ${page} is not a text page`);
      const layout = findTable(buildRows(classified.pieces), page);
      if (!layout.table) throw new Error(`page ${page} has no table`);
      layouts.push({ page, layout, table: layout.table });
    }
  } finally {
    await opened.doc.loadingTask.destroy();
  }
  const conventions = conventionsOf(layouts.map(({ table }) => table));
  return layouts.map(({ page, layout, table }) => {
    const decision = decideRoles(table, conventions, page);
    const result = buildItems(page, table, decision, conventions);
    expectValid(result);
    return { layout, table, decision, result };
  });
}

/** The first page of a fixture. */
async function fixturePage(build: () => Promise<Uint8Array>): Promise<FixturePage> {
  return (await fixturePages(build))[0];
}

/** A money value as a test reads it: every mark but the decimal one removed. */
function plainValue(text: string, decimal: "." | ","): number {
  const digits = asReadBack(text).replace(/[^\d.,-]/g, "");
  return decimal === "," ? Number(digits.replace(/\./g, "").replace(",", ".")) : Number(digits.replace(/,/g, ""));
}

// ---------------------------------------------------------------------------
// The tolerance
// ---------------------------------------------------------------------------

describe("arithmeticTolerance", () => {
  it("is one cent plus half a cent for small quantities", () => {
    expect(arithmeticTolerance(1)).toBeCloseTo(0.015, 10);
    expect(arithmeticTolerance(0)).toBeCloseTo(0.015, 10);
    expect(arithmeticTolerance(2)).toBeCloseTo(0.015, 10);
  });

  it("grows by half a cent per unit above two units", () => {
    expect(arithmeticTolerance(3)).toBeCloseTo(0.02, 10);
    expect(arithmeticTolerance(10)).toBeCloseTo(0.055, 10);
    expect(arithmeticTolerance(1000)).toBeCloseTo(5.005, 10);
  });

  it("uses the size of a negative quantity", () => {
    expect(arithmeticTolerance(-10)).toBeCloseTo(arithmeticTolerance(10), 10);
  });
});

// ---------------------------------------------------------------------------
// The normal case
// ---------------------------------------------------------------------------

describe("buildItems: the normal case", () => {
  it("builds one item per row with ids p{page}-r{rowIndex}", () => {
    const result = items(HEADERS, ROWS, ROLES, { page: 3 });
    expect(result.items.map((item) => item.id)).toEqual(["p3-r1", "p3-r2", "p3-r3"]);
    expect(result.items.map((item) => item.rowIndex)).toEqual([1, 2, 3]);
    expect(result.items.every((item) => item.page === 3)).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.totalsRows).toEqual([]);
    expect(result.ambiguousNumbers).toBe(false);
  });

  it("gives every field the header as printed, the raw cell text and its span", () => {
    const [item] = items(HEADERS, ROWS, ROLES).items;
    expect(item.sourceText).toBe("1 Cedar post 2.4m treated 4 ea $12.00 $48.00");
    expect(item.fields.itemNo).toEqual({ header: "Item", raw: "1", span: [0, 1] });
    expect(item.fields.description).toEqual({ header: "Description", raw: "Cedar post 2.4m treated", span: [2, 25] });
    expect(item.fields.quantity).toEqual({ header: "Qty", raw: "4", value: 4, span: [26, 27] });
    expect(item.fields.unit).toEqual({ header: "Unit", raw: "ea", span: [28, 30] });
    expect(item.fields.unitPrice).toEqual({ header: "Unit Price", raw: "$12.00", value: 12, currency: null, span: [31, 37] });
    expect(item.fields.lineTotal).toEqual({ header: "Line Total", raw: "$48.00", value: 48, currency: null, span: [38, 44] });
    expect(item.otherCells).toEqual([]);
    expect(item.missing).toEqual([]);
  });

  it("gives a value only to quantity, unit price and line total, and a currency only to the money roles", () => {
    const [item] = items(HEADERS, ROWS, ROLES).items;
    for (const role of ["itemNo", "description", "unit"] as const) {
      expect(item.fields[role]).not.toHaveProperty("value");
      expect(item.fields[role]).not.toHaveProperty("currency");
    }
    expect(item.fields.quantity).not.toHaveProperty("currency");
    expect(item.fields.lineTotal).not.toHaveProperty("per");
  });

  it("uses null for a column without a heading", () => {
    const [item] = items(null, ROWS, ROLES).items;
    expect(item.fields.quantity?.header).toBeNull();
  });

  it("reads thousands marks, currency codes and negative values", () => {
    const result = items(HEADERS, [
      ["1", "Steel beam 6m", "2", "ea", "$1,234.50", "$2,469.00"],
      ["2", "Freight to site", "1", "trip", "NZ$ 45.00", "NZ$ 45.00"],
      ["3", "Returned bracket", "-2", "ea", "$4.00", "($8.00)"],
    ], ROLES);
    expect(result.refusals).toEqual([]);
    const [beam, freight, returned] = result.items;
    expect(beam.fields.unitPrice?.value).toBe(1234.5);
    expect(beam.fields.lineTotal?.value).toBe(2469);
    expect(freight.fields.unitPrice?.currency).toBe("NZD");
    expect(returned.fields.quantity?.value).toBe(-2);
    expect(returned.fields.lineTotal?.value).toBe(-8);
  });

  it("does not change the table or the decision it is given", () => {
    const table = makeTable(HEADERS, ROWS);
    const decision = decisionFor(table, ROLES);
    const before = JSON.stringify({ table, decision });
    buildItems(1, table, decision, conventionsOf([table]));
    expect(JSON.stringify({ table, decision })).toBe(before);
  });

  it("lists nothing when an AMBIGUOUS_COLUMNS decision arrives", () => {
    const table = makeTable(HEADERS, ROWS);
    const refusal = decideRoles(makeTable(["Qty", "Quantity", "Price"], [["2", "2", "$1.00"], ["3", "3", "$2.00"]]), CONVENTIONS, 1).refusal;
    expect(refusal?.code).toBe("AMBIGUOUS_COLUMNS");
    const result = buildItems(1, table, decisionFor(table, ROLES, refusal), conventionsOf([table]));
    expect(result.items).toEqual([]);
    expect(result.refusals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty cells and unknown columns
// ---------------------------------------------------------------------------

describe("buildItems: empty cells and columns we don't read", () => {
  it("puts an empty unit price into missing and never computes it", () => {
    const result = items(HEADERS, withRow(1, ["2", "Hinge pin 60mm", "4", "ea", "", "$18.00"]), ROLES);
    const item = result.items[1];
    expect(item.missing).toEqual(["unitPrice"]);
    expect(item.fields.unitPrice).toBeUndefined();
    // 18 / 4 = 4.5 would be the computed unit price. It must appear nowhere.
    expect(JSON.stringify(result)).not.toContain("4.5");
    expect(result.refusals).toEqual([]);
  });

  it("puts an empty text cell into missing too", () => {
    const result = items(HEADERS, withRow(0, ["", "Cedar post 2.4m treated", "4", "", "$12.00", "$48.00"]), ROLES);
    expect(result.items[0].missing).toEqual(["itemNo", "unit"]);
  });

  it("puts the cells of a column with no role into otherCells, never into fields", () => {
    const headers = ["Item", "Description", "Qty", "Weight", "Unit Price", "Line Total"];
    const roles: (Role | null)[] = ["itemNo", "description", "quantity", null, "unitPrice", "lineTotal"];
    const rows = [
      ["1", "Cedar post 2.4m treated", "4", "12kg", "$12.00", "$48.00"],
      ["2", "Wire staple box 500", "2", "", "$7.50", "$15.00"],
    ];
    const result = items(headers, rows, roles);
    expect(result.items[0].otherCells).toEqual([{ header: "Weight", key: "weight", raw: "12kg" }]);
    // An empty cell is kept as "", so every item shows the same columns.
    expect(result.items[1].otherCells).toEqual([{ header: "Weight", key: "weight", raw: "" }]);
    for (const item of result.items) {
      expect(Object.values(item.fields).map((field) => field?.raw)).not.toContain("12kg");
      expect(item.missing).toEqual([]);
    }
  });

  it("keeps a percent in a column with no role as printed", () => {
    const headers = ["Item", "Description", "Qty", "Unit Price", "Disc %", "Line Total"];
    const roles: (Role | null)[] = ["itemNo", "description", "quantity", "unitPrice", null, "lineTotal"];
    const result = items(headers, [["1", "Cedar post 2.4m treated", "4", "$12.00", "0%", "$48.00"]], roles);
    expect(result.refusals).toEqual([]);
    expect(result.items[0].otherCells).toEqual([{ header: "Disc %", key: "disc", raw: "0%" }]);
  });

  it("gives an item with no line total column no lineTotal and no missing entry", () => {
    const result = items(["Item", "Description", "Qty", "Unit Price"], [["1", "Cedar post", "4", "$12.00"]], [
      "itemNo",
      "description",
      "quantity",
      "unitPrice",
    ]);
    expect(result.items[0].fields.lineTotal).toBeUndefined();
    expect(result.items[0].missing).toEqual([]);
  });
});

describe("buildItems: mixed 'total' wording in a column we don't read", () => {
  const headers = ["Item", "Description", "Qty", "Weight", "Unit Price"];
  const roles: (Role | null)[] = ["itemNo", "description", "quantity", null, "unitPrice"];

  it("warns when some cells say 'total' and others don't, quoting one of each in table order", () => {
    const result = items(headers, [
      ["1", "Garden lime sack", "6", "20kg", "$14.40"],
      ["2", "Hook set", "4", "600g total", "$2.60"],
      ["3", "Brass hinge", "2", "85g", "$3.15"],
    ], roles, { page: 2 });
    expect(result.notes).toEqual([NOTES.mixedTotalWording(2, "Weight", ["20kg", "600g total"])]);
    expect(result.notes[0].level).toBe("warning");
  });

  it("quotes the 'total' cell first when it comes first", () => {
    const result = items(headers, [
      ["1", "Hook set", "4", "600g total", "$2.60"],
      ["2", "Garden lime sack", "6", "20kg", "$14.40"],
    ], roles);
    expect(result.notes).toEqual([NOTES.mixedTotalWording(1, "Weight", ["600g total", "20kg"])]);
  });

  it("gives no warning when no cell says 'total'", () => {
    const result = items(headers, [
      ["1", "Garden lime sack", "6", "20kg", "$14.40"],
      ["2", "Brass hinge", "2", "85g", "$3.15"],
    ], roles);
    expect(result.notes).toEqual([]);
  });

  it("gives no warning when every cell says 'total'", () => {
    const result = items(headers, [
      ["1", "Garden lime sack", "6", "120kg total", "$14.40"],
      ["2", "Brass hinge", "2", "170g total", "$3.15"],
    ], roles);
    expect(result.notes).toEqual([]);
  });

  it("does not count a word that only contains 'total' ('totally')", () => {
    const result = items(headers, [
      ["1", "Garden lime sack", "6", "20kg", "$14.40"],
      ["2", "Brass hinge", "2", "totally 85g", "$3.15"],
    ], roles);
    expect(result.notes).toEqual([]);
  });

  it("gives no warning for a column that has a role", () => {
    const result = items(["Item", "Description", "Qty", "Unit Price"], [
      ["1", "Hook set total", "4", "$2.60"],
      ["2", "Garden lime sack", "6", "$14.40"],
    ], ["itemNo", "description", "quantity", "unitPrice"]);
    expect(result.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cells that can't be read
// ---------------------------------------------------------------------------

describe("buildItems: cells that can't be read", () => {
  /** The single refusal of a result. */
  function onlyRefusal(result: ItemsResult): Refusal {
    expect(result.refusals).toHaveLength(1);
    return result.refusals[0];
  }

  it.each([
    ["a unit word without a '/' as a unit price", 4, "$12.50 box"],
    ["a '/unit' ending on a line total", 5, "$12.50 /box"],
    ["a '/unit' ending on a quantity", 2, "4 /box"],
    ["a percent as a quantity", 2, "40%"],
    ["a currency marker on a quantity", 2, "$4"],
    ["a unit inside a quantity cell", 2, "4 boxes"],
    ["a broken thousands mark", 4, "1,2.50"],
    ["two decimal marks", 4, "12.5.0"],
    ["letters after the digits", 2, "12a"],
    ["a broken character", 5, "1�2"],
  ])("refuses %s as UNPARSEABLE_NUMBER", (_name, position, raw) => {
    const row = [...ROWS[1]];
    row[position] = raw;
    const result = items(HEADERS, withRow(1, row), ROLES, { page: 2 });
    const refusal = onlyRefusal(result);
    expect(refusal.code).toBe("UNPARSEABLE_NUMBER");
    expect(refusal.id).toBe("p2-r2-UNPARSEABLE_NUMBER");
    expect(refusal.rowIndex).toBe(2);
    expect(refusal.message).toBe(refusalMessage({ code: "UNPARSEABLE_NUMBER", page: 2, raw }));
    expect(refusal.evidence).toEqual([{ page: 2, sourceText: row.join(" ") }]);
    // The other rows are not affected.
    expect(result.items.map((item) => item.id)).toEqual(["p2-r1", "p2-r3"]);
  });

  it("reads '$12.50 /box' as a unit price, with per 'box'", () => {
    const result = items(HEADERS, withRow(1, ["2", "Tile spacers 3mm", "4", "box", "$12.50 /box", "$50.00"]), ROLES);
    expect(result.refusals).toEqual([]);
    expect(result.items[1].fields.unitPrice).toEqual({
      header: "Unit Price",
      raw: "$12.50 /box",
      value: 12.5,
      per: "box",
      currency: null,
      span: [25, 36],
    });
  });

  it("reads a unit price like '$0.15 /ea' and a plain quantity", () => {
    const result = items(HEADERS, withRow(1, ["2", "Cable tie", "100", "ea", "$0.15 /ea", "$15.00"]), ROLES);
    expect(result.refusals).toEqual([]);
    expect(result.items[1].fields.unitPrice?.per).toBe("ea");
    expect(result.items[1].fields.quantity?.value).toBe(100);
  });

  it("names the first bad cell from the left, and gives one refusal per row", () => {
    const result = items(HEADERS, withRow(0, ["1", "Cedar post", "four", "ea", "$12.00 box", "$48.00"]), ROLES);
    const refusal = onlyRefusal(result);
    expect(refusal.message).toBe(refusalMessage({ code: "UNPARSEABLE_NUMBER", page: 1, raw: "four" }));
  });

  it("refuses a cell with two readings as AMBIGUOUS_NUMBER_FORMAT, with the readings written plainly", () => {
    // With every convention still possible, "1.200" is 1.2 or 1200. The readings
    // come in the order of CONVENTIONS, where "." decimals come first.
    const result = items(HEADERS, withRow(1, ["2", "Wire staple box 500", "1.200", "kg", "$7.50", "$9.00"]), ROLES, {
      conventions: CONVENTIONS,
    });
    const refusal = onlyRefusal(result);
    expect(refusal.code).toBe("AMBIGUOUS_NUMBER_FORMAT");
    expect(refusal.message).toBe(
      refusalMessage({ code: "AMBIGUOUS_NUMBER_FORMAT", page: 1, raw: "1.200", readings: ["1.2", "1200"], target: "line" }),
    );
    expect(result.ambiguousNumbers).toBe(true);
    expect(result.items).toHaveLength(2);
  });

  it("reads the same cell when the document's conventions settle it", () => {
    const result = items(HEADERS, withRow(1, ["2", "Wire staple box 500", "1.200", "kg", "$7.50", "$9.00"]), ROLES, {
      conventions: [{ decimal: ".", grouping: "," }],
    });
    expect(result.refusals).toEqual([]);
    expect(result.items[1].fields.quantity?.value).toBe(1.2);
    expect(result.ambiguousNumbers).toBe(false);
  });

  it("doesn't set ambiguousNumbers when the refusal names another cell of the row", () => {
    // "1.200" has two readings, but the refusal names "two" (further left).
    // The person sees no AMBIGUOUS_NUMBER_FORMAT refusal, so the number
    // format must not say that a number had two readings.
    const result = items(HEADERS, withRow(1, ["2", "Wire staple box 500", "two", "kg", "1.200", "$9.00"]), ROLES, {
      conventions: CONVENTIONS,
    });
    expect(result.refusals[0].code).toBe("UNPARSEABLE_NUMBER");
    expect(result.ambiguousNumbers).toBe(false);
  });

  it("refuses every number when the document mixes formats and no convention is left", () => {
    const result = items(HEADERS, ROWS, ROLES, { conventions: [] });
    expect(result.items).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["UNPARSEABLE_NUMBER", "UNPARSEABLE_NUMBER", "UNPARSEABLE_NUMBER"]);
  });

  it("refuses the fixture's '$12.50 box' unit price and keeps the other rows", async () => {
    const { result } = await fixturePage(unparseableCell);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["UNPARSEABLE_NUMBER"]);
    expect(result.refusals[0].message).toBe(refusalMessage({ code: "UNPARSEABLE_NUMBER", page: 1, raw: UNPARSEABLE_PRICE }));
    expect(result.items).toHaveLength(DEFAULT_ROWS.length - 1);
  });
});

// ---------------------------------------------------------------------------
// No description
// ---------------------------------------------------------------------------

describe("buildItems: numbers with no description", () => {
  it("refuses a numbers-only row as NO_DESCRIPTION, quoting the row", () => {
    const row = ["4", "", "6", "ea", "$3.00", "$18.00"];
    const result = items(HEADERS, [...ROWS, row], ROLES, { page: 2 });
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal.code).toBe("NO_DESCRIPTION");
    expect(refusal.message).toBe(refusalMessage({ code: "NO_DESCRIPTION", page: 2, rowText: "4 6 ea $3.00 $18.00" }));
    expect(refusal.evidence).toEqual([{ page: 2, sourceText: "4 6 ea $3.00 $18.00" }]);
    expect(result.items).toHaveLength(3);
  });

  it("refuses rows with numbers when the table has no description column at all", () => {
    const result = items(["Code", "Qty", "Unit Price"], [["AB-100", "2", "$3.00"]], ["code", "quantity", "unitPrice"]);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["NO_DESCRIPTION"]);
  });

  it("keeps a row with no description and no number as an item", () => {
    const result = items(HEADERS, [...ROWS, ["4", "", "", "ea", "", ""]], ROLES);
    expect(result.refusals).toEqual([]);
    expect(result.items[3].missing).toEqual(["description", "quantity", "unitPrice", "lineTotal"]);
  });

  it("refuses the fixture's numbers-only row and keeps the others", async () => {
    const { result } = await fixturePage(numbersOnlyRow);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["NO_DESCRIPTION"]);
    expect(result.refusals[0].message).toBe(
      refusalMessage({ code: "NO_DESCRIPTION", page: 1, rowText: NUMBERS_ONLY_ROW.filter((cell) => cell !== "").join(" ") }),
    );
    expect(result.items).toHaveLength(DEFAULT_ROWS.length);
  });
});

// ---------------------------------------------------------------------------
// The arithmetic check
// ---------------------------------------------------------------------------

describe("buildItems: the arithmetic check", () => {
  it("refuses a row whose line total is not quantity x unit price, quoting all three and the product", () => {
    const result = items(HEADERS, withRow(1, ["2", "Wire staple box 500", "8", "box", "$22.25", "$187.00"]), ROLES, { page: 4 });
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal.code).toBe("ARITHMETIC_MISMATCH");
    expect(refusal.id).toBe("p4-r2-ARITHMETIC_MISMATCH");
    expect(refusal.message).toBe(
      refusalMessage({
        code: "ARITHMETIC_MISMATCH",
        page: 4,
        quantity: "8",
        unitPrice: "$22.25",
        lineTotal: "$187.00",
        expected: "$178.00",
        columnBetween: null,
      }),
    );
    expect(refusal.message).toContain("$178.00 (calculated by us)");
    expect(refusal.evidence).toEqual([{ page: 4, sourceText: "2 Wire staple box 500 8 box $22.25 $187.00" }]);
    // No item for that row, and the computed product is nowhere in the items.
    expect(result.items.map((item) => item.id)).toEqual(["p4-r1", "p4-r3"]);
    expect(JSON.stringify(result.items)).not.toContain("178");
  });

  it("refuses a $10,000 line that is off by $1", () => {
    const result = items(HEADERS, [["1", "Portal frame kit", "1", "set", "$10,000.00", "$10,001.00"]], ROLES);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["ARITHMETIC_MISMATCH"]);
    expect(result.refusals[0].message).toContain("$10,000.00 (calculated by us)");
  });

  it("accepts the same $10,000 line when it multiplies", () => {
    const result = items(HEADERS, [["1", "Portal frame kit", "1", "set", "$10,000.00", "$10,000.00"]], ROLES);
    expect(result.refusals).toEqual([]);
  });

  it("accepts a line off by half a cent (a unit price rounded to the cent)", () => {
    const result = items(HEADERS, [
      ["1", "Washer M6 bag", "3", "bag", "$0.335", "$1.00"],
      ["2", "Rivet pack", "1", "pack", "$10.00", "$10.005"],
    ], ROLES);
    expect(result.refusals).toEqual([]);
    expect(result.items).toHaveLength(2);
  });

  it("refuses a line off by two cents at quantity 1", () => {
    const result = items(HEADERS, [["1", "Rivet pack", "1", "pack", "$10.00", "$10.02"]], ROLES);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["ARITHMETIC_MISMATCH"]);
  });

  it("writes the product in the document's own format, with the line total's decimals and marker", () => {
    const conventions: Convention[] = [{ decimal: ",", grouping: " " }];
    const result = items(HEADERS, [["1", "Plaque de plâtre", "2", "pièce", "610,50 €", "1 220,00 €"]], ROLES, { conventions });
    expect(result.refusals[0].message).toBe(
      refusalMessage({
        code: "ARITHMETIC_MISMATCH",
        page: 1,
        quantity: "2",
        unitPrice: "610,50 €",
        lineTotal: "1 220,00 €",
        expected: "1 221,00 €",
        columnBetween: null,
      }),
    );
  });

  it("names a column we don't read between the unit price and the line total", () => {
    const headers = ["Item", "Description", "Qty", "Unit Price", "Disc %", "Line Total"];
    const roles: (Role | null)[] = ["itemNo", "description", "quantity", "unitPrice", null, "lineTotal"];
    const result = items(headers, [["1", "Soft close runner", "8", "$24.50", "10%", "$176.40"]], roles);
    expect(result.refusals[0].message).toBe(
      refusalMessage({
        code: "ARITHMETIC_MISMATCH",
        page: 1,
        quantity: "8",
        unitPrice: "$24.50",
        lineTotal: "$176.40",
        expected: "$196.00",
        columnBetween: "Disc %",
      }),
    );
  });

  it("names no column when the column we don't read is outside the price and the total", () => {
    const headers = ["Item", "Description", "Qty", "Unit Price", "Line Total", "Notes"];
    const roles: (Role | null)[] = ["itemNo", "description", "quantity", "unitPrice", "lineTotal", null];
    const result = items(headers, [["1", "Soft close runner", "8", "$24.50", "$176.40", "10% off"]], roles);
    expect(result.refusals[0].message).not.toContain("which may explain");
  });

  it("finds the column between them when the line total comes first", () => {
    const headers = ["Description", "Qty", "Line Total", "Disc %", "Unit Price"];
    const roles: (Role | null)[] = ["description", "quantity", "lineTotal", null, "unitPrice"];
    const result = items(headers, [["Soft close runner", "8", "$176.40", "10%", "$24.50"]], roles);
    expect(result.refusals[0].message).toContain("'Disc %' column");
  });

  it("runs no check when the table has no line total column", () => {
    const result = items(["Item", "Description", "Qty", "Unit Price"], [["1", "Cedar post", "4", "$12.00"]], [
      "itemNo",
      "description",
      "quantity",
      "unitPrice",
    ]);
    expect(result.refusals).toEqual([]);
  });

  it("runs no check when the line total cell is empty", () => {
    const result = items(HEADERS, withRow(0, ["1", "Cedar post", "4", "ea", "$12.00", ""]), ROLES);
    expect(result.refusals).toEqual([]);
    expect(result.items[0].missing).toEqual(["lineTotal"]);
  });

  it("refuses the fixture's wrong row and adds no item for it", async () => {
    const { result } = await fixturePage(mismatchRow);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["ARITHMETIC_MISMATCH"]);
    const refusal = result.refusals[0];
    const row = DEFAULT_ROWS[MISMATCH_ROW_INDEX];
    for (const raw of [row[2], row[4], "$187.00"]) expect(refusal.message).toContain(raw);
    expect(refusal.message).toContain(`${row[5]} (calculated by us)`);
    expect(result.items).toHaveLength(DEFAULT_ROWS.length - 1);
    expect(result.items.map((item) => item.rowIndex)).not.toContain(refusal.rowIndex);
  });

  it("refuses the discounted row of the Disc % fixture and names the column", async () => {
    const { result } = await fixturePage(LANGUAGE_FIXTURES.qtyOneDisc.build);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0].code).toBe("ARITHMETIC_MISMATCH");
    expect(result.refusals[0].message).toContain("'Disc %' column");
    expect(result.items).toHaveLength(LANGUAGE_FIXTURES.qtyOneDisc.rowCount - 1);
  });
});

// ---------------------------------------------------------------------------
// Wrapped descriptions
// ---------------------------------------------------------------------------

describe("buildItems: wrapped descriptions", () => {
  it("adds the wrapped line to sourceText after a '\\n' and keeps the description to its own cell when numbers follow it", () => {
    const result = items(HEADERS, [
      { cells: ROWS[0], wrap: [["", "pressure treated H4"]] },
      ROWS[1],
    ], ROLES);
    const [first, second] = result.items;
    expect(first.sourceText).toBe(`${ROWS[0].join(" ")}\npressure treated H4`);
    expect(first.fields.description?.raw).toBe("Cedar post 2.4m treated");
    expect(first.id).toBe("p1-r1");
    // The wrapped line has its own row index; the next item's index counts it.
    expect(second.id).toBe("p1-r3");
    expectSpansSliceBack(result);
    // The description field shows only the first line, and a note says so.
    expect(result.notes).toEqual([NOTES.descriptionWraps(1)]);
  });

  it("adds the wrapped lines to the description when the description is the last cell", () => {
    const result = items(["Qty", "Unit Price", "Description"], [
      { cells: ["4", "$12.00", "Cedar post 2.4m"], wrap: [["", "", "pressure treated"], ["", "", "H4 grade"]] },
    ], ["quantity", "unitPrice", "description"]);
    const [item] = result.items;
    expect(item.sourceText).toBe("4 $12.00 Cedar post 2.4m\npressure treated\nH4 grade");
    expect(item.fields.description?.raw).toBe("Cedar post 2.4m\npressure treated\nH4 grade");
    expect(item.fields.description?.span).toEqual([9, 50]);
    expectSpansSliceBack(result);
    expect(result.notes).toEqual([]);
  });

  it("stops adding wrapped lines at a line with a cell in another column", () => {
    const result = items(["Qty", "Unit Price", "Description"], [
      { cells: ["4", "$12.00", "Cedar post 2.4m"], wrap: [["", "", "pressure treated"], ["", "each", "H4 grade"]] },
    ], ["quantity", "unitPrice", "description"]);
    const [item] = result.items;
    expect(item.fields.description?.raw).toBe("Cedar post 2.4m\npressure treated");
    expectSpansSliceBack(result);
  });

  it("quotes the main row and its wrapped lines in a row refusal", () => {
    const result = items(HEADERS, [{ cells: withRow(0, ["1", "Cedar post", "four", "ea", "$12.00", "$48.00"])[0], wrap: [["", "treated"]] }], ROLES);
    expect(result.refusals[0].evidence).toEqual([{ page: 1, sourceText: "1 Cedar post four ea $12.00 $48.00\ntreated" }]);
  });

  it("gives the wrapped-description fixture spans that slice back to raw, and no refusal", async () => {
    const { result, layout } = await fixturePage(LANGUAGE_FIXTURES.wrappedDescription.build);
    const fixture = LANGUAGE_FIXTURES.wrappedDescription;
    expect(result.items).toHaveLength(fixture.rowCount);
    expect(result.refusals).toEqual([]);
    expectSpansSliceBack(result);
    for (const { row, lines } of fixture.wrapped) {
      const item = result.items[row];
      expect(item.sourceText).toBe([fixture.rows[row].filter((cell) => cell !== "").join(" "), ...lines].join("\n"));
      expect(item.fields.description?.raw).toBe(fixture.rows[row][1]);
    }
    // The note far below the table never joins a description or an item.
    for (const line of fixture.after) {
      for (const item of result.items) expect(item.sourceText).not.toContain(line);
      expect(layout.below.map((row) => row.text)).toContain(line);
    }
  });
});

// ---------------------------------------------------------------------------
// The totals safety net
// ---------------------------------------------------------------------------

describe("buildItems: totals rows inside the body", () => {
  it("moves a 'Total' row with no quantity and no unit price to totalsRows, with a note that quotes it", () => {
    const table = makeTable(HEADERS, [...ROWS, ["", "Total", "", "", "", "$126.00"]]);
    const result = buildItems(1, table, decisionFor(table, ROLES), conventionsOf([table]));
    expectValid(result);
    expect(result.totalsRows).toEqual([{ row: table.body[3].row, amount: table.body[3].cells[5], hasTotalColumn: true }]);
    expect(result.items).toHaveLength(3);
    expect(result.refusals).toEqual([]);
    expect(result.notes).toContainEqual(NOTES.totalsRowSkipped(1, "Total $126.00"));
  });

  it.each(["Subtotal:", "Sub total", "GST 15%", "Totals", "Amount due", "TOTAL inc GST"])("moves a row starting with '%s'", (label) => {
    const result = items(HEADERS, [...ROWS, ["", label, "", "", "", "$126.00"]], ROLES);
    expect(result.totalsRows).toHaveLength(1);
    expect(result.items).toHaveLength(3);
  });

  // $45.00 is not the sum of the rows above ($126.00), so only the words decide.
  it.each(["Totally new stock", "Freight total", "Deck screws", "GST-free delivery"])(
    "keeps a row starting with '%s' as a line",
    (label) => {
      const result = items(HEADERS, [...ROWS, ["", label, "", "", "", "$45.00"]], ROLES);
      expect(result.totalsRows).toEqual([]);
      expect(result.items).toHaveLength(4);
    },
  );

  it("keeps a row that starts with a totals word but has a unit price", () => {
    const result = items(HEADERS, [...ROWS, ["", "GST 15% delivery", "1", "trip", "$25.00", "$25.00"]], ROLES);
    expect(result.totalsRows).toEqual([]);
    expect(result.items).toHaveLength(4);
  });

  it("moves a 'Total' row that has a quantity but no unit price, as a packing list prints it", () => {
    const result = items(HEADERS, [...ROWS, ["", "Total", "9", "", "", "$45.00"]], ROLES);
    expect(result.totalsRows).toHaveLength(1);
    expect(result.items).toHaveLength(3);
  });

  it("looks only at the first cell of the row", () => {
    const result = items(HEADERS, [...ROWS, ["9", "Total", "", "", "", "$45.00"]], ROLES);
    expect(result.totalsRows).toEqual([]);
  });

  it("moves a line whose amount is the sum of the lines above, in any language", () => {
    const result = items(HEADERS, [...ROWS, ["", "Sous-total", "9", "", "", "$126.00"]], ROLES);
    expect(result.totalsRows).toHaveLength(1);
    expect(result.items).toHaveLength(3);
    expect(result.notes).toContainEqual(NOTES.totalsRowSkipped(1, "Sous-total 9 $126.00"));
  });

  it("starts the sum again after a totals row", () => {
    const rows = [...ROWS, ["", "Sous-total", "", "", "", "$126.00"], ...ROWS.map((row) => [...row]), ["", "Sous-total", "", "", "", "$126.00"]];
    const result = items(HEADERS, rows, ROLES);
    expect(result.totalsRows).toHaveLength(2);
    expect(result.items).toHaveLength(6);
  });

  it("keeps a line equal to the sum when a unit price is printed, or when fewer than 2 lines are above", () => {
    const withPrice = items(HEADERS, [...ROWS, ["", "Bulk order", "1", "lot", "$126.00", "$126.00"]], ROLES);
    expect(withPrice.totalsRows).toEqual([]);
    const oneAbove = items(HEADERS, [ROWS[0], ["", "Delivery", "", "", "", "$48.00"]], ROLES);
    expect(oneAbove.totalsRows).toEqual([]);
    expect(oneAbove.items).toHaveLength(2);
  });

  it("doesn't use the sum when a line above was refused, because the sum has a gap", () => {
    const rows = [ROWS[0], ["2", "Wire staple box 500", "two", "box", "$7.50", "$15.00"], ROWS[2], ["", "Sous-total", "", "", "", "$111.00"]];
    const result = items(HEADERS, rows, ROLES);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["UNPARSEABLE_NUMBER"]);
    expect(result.totalsRows).toEqual([]);
  });

  it("treats a missing quantity column as empty", () => {
    const result = items(["Description", "Unit Price", "Line Total"], [
      ["Cedar post", "$12.00", "$12.00"],
      ["Total", "", "$12.00"],
    ], ["description", "unitPrice", "lineTotal"]);
    expect(result.totalsRows).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("buildItems: numbers written in other ways", () => {
  it("reads a quantity with three capital letters as its unit ('50 KGS'), because a quantity is never money", () => {
    const result = items(["Description", "Qty", "Unit Price", "Line Total"], [
      ["Cement GP 40kg bag", "50 KGS", "$0.45", "$22.50"],
      ["Builders lime", "120 KGS", "$0.80", "$96.00"],
    ], ["description", "quantity", "unitPrice", "lineTotal"]);
    expect(result.refusals).toEqual([]);
    expect(result.items[0].fields.quantity).toMatchObject({ raw: "50 KGS", value: 50 });
    expect(result.items[0].fields.quantity).not.toHaveProperty("currency");
  });

  it("says a number is written in another format than the rest of its page", () => {
    const result = items(HEADERS, withRow(1, ["2", "Wire staple box 500", "1,5", "box", "$7.50", "$11.25"]), ROLES, {
      conventions: [{ decimal: ".", grouping: "," }],
    });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0].message).toBe(
      refusalMessage({ code: "UNPARSEABLE_NUMBER", page: 1, raw: "1,5", otherFormat: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Pages whose columns we couldn't understand
// ---------------------------------------------------------------------------

describe("buildItems: COLUMN_MEANING_UNKNOWN", () => {
  const headers = ["Account", "Terms", "Balance"];
  const rows = [
    ["4471", "30 days", "$1,250.00"],
    ["5820", "7 days", "$310.40"],
    ["6112", "20th of month", "$92.15"],
  ];

  it("lists the rows as printed, with no value anywhere", () => {
    const table = makeTable(headers, rows);
    const conventions = conventionsOf([table]);
    const decision = decideRoles(table, conventions, 2);
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
    const result = buildItems(2, table, decision, conventions);
    expectValid(result);
    expect(result.items).toHaveLength(3);
    expect(result.refusals).toEqual([]);
    expect(JSON.stringify(result.items)).not.toContain('"value"');
    expect(result.items[0].otherCells.map((cell) => cell.raw)).toEqual(
      decision.columns.flatMap((column, position) => (column.role === null ? [rows[0][position]] : [])),
    );
  });

  it("keeps the text roles that were decided, and puts the rest in otherCells", () => {
    const refusal = decideRoles(makeTable(headers, rows), CONVENTIONS, 1).refusal;
    const result = items(["Description", "Weight", "Size"], [
      ["Cedar post", "12", "2.4"],
      ["", "3", "1.2"],
    ], ["description", null, null], { refusal });
    expect(result.refusals).toEqual([]);
    expect(Object.keys(result.items[0].fields)).toEqual(["description"]);
    expect(result.items[0].otherCells).toEqual([
      { header: "Weight", key: "weight", raw: "12" },
      { header: "Size", key: "size", raw: "2.4" },
    ]);
    // No number is read, so a row without a description is not refused either.
    expect(result.items[1].missing).toEqual(["description"]);
  });

  it("never reads a number column on such a page, even if one arrives with a role", () => {
    const refusal = decideRoles(makeTable(headers, rows), CONVENTIONS, 1).refusal;
    const result = items(HEADERS, withRow(0, ["1", "Cedar post", "4", "ea", "$12.00", "$99.00"]), ROLES, { refusal });
    expect(result.refusals).toEqual([]);
    for (const item of result.items) {
      expect(item.fields.quantity).toBeUndefined();
      expect(item.fields.lineTotal).toBeUndefined();
      expect(item.otherCells.map((cell) => cell.key)).toEqual(["qty", "unitPrice", "lineTotal"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture PDFs end to end
// ---------------------------------------------------------------------------

describe("buildItems on fixture PDFs", () => {
  it("reads the default page: three items, ids from their rows, every value from its cell", async () => {
    const { result } = await fixturePage(() => buildPdf());
    expect(result.items.map((item) => item.id)).toEqual(["p1-r3", "p1-r4", "p1-r5"]);
    expect(result.refusals).toEqual([]);
    expect(result.notes).toEqual([]);
    result.items.forEach((item, i) => {
      const row = DEFAULT_ROWS[i];
      expect(item.sourceText).toBe(row.join(" "));
      expect(item.fields.quantity?.value).toBe(Number(row[2]));
      expect(item.fields.unitPrice?.value).toBe(plainValue(row[4], "."));
      expect(item.fields.lineTotal?.value).toBe(plainValue(row[5], "."));
    });
    expectSpansSliceBack(result);
  });

  it("reads the French fixture's values under ',' decimals, with currency EUR", async () => {
    const { result } = await fixturePage(LANGUAGE_FIXTURES.french.build);
    const fixture = LANGUAGE_FIXTURES.french;
    expect(result.refusals).toEqual([]);
    expect(result.items).toHaveLength(fixture.rowCount);
    result.items.forEach((item, i) => {
      const row = fixture.rows[i];
      expect(item.fields.quantity?.value).toBe(plainValue(row[2], ","));
      expect(item.fields.unitPrice?.value).toBe(plainValue(row[4], ","));
      expect(item.fields.lineTotal?.value).toBe(plainValue(row[5], ","));
      expect(item.fields.unitPrice?.currency).toBe("EUR");
      expect(item.fields.lineTotal?.currency).toBe("EUR");
      expect(item.fields.lineTotal?.raw).toBe(asReadBack(row[5]));
    });
    expectSpansSliceBack(result);
    // At least one value is 1000 or more, so the grouping really was read.
    expect(result.items.some((item) => (item.fields.lineTotal?.value ?? 0) >= 1000)).toBe(true);
  });

  it("puts the Vietnamese fixture's unknown columns into otherCells and runs no arithmetic check", async () => {
    const { result } = await fixturePage(LANGUAGE_FIXTURES.vietnamese.build);
    expect(result.refusals).toEqual([]);
    expect(result.items).toHaveLength(LANGUAGE_FIXTURES.vietnamese.rowCount);
    for (const item of result.items) {
      expect(item.otherCells.map((cell) => cell.header)).toEqual(["SL", "Đơn giá"]);
      expect(item.fields.quantity).toBeUndefined();
      expect(item.fields.lineTotal?.currency).toBeNull();
    }
  });

  it("reads the shifted-columns fixture: price units, no line total, the weight warning", async () => {
    const { result } = await fixturePage(shiftedColumns);
    expect(result.refusals).toEqual([]);
    expect(result.items.map((item) => item.fields.unitPrice?.per)).toEqual(["bag", "ea", "ea", "bundle"]);
    for (const item of result.items) {
      expect(item.fields.lineTotal).toBeUndefined();
      expect(item.missing).toEqual([]);
      expect(item.otherCells.map((cell) => cell.key)).toEqual(["weight"]);
    }
    expect(result.items.map((item) => item.otherCells[0].raw)).toEqual(SHIFTED_ROWS.map((row) => row[3]));
    expect(result.notes).toEqual([NOTES.mixedTotalWording(1, "Weight", [SHIFTED_ROWS[0][3], SHIFTED_ROWS[2][3]])]);
  });

  it("never lists the carried-forward row of the multi-page fixture", async () => {
    const pages = await fixturePages(multiPage);
    const all = pages.flatMap((page) => page.result.items);
    expect(all).toHaveLength(9);
    expect(all.map((item) => item.id.split("-")[0])).toEqual(["p1", "p1", "p1", "p2", "p2", "p2", "p3", "p3", "p3"]);
    expect(all.some((item) => item.sourceText.toLowerCase().includes("carried forward"))).toBe(false);
    expect(pages.every((page) => page.result.refusals.length === 0)).toBe(true);
  });

  it.each(["german", "englishSynonyms", "reorderedRightAligned", "twoLineHeader", "centredHeaders", "onePiecePerWord"] as const)(
    "%s: every row becomes an item with valid spans and no refusal",
    async (name) => {
      const { result } = await fixturePage(LANGUAGE_FIXTURES[name].build);
      expect(result.refusals).toEqual([]);
      expect(result.items).toHaveLength(LANGUAGE_FIXTURES[name].rowCount);
      expectSpansSliceBack(result);
    },
  );
});
