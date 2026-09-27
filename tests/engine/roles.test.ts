/**
 * Tests for src/lib/engine/roles.ts: deciding what each column of a table
 * means, from the numbers first and the header words second.
 *
 * Three kinds of input:
 *   - Hand-made tables, built directly as `Table` objects (no PDF, no layout),
 *     so a test can set exactly the cells one rule looks at.
 *   - The language and layout fixtures (tests/fixtures/languages.ts): real
 *     PDFs read with pdf.js, with the table found by findTable.
 *   - The six sample PDFs, when the samples folder exists. Only roles, role
 *     sources and column keys are checked, so no sample text appears here.
 *
 * The document's number conventions are worked out the way the pipeline does
 * it: from every numeric column of the table (numbers.ts).
 *
 * All text in the hand-made tables is invented.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { refusalMessage, type RefusalInput } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import { Column, Note, Refusal, type Role } from "@/lib/contract/schema";
import { classifyPage } from "@/lib/engine/classify-page";
import { analyseNumber, conventionsFor, isNumericColumn, type Convention } from "@/lib/engine/numbers";
import { openDocument } from "@/lib/engine/open";
import { readPage } from "@/lib/engine/read-page";
import { MIN_DISCRIMINATING_ROWS, decideRoles, type RoleDecision } from "@/lib/engine/roles";
import { buildRows, type Cell, type Row } from "@/lib/engine/rows";
import { cellShape } from "@/lib/engine/shapes";
import { columnKey, findTable, type Table } from "@/lib/engine/table";

import { LANGUAGE_FIXTURES, type LanguageFixtureName } from "../fixtures/languages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The width of one column in a hand-made table, in points. Only used for x positions. */
const COLUMN_WIDTH = 80;

/** A row of a hand-made table: its cells as text, "" for an empty cell. */
function rowOf(index: number, texts: readonly string[]): { row: Row; cells: (Cell | null)[] } {
  const cells: (Cell | null)[] = [];
  const filled: Cell[] = [];
  let offset = 0;
  texts.forEach((text, position) => {
    if (text === "") {
      cells.push(null);
      return;
    }
    const start = filled.length === 0 ? 0 : offset + 1;
    const cell: Cell = {
      text,
      x0: position * COLUMN_WIDTH,
      x1: position * COLUMN_WIDTH + text.length * 4.5,
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
  const row: Row = { index, y: 100 + index * 17, fontSize: 9, cells: filled, text: filled.map((cell) => cell.text).join(" ") };
  return { row, cells };
}

/**
 * A hand-made table. `headers` null means no header row; a null inside the
 * list means that column has no heading.
 */
function makeTable(headers: readonly (string | null)[] | null, rows: readonly (readonly string[])[]): Table {
  const width = headers?.length ?? rows[0].length;
  const headerRows = headers ? [rowOf(0, headers.map((header) => header ?? "")).row] : [];
  const body = rows.map((texts, i) => {
    const { row, cells } = rowOf(i + 1, texts);
    return { row, continuations: [], cells };
  });
  const columns = Array.from({ length: width }, (_, position) => {
    const header = headers?.[position] ?? null;
    const numeric = body.filter((bodyRow) => bodyRow.cells[position]?.shape !== "TEXT" && bodyRow.cells[position]).length;
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

/** The document's conventions for one table, found the way the pipeline finds them. */
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

/**
 * Decides the roles of a hand-made table, and checks that every column,
 * note and refusal fits the contract.
 */
function decide(headers: readonly (string | null)[] | null, rows: readonly (readonly string[])[], page = 1): RoleDecision {
  const table = makeTable(headers, rows);
  const decision = decideRoles(table, conventionsOf([table]), page);
  expectValid(decision);
  return decision;
}

/** Every column, note and refusal passes its contract schema. */
function expectValid(decision: RoleDecision): void {
  for (const column of decision.columns) expect(Column.safeParse(column).success).toBe(true);
  for (const note of decision.notes) expect(Note.safeParse(note).success).toBe(true);
  if (decision.refusal) expect(Refusal.safeParse(decision.refusal).success).toBe(true);
}

/** The roles, left to right. */
function roles(decision: RoleDecision): (Role | null)[] {
  return decision.columns.map((column) => column.role);
}

/** The role sources, left to right. */
function sources(decision: RoleDecision): (string | null)[] {
  return decision.columns.map((column) => column.roleSource);
}

/** Every row reversed, so the columns come in the opposite order. */
function mirrored(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row].reverse());
}

/** The six standard headers. */
const HEADERS = ["Item", "Description", "Qty", "Unit", "Unit Price", "Line Total"];

/** The six standard roles, in the order of HEADERS. */
const ROLES: Role[] = ["itemNo", "description", "quantity", "unit", "unitPrice", "lineTotal"];

/** Three rows that multiply (qty x price = total), with no factor 1. */
const ROWS = [
  ["1", "Cedar post 2.4m treated", "4", "ea", "$12.00", "$48.00"],
  ["2", "Wire staple box 500", "2", "box", "$7.50", "$15.00"],
  ["3", "Gate latch galvanised", "3", "ea", "$21.00", "$63.00"],
];

// ---------------------------------------------------------------------------
// Header words and numbers agreeing
// ---------------------------------------------------------------------------

describe("decideRoles: the normal case", () => {
  it("gives every column its role with source 'both' when the header words agree with the numbers", () => {
    const decision = decide(HEADERS, ROWS);
    expect(roles(decision)).toEqual(ROLES);
    expect(sources(decision)).toEqual(ROLES.map(() => "both"));
    expect(decision.refusal).toBeNull();
    expect(decision.notes).toEqual([]);
  });

  it("builds contract columns with the header, the key and the kind", () => {
    const decision = decide(HEADERS, ROWS);
    expect(decision.columns[4]).toEqual({ header: "Unit Price", key: "unitPrice", role: "unitPrice", roleSource: "both", kind: "numeric" });
    expect(decision.columns[1]).toEqual({
      header: "Description",
      key: "description",
      role: "description",
      roleSource: "both",
      kind: "text",
    });
  });

  it("gives the same roles from the numbers alone, with source 'numbers', when there is no header", () => {
    const decision = decide(null, ROWS);
    expect(roles(decision)).toEqual(ROLES);
    expect(sources(decision)).toEqual(ROLES.map(() => "numbers"));
    expect(decision.refusal).toBeNull();
    expect(decision.notes).toEqual([NOTES.noHeadings(1)]);
  });

  it("does not change the table it is given", () => {
    const table = makeTable(HEADERS, ROWS);
    const before = JSON.stringify(table);
    decideRoles(table, conventionsOf([table]), 1);
    expect(JSON.stringify(table)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The product check
// ---------------------------------------------------------------------------

describe("decideRoles: the product check", () => {
  it("finds no triple when every quantity is 1, so quantity, unit price and line total are unknown by the numbers", () => {
    const rows = [
      ["1", "Cedar post 2.4m treated", "1", "ea", "$12.00", "$12.00"],
      ["2", "Wire staple box 500", "1", "box", "$7.50", "$7.50"],
      ["3", "Gate latch galvanised", "1", "ea", "$21.00", "$21.00"],
    ];
    const decision = decide(null, rows);
    expect(roles(decision)).toEqual(["itemNo", "description", null, "unit", null, null]);
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
  });

  it(`accepts a triple with exactly ${MIN_DISCRIMINATING_ROWS} rows where neither factor is 1`, () => {
    const rows = [
      ["Cedar post 2.4m treated", "1", "$12.00", "$12.00"],
      ["Wire staple box 500", "1", "$7.50", "$7.50"],
      ["Gate latch galvanised", "3", "$21.00", "$63.00"],
      ["Hinge pair heavy duty", "2", "$9.00", "$18.00"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", "quantity", "unitPrice", "lineTotal"]);
  });

  it("rejects the triple when only one row has no factor 1", () => {
    const rows = [
      ["Cedar post 2.4m treated", "1", "$12.00", "$12.00"],
      ["Wire staple box 500", "1", "$7.50", "$7.50"],
      ["Gate latch galvanised", "3", "$21.00", "$63.00"],
      ["Hinge pair heavy duty", "1", "$9.00", "$9.00"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, null]);
  });

  it("rejects a triple that holds on only half of the checkable rows, and accepts one that holds on more", () => {
    const half = [
      ["Cedar post 2.4m treated", "4", "$12.00", "$48.00"],
      ["Wire staple box 500", "2", "$7.50", "$15.00"],
      ["Gate latch galvanised", "3", "$21.00", "$50.00"],
      ["Hinge pair heavy duty", "2", "$9.00", "$20.00"],
    ];
    expect(roles(decide(null, half))).toEqual(["description", null, null, null]);
    const most = half.map((row, i) => (i === 3 ? ["Hinge pair heavy duty", "2", "$9.00", "$18.00"] : row));
    expect(roles(decide(null, most))).toEqual(["description", "quantity", "unitPrice", "lineTotal"]);
  });

  it("needs support on at least half of all body rows, not only of the checkable ones", () => {
    const row = (description: string, qty: string, price: string, total: string) => [description, qty, price, total];
    const four = [
      row("Cedar post 2.4m treated", "4", "$12.00", "$48.00"),
      row("Wire staple box 500", "2", "$7.50", "$15.00"),
      row("Gate latch galvanised", "", "$21.00", "$63.00"),
      row("Hinge pair heavy duty", "", "$9.00", "$18.00"),
    ];
    // 2 supporting rows of 4: exactly half, accepted.
    expect(roles(decide(null, four))[3]).toBe("lineTotal");
    // 2 supporting rows of 5: less than half, rejected.
    const five = [...four, row("Bolt pack M10 zinc", "", "$6.00", "$30.00")];
    expect(roles(decide(null, five))[3]).toBeNull();
  });

  it("allows one unit of the total's last digit, and not two", () => {
    const within = [
      ["Cedar post 2.4m treated", "4", "$1.25", "$5.00"],
      ["Wire staple box 500", "3", "$2.50", "$7.51"],
    ];
    expect(roles(decide(null, within))[3]).toBe("lineTotal");
    const outside = [within[0], ["Wire staple box 500", "3", "$2.50", "$7.52"]];
    expect(roles(decide(null, outside))[3]).toBeNull();
  });

  it("leaves every number role unknown when a rival triple is as strong as the best one", () => {
    // Two copies of the quantity column: 'a x price = total' holds for both.
    const rows = [
      ["Cedar post 2.4m treated", "2", "2", "$3.00", "$6.00"],
      ["Wire staple box 500", "5", "5", "$1.50", "$7.50"],
      ["Gate latch galvanised", "3", "3", "$4.00", "$12.00"],
    ];
    const decision = decide(null, rows);
    expect(roles(decision)).toEqual(["description", null, null, null, null]);
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
  });

  it("does not use the '/unit' rule after a rival triple either", () => {
    const rows = [
      ["Cedar post 2.4m treated", "2", "2", "$3.00 /ea", "$6.00"],
      ["Wire staple box 500", "5", "5", "$1.50 /ea", "$7.50"],
      ["Gate latch galvanised", "3", "3", "$4.00 /ea", "$12.00"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// Which factor is the price
// ---------------------------------------------------------------------------

describe("decideRoles: which factor is the price", () => {
  it("uses the currency marker the price shares with the line total", () => {
    expect(roles(decide(null, ROWS)).slice(2)).toEqual(["quantity", "unit", "unitPrice", "lineTotal"]);
  });

  it("doesn't use decimals to tell the factors apart, because a quantity can have decimals too", () => {
    // Whole numbers next to prices with cents...
    const rows = [
      ["Cedar post 2.4m treated", "4", "12.50", "50.00"],
      ["Wire staple box 500", "2", "7.25", "14.50"],
      ["Gate latch galvanised", "3", "3.10", "9.30"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, "lineTotal"]);
    // ...look exactly like hours with decimals next to a whole-number rate.
    const hours = [
      ["Labour, framing crew", "7.50", "85", "637.50"],
      ["Concrete 20MPa (m3)", "2.40", "260", "624.00"],
      ["Site supervision", "1.50", "110", "165.00"],
    ];
    expect(roles(decide(null, hours))).toEqual(["description", null, null, "lineTotal"]);
  });

  it("uses thousands grouping when both factors are whole numbers", () => {
    const rows = [
      ["Cedar post 2.4m treated", "1500", "1,200", "1,800,000"],
      ["Wire staple box 500", "2000", "1,100", "2,200,000"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", "quantity", "unitPrice", "lineTotal"]);
  });

  it("leaves both factors unknown when their values look the same, and still knows the line total", () => {
    const rows = [
      ["Cedar post 2.4m treated", "4", "12", "48"],
      ["Wire staple box 500", "2", "7", "14"],
      ["Gate latch galvanised", "3", "21", "63"],
    ];
    const decision = decide(null, rows);
    expect(roles(decision)).toEqual(["description", null, null, "lineTotal"]);
    expect(decision.refusal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Position is never used
// ---------------------------------------------------------------------------

describe("decideRoles: column position is never used", () => {
  it("gives the same roles to a mirrored table, from the numbers alone", () => {
    expect(roles(decide(null, mirrored(ROWS)))).toEqual([...ROLES].reverse());
  });

  it("gives the same roles and sources to a mirrored table with headers", () => {
    const decision = decide([...HEADERS].reverse(), mirrored(ROWS));
    expect(roles(decision)).toEqual([...ROLES].reverse());
    expect(sources(decision)).toEqual(ROLES.map(() => "both"));
  });

  it("gives the same unknowns to a mirrored table whose factors can't be told apart", () => {
    const rows = [
      ["Cedar post 2.4m treated", "4", "12", "48"],
      ["Wire staple box 500", "2", "7", "14"],
      ["Gate latch galvanised", "3", "21", "63"],
    ];
    expect(roles(decide(null, mirrored(rows)))).toEqual(["lineTotal", null, null, "description"]);
  });

  it("orients the factors by grouping in either order", () => {
    const rows = [
      ["Cedar post 2.4m treated", "1,200", "1500", "1,800,000"],
      ["Wire staple box 500", "1,100", "2000", "2,200,000"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", "unitPrice", "quantity", "lineTotal"]);
  });
});

// ---------------------------------------------------------------------------
// Unit prices with "/unit", item numbers and percent columns
// ---------------------------------------------------------------------------

describe("decideRoles: '/unit' prices with no product column", () => {
  const perBag = [
    ["Bagged cement 20kg", "3", "$68.00 /bag"],
    ["Sand bulk bag", "2", "$95.00 /bag"],
    ["Gravel pea 10mm", "5", "$120.00 /bag"],
  ];

  it("makes a money column with '/unit' on its cells the unit price", () => {
    const decision = decide(null, perBag);
    expect(roles(decision)).toEqual(["description", null, "unitPrice"]);
    expect(sources(decision)[2]).toBe("numbers");
    expect(decision.refusal).toBeNull();
  });

  it("still counts when most cells (2 of 3) have the suffix", () => {
    const rows = perBag.map((row, i) => (i === 2 ? [row[0], row[1], "$120.00"] : row));
    expect(roles(decide(null, rows))[2]).toBe("unitPrice");
  });

  it("gives no role when only 1 of 3 cells has the suffix", () => {
    const rows = perBag.map((row, i) => (i === 0 ? row : [row[0], row[1], row[2].replace(" /bag", "")]));
    expect(roles(decide(null, rows))[2]).toBeNull();
  });

  it("gives no role when the column has no currency marker", () => {
    const rows = perBag.map((row) => [row[0], row[1], row[2].replace("$", "")]);
    const decision = decide(null, rows);
    expect(roles(decision)[2]).toBeNull();
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
  });

  it("gives no role to either of two such columns", () => {
    const rows = perBag.map((row) => [...row, row[2]]);
    expect(roles(decide(null, rows))).toEqual(["description", null, null, null]);
  });
});

describe("decideRoles: item numbers", () => {
  /** A table with one extra column in front of the standard rows. */
  const withFirst = (first: string[]) => ROWS.map((row, i) => [first[i], ...row.slice(1)]);

  it("makes a column counting 1, 2, 3 the item number", () => {
    expect(roles(decide(null, withFirst(["1", "2", "3"])))[0]).toBe("itemNo");
  });

  it("also accepts a count that starts above 1", () => {
    expect(roles(decide(null, withFirst(["7", "8", "9"])))[0]).toBe("itemNo");
  });

  it("does not accept a count that starts at 0, skips a number, or has a currency marker", () => {
    expect(roles(decide(null, withFirst(["0", "1", "2"])))[0]).toBeNull();
    expect(roles(decide(null, withFirst(["1", "2", "4"])))[0]).toBeNull();
    expect(roles(decide(null, withFirst(["$1", "$2", "$3"])))[0]).toBeNull();
  });

  it("needs at least 2 filled cells", () => {
    expect(roles(decide(null, withFirst(["1", "", ""])))[0]).toBeNull();
  });

  it("gives no role to either of two counting columns", () => {
    const rows = ROWS.map((row) => [row[0], ...row]);
    expect(roles(decide(null, rows)).slice(0, 2)).toEqual([null, null]);
  });
});

describe("decideRoles: percent columns", () => {
  it("never gives a percent column a role, even when its values count 1, 2, 3", () => {
    const rows = ROWS.map((row, i) => [...row.slice(0, 5), `${i + 1}%`, row[5]]);
    const decision = decide(null, rows);
    expect(roles(decision)).toEqual([...ROLES.slice(0, 5), null, "lineTotal"]);
  });

  it("adds a 'not read' note for a percent column with a heading", () => {
    const rows = ROWS.map((row, i) => [...row.slice(0, 5), i === 1 ? "10%" : "", row[5]]);
    const decision = decide([...HEADERS.slice(0, 5), "Disc %", "Line Total"], rows);
    expect(roles(decision)[5]).toBeNull();
    expect(decision.notes).toEqual([NOTES.columnNotRead(1, "Disc %")]);
  });
});

// ---------------------------------------------------------------------------
// Text columns from their shapes
// ---------------------------------------------------------------------------

describe("decideRoles: text columns from cell shapes", () => {
  /** Code | Description | Unit | Qty | Price | Total, with the text columns given. */
  const withText = (codes: string[], descriptions: string[], units: string[]) =>
    ROWS.map((row, i) => [codes[i], descriptions[i], units[i], row[2], row[4], row[5]]);
  const CODES = ["AB-100", "CD-220", "EF-310"];
  const DESCRIPTIONS = ROWS.map((row) => row[1]);
  const UNITS = ["ea", "box", "l.m."];

  it("finds the code, the description and the unit", () => {
    const decision = decide(null, withText(CODES, DESCRIPTIONS, UNITS));
    expect(roles(decision)).toEqual(["code", "description", "unit", "quantity", "unitPrice", "lineTotal"]);
  });

  it("accepts units in any script", () => {
    expect(roles(decide(null, withText(CODES, DESCRIPTIONS, ["pièce", "hộp", "ea"])))[2]).toBe("unit");
  });

  it("gives no description when the longest text column is shorter than 8 characters on average", () => {
    expect(roles(decide(null, withText(CODES, ["Nail", "Pin", "Tack"], UNITS)))[1]).toBeNull();
  });

  it("gives no description when two text columns are about the same length", () => {
    const decision = decide(null, withText(["Treated grade A", "Rough sawn pine", "Kiln dried fir"], DESCRIPTIONS, UNITS));
    expect(roles(decision).slice(0, 2)).toEqual([null, null]);
  });

  it("gives no code role to repeated codes or to measurements", () => {
    expect(roles(decide(null, withText(["AB-100", "AB-100", "CD-220"], DESCRIPTIONS, UNITS)))[0]).toBeNull();
    expect(roles(decide(null, withText(["25kg", "10kg", "5kg"], DESCRIPTIONS, UNITS)))[0]).toBeNull();
  });

  it("gives no unit role to words longer than 10 letters or with digits", () => {
    expect(roles(decide(null, withText(CODES, DESCRIPTIONS, ["ea", "box", "centimetres"])))[2]).toBeNull();
    expect(roles(decide(null, withText(CODES, DESCRIPTIONS, ["ea", "box", "m2"])))[2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Header words against the numbers
// ---------------------------------------------------------------------------

describe("decideRoles: header words against the numbers", () => {
  it("refuses the page with AMBIGUOUS_COLUMNS when a header disagrees about a number column, and never swaps", () => {
    const headers = ["Item", "Description", "Unit Price", "Unit", "Qty", "Line Total"];
    const decision = decide(headers, ROWS, 4);
    const input: RefusalInput = {
      code: "AMBIGUOUS_COLUMNS",
      kind: "numbersVsHeader",
      page: 4,
      column: { header: "Unit Price", position: 3 },
      numbersRole: "quantity",
      headerRole: "unitPrice",
    };
    expect(decision.refusal).toMatchObject({ id: "p4-AMBIGUOUS_COLUMNS", code: "AMBIGUOUS_COLUMNS", scope: "page", page: 4 });
    expect(decision.refusal?.message).toBe(refusalMessage(input));
    expect(decision.refusal?.message).toContain("quantities");
    expect(decision.refusal?.message).toContain("unit price");
    // Nothing is swapped, and no column keeps a quantity, price or total role.
    expect(roles(decision)).toEqual(["itemNo", "description", null, "unit", null, null]);
    // A disputed column is explained by the refusal, not by a 'not read' note.
    expect(decision.notes).toEqual([]);
  });

  it("quotes the header row and every body row in the refusal's evidence", () => {
    const headers = ["Item", "Description", "Unit Price", "Unit", "Qty", "Line Total"];
    const decision = decide(headers, ROWS, 4);
    expect(decision.refusal?.evidence).toEqual([
      { page: 4, sourceText: headers.join(" ") },
      ...ROWS.map((row) => ({ page: 4, sourceText: row.join(" ") })),
    ]);
  });

  it("follows the heading of a text column over the cell shapes, with a note and no refusal", () => {
    const rows = ROWS.map((row, i) => [["AB-100", "CD-220", "EF-310"][i], ...row.slice(1)]);
    const decision = decide(HEADERS, rows, 2);
    expect(decision.columns[0]).toMatchObject({ header: "Item", role: "itemNo", roleSource: "header" });
    expect(decision.notes).toEqual([NOTES.headingFollowed(2, "Item", "codes", "item number")]);
    expect(decision.refusal).toBeNull();
  });

  it("refuses with AMBIGUOUS_COLUMNS (same role) when 'Qty' and 'Quantity' both say quantity", () => {
    const rows = ROWS.map((row, i) => [...row, ["7", "11", "13"][i]]);
    const decision = decide([...HEADERS, "Quantity"], rows);
    const input: RefusalInput = {
      code: "AMBIGUOUS_COLUMNS",
      kind: "sameRole",
      page: 1,
      role: "quantity",
      columns: [
        { header: "Qty", position: 3 },
        { header: "Quantity", position: 7 },
      ],
    };
    expect(decision.refusal?.message).toBe(refusalMessage(input));
    expect(roles(decision)[2]).toBeNull();
    expect(roles(decision)[6]).toBeNull();
  });

  it("uses a role from the heading only, with source 'header' and a note", () => {
    const headers = ["Item", "Description", "Qty", "Weight", "Unit Price"];
    const rows = [
      ["1", "Bagged cement 20kg", "3", "20kg", "$68.00 /bag"],
      ["2", "Sand bulk bag", "2", "1t", "$95.00 /bag"],
      ["3", "Gravel pea 10mm", "5", "1t", "$120.00 /bag"],
    ];
    const decision = decide(headers, rows, 3);
    expect(roles(decision)).toEqual(["itemNo", "description", "quantity", null, "unitPrice"]);
    expect(sources(decision)).toEqual(["both", "both", "header", null, "both"]);
    expect(decision.notes).toEqual([NOTES.headerOnlyRole(3, "Qty", "the quantity"), NOTES.columnNotRead(3, "Weight")]);
    expect(decision.refusal).toBeNull();
  });

  it("uses heading-only roles for factors the numbers could not tell apart", () => {
    const rows = [
      ["Cedar post 2.4m treated", "4", "12", "48"],
      ["Wire staple box 500", "2", "7", "14"],
      ["Gate latch galvanised", "3", "21", "63"],
    ];
    const decision = decide(["Description", "Qty", "Unit Price", "Line Total"], rows);
    expect(sources(decision)).toEqual(["both", "header", "header", "both"]);
    expect(decision.notes).toEqual([NOTES.headerOnlyRole(1, "Qty", "the quantity"), NOTES.headerOnlyRole(1, "Unit Price", "the unit price")]);
  });

  it("uses no opinion from a heading with two meanings, and warns about it", () => {
    const headers = ["Item", "Description", "Qty Unit", "Unit", "Unit Price", "Line Total"];
    const decision = decide(headers, ROWS);
    expect(decision.columns[2]).toMatchObject({ role: "quantity", roleSource: "numbers" });
    expect(decision.notes).toEqual([NOTES.headingTwoMeanings(1, "Qty Unit")]);
  });
});

// ---------------------------------------------------------------------------
// Tables with no number role, and the heading warnings
// ---------------------------------------------------------------------------

describe("decideRoles: no number role", () => {
  it("refuses with COLUMN_MEANING_UNKNOWN when no column is a quantity, unit price or line total", () => {
    const rows = [
      ["Treated pine post 100x100", "AB-100", "ea"],
      ["Galvanised joist hanger", "CD-220", "box"],
    ];
    const decision = decide(null, rows, 5);
    expect(roles(decision)).toEqual(["description", "code", "unit"]);
    expect(decision.refusal).toMatchObject({ id: "p5-COLUMN_MEANING_UNKNOWN", code: "COLUMN_MEANING_UNKNOWN", page: 5 });
    expect(decision.refusal?.message).toBe(refusalMessage({ code: "COLUMN_MEANING_UNKNOWN", page: 5 }));
    expect(decision.refusal?.evidence).toEqual(rows.map((row) => ({ page: 5, sourceText: row.join(" ") })));
  });

  it("ends an 'Account | Terms | Balance' block as COLUMN_MEANING_UNKNOWN", () => {
    const headers = ["Account", "Terms", "Balance"];
    const rows = [
      ["4471", "30 days", "$1,250.00"],
      ["5820", "7 days", "$310.40"],
      ["6112", "20th of month", "$92.15"],
    ];
    const decision = decide(headers, rows, 2);
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
    expect(decision.refusal?.evidence.map((evidence) => evidence.sourceText)).toEqual([
      "Account Terms Balance",
      ...rows.map((row) => row.join(" ")),
    ]);
    expect(decision.notes).toContainEqual(NOTES.unknownHeadings(2));
    expect(roles(decision)[2]).toBeNull();
  });
});

describe("decideRoles: when the numbers can't be sure", () => {
  it("trusts no product when two products fit, like pieces x length = metres and metres x price = value", () => {
    const rows = [
      ["Pine batten 45x19 H3.2", "6", "2.4", "14.4", "4.35", "62.64"],
      ["Rimu board 150x25", "4", "3.6", "14.4", "11.90", "171.36"],
      ["Framing 90x45 SG8", "10", "4.8", "48.0", "6.20", "297.60"],
    ];
    const decision = decide(null, rows);
    expect(roles(decision)).toEqual(["description", null, null, null, null, null]);
    expect(decision.refusal?.code).toBe("COLUMN_MEANING_UNKNOWN");
  });

  it("trusts no product when a column outside it has the currency and the product's total has none", () => {
    // Pieces x length = metres is the only product; the money columns include GST.
    const rows = [
      ["Pine batten 45x19 H3.2", "6", "2.4", "14.4", "$4.35", "$72.03"],
      ["Rimu board 150x25", "4", "3.6", "14.4", "$11.90", "$197.06"],
      ["Framing 90x45 SG8", "10", "4.8", "48.0", "$6.20", "$342.24"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, null, null, null]);
  });

  it("trusts no product when a column outside it is larger on every row and shows as many decimals", () => {
    const rows = [
      ["Pine batten 45x19 H3.2", "6", "2.4", "14.4", "4.35", "72.03"],
      ["Rimu board 150x25", "4", "3.6", "14.4", "11.90", "197.06"],
      ["Framing 90x45 SG8", "10", "4.8", "48.0", "6.20", "342.24"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, null, null, null]);
  });

  it("still trusts the product next to a larger column of whole numbers, like a numeric part code", () => {
    const rows = [
      ["48213", "Cedar post 2.4m treated", "4", "12.50", "50.00"],
      ["48214", "Wire staple box 500", "2", "7.25", "14.50"],
      ["48230", "Gate latch galvanised", "3", "3.10", "9.30"],
    ];
    expect(decide(null, rows).columns[4].role).toBe("lineTotal");
  });

  it("doesn't take a unit that is also a currency code ('50 KGS') as the sign of a price", () => {
    const rows = [
      ["Cement GP 40kg bag", "50 KGS", "0.45", "$22.50"],
      ["Builders lime bag", "120 KGS", "0.80", "$96.00"],
      ["Sand washed per kg", "400 KGS", "0.12", "$48.00"],
    ];
    expect(roles(decide(null, rows))).toEqual(["description", null, null, "lineTotal"]);
  });

  it("leaves a factor that counts 1, 2, 3 without a role, and still finds the price", () => {
    // The quantities carry their unit ("1 Stk"), so they are not numbers, and
    // the line numbers happen to equal the quantities.
    const rows = [
      ["1", "Kantholz 45x19 gehobelt", "1 Stk", "$15.50", "$15.50"],
      ["2", "Terrassenschrauben Box", "2 Box", "$22.25", "$44.50"],
      ["3", "Balkenschuh verzinkt", "3 Stk", "$9.90", "$29.70"],
    ];
    const decision = decide(["Pos", "Bezeichnung", "Menge", "Preis", "Betrag"], rows);
    expect(roles(decision)).toEqual([null, "description", null, "unitPrice", "lineTotal"]);
  });

  it("follows a heading over the item-number shape, because a quantity can count 1, 2, 3", () => {
    const rows = [
      ["Cedar post 2.4m treated", "1", "$12.00"],
      ["Wire staple box 500", "2", "$7.50"],
      ["Gate latch galvanised", "3", "$21.00"],
    ];
    const decision = decide(["Description", "Qty", "Price"], rows);
    expect(decision.refusal).toBeNull();
    expect(decision.columns[1]).toMatchObject({ role: "quantity", roleSource: "header" });
    expect(decision.notes).toContainEqual(NOTES.headingFollowed(1, "Qty", "item numbers", "quantity"));
  });

  it("doesn't count a row with a 0 against the product", () => {
    const rows = [
      ["Cedar post 2.4m treated", "4", "$12.00", "$48.00"],
      ["Wire staple box 500", "3", "$21.00", "$63.00"],
      ["Gate latch galvanised", "0", "$7.50", "$0.00"],
      ["Hinge set black", "0", "$9.90", "$0.00"],
    ];
    expect(decide(null, rows).columns[3].role).toBe("lineTotal");
  });

  it("gives no description when two columns hold phrases, like a product and a delivery place", () => {
    const rows = [
      ["Kantholz 45x19", "Baustelle Nord, Tor 3, Halle B", "12", "$15.50", "$186.00"],
      ["Schrauben Box", "Baustelle Sued, Container 2", "8", "$22.25", "$178.00"],
      ["Balkenschuh 90", "Baustelle Nord, Tor 1, Lager", "5", "$9.90", "$49.50"],
    ];
    expect(roles(decide(null, rows)).slice(0, 2)).toEqual([null, null]);
  });

  it("keeps no number role and no note about single columns on an ambiguous page", () => {
    const headers = ["Item", "Description", "Qty", "Quantity", "Unit Price", "Line Total"];
    const rows = ROWS.map(([no, description, qty, , price, total]) => [no, description, qty, qty, price, total]);
    const decision = decide(headers, rows);
    expect(decision.refusal?.code).toBe("AMBIGUOUS_COLUMNS");
    expect(roles(decision)).toEqual(["itemNo", "description", null, null, null, null]);
    expect(decision.notes).toEqual([]);
  });
});

describe("decideRoles: a text role held by two columns", () => {
  const rows = [
    ["1", "Cedar post 2.4m treated", "red", "4", "ea", "$12.00", "$48.00"],
    ["2", "Wire staple box 500", "blue", "2", "box", "$7.50", "$15.00"],
    ["3", "Gate latch galvanised", "green", "3", "ea", "$21.00", "$63.00"],
  ];

  it("keeps the role on the column whose heading names it, and still reads the page", () => {
    const decision = decide(["Item", "Description", "Colour", "Qty", "Unit", "Unit Price", "Line Total"], rows);
    expect(decision.refusal).toBeNull();
    expect(roles(decision)).toEqual(["itemNo", "description", null, "quantity", "unit", "unitPrice", "lineTotal"]);
    expect(decision.notes).toEqual([NOTES.columnNotRead(1, "Colour")]);
  });

  it("gives the role to neither column when no heading names it, and still reads the page", () => {
    const decision = decide(null, rows);
    expect(decision.refusal).toBeNull();
    expect(roles(decision)).toEqual(["itemNo", "description", null, "quantity", null, "unitPrice", "lineTotal"]);
  });
});

describe("decideRoles: heading warnings and 'not read' notes", () => {
  it("warns when the table has headings and none of them is a word we know", () => {
    const decision = decide(["Ref", "Material", "Count", "Pack", "Cost", "Value"], ROWS, 3);
    expect(sources(decision)).toEqual(ROLES.map(() => "numbers"));
    expect(decision.notes).toEqual([NOTES.unknownHeadings(3)]);
  });

  it("does not warn when one heading is known", () => {
    const decision = decide(["Ref", "Material", "Qty", "Pack", "Cost", "Value"], ROWS);
    expect(decision.notes).toEqual([]);
  });

  it("does not warn about unknown headings when a heading has known words with two meanings", () => {
    const decision = decide(["Ref", "Material", "Qty Unit", "Pack", "Cost", "Value"], ROWS);
    expect(decision.notes).toEqual([NOTES.headingTwoMeanings(1, "Qty Unit")]);
  });

  it("gives the no-headings warning to a table without a header row", () => {
    expect(decide(null, ROWS, 6).notes).toEqual([NOTES.noHeadings(6)]);
  });

  it("adds a 'not read' note only for role-less columns that have a heading", () => {
    const rows = ROWS.map((row, i) => [...row, ["20kg", "480g total", "1t"][i]]);
    expect(decide([...HEADERS, "Weight"], rows).notes).toEqual([NOTES.columnNotRead(1, "Weight")]);
    expect(decide([...HEADERS, null], rows).notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The language and layout fixtures
// ---------------------------------------------------------------------------

/** Reads the first page of a fixture PDF and finds its table. */
async function fixtureTable(build: () => Promise<Uint8Array>): Promise<Table> {
  const opened = await openDocument(await build());
  if (!opened.ok) throw new Error(`PDF did not open: ${opened.refusal.code}`);
  try {
    const classified = classifyPage(await readPage(opened.doc, opened.pdfjs, 1));
    if (classified.kind !== "text") throw new Error("the fixture's first page is not a text page");
    const table = findTable(buildRows(classified.pieces), 1).table;
    if (!table) throw new Error("the fixture has no table");
    return table;
  } finally {
    await opened.doc.loadingTask.destroy();
  }
}

/** The roles of a fixture's table. */
async function fixtureDecision(name: LanguageFixtureName): Promise<RoleDecision> {
  const table = await fixtureTable(LANGUAGE_FIXTURES[name].build);
  const decision = decideRoles(table, conventionsOf([table]), 1);
  expectValid(decision);
  return decision;
}

describe("decideRoles on the language fixtures", () => {
  it.each(["french", "german", "englishSynonyms"] as const)(
    "%s: all six roles from the numbers, with the unknown-headings warning",
    async (name) => {
      const decision = await fixtureDecision(name);
      expect(roles(decision)).toEqual(ROLES);
      expect(sources(decision)).toEqual(ROLES.map(() => "numbers"));
      expect(decision.refusal).toBeNull();
      expect(decision.notes).toEqual([NOTES.unknownHeadings(1)]);
    },
  );

  it("vietnamese: SL and Đơn giá are unknown, the other four come from the numbers", async () => {
    const decision = await fixtureDecision("vietnamese");
    expect(roles(decision)).toEqual(["itemNo", "description", null, "unit", null, "lineTotal"]);
    expect(sources(decision)).toEqual(["numbers", "numbers", null, "numbers", null, "numbers"]);
    expect(decision.refusal).toBeNull();
    expect(decision.notes).toEqual([
      NOTES.columnNotRead(1, "SL"),
      NOTES.columnNotRead(1, "Đơn giá"),
      NOTES.unknownHeadings(1),
    ]);
  });
});

describe("decideRoles on the English layout fixtures", () => {
  it.each(["wrappedDescription", "twoLineHeader", "centredHeaders", "onePiecePerWord"] as const)(
    "%s: all six roles from both opinions, no notes",
    async (name) => {
      const decision = await fixtureDecision(name);
      expect(roles(decision)).toEqual(ROLES);
      expect(sources(decision)).toEqual(ROLES.map(() => "both"));
      expect(decision.refusal).toBeNull();
      expect(decision.notes).toEqual([]);
    },
  );

  it("reorderedRightAligned: the roles follow the columns, not their places", async () => {
    const decision = await fixtureDecision("reorderedRightAligned");
    expect(roles(decision)).toEqual(["description", "code", "quantity", "unit", "lineTotal", "unitPrice"]);
    expect(sources(decision)).toEqual(ROLES.map(() => "both"));
    expect(decision.notes).toEqual([]);
  });

  it("qtyOneDisc: the discount column is not read, the others come from both opinions", async () => {
    const decision = await fixtureDecision("qtyOneDisc");
    expect(roles(decision)).toEqual([...ROLES.slice(0, 5), null, "lineTotal"]);
    expect(decision.refusal).toBeNull();
    expect(decision.notes).toEqual([NOTES.columnNotRead(1, "Disc %")]);
  });
});

// ---------------------------------------------------------------------------
// The six samples (roles and keys only)
// ---------------------------------------------------------------------------

/** The sample files with text pages. KBS-10241 is a scan and has no table. */
const SAMPLE_FILES = ["KBS-10234.pdf", "KBS-10255.pdf", "KBS-10262.pdf", "KBS-10270.pdf", "KBS-DR118.pdf"];

/** The role source of each column key on every table page of every sample (PLAN Part 5, step 9). */
function expectedSources(file: string): Record<string, string | null> {
  if (file === "KBS-10255.pdf") return { item: "both", description: "both", qty: "header", weight: null, unitPrice: "both" };
  return { item: "both", description: "both", qty: "both", unit: "both", unitPrice: "both", lineTotal: "both" };
}

describe.skipIf(!existsSync("samples"))("decideRoles on the sample PDFs", () => {
  it.each(SAMPLE_FILES)("%s: every table page gets the expected role sources and no refusal", async (file) => {
    const opened = await openDocument(new Uint8Array(readFileSync(`samples/${file}`)));
    if (!opened.ok) throw new Error(`PDF did not open: ${opened.refusal.code}`);
    try {
      const tables: Table[] = [];
      for (let n = 1; n <= opened.doc.numPages; n++) {
        const classified = classifyPage(await readPage(opened.doc, opened.pdfjs, n));
        if (classified.kind !== "text") continue;
        const table = findTable(buildRows(classified.pieces), n).table;
        if (table) tables.push(table);
      }
      expect(tables.length).toBeGreaterThan(0);
      const conventions = conventionsOf(tables);
      for (const table of tables) {
        const decision = decideRoles(table, conventions, 1);
        expectValid(decision);
        expect(decision.refusal).toBeNull();
        expect(Object.fromEntries(decision.columns.map((column) => [column.key, column.roleSource]))).toEqual(expectedSources(file));
      }
    } finally {
      await opened.doc.loadingTask.destroy();
    }
  });
});
