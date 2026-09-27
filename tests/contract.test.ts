/**
 * Tests for the response contract in src/lib/contract/schema.ts.
 *
 * What these tests protect
 * ------------------------
 * The web page checks every reply against these schemas before showing it.
 * If the server ever sends a shape the page doesn't expect, the page must say
 * so clearly instead of showing wrong numbers. These tests check both sides:
 *
 *   1. A complete, correct reply passes (a two-page example with invented
 *      text; no text from the sample PDFs).
 *   2. Replies that break the rules fail, especially the rules about numbers
 *      and evidence: a number on a text column, a numeric column with no
 *      value, a span that points at the wrong characters, a refusal that can't
 *      be placed on its page, a Problem whose status and code disagree.
 */
import { describe, expect, it } from "vitest";

import {
  Column,
  LineItem,
  NUMERIC_ROLES,
  NumberFormat,
  ParseResponse,
  ParseResult,
  Problem,
  Refusal,
  StatedTotal,
  TotalsCheck,
  type Span,
} from "@/lib/contract/schema";

/**
 * Finds `part` inside `text` and returns its [start, end) span. Computing the
 * spans here, instead of typing numbers by hand, keeps the fixture correct if
 * the text changes. It returns the first match; if `part` also appears earlier
 * in the row, pass `from` to skip past it.
 */
function spanOf(text: string, part: string, from = 0): Span {
  const start = text.indexOf(part, from);
  if (start < 0) throw new Error(`"${part}" is not in "${text}"`);
  return [start, start + part.length];
}

/** One row, joined the way the engine will join cells: single spaces between them. */
const ROW = "1 Timber lot A 10 length $16.00 $160.00";

/** A correct line item for ROW, with every cell's evidence. */
function validItem(): LineItem {
  return {
    id: "p1-r5",
    page: 1,
    rowIndex: 5,
    sourceText: ROW,
    fields: {
      itemNo: { header: "Item", raw: "1", span: spanOf(ROW, "1") },
      description: { header: "Description", raw: "Timber lot A", span: spanOf(ROW, "Timber lot A") },
      quantity: { header: "Qty", raw: "10", value: 10, span: spanOf(ROW, "10") },
      unit: { header: "Unit", raw: "length", span: spanOf(ROW, "length") },
      unitPrice: { header: "Unit Price", raw: "$16.00", value: 16, currency: null, span: spanOf(ROW, "$16.00") },
      lineTotal: { header: "Line Total", raw: "$160.00", value: 160, currency: null, span: spanOf(ROW, "$160.00") },
    },
    otherCells: [],
    missing: [],
  };
}

/** A complete reply for an invented two-page document: page 1 read, page 2 a scan. */
function validResult(): ParseResult {
  return {
    kind: "result",
    requestId: "3f1c9a52-8d7e-4b1a-9c55-0e2f6b7d4a10",
    fileName: "invented-docket.pdf",
    pageCount: 2,
    numberFormat: { decimal: ".", grouping: null, settled: true },
    pages: [
      {
        page: 1,
        status: "extracted",
        titleLines: ["Example Supplies Ltd", "Delivery Run 7 - Site 1 of 2"],
        itemCount: 1,
        columns: [
          { header: "Item", key: "item", role: "itemNo", roleSource: "both", kind: "numeric" },
          { header: "Description", key: "description", role: "description", roleSource: "both", kind: "text" },
          { header: "Qty", key: "qty", role: "quantity", roleSource: "both", kind: "numeric" },
          { header: "Unit", key: "unit", role: "unit", roleSource: "both", kind: "text" },
          { header: "Unit Price", key: "unitPrice", role: "unitPrice", roleSource: "both", kind: "numeric" },
          { header: "Line Total", key: "lineTotal", role: "lineTotal", roleSource: "both", kind: "numeric" },
        ],
        notes: [],
      },
      { page: 2, status: "refused", titleLines: [], itemCount: 0, columns: [], notes: [] },
    ],
    items: [validItem()],
    refusals: [
      {
        id: "p2-NO_TEXT_LAYER",
        code: "NO_TEXT_LAYER",
        scope: "page",
        page: 2,
        message: "Page 2 is a scanned picture. We don't read scans, so nothing on it was extracted.",
        evidence: [],
      },
    ],
    totals: {
      stated: [],
      gstBasis: "unstated",
      checks: [
        {
          name: "lines_vs_total",
          outcome: "not_checked",
          pagesCovered: [],
          reason: "The document doesn't state a total, so there was nothing to check the lines against.",
        },
      ],
    },
  };
}

/** A correct whole-file refusal. */
function validProblem(): Problem {
  return {
    kind: "problem",
    type: "/problems/encrypted",
    title: "Password-protected PDF",
    status: 422,
    detail: "This PDF is password-protected. Remove the password and upload it again.",
    code: "ENCRYPTED",
    requestId: "a1b2c3",
    refusal: {
      id: "doc-ENCRYPTED",
      code: "ENCRYPTED",
      scope: "document",
      message: "This PDF is password-protected. Remove the password and upload it again.",
      evidence: [],
    },
  };
}

/** The first validation message, to make a failing test easy to read. */
function firstIssue(result: { success: boolean; error?: { issues: { message: string }[] } }): string | undefined {
  return result.success ? undefined : result.error?.issues[0]?.message;
}

describe("a correct reply", () => {
  it("passes as a ParseResult", () => {
    const parsed = ParseResult.safeParse(validResult());
    expect(firstIssue(parsed)).toBeUndefined();
  });

  it("is told apart from a Problem by its kind", () => {
    const parsed = ParseResponse.safeParse(validResult());
    expect(parsed.success && parsed.data.kind).toBe("result");
  });

  it("accepts a column with no heading and no role", () => {
    const headerless = { header: null, key: "col1", role: null, roleSource: null, kind: "text" };
    expect(Column.safeParse(headerless).success).toBe(true);
  });

  it("accepts a price with a unit and a cell from a column we don't read", () => {
    const row = "1 Galv nails, bulk 4 25kg $68.00 /bag";
    const item: LineItem = {
      id: "p1-r7",
      page: 1,
      rowIndex: 7,
      sourceText: row,
      fields: {
        description: { header: "Description", raw: "Galv nails, bulk", span: spanOf(row, "Galv nails, bulk") },
        quantity: { header: "Qty", raw: "4", value: 4, span: spanOf(row, "4") },
        unitPrice: {
          header: "Unit Price",
          raw: "$68.00 /bag",
          value: 68,
          per: "bag",
          currency: null,
          span: spanOf(row, "$68.00 /bag"),
        },
      },
      otherCells: [{ header: "Weight", key: "weight", raw: "25kg" }],
      missing: [],
    };
    expect(firstIssue(LineItem.safeParse(item))).toBeUndefined();
  });

  it("accepts a number without a span, for a later extractor that can't give one", () => {
    // The plan keeps span optional on purpose. This test records that choice,
    // so making span required later is a deliberate change, not an accident.
    const item = validItem();
    delete item.fields.quantity!.span;
    expect(LineItem.safeParse(item).success).toBe(true);
  });

  it("accepts a whole-file Problem that carries its refusal", () => {
    expect(firstIssue(Problem.safeParse(validProblem()))).toBeUndefined();
    const parsed = ParseResponse.safeParse(validProblem());
    expect(parsed.success && parsed.data.kind).toBe("problem");
  });
});

describe("line items: every number is traceable", () => {
  it("rejects a span that points at other characters", () => {
    // The page highlights by span, so a shifted span would highlight the
    // wrong digits.
    const item = validItem();
    const [start, end] = item.fields.quantity!.span!;
    item.fields.quantity!.span = [start - 1, end - 1];
    expect(firstIssue(LineItem.safeParse(item))).toMatch(/doesn't point at the raw text/);
  });

  it("rejects a span that runs past the end of the row", () => {
    const item = validItem();
    item.fields.lineTotal!.span = [ROW.length - 2, ROW.length + 5];
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a span that ends before it starts", () => {
    const item = validItem();
    item.fields.quantity!.span = [10, 5];
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it.each(NUMERIC_ROLES)("rejects %s without a value", (role) => {
    // A number we couldn't read makes the whole row a refusal, so a numeric
    // field without a value can only be a bug.
    const item = validItem();
    delete item.fields[role]!.value;
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a number on a text column", () => {
    const item = validItem();
    item.fields.description!.value = 5;
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a price unit on anything but the unit price", () => {
    const item = validItem();
    item.fields.lineTotal!.per = "bag";
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a currency on the quantity", () => {
    const item = validItem();
    item.fields.quantity!.currency = "NZD";
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a currency that isn't a three-letter code", () => {
    const item = validItem();
    item.fields.unitPrice!.currency = "nz$";
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects an id that doesn't match the page and row", () => {
    const item = { ...validItem(), id: "p9-r99" };
    expect(firstIssue(LineItem.safeParse(item))).toBe("the id must be p1-r5");
  });

  it("rejects a role that is both filled in and listed as missing", () => {
    const item = validItem();
    item.missing = ["unitPrice"];
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects a field under a role we don't know", () => {
    const item = validItem() as unknown as { fields: Record<string, unknown> };
    item.fields.weight = { header: "Weight", raw: "25kg" };
    expect(LineItem.safeParse(item).success).toBe(false);
  });

  it("rejects extra, unexpected fields", () => {
    const item = { ...validItem(), confidence: 0.9 };
    expect(LineItem.safeParse(item).success).toBe(false);
  });
});

describe("columns", () => {
  it("rejects a role source without a role, and a role without a source", () => {
    expect(Column.safeParse({ header: "Weight", key: "weight", role: null, roleSource: "numbers", kind: "text" }).success).toBe(false);
    expect(Column.safeParse({ header: "Qty", key: "qty", role: "quantity", roleSource: null, kind: "numeric" }).success).toBe(false);
  });
});

describe("refusals can always be placed", () => {
  const base = { message: "A sentence for the user.", evidence: [] };

  it("accepts each scope in its correct form", () => {
    const good = [
      { ...base, id: "doc-NO_LINE_ITEMS_FOUND", code: "NO_LINE_ITEMS_FOUND", scope: "document" },
      { ...base, id: "doc-CONFLICTING_FIGURES-crate", code: "CONFLICTING_FIGURES", scope: "document" },
      { ...base, id: "p4-NO_TEXT_LAYER", code: "NO_TEXT_LAYER", scope: "page", page: 4 },
      { ...base, id: "p1-r7-ARITHMETIC_MISMATCH", code: "ARITHMETIC_MISMATCH", scope: "row", page: 1, rowIndex: 7 },
      { ...base, id: "totals-lines_vs_total", code: "TOTALS_DISAGREE", scope: "totals" },
      { ...base, id: "totals-p2-r9-AMBIGUOUS_NUMBER_FORMAT", code: "AMBIGUOUS_NUMBER_FORMAT", scope: "totals", page: 2 },
    ];
    for (const refusal of good) expect(firstIssue(Refusal.safeParse(refusal)), refusal.id).toBeUndefined();
  });

  it("rejects a scope the code doesn't allow", () => {
    const refusal = { ...base, id: "doc-ARITHMETIC_MISMATCH", code: "ARITHMETIC_MISMATCH", scope: "document" };
    expect(Refusal.safeParse(refusal).success).toBe(false);
  });

  it("rejects a page refusal without its page", () => {
    const refusal = { ...base, id: "p4-NO_TEXT_LAYER", code: "NO_TEXT_LAYER", scope: "page" };
    expect(Refusal.safeParse(refusal).success).toBe(false);
  });

  it("rejects a row refusal without its row", () => {
    const refusal = { ...base, id: "p1-r7-UNPARSEABLE_NUMBER", code: "UNPARSEABLE_NUMBER", scope: "row", page: 1 };
    expect(Refusal.safeParse(refusal).success).toBe(false);
  });

  it("rejects an id that doesn't follow the form for its scope", () => {
    const refusal = { ...base, id: "refusal-17", code: "NO_TEXT_LAYER", scope: "page", page: 4 };
    expect(firstIssue(Refusal.safeParse(refusal))).toBe("the id must be p4-NO_TEXT_LAYER");
  });
});

describe("printed totals and checks", () => {
  const sourceText = "Total: $3,417.60";
  const total = {
    label: "total",
    labelKnown: true,
    page: 2,
    sourceText,
    amount: { header: "Total:", raw: "$3,417.60", value: 3417.6, currency: null, span: spanOf(sourceText, "$3,417.60") },
  };

  it("accepts a printed total with evidence", () => {
    expect(firstIssue(StatedTotal.safeParse(total))).toBeUndefined();
  });

  it("rejects a printed total without a value, with a price unit, or with a wrong span", () => {
    expect(StatedTotal.safeParse({ ...total, amount: { ...total.amount, value: undefined } }).success).toBe(false);
    expect(StatedTotal.safeParse({ ...total, amount: { ...total.amount, per: "bag" } }).success).toBe(false);
    expect(StatedTotal.safeParse({ ...total, amount: { ...total.amount, span: [0, 6] } }).success).toBe(false);
  });

  it("requires a sum when a check ran, and a reason when it didn't", () => {
    const derived = { label: "calculated by us", value: 3417.6, fromItemIds: ["p1-r5"] };
    expect(TotalsCheck.safeParse({ name: "lines_vs_total", outcome: "pass", pagesCovered: [1], derived }).success).toBe(true);
    expect(TotalsCheck.safeParse({ name: "lines_vs_total", outcome: "fail", pagesCovered: [1] }).success).toBe(false);
    expect(TotalsCheck.safeParse({ name: "lines_vs_total", outcome: "not_checked", pagesCovered: [] }).success).toBe(false);
  });

  it("rejects a calculated sum that isn't labelled as ours", () => {
    // The cast tricks TypeScript on purpose, so the wrong label reaches the runtime check.
    const derived = { label: "total" as "calculated by us", value: 160, fromItemIds: ["p1-r5"] };
    expect(TotalsCheck.safeParse({ name: "lines_vs_total", outcome: "pass", pagesCovered: [1], derived }).success).toBe(false);
  });

  it("rejects a number format whose decimal and thousands marks are the same", () => {
    expect(NumberFormat.safeParse({ decimal: ",", grouping: ",", settled: true }).success).toBe(false);
    expect(NumberFormat.safeParse({ decimal: ",", grouping: ".", settled: true }).success).toBe(true);
  });
});

describe("a whole result can't contradict itself", () => {
  it("rejects a missing page report", () => {
    const result = validResult();
    result.pages = [result.pages[0]];
    expect(ParseResult.safeParse(result).success).toBe(false);
  });

  it("rejects an item count that doesn't match the items listed", () => {
    const result = validResult();
    result.pages[0].itemCount = 3;
    expect(ParseResult.safeParse(result).success).toBe(false);
  });

  it("rejects items on a refused page", () => {
    const result = validResult();
    result.pages[0].status = "refused";
    expect(ParseResult.safeParse(result).success).toBe(false);
  });

  it("rejects a refusal on a page that doesn't exist", () => {
    const result = validResult();
    result.refusals[0] = { ...result.refusals[0], id: "p9-NO_TEXT_LAYER", page: 9 };
    expect(ParseResult.safeParse(result).success).toBe(false);
  });

  it("rejects the same refusal id twice", () => {
    const result = validResult();
    result.refusals.push({ ...result.refusals[0] });
    expect(ParseResult.safeParse(result).success).toBe(false);
  });
});

describe("a Problem reply tells one story", () => {
  it("rejects an empty detail, because the page would have nothing to show", () => {
    expect(Problem.safeParse({ ...validProblem(), detail: "" }).success).toBe(false);
  });

  it("rejects a status that doesn't match the code", () => {
    expect(Problem.safeParse({ ...validProblem(), status: 500 }).success).toBe(false);
    expect(Problem.safeParse({ ...validProblem(), status: 200 }).success).toBe(false);
  });

  it("rejects a refusal whose code differs from the problem's code", () => {
    const problem = validProblem();
    problem.refusal = { ...problem.refusal!, id: "doc-NO_FILE", code: "NO_FILE" };
    expect(Problem.safeParse(problem).success).toBe(false);
  });

  it("rejects a whole-file refusal without its refusal", () => {
    const withoutRefusal = validProblem();
    delete withoutRefusal.refusal;
    expect(Problem.safeParse(withoutRefusal).success).toBe(false);
  });

  it("accepts INTERNAL only as a 500 with no refusal", () => {
    const internal = {
      kind: "problem",
      type: "/problems/internal",
      title: "Our code failed",
      status: 500,
      detail: "Something in our code failed while reading this file (reference 7f3a). This is our bug, not a problem with your file.",
      code: "INTERNAL",
      requestId: "a1b2c3",
    };
    expect(firstIssue(Problem.safeParse(internal))).toBeUndefined();
    expect(Problem.safeParse({ ...internal, status: 422 }).success).toBe(false);
    expect(Problem.safeParse({ ...internal, refusal: validProblem().refusal }).success).toBe(false);
  });

  it("rejects a code that isn't a whole-file refusal or INTERNAL", () => {
    expect(Problem.safeParse({ ...validProblem(), code: "NO_TEXT_LAYER" }).success).toBe(false);
  });
});
