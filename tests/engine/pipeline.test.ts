/**
 * Tests for the rules in the engine's wiring (src/lib/engine/index.ts).
 *
 * Each step has its own tests. These tests check what only the wiring decides,
 * or what needs a real PDF read by pdf.js:
 *   - a text page with no table: "mostly a scan" or "no table found"
 *   - a page titled as returns or credit: refused, with its rows quoted
 *   - a summary page: read, with a warning
 *   - ambiguous columns: no line items at all
 *   - the evidence gate: an item that fails is replaced by a refusal, the page's
 *     status follows, and the other pages are untouched
 *   - each page read in its own number format, never one borrowed from
 *     another page
 *   - totals lines and cells that pdf.js joined, which must never become a
 *     wrong number
 *   - each page's status, the order of refusals, and that every result fits
 *     the contract
 * All fixture text is invented.
 */
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";

import { refusalMessage } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import { ParseResult } from "@/lib/contract/schema";
import { defaultDeps, parsePdf, type EngineDeps, type EngineOutcome } from "@/lib/engine";

import { DEFAULT_COLUMNS, DEFAULT_ROWS, buildPdf, mismatchRow, threePages, titledPages } from "../fixtures/build";
import { noTable } from "../fixtures/languages";
import { TINY_PNG } from "../fixtures/png";

/** The result, or a failed test if the whole file was refused. */
function read(outcome: EngineOutcome) {
  if (outcome.kind !== "read") throw new Error(`expected the file to be read, got ${outcome.refusal.code}`);
  return outcome.result;
}

/** Checks that a result fits the contract, as the route does before sending it. */
function expectValidContract(result: ReturnType<typeof read>) {
  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...result });
  expect(parsed.success ? "ok" : parsed.error.issues[0]?.message).toBe("ok");
}

/** A one-page PDF with a picture and only a few words of real text: what a scan with a stamp looks like. */
function scanWithAFewWords(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.image(TINY_PNG, 40, 40, { width: 500 });
    doc.fontSize(9).text("Scanned copy", 43, 800, { lineBreak: false });
    doc.end();
  });
}

describe("a text page with no table", () => {
  it("is 'mostly a scan' when it has a picture and only a few words", async () => {
    const result = read(await parsePdf(await scanWithAFewWords()));
    expect(result.pages[0]?.status).toBe("refused");
    expect(result.refusals[0]).toMatchObject({ code: "NO_TEXT_LAYER", scope: "page", page: 1 });
    expect(result.refusals[0]?.message).toContain("mostly a scanned picture");
    // The message already says it is a picture, so the "images were not read" note is not repeated.
    expect(result.pages[0]?.notes.map((note) => note.text).join(" ")).not.toContain("images as well as text");
    expectValidContract(result);
  });

  it("is 'no table found' when it has plenty of text, and quotes at most 5 rows", async () => {
    const result = read(await parsePdf(await noTable()));
    expect(result.refusals[0]).toMatchObject({ code: "NO_TABLE_FOUND", scope: "page", page: 1 });
    expect(result.refusals[0]?.evidence.length).toBeGreaterThan(0);
    expect(result.refusals[0]?.evidence.length).toBeLessThanOrEqual(5);
    expect(result.items).toHaveLength(0);
    expectValidContract(result);
  });
});

describe("page titles", () => {
  it("refuses returns and credit pages with their rows quoted, and warns on summary and acceptance pages", async () => {
    const result = read(await parsePdf(await titledPages()));
    const byPage = (page: number) => result.refusals.filter((refusal) => refusal.page === page).map((r) => r.code);

    // Page 1: "Weekly Summary". Read, with a warning.
    expect(result.pages[0]?.status).toBe("extracted");
    expect(result.pages[0]?.notes.some((note) => note.level === "warning" && note.text.includes("'Weekly Summary'"))).toBe(true);

    // Pages 2 and 3: returns and credit. Refused, no items, every row quoted.
    for (const page of [2, 3]) {
      expect(result.pages[page - 1]?.status).toBe("refused");
      expect(byPage(page)).toEqual(["CREDIT_OR_RETURN_PAGE"]);
      expect(result.items.filter((item) => item.page === page)).toHaveLength(0);
      const refusal = result.refusals.find((r) => r.page === page);
      // The title row, the header and the three item rows.
      expect(refusal?.evidence.length).toBeGreaterThanOrEqual(5);
    }
    expect(result.refusals.find((r) => r.page === 2)?.message).toContain("titled 'Returns Slip'");

    // Page 4: "Customer Acceptance". Read, with a warning.
    expect(result.pages[3]?.notes.some((note) => note.level === "warning")).toBe(true);

    // Page 5: a "Summary: ..." label line is not a title, so no warning.
    expect(result.pages[4]?.status).toBe("extracted");
    expect(result.pages[4]?.notes.some((note) => note.level === "warning")).toBe(false);
    expectValidContract(result);
  });
});

describe("ambiguous columns", () => {
  it("lists no line items when two columns could both be the quantity", async () => {
    // "Qty" and "Quantity" hold the same numbers, so the numbers can't choose
    // and the header words give both the quantity role.
    const columns = [
      DEFAULT_COLUMNS[0],
      DEFAULT_COLUMNS[1],
      { header: "Qty", x: 300 },
      { header: "Quantity", x: 360 },
      DEFAULT_COLUMNS[4],
      DEFAULT_COLUMNS[5],
    ];
    const rows = [
      ["1", "Pine batten 45x19", "12", "12", "$15.50", "$186.00"],
      ["2", "Deck screws 10g box", "8", "8", "$22.25", "$178.00"],
      ["3", "Joist hanger 90mm", "5", "5", "$9.90", "$49.50"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ columns, rows }] })));
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["AMBIGUOUS_COLUMNS"]);
    expect(result.items).toHaveLength(0);
    expect(result.pages[0]?.status).toBe("refused");
    expectValidContract(result);
  });
});

describe("the evidence gate", () => {
  it("replaces every item that fails with a refusal, sets the page's status, and leaves other pages alone", async () => {
    // Give page 1 an empty copy of its page text, so no row can be found on
    // the page, and every item of page 1 must fail the gate.
    const deps: EngineDeps = {
      ...defaultDeps,
      processPage: async (doc, pdfjs, page) => {
        const findings = await defaultDeps.processPage(doc, pdfjs, page);
        return page === 1 ? { ...findings, streamText: "" } : findings;
      },
    };
    const normal = read(await parsePdf(await threePages()));
    const gated = read(await parsePdf(await threePages(), deps));

    const page1 = gated.refusals.filter((refusal) => refusal.page === 1);
    expect(page1.map((refusal) => refusal.code)).toEqual(["EVIDENCE_CHECK_FAILED", "EVIDENCE_CHECK_FAILED", "EVIDENCE_CHECK_FAILED"]);
    // Row refusals are in row order.
    const rows = page1.map((refusal) => refusal.rowIndex ?? -1);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    // No item left on page 1, so the page is refused; pages 2 and 3 are as normal.
    expect(gated.pages[0]?.status).toBe("refused");
    expect(gated.pages[0]?.itemCount).toBe(0);
    for (const page of [2, 3]) {
      expect(gated.items.filter((item) => item.page === page)).toEqual(normal.items.filter((item) => item.page === page));
      expect(gated.pages[page - 1]).toEqual(normal.pages[page - 1]);
    }
    expectValidContract(gated);
  });
});

/**
 * A one-page PDF whose numbers are right-aligned, with the quantity's right
 * edge only 31.5 pt left of the price's right edge. A short quantity and a
 * price with three digits before the point ("2" and "150.00") are then about
 * 4 pt apart, and pdf.js returns them as one piece: "2 150.00".
 */
function tightColumns(rows: string[][]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(9);
    const lefts = [43, 71];
    const rights = [300, 331.5, 420];
    const draw = (cells: string[], y: number) =>
      cells.forEach((cell, i) => {
        if (cell === "") return;
        const x = i < lefts.length ? lefts[i] : rights[i - lefts.length] - doc.widthOfString(cell);
        doc.text(cell, x, y, { lineBreak: false });
      });
    doc.text("Invented Timber Co", 43, 57, { lineBreak: false });
    draw(["Item", "Description", "Qty", "Price", "Total"], 176);
    rows.forEach((row, k) => draw(row, 198 + k * 17));
    doc.end();
  });
}

describe("each page's own number format", () => {
  it("never reads a page with a format borrowed from another page", async () => {
    // Page 1 writes "$1,250.00". Page 2's numbers are all like "1.200", which
    // is 1200 in Germany and 1.2 in New Zealand, and page 2 alone can't tell.
    const newZealand = DEFAULT_ROWS.map((row) => [...row]);
    newZealand[0] = ["1", "Cedar weatherboard", "40", "length", "$31.25", "$1,250.00"];
    const german = [
      ["1", "Fensterelement Eiche", "3", "Stk", "1.200", "3.600"],
      ["2", "Haustuer Laerche", "2", "Stk", "2.450", "4.900"],
      ["3", "Schiebetuer Anlage", "4", "Stk", "1.150", "4.600"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows: newZealand }, { rows: german }] })));
    expect(result.items.filter((item) => item.page === 1)).toHaveLength(3);
    // Page 2's headings are English, so every row is read, and every price is
    // refused as having two readings: never read as 1.2.
    expect(result.items.filter((item) => item.page === 2)).toEqual([]);
    const page2 = result.refusals.filter((refusal) => refusal.page === 2).map((refusal) => refusal.code);
    expect(page2).toEqual(["AMBIGUOUS_NUMBER_FORMAT", "AMBIGUOUS_NUMBER_FORMAT", "AMBIGUOUS_NUMBER_FORMAT"]);
    expect(result.numberFormat.settled).toBe(false);
    expectValidContract(result);
  });

  it("reads pages that use different formats, each in its own", async () => {
    const german = [
      ["1", "Holzfaserplatte 22 mm", "40", "Platte", "31,25", "1.250,00"],
      ["2", "Klebeband 60 mm", "8", "Rolle", "22,25", "178,00"],
      ["3", "Dampfbremsfolie", "5", "Rolle", "9,90", "49,50"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{}, { rows: german }] })));
    expect(result.refusals).toEqual([]);
    const page2 = result.items.filter((item) => item.page === 2);
    expect(page2.map((item) => item.fields.lineTotal?.value)).toEqual([1250, 178, 49.5]);
    expect(page2.map((item) => item.fields.unitPrice?.value)).toEqual([31.25, 22.25, 9.9]);
    // The pages share no format, so the document's format is unknown.
    expect(result.numberFormat).toEqual({ decimal: null, grouping: null, settled: false });
    expectValidContract(result);
  });

  it("refuses only the row of a number written differently from the rest of its page, and says why", async () => {
    const rows = DEFAULT_ROWS.map((row) => [...row]);
    rows[2] = ["3", "Joist hanger 90mm", "1,5", "ea", "$9.90", "$14.85"];
    const result = read(await parsePdf(await buildPdf({ pages: [{}, { rows }] })));
    expect(result.items).toHaveLength(5);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ code: "UNPARSEABLE_NUMBER", page: 2 });
    expect(result.refusals[0].message).toBe(
      refusalMessage({ code: "UNPARSEABLE_NUMBER", page: 2, raw: "1,5", otherFormat: true }),
    );
    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "partial"]);
    expectValidContract(result);
  });
});

describe("numbers that must never come out wrong", () => {
  it("doesn't list a 'Total' line that also prints the total quantity, and quotes it in a note", async () => {
    const rows = [...DEFAULT_ROWS, ["", "Total", "25", "", "", "$413.50"]];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows }] })));
    expect(result.items).toHaveLength(3);
    expect(result.refusals).toEqual([]);
    expect(result.pages[0]?.notes).toContainEqual(NOTES.totalsRowSkipped(1, "Total 25 $413.50"));
    expectValidContract(result);
  });

  it("refuses a quantity and a price that pdf.js joined into one piece, instead of reading one number", async () => {
    const result = read(
      await parsePdf(
        await tightColumns([
          ["1", "Pine batten 45x19", "12", "15.50", "186.00"],
          ["2", "Deck screws 10g box", "10", "22.25", "222.50"],
          ["3", "Treated post 100x100", "2", "150.00", "300.00"],
          ["4", "Joist hanger 90mm", "24", "9.90", "237.60"],
        ]),
      ),
    );
    expect(result.items).toHaveLength(3);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["UNPARSEABLE_NUMBER"]);
    expect(result.refusals[0].message).toContain("'2 150.00'");
    for (const item of result.items) expect(item.fields.unitPrice?.value).not.toBe(2150);
    expectValidContract(result);
  });
});

describe("page statuses", () => {
  it("is 'partial' when a row is refused and other items are listed", async () => {
    const result = read(await parsePdf(await mismatchRow()));
    expect(result.pages[0]?.status).toBe("partial");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["ARITHMETIC_MISMATCH"]);
    expect(result.items).toHaveLength(2);
    expectValidContract(result);
  });

  it("is 'partial' when no column's meaning is known, and the rows are listed as printed, with no value", async () => {
    const columns = [
      { header: "Account", x: 43 },
      { header: "Terms", x: 200 },
      { header: "Balance", x: 400 },
    ];
    const rows = [
      ["4471", "30 days", "$1,250.00"],
      ["5820", "7 days", "$310.40"],
      ["6112", "20th of month", "$92.15"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ columns, rows }] })));
    expect(result.pages[0]?.status).toBe("partial");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["COLUMN_MEANING_UNKNOWN"]);
    expect(result.items).toHaveLength(3);
    expect(JSON.stringify(result.items)).not.toContain('"value"');
    expectValidContract(result);
  });

  it("keeps a page's gate refusals and row refusals in row order", async () => {
    // mismatchRow's middle row is refused by the arithmetic check. Changing the
    // quantity value of the other two items after they were built makes the
    // evidence gate refuse them too.
    const deps: EngineDeps = {
      ...defaultDeps,
      analysePage: async (findings) => {
        const analysis = await defaultDeps.analysePage(findings);
        const items = analysis.items.map((item) => {
          const quantity = item.fields.quantity;
          return quantity ? { ...item, fields: { ...item.fields, quantity: { ...quantity, value: 99 } } } : item;
        });
        return { ...analysis, items };
      },
    };
    const result = read(await parsePdf(await mismatchRow(), deps));
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "EVIDENCE_CHECK_FAILED",
      "ARITHMETIC_MISMATCH",
      "EVIDENCE_CHECK_FAILED",
    ]);
    const rows = result.refusals.map((refusal) => refusal.rowIndex ?? -1);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(result.pages[0]?.status).toBe("refused");
    expectValidContract(result);
  });

  it("is 'extracted' for a page with a table and a logo, with a note that the image wasn't read", async () => {
    const result = read(await parsePdf(await buildPdf({ pages: [{ logo: true }] })));
    expect(result.pages[0]?.status).toBe("extracted");
    expect(result.items).toHaveLength(3);
    expect(result.pages[0]?.notes).toContainEqual(NOTES.imagesNotRead(1));
    expectValidContract(result);
  });
});

describe("a clean document", () => {
  it("reads every row of every page as an item, with no refusals", async () => {
    const result = read(await parsePdf(await threePages()));
    expect(result.items).toHaveLength(9);
    expect(result.refusals).toEqual([]);
    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "extracted", "extracted"]);
    expect(result.numberFormat).toMatchObject({ decimal: ".", settled: true });
    expectValidContract(result);
  });
});
