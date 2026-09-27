/**
 * Tests for the refusal wording in src/lib/contract/codes.ts.
 *
 * What these tests protect
 * ------------------------
 * The brief fails a submission if a refusal reaches the user as a generic
 * error. These tests render EVERY refusal message, with every variant, and
 * check that each one is a real, specific sentence:
 *   - it is not empty and ends like a sentence
 *   - it never contains generic or leaked-code words ("something went wrong",
 *     "an error occurred", "exception", "undefined", "null", "NaN",
 *     "[object Object]")
 *   - it names the page when the refusal is about a page, so the user can find it
 *
 * Separately, the messages that contain numbers we calculated
 * (ARITHMETIC_MISMATCH and TOTALS_DISAGREE) must label them "(calculated by us)",
 * and every note in src/lib/contract/notes.ts must pass the same sentence checks.
 *
 * The SAMPLES table below is typed against the list of refusal codes. If
 * someone adds a code to schema.ts without adding samples here, TypeScript
 * fails the build, so no new code can skip these checks.
 */
import { describe, expect, it } from "vitest";

import {
  CHECK_REASONS,
  DOCUMENT_PROBLEM_TITLES,
  INTERNAL_PROBLEM,
  REFUSAL_MESSAGES,
  type MessageContexts,
  type RefusalInput,
  listText,
  megabytes,
  pagesText,
  problemType,
  refusalMessage,
} from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import {
  DOCUMENT_HTTP_STATUS,
  DocumentCode,
  INTERNAL_HTTP_STATUS,
  PAGE_REFUSAL_STATUS,
  REFUSAL_SCOPES,
  RefusalCode,
  RefusalScope,
} from "@/lib/contract/schema";

/** Words that must never appear in anything the user reads. */
const FORBIDDEN = [
  /something went wrong/i,
  /an error occurred/i,
  /exception/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bNaN\b/,
  /\[object /i,
];

/**
 * At least one set of facts per refusal code, and one per variant where a
 * message has several (for example the three causes of PAGE_LOAD_FAILED).
 * The values are invented; none come from the sample PDFs.
 */
const SAMPLES: { [Code in RefusalCode]: MessageContexts[Code][] } = {
  NO_FILE: [{}],
  EMPTY_FILE: [{}],
  FILE_TOO_LARGE: [{ sizeBytes: 6.2 * 1024 * 1024, limitBytes: 4 * 1024 * 1024 }],
  NOT_A_PDF: [{ fileName: "notes.pdf" }, { fileName: "photo.jpg" }],
  ENCRYPTED: [{}],
  CORRUPT_FILE: [{}],
  TOO_MANY_PAGES: [{ pageCount: 350, limit: 200 }],
  TOO_MANY_LINES: [
    { itemCount: 7200, leftOutCount: 0, pagesPerFile: 150 },
    { itemCount: 7200, leftOutCount: 1, pagesPerFile: 1 },
    { itemCount: 0, leftOutCount: 11000, pagesPerFile: null },
  ],

  NO_TEXT_LAYER: [
    { page: 3, form: "scan" },
    { page: 3, form: "mostlyScan" },
    { page: 3, form: "shapes" },
  ],
  GARBLED_TEXT: [{ page: 2 }],
  ROTATED_TEXT: [
    { page: 4, allText: false },
    { page: 4, allText: true },
  ],
  PAGE_LOAD_FAILED: [
    { page: 5, cause: "error" },
    { page: 5, cause: "timeout" },
    { page: 5, cause: "budget" },
  ],
  NO_TABLE_FOUND: [{ page: 1 }],
  AMBIGUOUS_COLUMNS: [
    {
      page: 2,
      kind: "numbersVsHeader",
      column: { header: "Rate", position: 5 },
      numbersRole: "lineTotal",
      headerRole: "unitPrice",
    },
    {
      page: 2,
      kind: "sameRole",
      role: "quantity",
      columns: [
        { header: "Qty", position: 3 },
        { header: null, position: 4 },
      ],
    },
  ],
  COLUMN_MEANING_UNKNOWN: [{ page: 2 }],
  CREDIT_OR_RETURN_PAGE: [{ page: 6, title: "Returns Note" }],

  UNPARSEABLE_NUMBER: [
    { page: 1, raw: "$12.50 box" },
    { page: 3, raw: "1,5", otherFormat: true },
  ],
  NO_DESCRIPTION: [{ page: 1, rowText: "2 45.00 90.00" }],
  ARITHMETIC_MISMATCH: [
    { page: 1, quantity: "2", unitPrice: "$45.00", lineTotal: "$95.00", expected: "$90.00" },
    {
      page: 1,
      quantity: "2",
      unitPrice: "$45.00",
      lineTotal: "$81.00",
      expected: "$90.00",
      columnBetween: "Disc %",
    },
  ],
  AMBIGUOUS_NUMBER_FORMAT: [
    { page: 1, raw: "1.200", readings: ["1200", "1.2"], target: "line" },
    { page: 2, raw: "3.400", readings: ["3400", "3.4"], target: "total" },
  ],
  EVIDENCE_CHECK_FAILED: [{ page: 2, raw: "$99.00" }, { page: 2 }],

  CONFLICTING_FIGURES: [
    {
      mentions: [
        { text: "8 crates", page: 1 },
        { text: "9 crates", page: 1 },
      ],
    },
    {
      mentions: [
        { text: "8 crates", page: 1 },
        { text: "9 crates", page: 2 },
        { text: "10 crates", page: 3 },
      ],
    },
  ],
  TOTALS_DISAGREE: [{ pages: [1, 2], label: "total", sum: "$3,417.60", stated: "$3,500.00", difference: "$82.40" }],
  TOTALS_UNVERIFIABLE: [
    { reason: "pageNotRead", label: "total", totalPage: 2, page: 1, status: "partial" },
    { reason: "pageNotRead", label: "subtotal", totalPage: 2, page: 1, status: "refused" },
    { reason: "pageNotRead", label: "total", totalPage: 3, page: 2, status: "blank" },
    { reason: "pageNotRead", label: "total", totalPage: 2, page: 1, status: "refused", noTable: true },
    { reason: "missingLineTotal", label: "total", totalPage: 2, page: 1 },
    {
      reason: "twoAmounts",
      label: "total",
      amounts: [
        { text: "$500.00", page: 1 },
        { text: "$550.00", page: 2 },
      ],
    },
  ],
  NO_LINE_ITEMS_FOUND: [{}],
};

/**
 * Every (code, sample) pair as one `RefusalInput`, ready to pass to
 * `refusalMessage`. Building the list loses the link between each code and its
 * context type, so we cast here; the SAMPLES table above already checked each
 * context against its code.
 */
const CASES = RefusalCode.options.flatMap((code) =>
  SAMPLES[code].map((context, index) => ({ code, index, input: { code, ...context } as RefusalInput })),
);

/** The message for the n-th sample of a code. */
function sample<Code extends RefusalCode>(code: Code, index = 0): string {
  return refusalMessage({ code, ...SAMPLES[code][index] } as RefusalInput);
}

describe("refusal messages", () => {
  it("has samples for every refusal code", () => {
    for (const code of RefusalCode.options) {
      expect(SAMPLES[code].length, `${code} needs at least one sample`).toBeGreaterThan(0);
    }
  });

  it.each(CASES)("$code (sample $index) reads as a plain, specific sentence", ({ code, input }) => {
    const message = refusalMessage(input);

    expect(message.trim().length).toBeGreaterThan(20);
    // Ends like a sentence, so it reads as a full explanation, not a label.
    expect(message).toMatch(/[.!?]$/);
    for (const pattern of FORBIDDEN) {
      expect(message, `${code} must not contain ${pattern}`).not.toMatch(pattern);
    }

    // A refusal about a page must say which page, so the user can find it.
    if ("page" in input && typeof input.page === "number") {
      expect(message).toMatch(new RegExp(`\\b[Pp]age ${input.page}\\b`));
    }
  });

  it("labels the numbers we calculated in the arithmetic and totals messages", () => {
    const arithmetic = sample("ARITHMETIC_MISMATCH");
    expect(arithmetic).toContain("$90.00 (calculated by us)");
    // The number read from the document is quoted as printed, with no label.
    expect(arithmetic).toContain("the document says $95.00");

    const totals = sample("TOTALS_DISAGREE");
    expect(totals).toContain("$3,417.60 (calculated by us)");
    expect(totals).toContain("$82.40 (calculated by us)");
    expect(totals).toContain("says $3,500.00");
  });

  it("says what happened after a refusal, not only that there was one", () => {
    expect(sample("ARITHMETIC_MISMATCH")).toContain("so we left this line out");
    expect(sample("AMBIGUOUS_COLUMNS")).toContain("so we didn't read the lines on this page");
  });

  it("names a column between the price and the total when there is one", () => {
    expect(sample("ARITHMETIC_MISMATCH", 1)).toContain("'Disc %' column between the price and the total");
  });

  it("names a column without a heading by its position", () => {
    expect(sample("AMBIGUOUS_COLUMNS", 1)).toBe(
      "Page 2 has two columns that could be the quantity ('Qty' and column 4). " +
        "We can't tell which is right, so we didn't read the lines on this page.",
    );
  });

  it("lists every conflicting figure with its page", () => {
    expect(sample("CONFLICTING_FIGURES")).toBe(
      "The document says 8 crates in one place (page 1) and 9 crates in another (page 1). " +
        "We can't tell which one is right.",
    );
    expect(sample("CONFLICTING_FIGURES", 1)).toContain("8 crates (page 1), 9 crates (page 2) and 10 crates (page 3)");
  });

  it("names the page of each amount when a total is printed twice", () => {
    expect(sample("TOTALS_UNVERIFIABLE", 5)).toContain("($500.00 on page 1 and $550.00 on page 2)");
  });

  it("says that a page with no table may hold lines, instead of saying it couldn't be read", () => {
    expect(sample("TOTALS_UNVERIFIABLE", 3)).toBe(
      "We couldn't check the total on page 2 because page 1 has no table we could read, so it may hold lines we didn't see.",
    );
  });

  it("says what a page without readable text has instead", () => {
    expect(sample("NO_TEXT_LAYER", 0)).toContain("is a scanned picture");
    expect(sample("NO_TEXT_LAYER", 2)).toContain("has drawings but no text we can read");
  });

  it("only talks about numbers when the numbers are what is sideways", () => {
    expect(sample("ROTATED_TEXT", 0)).toContain("Most of the numbers on page 4");
    expect(sample("ROTATED_TEXT", 1)).toBe("All the text on page 4 is printed sideways, so we skipped the page.");
  });

  it("only says 'ends in .pdf' when the file name really does", () => {
    expect(refusalMessage({ code: "NOT_A_PDF", fileName: "Invoice.PDF" })).toContain("even though its name ends in .pdf");
    expect(refusalMessage({ code: "NOT_A_PDF", fileName: "photo.jpg" })).not.toContain("ends in .pdf");
  });

  it("has a message for every code", () => {
    for (const code of RefusalCode.options) expect(typeof REFUSAL_MESSAGES[code]).toBe("function");
  });
});

describe("rules attached to each code", () => {
  it("gives every code at least one valid scope", () => {
    for (const code of RefusalCode.options) {
      const scopes = REFUSAL_SCOPES[code];
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) expect(RefusalScope.options).toContain(scope);
    }
    // Whole-file refusals are always document-level.
    for (const code of DocumentCode.options) expect(REFUSAL_SCOPES[code]).toEqual(["document"]);
  });

  it("says what every page refusal does to the page's status, and only page refusals", () => {
    const pageCodes = RefusalCode.options.filter((code) => REFUSAL_SCOPES[code].includes("page"));
    expect(Object.keys(PAGE_REFUSAL_STATUS).sort()).toEqual([...pageCodes].sort());
    // The one exception: the rows are still shown, so the page is only partly read.
    expect(PAGE_REFUSAL_STATUS.COLUMN_MEANING_UNKNOWN).toBe("partial");
  });
});

describe("whole-file problems", () => {
  it("gives every document code a 4xx status and a title", () => {
    for (const code of DocumentCode.options) {
      expect(DOCUMENT_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(DOCUMENT_HTTP_STATUS[code]).toBeLessThan(500);
      expect(DOCUMENT_PROBLEM_TITLES[code].length).toBeGreaterThan(0);
    }
  });

  it("words our own failure as our bug, with a reference", () => {
    const message = INTERNAL_PROBLEM.message({ reference: "7f3a" });
    expect(message).toContain("reference 7f3a");
    expect(message).toContain("This is our bug, not a problem with your file.");
    for (const pattern of FORBIDDEN) expect(message).not.toMatch(pattern);
    expect(INTERNAL_HTTP_STATUS).toBe(500);
  });

  it("builds a stable problem type for each code", () => {
    expect(problemType("ENCRYPTED")).toBe("/problems/encrypted");
    expect(problemType("FILE_TOO_LARGE")).toBe("/problems/file-too-large");
    expect(problemType("INTERNAL")).toBe("/problems/internal");
  });
});

/**
 * Sample facts for every note, all on page 7. Typed against NOTES, so a new
 * note can't be added without a sample here.
 */
const NOTE_SAMPLES: { [Name in keyof typeof NOTES]: Parameters<(typeof NOTES)[Name]> } = {
  blankPage: [7],
  imagesNotRead: [7],
  rotatedTextIgnored: [7],
  sectionHeading: [7, "Stage 1 - Framing"],
  shortLineInTable: [7, "Less 10% trade discount -$18.60"],
  descriptionWraps: [7],
  carriedForwardSkipped: [7, "Carried forward $1,200.00"],
  totalsRowSkipped: [7, "Total 25 $413.50"],
  otherTableNotRead: [7, "Account 1001 Terms 30 days"],
  columnNotRead: [7, "Weight"],
  headerOnlyRole: [7, "Qty", "the quantity"],
  headingFollowed: [7, "Item", "codes", "item number"],
  headingTwoMeanings: [7, "Qty Unit"],
  mixedTotalWording: [7, "Weight", ["25kg", "480g total"]],
  totalLabelNoAmount: [7, "Total consignment weight: see each line."],
  totalAmountNotRead: [7, "Total: $500.00 NZD"],
  totalNotMoney: [7, "Total 25"],
  unknownLabelTotalUsed: [7, "Summe: 1.234,50 €"],
  unknownFigureAlsoMatches: [7, "Netto: 1.234,50 €"],
  unknownFigureNotPlaced: [7, "Endbetrag: 1.300,00 €"],
  unknownFigureNotCompared: [7, "Endbetrag: 1.300,00 €"],
  unknownFigureIgnored: [7, "Freight: $36.50"],
  unknownFigureIgnoredTax: [7, "Zwischensumme: 364,00 €"],
  figureBeforeLines: [7, "Übertrag: 364,00 €"],
  summaryPage: [7, "Summary"],
  unknownHeadings: [7],
  noHeadings: [7],
};

describe("notes", () => {
  it.each(Object.keys(NOTE_SAMPLES) as (keyof typeof NOTES)[])("%s reads as a plain sentence that names its page", (name) => {
    const makeNote = NOTES[name] as (...args: unknown[]) => { level: string; text: string };
    const note = makeNote(...NOTE_SAMPLES[name]);
    expect(["info", "warning"]).toContain(note.level);
    expect(note.text).toMatch(/[.!?]$/);
    expect(note.text).toMatch(/\b[Pp]age 7\b/);
    for (const pattern of FORBIDDEN) expect(note.text).not.toMatch(pattern);
  });

  it("quotes every example in the mixed-wording warning", () => {
    expect(NOTES.mixedTotalWording(1, "Weight", ["25kg", "480g total"]).text).toContain("('25kg' and '480g total')");
  });
});

describe("the reasons a totals check didn't run", () => {
  it.each(Object.entries(CHECK_REASONS))("%s is one plain sentence", (_name, reason) => {
    expect(reason).toMatch(/^[A-Z].*\.$/);
    for (const pattern of FORBIDDEN) expect(reason).not.toMatch(pattern);
  });
});

describe("wording helpers", () => {
  it("rounds a file size up, so a file over the limit never looks equal to it", () => {
    const limit = 4 * 1024 * 1024;
    expect(megabytes(limit + 40 * 1024)).toBe("4.1 MB");
    expect(megabytes(limit, false)).toBe("4 MB");
    expect(megabytes(6.2 * 1024 * 1024)).toBe("6.2 MB");
  });

  it("names pages the way people write them", () => {
    expect(pagesText([2])).toBe("page 2");
    expect(pagesText([2, 1])).toBe("pages 1 and 2");
    expect(pagesText([1, 2, 3, 4])).toBe("pages 1 to 4");
    expect(pagesText([5, 1, 3, 3])).toBe("pages 1, 3 and 5");
    expect(pagesText([])).toBe("the document");
  });

  it("joins lists the way people write them", () => {
    expect(listText([])).toBe("");
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b"])).toBe("a and b");
    expect(listText(["a", "b", "c"])).toBe("a, b and c");
  });
});
