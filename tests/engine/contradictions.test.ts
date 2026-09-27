/**
 * Tests for src/lib/engine/contradictions.ts: counts that contradict each
 * other in the text around the tables.
 *
 * Hand-made rows test each rule of the scan: what counts as a "<number>
 * <word>" pair, the singular form, and what is left out. Built PDFs test that
 * the engine only scans the text around the table, never the table itself.
 * All text is invented.
 */
import { describe, expect, it } from "vitest";

import { refusalMessage } from "@/lib/contract/codes";
import { ParseResult } from "@/lib/contract/schema";
import { parsePdf, type EngineOutcome } from "@/lib/engine";
import { findConflictingFigures, singular } from "@/lib/engine/contradictions";
import { buildRows, type Row } from "@/lib/engine/rows";

import { CONFLICTING_NOTES, buildPdf, conflictingNotes } from "../fixtures/build";
import { piece } from "../fixtures/items";

/** Rows from lines of text, one line each, 20 pt apart. */
function rows(...lines: string[]): Row[] {
  return buildRows(lines.map((text, k) => piece(text, 43, 100 + k * 20)));
}

/** The conflicts in lines of text on page 1. */
function conflictsIn(...lines: string[]) {
  return findConflictingFigures([{ page: 1, rows: rows(...lines) }]);
}

/** The result, or a failed test if the whole file was refused. */
function read(outcome: EngineOutcome) {
  if (outcome.kind !== "read") throw new Error(`expected the file to be read, got ${outcome.refusal.code}`);
  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...outcome.result });
  expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues[0])).toBe("ok");
  return outcome.result;
}

describe("singular", () => {
  it.each([
    ["pallets", "pallet"],
    ["Pallet", "pallet"],
    ["boxes", "box"],
    ["batches", "batch"],
    ["brushes", "brush"],
    ["deliveries", "delivery"],
    ["glasses", "glass"],
    ["glass", "glass"],
  ])("%s -> %s", (word, expected) => {
    expect(singular(word)).toBe(expected);
  });
});

describe("findConflictingFigures", () => {
  it("gives one refusal quoting both counts and both lines when a word has two numbers", () => {
    const [refusal, ...rest] = conflictsIn("Loading: 8 crates packed", "Driver notes: 9 crates unloaded");
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ id: "doc-CONFLICTING_FIGURES-crate", code: "CONFLICTING_FIGURES", scope: "document" });
    expect(refusal.message).toBe(
      refusalMessage({
        code: "CONFLICTING_FIGURES",
        mentions: [
          { text: "8 crates", page: 1 },
          { text: "9 crates", page: 1 },
        ],
      }),
    );
    expect(refusal.evidence).toEqual([
      { page: 1, sourceText: "Loading: 8 crates packed" },
      { page: 1, sourceText: "Driver notes: 9 crates unloaded" },
    ]);
  });

  it("treats 'crate' and 'crates' as the same word", () => {
    expect(conflictsIn("1 crate left behind", "3 crates delivered")).toHaveLength(1);
  });

  it("finds counts on different pages, and names each page", () => {
    const [refusal] = findConflictingFigures([
      { page: 1, rows: rows("Order: 12 sheets") },
      { page: 3, rows: rows("Received 10 sheets") },
    ]);
    expect(refusal.message).toContain("(page 1)");
    expect(refusal.message).toContain("(page 3)");
  });

  it("quotes every different number once", () => {
    const [refusal] = conflictsIn("5 bags", "6 bags", "5 bags", "7 bags");
    expect(refusal.message).toBe(
      refusalMessage({
        code: "CONFLICTING_FIGURES",
        mentions: [
          { text: "5 bags", page: 1 },
          { text: "6 bags", page: 1 },
          { text: "7 bags", page: 1 },
        ],
      }),
    );
  });

  it.each([
    ["the same number twice", ["14 pallets loaded", "14 pallets unloaded"]],
    ["'Site 1 of 4' and 'Page 1 of 8'", ["Site 1 of 4", "Site 2 of 4", "Page 1 of 8"]],
    ["dates", ["Delivered 24 August 2026", "Ordered 3 August 2026"]],
    ["a document number line", ["Invoice No: 4471 3 crates", "5 crates on site"]],
    ["a number glued to a comma", ["Site 14, Tirau", "Site 16, Taupo"]],
    ["a number glued to letters or a dash", ["KBS-10234 boxes", "400ml bottles", "12 bottles"]],
    ["an amount with a currency sign", ["$5,122.40 total", "$4.00 total"]],
    ["times of day", ["Loaded 7 am", "Unloaded 4 pm"]],
    ["a time glued to a colon", ["Arrived 7:15 trucks", "Left 9:40 trucks"]],
    ["lengths of time", ["Terms: 30 days", "Quote valid for 14 days"]],
    ["rates", ["Deposit 15 percent", "Discount 10 percent"]],
    ["sizes in units", ["Sheets cut to 1200 mm", "Offcuts under 400 mm"]],
    ["postcodes before a place name", ["Hamilton 3204 New Zealand", "Auckland 1010 New Zealand"]],
    ["the same count written with and without a thousands mark", ["1,000 sheets ordered", "1000 sheets delivered"]],
    ["the same count written with and without trailing zeros", ["2.5 bags spare", "2.50 bags spare"]],
    ["two numbers on one line (a size or a range)", ["Either 12 bags or 14 bags, as agreed"]],
  ])("gives no refusal for %s", (_name, lines) => {
    expect(conflictsIn(...lines)).toEqual([]);
  });

  it("never joins two cells of one row into a pair", () => {
    // "Qty 5" and "pallets loaded" sit far apart on one row. Joined, they
    // would read "5 pallets", which conflicts with "7 pallets" below.
    const table = buildRows([piece("Qty 5", 43, 100), piece("pallets loaded", 300, 100), piece("7 pallets on site", 43, 120)]);
    expect(table[0]?.cells).toHaveLength(2);
    expect(findConflictingFigures([{ page: 1, rows: table }])).toEqual([]);
  });

  it("matches a word with accents however its accents are stored", () => {
    // "thùng" (box) once as one character per letter, once as "u" plus a
    // separate grave accent. Both are the same word.
    const [refusal, ...rest] = conflictsIn("Giao 5 thùng", "Nhận 6 thùng");
    expect(rest).toEqual([]);
    expect(refusal?.id).toBe("doc-CONFLICTING_FIGURES-thùng");
  });

  it("quotes at most five values and five lines", () => {
    const lines = Array.from({ length: 8 }, (_, k) => `${k + 1} bags`);
    const [refusal] = conflictsIn(...lines);
    expect(refusal?.evidence).toHaveLength(5);
    expect(refusal?.evidence.map((evidence) => evidence.sourceText)).toEqual(lines.slice(0, 5));
    expect(refusal?.message).toContain("5 bags");
    expect(refusal?.message).not.toContain("6 bags");
  });

  it("stays fast on a very long line of numbers with no word after them", () => {
    const long = `${"1,".repeat(50_000)}1`;
    const started = performance.now();
    expect(conflictsIn(long, long)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("the contradiction scan in the engine", () => {
  it("finds the conflict between a line above the table and a note below it", async () => {
    const result = read(await parsePdf(await conflictingNotes()));
    const conflicts = result.refusals.filter((refusal) => refusal.code === "CONFLICTING_FIGURES");
    expect(conflicts.map((refusal) => refusal.id)).toEqual(["doc-CONFLICTING_FIGURES-crate"]);
    expect(conflicts[0].evidence).toEqual([
      { page: 1, sourceText: CONFLICTING_NOTES.above },
      { page: 1, sourceText: CONFLICTING_NOTES.below[0] },
    ]);
    // Document findings come first in the refusals.
    expect(result.refusals[0]?.code).toBe("CONFLICTING_FIGURES");
  });

  it("never scans the table itself", async () => {
    // The table has "8 box" (quantity 8, unit box). A note saying "3 box lids"
    // is the only mention outside the table, so there is no conflict.
    const result = read(await parsePdf(await buildPdf({ pages: [{ after: ["Extra: 3 box lids in the cab"] }] })));
    expect(result.refusals.filter((refusal) => refusal.code === "CONFLICTING_FIGURES")).toEqual([]);
  });
});
