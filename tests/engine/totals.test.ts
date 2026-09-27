/**
 * Tests for src/lib/engine/totals.ts: reading the printed totals, and checking
 * the lines against them.
 *
 * Two kinds of test:
 *   - readTotalRow and findTotalsCandidates on hand-made rows, so one test
 *     can set exactly how a totals line is drawn (one piece or two, which
 *     label, which number format).
 *   - The whole engine on built PDFs (tests/fixtures/build.ts), for the check
 *     itself: which check runs, what it covers, and every way it can pass,
 *     fail, or not run.
 * Every result from the engine is also checked against the contract. All text
 * is invented.
 */
import { describe, expect, it } from "vitest";

import { CHECK_REASONS, refusalMessage } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import { ParseResult } from "@/lib/contract/schema";
import { parsePdf, type EngineOutcome } from "@/lib/engine";
import { conventionsFor, CONVENTIONS, analyseNumber, type Convention } from "@/lib/engine/numbers";
import { buildRows, type Row } from "@/lib/engine/rows";
import { findTotalsCandidates, readTotalRow } from "@/lib/engine/totals";

import {
  DEFAULT_ROWS,
  GERMAN_STYLE_ROWS,
  TOTAL_GAP_STATED,
  buildPdf,
  multiPage,
  oneCellTotal,
  totalAfterScan,
  totalGap,
  twoPieceTotals,
  unknownLabelTotal,
} from "../fixtures/build";
import { piece } from "../fixtures/items";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "." decimals with "," thousands, as in "$1,195.20". */
const EN: Convention[] = conventionsFor([[analyseNumber("$1,195.20")]]);
/** "," decimals with "." thousands, as in "1.195,20 €". */
const DE: Convention[] = conventionsFor([[analyseNumber("1.195,20 €")]]);
/** "," decimals with a space for thousands, as in "1 195,20 €". */
const FR: Convention[] = conventionsFor([[analyseNumber("1 195,20 €")]]);

/**
 * One row from pieces drawn on the same line, each given as its text and its
 * left edge. Pieces far apart become separate cells, as on a real page.
 */
function rowOf(...pieces: [string, number][]): Row {
  const [row] = buildRows(pieces.map(([text, x]) => piece(text, x, 300)));
  return row;
}

/** The result, or a failed test if the whole file was refused. */
function read(outcome: EngineOutcome) {
  if (outcome.kind !== "read") throw new Error(`expected the file to be read, got ${outcome.refusal.code}`);
  const result = outcome.result;
  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...result });
  expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues[0])).toBe("ok");
  return result;
}

/** The totals refusals of a result. */
function totalsRefusals(result: ReturnType<typeof read>) {
  return result.refusals.filter((refusal) => refusal.scope === "totals");
}

// ---------------------------------------------------------------------------
// Reading one totals line
// ---------------------------------------------------------------------------

describe("readTotalRow", () => {
  it("reads a label and an amount drawn as one piece", () => {
    const candidate = readTotalRow(1, rowOf(["Total: $5,122.40", 380]), EN);
    expect(candidate).toMatchObject({ label: "Total:", kind: "total", reading: { status: "ok", value: 5122.4, dp: 2 } });
    expect(candidate?.amount).toMatchObject({ header: "Total:", raw: "$5,122.40", value: 5122.4 });
    const [start, end] = candidate?.amount.span ?? [0, 0];
    expect(candidate?.sourceText.slice(start, end)).toBe("$5,122.40");
  });

  it("reads a label and an amount drawn as two pieces the same way", () => {
    const candidate = readTotalRow(1, rowOf(["Total:", 380], ["$2,630.00", 500]), EN);
    expect(candidate).toMatchObject({ label: "Total:", kind: "total", reading: { value: 2630 } });
    expect(candidate?.sourceText).toBe("Total: $2,630.00");
  });

  it.each([
    ["Subtotal", "subtotal"],
    ["Sub-total:", "subtotal"],
    ["Total ex GST", "subtotal"],
    ["GST 15%", "gst"],
    ["Total incl GST", "total"],
    ["Grand total", "total"],
    ["Balance due", "amount_due"],
  ])("gives the label '%s' the kind %s", (label, kind) => {
    expect(readTotalRow(1, rowOf([label, 380], ["$240.00", 500]), EN)?.kind).toBe(kind);
  });

  it("keeps a label the vocabulary doesn't know, with no kind", () => {
    const candidate = readTotalRow(2, rowOf(["Summe:", 380], ["1.234,50 €", 500]), DE);
    expect(candidate).toMatchObject({ page: 2, label: "Summe:", kind: null, reading: { value: 1234.5 } });
    expect(candidate?.amount.currency).toBe("EUR");
  });

  it("reads a French amount with a thousands space inside one piece", () => {
    expect(readTotalRow(1, rowOf(["Total 1 195,20 €", 380]), FR)?.reading).toMatchObject({ value: 1195.2 });
  });

  it("never reads a space between two separate pieces as a thousands space", () => {
    // "1" and "195,20" are two cells, so they are not the number 1195,20.
    expect(readTotalRow(1, rowOf(["Total", 380], ["1", 450], ["195,20", 500]), FR)).toBeNull();
  });

  it.each([
    ["Page 1 of 8"],
    ["Site 1 of 4"],
    ["Driver notes: 16 pallets unloaded at site"],
    ["Total 25 $413.50"],
    ["GST 15%"],
    ["$413.50"],
  ])("does not read '%s' as a total", (text) => {
    expect(readTotalRow(1, rowOf([text, 380]), EN)).toBeNull();
  });

  it("marks an amount with two readings, and gives it no value", () => {
    const candidate = readTotalRow(1, rowOf(["Total:", 380], ["1.200", 500]), [...CONVENTIONS]);
    expect(candidate?.reading).toEqual({ status: "ambiguous", values: [1.2, 1200] });
    expect(candidate?.amount.value).toBeUndefined();
  });
});

describe("findTotalsCandidates", () => {
  it("notes a line with a totals label but no amount, and doesn't read it", () => {
    const line = rowOf(["Total consignment weight: see each line.", 43]);
    const result = findTotalsCandidates(1, [line], [], [], EN);
    expect(result.candidates).toEqual([]);
    expect(result.notes).toEqual([NOTES.totalLabelNoAmount(1, "Total consignment weight: see each line.")]);
  });

  it("skips the rows of another table on the page", () => {
    const row = rowOf(["Deposit", 43], ["$124.05", 400]);
    expect(findTotalsCandidates(1, [row], [], [row], EN).candidates).toEqual([]);
  });

  it("takes a moved 'Total' line's amount from its line-total cell, even when it also prints a quantity", () => {
    const row = rowOf(["Total", 71], ["25", 326], ["$413.50", 502]);
    const [candidate] = findTotalsCandidates(1, [], [{ row, amount: row.cells[2], hasTotalColumn: true }], [], EN).candidates;
    expect(candidate).toMatchObject({ label: "Total", kind: "total", reading: { value: 413.5 } });
    expect(candidate.amount.raw).toBe("$413.50");
  });
});

// ---------------------------------------------------------------------------
// The check, through the whole engine
// ---------------------------------------------------------------------------

describe("checkTotals: the lines against the printed total", () => {
  it("passes when the lines add up to a total drawn as one piece", async () => {
    const result = read(await parsePdf(await oneCellTotal()));
    expect(result.totals.stated).toHaveLength(1);
    expect(result.totals.stated[0]).toMatchObject({ label: "total", labelKnown: true, page: 1, amount: { raw: "$413.50", value: 413.5 } });
    expect(result.totals.checks).toEqual([
      {
        name: "lines_vs_total",
        outcome: "pass",
        pagesCovered: [1],
        derived: { label: "calculated by us", value: 413.5, fromItemIds: result.items.map((item) => item.id) },
      },
    ]);
    expect(totalsRefusals(result)).toEqual([]);
  });

  it("passes the same way when the label and the amount are two pieces", async () => {
    const result = read(await parsePdf(await twoPieceTotals([{ label: "Total:", amount: "$413.50" }])));
    expect(result.totals.checks[0]?.outcome).toBe("pass");
  });

  it("refuses with TOTALS_DISAGREE when the lines don't add up to the total, quoting both numbers", async () => {
    const result = read(await parsePdf(await totalGap()));
    expect(result.totals.checks[0]).toMatchObject({ name: "lines_vs_total", outcome: "fail", derived: { value: 413.5 } });
    const [refusal] = totalsRefusals(result);
    expect(refusal).toMatchObject({ id: "totals-lines_vs_total", code: "TOTALS_DISAGREE", scope: "totals", page: 1 });
    expect(refusal.message).toBe(
      refusalMessage({ code: "TOTALS_DISAGREE", pages: [1], label: "total", sum: "$413.50", stated: TOTAL_GAP_STATED, difference: "$36.50" }),
    );
    expect(refusal.message).toContain("(calculated by us)");
    expect(refusal.evidence).toEqual([{ page: 1, sourceText: `Total: ${TOTAL_GAP_STATED}` }]);
  });

  it("allows one cent per line for rounding, and no more", async () => {
    const within = read(await parsePdf(await twoPieceTotals([{ label: "Total:", amount: "$413.53" }])));
    expect(within.totals.checks[0]?.outcome).toBe("pass");
    const beyond = read(await parsePdf(await twoPieceTotals([{ label: "Total:", amount: "$413.54" }])));
    expect(beyond.totals.checks[0]?.outcome).toBe("fail");
  });

  it("checks the lines against the subtotal when one is printed, and only shows the GST and the total", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Subtotal", amount: "$413.50" },
          { label: "GST 15%", amount: "$62.03" },
          { label: "Total", amount: "$475.53" },
        ]),
      ),
    );
    expect(result.totals.stated.map((total) => total.label)).toEqual(["subtotal", "gst", "total"]);
    expect(result.totals.checks).toMatchObject([{ name: "lines_vs_subtotal", outcome: "pass" }]);
  });

  it("doesn't check a total when a GST line is printed but no subtotal", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "GST 15%", amount: "$62.03" },
          { label: "Total", amount: "$475.53" },
        ]),
      ),
    );
    expect(result.totals.checks).toEqual([
      { name: "lines_vs_total", outcome: "not_checked", pagesCovered: [], reason: CHECK_REASONS.gstNoSubtotal },
    ]);
    expect(totalsRefusals(result)).toEqual([]);
  });

  it("refuses with TOTALS_UNVERIFIABLE when the same label has two different amounts, quoting both", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Total", amount: "$413.50" },
          { label: "Total", amount: "$420.00" },
        ]),
      ),
    );
    const [refusal] = totalsRefusals(result);
    expect(refusal.code).toBe("TOTALS_UNVERIFIABLE");
    expect(refusal.message).toBe(
      refusalMessage({
        code: "TOTALS_UNVERIFIABLE",
        reason: "twoAmounts",
        label: "total",
        amounts: [
          { text: "$413.50", page: 1 },
          { text: "$420.00", page: 1 },
        ],
      }),
    );
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: refusal.message });
  });

  it("checks a total printed twice with the same amount", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Total", amount: "$413.50" },
          { label: "Total", amount: "$413.50" },
        ]),
      ),
    );
    expect(result.totals.checks[0]?.outcome).toBe("pass");
  });

  it("covers every page up to the total's page, and never counts a carried-forward line twice", async () => {
    const result = read(await parsePdf(await multiPage()));
    expect(result.totals.checks[0]).toMatchObject({
      name: "lines_vs_subtotal",
      outcome: "pass",
      pagesCovered: [1, 2, 3],
      derived: { value: 1144.95 },
    });
    expect(result.totals.checks[0]?.derived?.fromItemIds).toHaveLength(9);
  });

  it("refuses with TOTALS_UNVERIFIABLE when a page the total covers wasn't read", async () => {
    const result = read(await parsePdf(await totalAfterScan()));
    const [refusal] = totalsRefusals(result);
    expect(refusal.message).toBe(
      refusalMessage({ code: "TOTALS_UNVERIFIABLE", reason: "pageNotRead", label: "total", totalPage: 3, page: 2, status: "refused" }),
    );
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", pagesCovered: [1, 2, 3] });
  });

  it("refuses with TOTALS_UNVERIFIABLE when a line has no line total", async () => {
    const rows = [...DEFAULT_ROWS.map((row) => [...row]), ["4", "Delivery to site", "1", "trip", "$25.00", ""]];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Total", amount: "$438.50" }] }] })));
    expect(totalsRefusals(result).map((refusal) => refusal.message)).toEqual([
      refusalMessage({ code: "TOTALS_UNVERIFIABLE", reason: "missingLineTotal", label: "total", totalPage: 1, page: 1 }),
    ]);
  });

  it("says why when no total is printed", async () => {
    const result = read(await parsePdf(await buildPdf()));
    expect(result.totals).toEqual({
      stated: [],
      gstBasis: "unstated",
      checks: [{ name: "lines_vs_total", outcome: "not_checked", pagesCovered: [], reason: CHECK_REASONS.nothingStated }],
    });
  });

  it("refuses a total whose amount has two readings, and doesn't check it", async () => {
    // Only whole numbers in the table, so the page can't tell what "1.200" means.
    const rows = [
      ["1", "Fensterelement Eiche", "3", "Stk", "100", "300"],
      ["2", "Haustuer Laerche", "2", "Stk", "450", "900"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Total", amount: "1.200" }] }] })));
    const [refusal] = totalsRefusals(result);
    expect(refusal).toMatchObject({ code: "AMBIGUOUS_NUMBER_FORMAT", scope: "totals", page: 1 });
    expect(refusal.message).toContain("we didn't use that total");
    expect(result.totals.stated).toEqual([]);
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: refusal.message });
    expect(result.numberFormat.settled).toBe(false);
  });

  it("notes a totals label with no amount, and adds no refusal", async () => {
    const result = read(await parsePdf(await buildPdf({ pages: [{ after: ["Total weight: see each line."] }] })));
    expect(result.pages[0]?.notes).toContainEqual(NOTES.totalLabelNoAmount(1, "Total weight: see each line."));
    expect(totalsRefusals(result)).toEqual([]);
  });
});

describe("checkTotals: figures under a label we don't know", () => {
  it("uses the figure as the total when it equals the lines, with a note", async () => {
    const result = read(await parsePdf(await unknownLabelTotal({ matches: true })));
    expect(result.totals.stated).toMatchObject([{ label: "total", labelKnown: false, amount: { raw: "413,50", value: 413.5 } }]);
    expect(result.totals.checks[0]).toMatchObject({ name: "lines_vs_total", outcome: "pass" });
    expect(result.pages[0]?.notes).toContainEqual(NOTES.unknownLabelTotalUsed(1, "Endbetrag: 413,50"));
  });

  it("doesn't call a figure that differs from the lines a total, and never refuses because of it", async () => {
    const result = read(await parsePdf(await unknownLabelTotal({ matches: false })));
    expect(result.totals.stated).toEqual([]);
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.unknownFigure });
    expect(result.pages[0]?.notes).toContainEqual(NOTES.unknownFigureNotPlaced(1, "Endbetrag: 450,00"));
    expect(totalsRefusals(result)).toEqual([]);
    expect(result.items.map((item) => item.fields.lineTotal?.raw)).toEqual(GERMAN_STYLE_ROWS.map((row) => row[5]));
  });
});

describe("gstBasis", () => {
  it("is exclusive when the checked subtotal says 'ex GST'", async () => {
    const result = read(await parsePdf(await twoPieceTotals([{ label: "Total ex GST", amount: "$413.50" }])));
    expect(result.totals.gstBasis).toBe("exclusive");
  });

  it("is inclusive when the checked total says 'incl GST'", async () => {
    const result = read(await parsePdf(await twoPieceTotals([{ label: "Total incl GST", amount: "$413.50" }])));
    expect(result.totals.gstBasis).toBe("inclusive");
  });

  it("is unstated when nothing says", async () => {
    const result = read(await parsePdf(await oneCellTotal()));
    expect(result.totals.gstBasis).toBe("unstated");
  });
});

// ---------------------------------------------------------------------------
// Cases found when the totals code was attacked with made-up documents
// ---------------------------------------------------------------------------

/** Rows in whole dollars that add up to $454. */
const WHOLE_DOLLAR_ROWS = [
  ["1", "Hire of mixer, day", "2", "day", "$95", "$190"],
  ["2", "Hire of trailer, day", "2", "day", "$80", "$160"],
  ["3", "Delivery to site", "1", "trip", "$104", "$104"],
];

/** A second page of lines: $36.00 + $49.50 = $85.50. */
const PAGE_TWO_ROWS = [
  ["4", "Wire staple box 500", "2", "box", "$18.00", "$36.00"],
  ["5", "Joist hanger 90mm", "5", "ea", "$9.90", "$49.50"],
];

describe("checkTotals: labels that are not a money total", () => {
  it.each([["Total Qty"], ["Total pallets:"], ["Total items"]])(
    "doesn't take '%s' 25 as the total, and still checks the real total",
    async (label) => {
      const result = read(
        await parsePdf(
          await twoPieceTotals([
            { label, amount: "25" },
            { label: "Total", amount: "$413.50" },
          ]),
        ),
      );
      expect(result.totals.stated.map((total) => total.amount.raw)).toEqual(["$413.50"]);
      expect(result.totals.checks[0]?.outcome).toBe("pass");
      expect(totalsRefusals(result)).toEqual([]);
    },
  );

  it("doesn't take a GST number in the footer as a GST line", async () => {
    const rows = DEFAULT_ROWS.map((row) => [...row]);
    const result = read(
      await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Total", amount: "$413.50" }], after: ["GST No. 123456789"] }] })),
    );
    expect(result.totals.stated.map((total) => total.label)).toEqual(["total"]);
    expect(result.totals.checks[0]?.outcome).toBe("pass");
  });

  it("reads 'Total excl. GST' as the subtotal and 'Total GST' as the GST line", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Total excl. GST", amount: "$413.50" },
          { label: "Total GST", amount: "$62.03" },
          { label: "Total incl. GST", amount: "$475.53" },
        ]),
      ),
    );
    expect(result.totals.stated.map((total) => total.label)).toEqual(["subtotal", "gst", "total"]);
    expect(result.totals.checks).toMatchObject([{ name: "lines_vs_subtotal", outcome: "pass" }]);
  });

  it("doesn't read 'Total 25 413.50' as 25,413.50 on a page whose lines never show a space thousands mark", async () => {
    const result = read(await parsePdf(await buildPdf({ pages: [{ after: ["Total 25 413.50"] }] })));
    expect(result.totals.stated).toEqual([]);
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.totalNotRead });
    expect(result.pages[0]?.notes).toContainEqual(NOTES.totalAmountNotRead(1, "Total 25 413.50"));
  });

  it("gives no money total for a moved 'Total' line that only totals the quantity", async () => {
    const rows = [...DEFAULT_ROWS.map((row) => [...row]), ["", "Total", "25", "", "", ""]];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows }] })));
    expect(result.totals.stated).toEqual([]);
    expect(totalsRefusals(result)).toEqual([]);
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.totalLooksLikeCount });
    expect(result.pages[0]?.notes).toContainEqual(NOTES.totalNotMoney(1, "Total 25"));
  });

  it.each([
    ["with decimals, even without a currency sign", "413.5"],
    ["with a currency code instead of a sign", "NZD 413.50"],
  ])("keeps a total written %s as money", async (_name, amount) => {
    const result = read(await parsePdf(await twoPieceTotals([{ label: "Total", amount }])));
    expect(result.totals.stated.map((total) => total.amount.raw)).toEqual([amount]);
    expect(result.totals.checks[0]?.outcome).toBe("pass");
  });

  it("keeps a whole-number total that is the sum of the lines (money written without its cents)", async () => {
    const rows = [
      ["1", "Hire of mixer, day", "2", "day", "$95.00", "$190.00"],
      ["2", "Hire of trailer, day", "2", "day", "$80.00", "$160.00"],
      ["3", "Delivery to site", "1", "trip", "$104.00", "$104.00"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Total", amount: "454" }] }] })));
    expect(result.totals.stated.map((total) => total.amount.raw)).toEqual(["454"]);
    expect(result.totals.checks[0]?.outcome).toBe("pass");
  });

  it("lets a subtotal that looks like a count take no part in choosing the check", async () => {
    // "Subtotal 25" is set aside, so the GST line and the total decide: a
    // total next to a GST line with no subtotal can't be checked.
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Subtotal", amount: "25" },
          { label: "GST", amount: "$62.03" },
          { label: "Total", amount: "$475.53" },
        ]),
      ),
    );
    expect(result.totals.stated.map((total) => total.label)).toEqual(["gst", "total"]);
    expect(result.totals.checks[0]).toMatchObject({ name: "lines_vs_total", outcome: "not_checked", reason: CHECK_REASONS.gstNoSubtotal });
    expect(result.pages[0]?.notes).toContainEqual(NOTES.totalNotMoney(1, "Subtotal 25"));
  });

  it("reads a totals box drawn as its own small table, and doesn't say it wasn't read", async () => {
    // Three pieces per line at x 250, 350 and 450, which don't line up with
    // the item table's columns, so the box is found as a table of its own.
    const box = [
      ["Subtotal", "NZD", "413.50"],
      ["GST", "NZD", "62.03"],
      ["Total", "NZD", "475.53"],
    ].map((line) => line.map((str, k) => ({ x: 250 + k * 100, text: str })));
    const result = read(await parsePdf(await buildPdf({ pages: [{ box }] })));
    expect(result.items).toHaveLength(3);
    expect(result.totals.stated.map((total) => total.label)).toEqual(["subtotal", "gst", "total"]);
    expect(result.totals.checks[0]).toMatchObject({ name: "lines_vs_subtotal", outcome: "pass" });
    expect(result.pages[0]?.notes.map((note) => note.text).join(" ")).not.toContain("another table");
  });
});

describe("checkTotals: tolerance, scope and tax lines", () => {
  it("allows no difference at all when the amounts are whole dollars", async () => {
    const exact = read(await parsePdf(await buildPdf({ pages: [{ rows: WHOLE_DOLLAR_ROWS, totals: [{ label: "Total", amount: "$454" }] }] })));
    expect(exact.totals.checks[0]?.outcome).toBe("pass");
    const off = read(await parsePdf(await buildPdf({ pages: [{ rows: WHOLE_DOLLAR_ROWS, totals: [{ label: "Total", amount: "$456" }] }] })));
    expect(off.totals.checks[0]?.outcome).toBe("fail");
  });

  it("doesn't let a subtotal on page 1 stand for a document whose lines go on to page 2", async () => {
    const result = read(
      await parsePdf(
        await buildPdf({
          pages: [
            { totals: [{ label: "Subtotal", amount: "$413.50" }] },
            { rows: PAGE_TWO_ROWS, totals: [{ label: "Total", amount: "$600.00" }] },
          ],
        }),
      ),
    );
    // The page-2 total covers every line and is the one checked: $499.00 is not $600.00.
    expect(result.totals.checks[0]).toMatchObject({ name: "lines_vs_total", outcome: "fail", pagesCovered: [1, 2] });
  });

  it("doesn't check a total printed before some of the lines, and says why", async () => {
    const result = read(
      await parsePdf(await buildPdf({ pages: [{ totals: [{ label: "Total", amount: "$413.50" }] }, { rows: PAGE_TWO_ROWS }] })),
    );
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.earlyTotal });
  });

  it("never uses a figure under an unknown label from an earlier page as the document's total", async () => {
    const result = read(
      await parsePdf(
        await buildPdf({
          pages: [
            { rows: GERMAN_STYLE_ROWS.map((row) => [...row]), totals: [{ label: "Übertrag", amount: "413,50" }] },
            { rows: [["4", "Kantholz 90x45", "2", "Stk", "18,00", "36,00"]], totals: [{ label: "Gesamtbetrag", amount: "534,91" }] },
          ],
        }),
      ),
    );
    expect(result.totals.stated).toEqual([]);
    expect(result.totals.checks[0]?.outcome).toBe("not_checked");
    expect(result.pages[0]?.notes).toContainEqual(NOTES.figureBeforeLines(1, "Übertrag 413,50"));
  });

  it("doesn't check a total when a tax line with a percentage is printed, whatever the tax is called", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "VAT 20%", amount: "$82.70" },
          { label: "Total", amount: "$496.20" },
        ]),
      ),
    );
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.gstNoSubtotal });
    expect(totalsRefusals(result)).toEqual([]);
  });

  it("doesn't check a total next to a GST line whose amount has two readings", async () => {
    const rows = [
      ["1", "Fensterelement Eiche", "3", "Stk", "100", "300"],
      ["2", "Haustuer Laerche", "2", "Stk", "450", "900"],
    ];
    const result = read(
      await parsePdf(
        await buildPdf({
          pages: [
            {
              rows,
              totals: [
                { label: "GST", amount: "1.800" },
                { label: "Total", amount: "13.800" },
              ],
            },
          ],
        }),
      ),
    );
    expect(result.totals.checks[0]?.outcome).toBe("not_checked");
    expect(totalsRefusals(result).map((refusal) => refusal.code)).not.toContain("TOTALS_DISAGREE");
  });

  it("doesn't claim the lines include GST when the check didn't run", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "GST 15%", amount: "$62.03" },
          { label: "Total incl GST", amount: "$475.53" },
        ]),
      ),
    );
    expect(result.totals.checks[0]?.outcome).toBe("not_checked");
    expect(result.totals.gstBasis).toBe("unstated");
  });
});

describe("checkTotals: every figure we don't use gets a note that says why", () => {
  it("notes a figure under an unknown label when a known total is printed", async () => {
    const result = read(
      await parsePdf(
        await twoPieceTotals([
          { label: "Freight:", amount: "$36.50" },
          { label: "Total", amount: "$450.00" },
        ]),
      ),
    );
    expect(result.pages[0]?.notes).toContainEqual(NOTES.unknownFigureIgnored(1, "Freight: $36.50"));
  });

  it("refuses a figure under an unknown label whose amount has two readings", async () => {
    const rows = [
      ["1", "Fensterelement Eiche", "3", "Stk", "100", "300"],
      ["2", "Haustuer Laerche", "2", "Stk", "450", "900"],
    ];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Summe", amount: "1.200" }] }] })));
    expect(totalsRefusals(result).map((refusal) => refusal.code)).toEqual(["AMBIGUOUS_NUMBER_FORMAT"]);
    expect(result.numberFormat.settled).toBe(false);
  });

  it("says the lines couldn't be added up, not that the figure doesn't match, when a line has no total", async () => {
    const rows = [...GERMAN_STYLE_ROWS.map((row) => [...row]), ["4", "Lieferung", "1", "Fahrt", "25,00", ""]];
    const result = read(await parsePdf(await buildPdf({ pages: [{ rows, totals: [{ label: "Endbetrag:", amount: "438,50" }] }] })));
    expect(result.pages[0]?.notes).toContainEqual(NOTES.unknownFigureNotCompared(1, "Endbetrag: 438,50"));
    expect(result.totals.checks[0]).toMatchObject({ outcome: "not_checked", reason: CHECK_REASONS.unknownNotCompared });
  });
});
