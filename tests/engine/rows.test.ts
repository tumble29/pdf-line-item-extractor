/**
 * Tests for src/lib/engine/rows.ts: text pieces into rows and cells.
 *
 * Most cases use hand-made pieces (tests/fixtures/items.ts), so each test can
 * set exact positions and gaps. The widths come from piece(): 0.5 font sizes
 * per character, so at font size 9 each character is 4.5 pt wide. One case
 * builds a real PDF and reads it with pdf.js, to check the rules on real
 * positions. All text is invented.
 *
 * At font size 9 the thresholds are:
 *   same row      baselines within 0.35 x 9 = 3.15 pt
 *   same cell     gap less than 0.4 x 9 = 3.6 pt
 *   space added   gap more than 0.1 x 9 = 0.9 pt
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDocument } from "@/lib/engine/open";
import type { PDFDocumentProxy } from "@/lib/engine/pdfjs";
import { readPage } from "@/lib/engine/read-page";
import { buildRows, MERGE_GAP, ROW_TOL, SPACE_GAP, type Row } from "@/lib/engine/rows";

import { buildPdf, DEFAULT_COLUMNS } from "../fixtures/build";
import { piece } from "../fixtures/items";

/** Width of one character at font size 9 in the piece() fixture. */
const CHAR = 4.5;

/** The text of each cell of a row. */
function cellTexts(row: Row): string[] {
  return row.cells.map((cell) => cell.text);
}

describe("buildRows: the constants", () => {
  it("uses the tolerances from the plan", () => {
    expect(ROW_TOL).toBe(0.35);
    expect(MERGE_GAP).toBe(0.4);
    expect(SPACE_GAP).toBe(0.1);
  });
});

describe("buildRows: rows", () => {
  it("returns no rows for no pieces", () => {
    expect(buildRows([])).toEqual([]);
  });

  it("keeps one row when baselines jitter by up to 1.5 pt at font size 9", () => {
    const rows = buildRows([
      piece("Oak panel", 50, 201.5),
      piece("4", 200, 198.5),
      piece("$7.00", 300, 200),
      piece("$28.00", 400, 201),
    ]);
    expect(rows).toHaveLength(1);
    expect(cellTexts(rows[0])).toEqual(["Oak panel", "4", "$7.00", "$28.00"]);
  });

  it("keeps rows 17 pt apart separate", () => {
    const rows = buildRows([piece("First line", 50, 200), piece("Second line", 50, 217)]);
    expect(rows.map((row) => row.text)).toEqual(["First line", "Second line"]);
  });

  it("splits two baselines just over the tolerance (3.5 pt at font size 9)", () => {
    const rows = buildRows([piece("Upper", 50, 200), piece("Lower", 200, 203.5)]);
    expect(rows).toHaveLength(2);
  });

  it("uses the smaller font size, so a big title does not pull in small text below it", () => {
    // 5 pt apart: within 0.35 x 20 = 7 (the title's size), but not within
    // 0.35 x 9 = 3.15 (the small text's size).
    const rows = buildRows([piece("Big Title", 50, 100, { fontSize: 20 }), piece("small note", 300, 105)]);
    expect(rows).toHaveLength(2);
  });

  it("gives the row the largest font size on it", () => {
    const rows = buildRows([piece("Label", 50, 100, { fontSize: 9 }), piece("Big", 300, 101, { fontSize: 12 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fontSize).toBe(12);
  });

  it("orders rows top to bottom and cells left to right, whatever the input order", () => {
    const rows = buildRows([
      piece("right lower", 300, 220),
      piece("left lower", 50, 220),
      piece("right upper", 300, 200),
      piece("left upper", 50, 200),
    ]);
    expect(rows.map((row) => row.text)).toEqual(["left upper right upper", "left lower right lower"]);
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
    expect(rows[0].y).toBe(200);
  });

  it("does not change the input array", () => {
    const input = [piece("b", 300, 200), piece("a", 50, 200)];
    const copy = input.map((p) => ({ ...p }));
    buildRows(input);
    expect(input).toEqual(copy);
  });
});

describe("buildRows: cells", () => {
  it("joins one piece per word into one cell with spaces", () => {
    // "Pine" ends at 50 + 4 x 4.5 = 68; each next word starts 2.5 pt later
    // (more than 0.9, less than 3.6).
    const rows = buildRows([piece("Pine", 50, 200), piece("batten", 70.5, 200), piece("45x19", 70.5 + 6 * CHAR + 2.5, 200)]);
    expect(rows[0].cells).toHaveLength(1);
    const cell = rows[0].cells[0];
    expect(cell.text).toBe("Pine batten 45x19");
    expect(cell.pieces.map((p) => p.str)).toEqual(["Pine", "batten", "45x19"]);
    expect(cell.joinSpaces).toEqual([4, 11]);
    for (const offset of cell.joinSpaces) expect(cell.text[offset]).toBe(" ");
  });

  it("joins two touching pieces with no space", () => {
    const rows = buildRows([piece("Pin", 50, 200), piece("e", 50 + 3 * CHAR, 200)]);
    expect(rows[0].cells[0].text).toBe("Pine");
    expect(rows[0].cells[0].joinSpaces).toEqual([]);
  });

  it("adds no space for a gap under 0.9 pt, and one space for a gap over it", () => {
    const small = buildRows([piece("ab", 50, 200), piece("cd", 50 + 2 * CHAR + 0.5, 200)]);
    const large = buildRows([piece("ab", 50, 200), piece("cd", 50 + 2 * CHAR + 1.2, 200)]);
    expect(small[0].cells[0].text).toBe("abcd");
    expect(large[0].cells[0].text).toBe("ab cd");
    expect(large[0].cells[0].joinSpaces).toEqual([2]);
  });

  it("keeps a space that pdf.js gave inside the piece, and records it as a join", () => {
    // pdf.js often puts the word space at the end of a piece and counts it in
    // the width, so the next piece touches it.
    const rows = buildRows([piece("Pine ", 50, 200), piece("batten", 50 + 5 * CHAR, 200)]);
    const cell = rows[0].cells[0];
    expect(cell.text).toBe("Pine batten");
    expect(cell.joinSpaces).toEqual([4]);
  });

  it("trims each piece, so a cell has no leading or trailing space", () => {
    const rows = buildRows([piece("  Hinge set  ", 50, 200), piece(" 6 ", 300, 200)]);
    expect(cellTexts(rows[0])).toEqual(["Hinge set", "6"]);
    expect(rows[0].text).toBe("Hinge set 6");
  });

  it("records no join space for a space inside one piece", () => {
    const one = buildRows([piece("1 195,20", 50, 200)]);
    const two = buildRows([piece("1", 50, 200), piece("195,20", 50 + CHAR + 2, 200)]);
    expect(one[0].cells[0].text).toBe("1 195,20");
    expect(one[0].cells[0].joinSpaces).toEqual([]);
    expect(two[0].cells[0].text).toBe("1 195,20");
    expect(two[0].cells[0].joinSpaces).toEqual([1]);
  });

  it("starts a new cell at a gap of 3.6 pt or more, and joins below it", () => {
    const joined = buildRows([piece("ab", 50, 200), piece("cd", 50 + 2 * CHAR + 3.4, 200)]);
    const split = buildRows([piece("ab", 50, 200), piece("cd", 50 + 2 * CHAR + 3.8, 200)]);
    expect(cellTexts(joined[0])).toEqual(["ab cd"]);
    expect(cellTexts(split[0])).toEqual(["ab", "cd"]);
  });

  it("gives each cell the left edge of its first piece and the right edge of its last", () => {
    const rows = buildRows([piece("Pine", 50, 200), piece("batten", 70.5, 200), piece("12", 300, 200)]);
    const [description, qty] = rows[0].cells;
    expect(description.x0).toBe(50);
    expect(description.x1).toBe(70.5 + 6 * CHAR);
    expect(qty.x0).toBe(300);
    expect(qty.x1).toBe(300 + 2 * CHAR);
  });

  it("gives offsets that slice the row text back to each cell's text", () => {
    const rows = buildRows([
      piece("7", 43, 200),
      piece("Brass", 71, 200),
      piece("latch", 71 + 5 * CHAR + 2.5, 200),
      piece("3", 326, 200),
      piece("$4.10", 428, 200),
      piece("$12.30", 502, 200),
    ]);
    const row = rows[0];
    expect(row.text).toBe("7 Brass latch 3 $4.10 $12.30");
    for (const cell of row.cells) expect(row.text.slice(cell.start, cell.end)).toBe(cell.text);
    expect(row.cells.map((cell) => [cell.start, cell.end])).toEqual([
      [0, 1],
      [2, 13],
      [14, 15],
      [16, 21],
      [22, 28],
    ]);
  });
});

describe("buildRows: cell shapes", () => {
  it.each([
    ["1,195.20", "NUM"],
    ["1.195,20 €", "NUM"],
    ["25kg", "NUMX"],
    ["ADH-400", "TEXT"],
  ])("gives %s the shape %s", (text, shape) => {
    const rows = buildRows([piece("Label", 20, 200), piece(text, 300, 200)]);
    expect(rows[0].cells[1].shape).toBe(shape);
  });

  it("gives a price and its unit drawn as two pieces the shape NUMX", () => {
    const rows = buildRows([piece("$68.00", 300, 200), piece("/bag", 300 + 6 * CHAR + 2.5, 200)]);
    expect(rows[0].cells).toHaveLength(1);
    expect(rows[0].cells[0].text).toBe("$68.00 /bag");
    expect(rows[0].cells[0].shape).toBe("NUMX");
  });
});

describe("buildRows: separator rows", () => {
  it("drops a dash line and does not count it in the row numbers", () => {
    const rows = buildRows([
      piece("Description", 71, 176),
      piece("Qty", 326, 176),
      piece("-".repeat(60), 43, 186),
      piece("Cedar post", 71, 198),
      piece("2", 326, 198),
    ]);
    expect(rows.map((row) => row.text)).toEqual(["Description Qty", "Cedar post 2"]);
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
  });

  it("keeps a dash line 5 pt under the header out of the header row", () => {
    const rows = buildRows([piece("Description", 71, 176), piece("Qty", 326, 176), piece("=".repeat(40), 43, 181)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Description Qty");
  });

  it("keeps a row where dashes sit next to other cells", () => {
    const rows = buildRows([piece("---", 43, 200), piece("Spare part", 200, 200)]);
    expect(rows).toHaveLength(1);
    expect(cellTexts(rows[0])).toEqual(["---", "Spare part"]);
  });

  it("keeps a row of currency signs, which is not a separator", () => {
    const rows = buildRows([piece("$$$", 43, 200)]);
    expect(rows).toHaveLength(1);
  });

  it("keeps a row of only two dashes, which is too short to be a separator", () => {
    const rows = buildRows([piece("--", 43, 200)]);
    expect(rows).toHaveLength(1);
  });

  it("drops a row of underlines drawn under each heading, so it can't be taken for the headings", () => {
    const rows = buildRows([
      piece("Description", 71, 176),
      piece("Qty", 326, 176),
      piece("-----------", 71, 186),
      piece("-----", 326, 186),
      piece("Cedar post", 71, 198),
      piece("2", 326, 198),
    ]);
    expect(rows.map((row) => row.text)).toEqual(["Description Qty", "Cedar post 2"]);
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
  });
});

describe("buildRows on a real PDF", () => {
  let doc: PDFDocumentProxy;
  let rows: Row[];

  beforeAll(async () => {
    const opened = await openDocument(await buildPdf());
    if (!opened.ok) throw new Error("fixture failed to open");
    doc = opened.doc;
    const page = await readPage(opened.doc, opened.pdfjs, 1);
    rows = buildRows(page.pieces);
  });

  afterAll(async () => {
    await doc.loadingTask.destroy();
  });

  it("drops the dash separator, so no row has dashes and the header is alone", () => {
    expect(rows.some((row) => row.text.includes("---"))).toBe(false);
    const header = rows.find((row) => row.text.startsWith("Item"));
    expect(header && cellTexts(header)).toEqual(DEFAULT_COLUMNS.map((column) => column.header));
  });

  it("numbers the kept rows: supplier, title, header, then the three items", () => {
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows[0].text).toBe("Example Supplies Ltd");
    expect(rows[2].cells[0].text).toBe("Item");
    expect(cellTexts(rows[3])).toEqual(["1", "Pine batten 45x19", "12", "length", "$15.50", "$186.00"]);
  });

  it("gives the item cells their shapes and offsets into the row text", () => {
    const row = rows[3];
    expect(row.cells.map((cell) => cell.shape)).toEqual(["NUM", "TEXT", "NUM", "TEXT", "NUM", "NUM"]);
    for (const cell of row.cells) expect(row.text.slice(cell.start, cell.end)).toBe(cell.text);
    expect(row.fontSize).toBeCloseTo(9, 3);
  });
});
