/**
 * Tests for src/lib/engine/page-title.ts: which rows above a table are title
 * lines, and whether the title makes the page a returns/credit page or a
 * summary page.
 *
 * The rows are made by hand (one cell per row), so these tests do not depend
 * on the row builder. All text is invented.
 */
import { describe, expect, it } from "vitest";

import { isLabelLine, readPageTitle } from "@/lib/engine/page-title";
import type { Row } from "@/lib/engine/rows";
import { cellShape } from "@/lib/engine/shapes";

/** Makes a row with one cell that holds `text`, at position `index` on the page. */
function row(text: string, index = 0): Row {
  const x0 = 40;
  const x1 = x0 + text.length * 5;
  const y = 60 + index * 14;
  const piece = { str: text, x: x0, y, width: x1 - x0, fontSize: 10, angle: 0, order: index };
  const cell = { text, x0, x1, pieces: [piece], joinSpaces: [], shape: cellShape(text), start: 0, end: text.length };
  return { index, y, fontSize: 10, cells: [cell], text };
}

/** Makes rows from texts, numbered from the top. */
function rows(...texts: string[]): Row[] {
  return texts.map((text, index) => row(text, index));
}

describe("isLabelLine", () => {
  it.each([
    ["Document No: X-1", "two words then a colon"],
    ["Date : 1 May", "a space before the colon"],
    ["Delivered to: Lot 7, Fern Road", "two words"],
    ["Summary: 14 pallets loaded", "one word"],
    ["N° de piece : 88", "three words"],
    ["Ordered by:", "a colon at the end of the line"],
    ["Time:10:30", "a time after the label colon"],
  ])("reads %s as a label line (%s)", (text) => {
    expect(isLabelLine(text)).toBe(true);
  });

  it.each([
    ["Harbour Timber Ltd", "no colon"],
    ["Please check the goods on arrival: thank you", "more than 3 words before the colon"],
    ["Run 4 10:30", "the colon is part of a time"],
    [": 14 pallets", "no word before the colon"],
    ["Blue Hill - Returns Note", "a title with a separator"],
  ])("does not read %s as a label line (%s)", (text) => {
    expect(isLabelLine(text)).toBe(false);
  });
});

describe("readPageTitle: title lines", () => {
  it("keeps title lines as printed and leaves out label lines", () => {
    const title = readPageTitle(rows("Harbour Timber Ltd", "Delivery Docket", "Document No: HT-100", "Date : 1 May"));
    expect(title.titleLines).toEqual(["Harbour Timber Ltd", "Delivery Docket"]);
    expect(title.creditTitle).toBeNull();
    expect(title.creditRow).toBeNull();
    expect(title.summaryTitle).toBeNull();
  });

  it("gives empty results when there are no rows above the table", () => {
    expect(readPageTitle([])).toEqual({ titleLines: [], creditTitle: null, creditRow: null, summaryTitle: null });
  });
});

describe("readPageTitle: credit and return pages", () => {
  it("quotes the segment of a 'Name - Title' line", () => {
    const above = rows("Blue Hill Supplies", "Blue Hill - Returns Note", "Date: 2 May");
    const title = readPageTitle(above);
    expect(title.creditTitle).toBe("Returns Note");
    expect(title.creditRow).toBe(above[1]);
  });

  it("quotes the whole line when it has no separator", () => {
    expect(readPageTitle(rows("Credit Adjustment")).creditTitle).toBe("Credit Adjustment");
  });

  it("splits on an en dash and on a bar", () => {
    expect(readPageTitle(rows("Blue Hill – Refund")).creditTitle).toBe("Refund");
    expect(readPageTitle(rows("Blue Hill | Stock Return | May")).creditTitle).toBe("Stock Return");
  });

  it("finds a credit word in the label part of a label line", () => {
    const above = rows("Blue Hill Supplies", "Credit Note: CN-1");
    const title = readPageTitle(above);
    expect(title.creditTitle).toBe("Credit Note: CN-1");
    expect(title.creditRow).toBe(above[1]);
    expect(title.titleLines).toEqual(["Blue Hill Supplies"]);
  });

  it("ignores a credit word in the value part of a label line", () => {
    const title = readPageTitle(rows("Reason: stock return"));
    expect(title.creditTitle).toBeNull();
    expect(title.creditRow).toBeNull();
  });

  it("matches whole words only", () => {
    expect(readPageTitle(rows("Creditor Supplies Ltd")).creditTitle).toBeNull();
    expect(readPageTitle(rows("Accredited Returnable Crates")).creditTitle).toBeNull();
  });

  it("quotes the first matching row from the top", () => {
    const above = rows("Refund Advice", "Credit Adjustment");
    const title = readPageTitle(above);
    expect(title.creditTitle).toBe("Refund Advice");
    expect(title.creditRow).toBe(above[0]);
  });
});

describe("readPageTitle: summary pages", () => {
  it("quotes the segment with the summary word", () => {
    expect(readPageTitle(rows("Run 7 - Summary - Batch 7")).summaryTitle).toBe("Summary");
  });

  it("finds an acceptance word", () => {
    expect(readPageTitle(rows("Signed Acceptance")).summaryTitle).toBe("Signed Acceptance");
  });

  it("finds a summary word in a title that holds a time", () => {
    expect(readPageTitle(rows("Summary - 10:30 run")).summaryTitle).toBe("Summary");
  });

  it("never takes a summary word from a label line", () => {
    const title = readPageTitle(rows("Summary: 14 pallets loaded at the yard"));
    expect(title.summaryTitle).toBeNull();
    expect(title.titleLines).toEqual([]);
  });

  it("lets a credit word win over a summary word", () => {
    const sameLine = readPageTitle(rows("Returns Summary"));
    expect(sameLine.creditTitle).toBe("Returns Summary");
    expect(sameLine.summaryTitle).toBeNull();

    const otherLines = readPageTitle(rows("Run 7 - Summary", "Credit Note: CN-2"));
    expect(otherLines.creditTitle).toBe("Credit Note: CN-2");
    expect(otherLines.summaryTitle).toBeNull();
  });

  it("does not match a summary word inside another word", () => {
    expect(readPageTitle(rows("Summarylink Freight")).summaryTitle).toBeNull();
  });
});
