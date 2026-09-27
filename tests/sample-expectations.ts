/**
 * The expected outcome for each of the six sample PDFs, as data, and one
 * function that compares a result with it.
 *
 * Where this fits: when the six samples were first studied, what the engine
 * must do with each one was written down by hand. This file holds those facts
 * in a form a program can check. Two things use it: tests/samples.test.ts
 * (Vitest) and scripts/run-samples.ts (`pnpm samples`), so both compare in
 * exactly the same way.
 *
 * How to read it: the types first, then SAMPLE_EXPECTATIONS (one entry per
 * file name), then `compareWithExpectation`, which returns every difference
 * as one plain sentence.
 *
 * What is in here: file names, counts, refusal codes, roles, column keys,
 * role sources, number formats, and a few amounts: the sum of each file's line
 * totals and the price units of KBS-10255. No text from the samples is copied
 * here (tests use invented text; the samples themselves are committed, so the
 * facts below can be checked against them). The amounts were added up by hand
 * from the printed lines, not taken from the engine's output.
 *
 * Every value is also compared with its own printed text, read the simplest
 * way (see `plainValue`), so a reader bug that returns a wrong value can't
 * pass unnoticed.
 *
 * Not checked yet: the printed totals and CONFLICTING_FIGURES. The totals step
 * is not built yet, so `totals` is left out of every entry, and
 * `documentRefusals` will then gain CONFLICTING_FIGURES on KBS-10262. That
 * step will also add one info note on KBS-10255 (a total label with no amount).
 */
import type { NumberFormat, PageStatus, RefusalCode, RefusalScope, Role, RoleSource, TotalsCheck } from "@/lib/contract/schema";
import type { EngineResult } from "@/lib/engine";

/** A refusal we expect: its code and its scope. */
export interface RefusalExpectation {
  code: RefusalCode;
  scope: RefusalScope;
}

/** What one page must look like. */
export interface PageExpectation {
  status: PageStatus;
  itemCount: number;
  /** The page's own refusals (page and row scope), in the order of the result. */
  refusals: RefusalExpectation[];
  /** How many notes of each level the page has. */
  notes: { info: number; warning: number };
}

/** What the items of a file must hold. */
export interface ItemExpectation {
  /** Roles every item must have a field for. */
  required: Role[];
  /** Roles no item may have a field for. */
  forbidden: Role[];
  /** When true, every item's unitPrice field has a price unit (`per`). */
  everyUnitPriceHasPer: boolean;
  /** The keys of every item's otherCells, in order (the same on every item). */
  otherCellKeys: string[];
}

/** The totals, checked from Part 6 on. */
export interface TotalsExpectation {
  /** The checks that ran, by name and outcome. */
  checks: Pick<TotalsCheck, "name" | "outcome">[];
  /** The totals-scope refusals, in order (for example TOTALS_DISAGREE). */
  refusals: RefusalExpectation[];
}

/** Everything we expect from one sample file. */
export interface FileExpectation {
  /** One entry per page, in page order. Its length is the page count. */
  pages: PageExpectation[];
  /** Refusals about the whole document (scope "document"), in order. */
  documentRefusals: RefusalExpectation[];
  items: ItemExpectation;
  /**
   * The columns of every page that has columns: the keys left to right, and
   * each column's roleSource. A file whose pages have no table has none.
   */
  columns: Record<string, RoleSource>;
  numberFormat: NumberFormat;
  /**
   * The sum of every item's line total, added up by hand from the printed
   * lines. Undefined when the file's lines were not added up.
   */
  lineTotalSum?: number;
  /** The price unit (`per`) of each item's unit price, in item order, when the file prints them. */
  pricePers?: string[];
  /** Undefined until the totals step reads the totals: then nothing about totals is compared. */
  totals?: TotalsExpectation;
}

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

const NO_NOTES = { info: 0, warning: 0 };

/** A normal page: extracted, with this many items, no refusals and no notes. */
function extracted(itemCount: number, notes = NO_NOTES): PageExpectation {
  return { status: "extracted", itemCount, refusals: [], notes };
}

/** A page refused with one page refusal, and no notes. */
function refused(code: RefusalCode): PageExpectation {
  return { status: "refused", itemCount: 0, refusals: [{ code, scope: "page" }], notes: NO_NOTES };
}

/** The six columns most samples share, every one confirmed by the numbers and the heading. */
const STANDARD_COLUMNS: Record<string, RoleSource> = {
  item: "both",
  description: "both",
  qty: "both",
  unit: "both",
  unitPrice: "both",
  lineTotal: "both",
};

/** What every item of a page with the standard columns holds. */
const STANDARD_ITEMS: ItemExpectation = {
  required: ["itemNo", "description", "quantity", "unit", "unitPrice", "lineTotal"],
  forbidden: ["code"],
  everyUnitPriceHasPer: false,
  otherCellKeys: [],
};

/** Decimals "." proved; the grouping mark "," proved because a table value reaches 1,000. */
const DOT_DECIMALS_COMMA_GROUPING: NumberFormat = { decimal: ".", grouping: ",", settled: true };
/** Decimals "." proved; the grouping mark stays open because no table value reaches 1,000. */
const DOT_DECIMALS: NumberFormat = { decimal: ".", grouping: null, settled: true };

/** The expected outcome per sample file name. */
export const SAMPLE_EXPECTATIONS: Record<string, FileExpectation> = {
  // The clean baseline.
  "KBS-10234.pdf": {
    pages: [extracted(5)],
    documentRefusals: [],
    items: STANDARD_ITEMS,
    columns: STANDARD_COLUMNS,
    numberFormat: DOT_DECIMALS_COMMA_GROUPING,
    // The lines add up to the printed total, $2,630.00.
    lineTotalSum: 2630,
  },
  // A picture of a page, with no text layer: refused, so no NO_LINE_ITEMS_FOUND.
  "KBS-10241.pdf": {
    pages: [refused("NO_TEXT_LAYER")],
    documentRefusals: [],
    items: { required: [], forbidden: [], everyUnitPriceHasPer: false, otherCellKeys: [] },
    columns: {},
    numberFormat: { decimal: null, grouping: null, settled: true },
  },
  // No line total; prices end in "/unit"; a weight column we don't read.
  // Notes: the quantity role from the heading only (info), the weight column
  // not read (info), and its mixed "total" wording (warning).
  "KBS-10255.pdf": {
    pages: [extracted(4, { info: 2, warning: 1 })],
    documentRefusals: [],
    items: {
      required: ["itemNo", "description", "quantity", "unitPrice"],
      forbidden: ["lineTotal", "unit", "code"],
      everyUnitPriceHasPer: true,
      otherCellKeys: ["weight"],
    },
    columns: { item: "both", description: "both", qty: "header", weight: null, unitPrice: "both" },
    numberFormat: DOT_DECIMALS,
    pricePers: ["bag", "ea", "ea", "bundle"],
  },
  // The totals step adds CONFLICTING_FIGURES (document scope) here.
  "KBS-10262.pdf": {
    pages: [extracted(3)],
    documentRefusals: [],
    items: STANDARD_ITEMS,
    columns: STANDARD_COLUMNS,
    numberFormat: DOT_DECIMALS_COMMA_GROUPING,
    // The lines add up to the printed total, $5,122.40.
    lineTotalSum: 5122.4,
  },
  // The totals step adds TOTALS_DISAGREE (totals scope) here.
  "KBS-10270.pdf": {
    pages: [extracted(4)],
    documentRefusals: [],
    items: STANDARD_ITEMS,
    columns: STANDARD_COLUMNS,
    numberFormat: DOT_DECIMALS,
    // The lines add up to $1,538.20; the printed total says $1,612.90.
    lineTotalSum: 1538.2,
  },
  // Eight pages: three sites, a scanned page, a summary page, a returns page,
  // a credit page and an acceptance page (the last two pages that are read
  // carry a warning).
  "KBS-DR118.pdf": {
    pages: [
      extracted(3),
      extracted(3),
      extracted(3),
      refused("NO_TEXT_LAYER"),
      extracted(3, { info: 0, warning: 1 }),
      refused("CREDIT_OR_RETURN_PAGE"),
      refused("CREDIT_OR_RETURN_PAGE"),
      extracted(3, { info: 0, warning: 1 }),
    ],
    documentRefusals: [],
    items: STANDARD_ITEMS,
    columns: STANDARD_COLUMNS,
    numberFormat: DOT_DECIMALS,
  },
};

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** "CODE (scope)" for each refusal, joined, so two lists compare as text. */
function refusalList(refusals: readonly RefusalExpectation[]): string {
  return refusals.map((refusal) => `${refusal.code} (${refusal.scope})`).join(", ") || "none";
}

/**
 * A printed number read the simplest way: every character that is not a
 * digit or "." is dropped ("$1,250.00 /bag" -> 1250). All six samples write
 * numbers like "$1,250.00", so this is enough, and it shares no code with
 * numbers.ts. None of the samples has a negative number.
 */
function plainValue(raw: string): number {
  return Number(raw.replace(/[^\d.]/g, ""));
}

/** Values compared as JSON, so objects and arrays compare by content. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares one result with its expected outcome. Returns every difference as
 * a plain sentence, or an empty list when the result matches.
 */
export function compareWithExpectation(expected: FileExpectation, result: EngineResult): string[] {
  const differences: string[] = [];
  const differ = (what: string, want: unknown, got: unknown) => {
    if (!same(want, got)) differences.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  // The pages.
  differ("page count", expected.pages.length, result.pageCount);
  expected.pages.forEach((want, index) => {
    const page = index + 1;
    const report = result.pages.find((candidate) => candidate.page === page);
    if (!report) {
      differences.push(`page ${page}: missing from the result`);
      return;
    }
    differ(`page ${page} status`, want.status, report.status);
    differ(`page ${page} item count`, want.itemCount, result.items.filter((item) => item.page === page).length);
    const refusals = result.refusals.filter(
      (refusal) => refusal.page === page && (refusal.scope === "page" || refusal.scope === "row"),
    );
    differ(`page ${page} refusals`, refusalList(want.refusals), refusalList(refusals));
    const notes = {
      info: report.notes.filter((note) => note.level === "info").length,
      warning: report.notes.filter((note) => note.level === "warning").length,
    };
    differ(`page ${page} notes`, want.notes, notes);

    // Columns: every page that has columns must have exactly the expected
    // keys, in order, with the expected role sources. A page that is read
    // must have columns when the file expects any.
    if (report.columns.length > 0 || (report.status === "extracted" && Object.keys(expected.columns).length > 0)) {
      const columns = Object.fromEntries(report.columns.map((column) => [column.key, column.roleSource]));
      differ(`page ${page} column keys`, Object.keys(expected.columns), Object.keys(columns));
      differ(`page ${page} role sources`, expected.columns, columns);
    }
  });

  // The document refusals.
  const documentRefusals = result.refusals.filter((refusal) => refusal.scope === "document");
  differ("document refusals", refusalList(expected.documentRefusals), refusalList(documentRefusals));

  // The items.
  for (const item of result.items) {
    const roles = Object.keys(item.fields) as Role[];
    const lacking = expected.items.required.filter((role) => !roles.includes(role));
    if (lacking.length > 0) differences.push(`item ${item.id}: no field for ${lacking.join(", ")}`);
    const extra = expected.items.forbidden.filter((role) => roles.includes(role));
    if (extra.length > 0) differences.push(`item ${item.id}: has a field for ${extra.join(", ")}, which it should not`);
    if (expected.items.everyUnitPriceHasPer && item.fields.unitPrice?.per === undefined) {
      differences.push(`item ${item.id}: its unit price has no price unit (per)`);
    }
    differ(`item ${item.id} other cell keys`, expected.items.otherCellKeys, item.otherCells.map((cell) => cell.key));
    for (const role of ["quantity", "unitPrice", "lineTotal"] as const) {
      const field = item.fields[role];
      if (field) differ(`item ${item.id} ${role} value`, plainValue(field.raw), field.value);
    }
  }

  // The amounts added up by hand.
  if (expected.lineTotalSum !== undefined) {
    const sum = result.items.reduce((total, item) => total + (item.fields.lineTotal?.value ?? 0), 0);
    if (Math.abs(sum - expected.lineTotalSum) > 0.005) {
      differences.push(`the line totals add up to ${sum.toFixed(2)}, expected ${expected.lineTotalSum.toFixed(2)}`);
    }
  }
  if (expected.pricePers !== undefined) {
    differ("price units", expected.pricePers, result.items.map((item) => item.fields.unitPrice?.per ?? null));
  }

  // The number format.
  differ("number format", expected.numberFormat, result.numberFormat);

  // The totals, once the totals step fills them in.
  if (expected.totals) {
    differ(
      "totals checks",
      expected.totals.checks,
      result.totals.checks.map((check) => ({ name: check.name, outcome: check.outcome })),
    );
    const totalsRefusals = result.refusals.filter((refusal) => refusal.scope === "totals");
    differ("totals refusals", refusalList(expected.totals.refusals), refusalList(totalsRefusals));
  }

  return differences;
}
