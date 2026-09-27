/**
 * The engine: turns the bytes of a PDF into a result.
 *
 * Where this fits
 * ---------------
 * The brief asks for an API (this engine plus the route in src/app/api/parse)
 * and a web page. This file joins the steps of the engine together. Each step
 * lives in its own file and is tested on its own; this file only decides the
 * order and passes the results on. The printed totals, and the checks against
 * them, are not read yet.
 *
 * The pipeline
 * ------------
 *   open        open the file; a protected, damaged or oversized file refuses
 *               the whole file (open.ts)
 *   pass 1      per page, one at a time: read the page (read-page.ts),
 *               classify it (classify-page.ts), and for a normal text page
 *               build its rows (rows.ts) and find its table (table.ts)
 *   pass 2      per page: decide the page's number format from its table's
 *               numbers (numbers.ts), read the title (page-title.ts), decide
 *               the column roles (roles.ts) and build the line items (items.ts)
 *   gate        check every number of every item against its row and its
 *               page once more (evidence.ts); an item that fails is replaced
 *               by a refusal
 *   assemble    put pages, items and refusals together in the contract's
 *               order, set each page's status, and report the number format
 *               the pages share
 *
 * Each page is read in its own number format and never borrows one from
 * another page (see numbers.ts for why).
 *
 * How to read this file: the types passed between the steps come first, then
 * pass 1 (`processPage`), the page's number format (`pageConventions`), pass 2
 * (`analysePage`), the time limits, and at the end `parsePdf` and the helpers
 * that put the result together.
 *
 * Containment
 * -----------
 * Every page runs inside `settlePage` (isolate.ts), in both passes. A page
 * that throws becomes a PAGE_LOAD_FAILED refusal for that page only. The
 * other pages are read exactly as if nothing had happened;
 * tests/engine/containment.test.ts checks this. A page that fails in pass 1
 * has no findings, so it adds nothing to the document's number format.
 *
 * Time limits
 * -----------
 * There are two limits, and it matters what each can do:
 *   - per page (pageMs): a page that doesn't finish in time is refused. This
 *     works while pdf.js is waiting. It can't stop pdf.js in the middle of a
 *     long calculation, because JavaScript can't interrupt running code; such
 *     a page finishes late, and we log it as slow.
 *   - per document (totalMs): once it is used up, pass 1 starts no new page,
 *     and the pages not reached are refused with the "took too long" reason.
 *     Pass 2 only works on text that is already read, so it has no budget of
 *     its own; each page still has its per-page limit.
 * A single extremely heavy page can still run past the route's 60-second limit.
 * The platform then ends the request, and the web page will show its own "took
 * too long" message. The real fix is to read the file in a separate worker
 * thread that can be stopped; that is listed for later.
 *
 * What this function never does
 * -----------------------------
 * It never reports our own bug as a problem with the file. An unexpected error
 * while opening is thrown again to the caller, and the route answers INTERNAL.
 */
import { NOTES } from "@/lib/contract/notes";
import {
  PAGE_REFUSAL_STATUS,
  type Evidence,
  type LineItem,
  type Note,
  type NumberFormat,
  type PageReport,
  type ParseResult,
  type Refusal,
} from "@/lib/contract/schema";

import { classifyPage, type PageClassification } from "./classify-page";
import { evidenceGate } from "./evidence";
import { settlePage } from "./isolate";
import { buildItems } from "./items";
import {
  CONVENTIONS,
  analyseNumber,
  conventionsFor,
  isNumericColumn,
  numberFormatOf,
  sharedConventions,
  type Convention,
  type NumberParts,
} from "./numbers";
import { defaultLoader, openDocument, type DocumentLoader } from "./open";
import { readPageTitle } from "./page-title";
import type { PDFDocumentProxy, PdfJs } from "./pdfjs";
import { readPage } from "./read-page";
import { findingRefusal, pageRefusal, type DocumentRefusal } from "./refusals";
import { decideRoles } from "./roles";
import { buildRows, type Row } from "./rows";
import { findTable, type PageLayout, type Table } from "./table";

// ---------------------------------------------------------------------------
// Types passed between the stages
// ---------------------------------------------------------------------------

/** What pass 1 learns about one page. */
export interface PageFindings {
  page: number;
  /** The page text in stream order with all whitespace removed (see read-page.ts). The evidence gate uses it. */
  streamText: string;
  classification: PageClassification;
  /**
   * The page's rows and its table (table.ts). Null when the page is not a
   * normal text page (blank, or refused by classifyPage), because such a page
   * has no rows to look at.
   */
  layout: PageLayout | null;
  /** How many images the page draws. */
  imageCount: number;
  /** How many text pieces pdf.js gave for the page (sideways ones included). */
  pieceCount: number;
}

/** What pass 2 produces for one page: its report, its items and its refusals. */
export interface PageAnalysis {
  report: PageReport;
  items: LineItem[];
  /** The page refusal first (at most one), then the row refusals, top to bottom. */
  refusals: Refusal[];
  /** True when a cell on this page was refused because it could be read two ways (AMBIGUOUS_NUMBER_FORMAT). */
  ambiguousNumbers: boolean;
  /**
   * The page's number conventions (numbers.ts). The evidence gate reads the
   * page's values again with them. Every convention for a page with no table.
   */
  conventions: readonly Convention[];
}

/**
 * A page problem, for the server log only. It is never sent to the user; the
 * user gets the plain-English PAGE_LOAD_FAILED refusal instead.
 *
 * `cause` is "slow" when the page was read correctly but took longer than the
 * per-page limit (see "Time limits" above). Its result is still used.
 */
export interface PageDiagnostic {
  page: number;
  stage: "read" | "analyse";
  cause: "error" | "timeout" | "budget" | "slow";
  errorName?: string;
  errorMessage?: string;
  ms?: number;
}

/** The result without the fields only the route knows (the request id and the file name). */
export type EngineResult = Omit<ParseResult, "kind" | "requestId" | "fileName">;

/** Either the whole file was refused, or it was read (with page and row refusals inside). */
export type EngineOutcome =
  | { kind: "refused"; refusal: DocumentRefusal }
  | { kind: "read"; result: EngineResult; diagnostics: PageDiagnostic[] };

// ---------------------------------------------------------------------------
// Replaceable parts, so tests can simulate a page that throws or hangs
// ---------------------------------------------------------------------------

export interface EngineDeps {
  /** How the file is opened. */
  load: DocumentLoader;
  /** Pass 1 for one page. The default reads and classifies it, then builds its rows and finds its table. */
  processPage: (doc: PDFDocumentProxy, pdfjs: PdfJs, page: number) => Promise<PageFindings>;
  /** Pass 2 for one page. The default decides the number format, then reads the title, the column roles and the line items. */
  analysePage: (findings: PageFindings) => PageAnalysis | Promise<PageAnalysis>;
}

// ---------------------------------------------------------------------------
// Pass 1: one page's rows and table
// ---------------------------------------------------------------------------

/** Pass 1: read the page, decide what kind of page it is, and find its table. */
async function processPage(doc: PDFDocumentProxy, pdfjs: PdfJs, page: number): Promise<PageFindings> {
  const raw = await readPage(doc, pdfjs, page);
  const classification = classifyPage(raw);
  // Only a normal text page has rows. The pieces come from the
  // classification, so sideways stamps and watermarks are already left out.
  const layout = classification.kind === "text" ? findTable(buildRows(classification.pieces), page) : null;
  return {
    page,
    streamText: raw.streamText,
    classification,
    layout,
    imageCount: raw.imageCount,
    pieceCount: raw.pieces.length,
  };
}

// ---------------------------------------------------------------------------
// The page's number format
// ---------------------------------------------------------------------------

/**
 * The body cells of each column of a table, as numbers.ts sees them. Empty
 * cells are left out. The join spaces are passed on, so a space between two
 * separate values is never taken for a thousands separator.
 */
function columnsAsNumbers(table: Table): NumberParts[][] {
  return table.columns.map((column) =>
    table.body.flatMap((row) => {
      const cell = row.cells[column.position];
      return cell ? [analyseNumber(cell.text, cell.joinSpaces)] : [];
    }),
  );
}

/**
 * The number conventions of one page, from its table. Only the numeric
 * columns count as evidence: a description such as "2 x 4 timber" must not
 * narrow the format. Printed totals don't count either, because they sit
 * outside the table, and a total that is read wrongly must not change how
 * the lines are read.
 */
function pageConventions(table: Table): Convention[] {
  return conventionsFor(columnsAsNumbers(table).filter(isNumericColumn));
}

// ---------------------------------------------------------------------------
// Pass 2: one page's items
// ---------------------------------------------------------------------------

/**
 * A text page with fewer text pieces than this, some images and no table is
 * "mostly a scanned picture" (NO_TEXT_LAYER) rather than "a page with no
 * table" (NO_TABLE_FOUND). A scan often carries a few real words, such as a
 * printed page number or a stamp. A real page of text almost always has at
 * least 10 pieces. The "no table" part protects a short docket with a logo:
 * if a table is found, the page is read normally.
 */
const MOSTLY_SCAN_MAX_PIECES = 10;

/**
 * How many rows a NO_TABLE_FOUND refusal quotes. The first few rows are
 * enough for the user to recognise the page; the whole page would be noise.
 */
const NO_TABLE_EVIDENCE_ROWS = 5;

/** An empty page report, filled in by the callers below. */
function report(page: number, status: PageReport["status"], notes: PageReport["notes"] = []): PageReport {
  return { page, status, titleLines: [], itemCount: 0, columns: [], notes };
}

/** Rows as evidence for a refusal, in the order given. */
function asEvidence(page: number, rows: readonly Row[]): Evidence[] {
  return rows.map((row) => ({ page, sourceText: row.text }));
}

/** Every row of a table, top to bottom: the header rows, then each body row and its wrapped lines. */
function tableRows(table: Table): Row[] {
  return [...table.headerRows, ...table.body.flatMap((row) => [row.row, ...row.continuations])];
}

/** The notes in order, each one only once (the same level and the same text). */
function uniqueNotes(notes: readonly Note[]): Note[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = `${note.level}\n${note.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A page's status from its refusals and its items:
 *   - a page refusal decides it (PAGE_REFUSAL_STATUS in schema.ts): "refused",
 *     or "partial" for COLUMN_MEANING_UNKNOWN, whose rows are still shown
 *   - else row refusals make it "partial" when some items are left, and
 *     "refused" when none are
 *   - else it is "extracted" (it may still carry warning notes)
 * A blank page keeps "blank": it has no refusals and no items.
 */
function statusOf(current: PageReport["status"], refusals: readonly Refusal[], itemCount: number): PageReport["status"] {
  if (current === "blank") return "blank";
  const pageLevel = refusals.find((refusal) => refusal.scope === "page");
  if (pageLevel) return PAGE_REFUSAL_STATUS[pageLevel.code as keyof typeof PAGE_REFUSAL_STATUS] ?? "refused";
  if (refusals.some((refusal) => refusal.scope === "row")) return itemCount > 0 ? "partial" : "refused";
  return "extracted";
}

/**
 * Pass 2 for one page. The classification and the layout from pass 1 decide
 * which of these happens:
 *
 *   blank or refused page     the classification's report, as it is
 *   text, no table            NO_TEXT_LAYER ("mostly a scan") or NO_TABLE_FOUND
 *   a credit or return title  CREDIT_OR_RETURN_PAGE, and no items
 *   ambiguous columns         AMBIGUOUS_COLUMNS, and no items
 *   otherwise                 the line items, with row refusals and notes
 *
 * The page status is set here and set again after the evidence gate, which
 * may remove items (see `withGateResults`).
 */
function analysePage(findings: PageFindings): PageAnalysis {
  const { page, classification, layout } = findings;
  const none = { items: [], ambiguousNumbers: false, conventions: CONVENTIONS };

  if (classification.kind === "blank") {
    // Not a refusal: there was nothing to read.
    return { ...none, report: report(page, "blank", [NOTES.blankPage(page)]), refusals: [] };
  }
  if (classification.kind === "refused") {
    return { ...none, report: report(page, "refused"), refusals: [pageRefusal({ ...classification.reason, page })] };
  }
  if (!layout) throw new Error(`page ${page} is a text page but has no layout`);

  const { table } = layout;
  if (!table) {
    if (findings.imageCount > 0 && findings.pieceCount < MOSTLY_SCAN_MAX_PIECES) {
      // The page's own message already says it is a picture, so the
      // "images were not read" note would only repeat it.
      const imagesNote = NOTES.imagesNotRead(page).text;
      const notes = classification.notes.filter((note) => note.text !== imagesNote);
      const refusal = pageRefusal({ code: "NO_TEXT_LAYER", page, form: "mostlyScan" });
      return { ...none, report: report(page, "refused", notes), refusals: [refusal] };
    }
    const evidence = asEvidence(page, layout.rows.slice(0, NO_TABLE_EVIDENCE_ROWS));
    const refusal = pageRefusal({ code: "NO_TABLE_FOUND", page }, evidence);
    return { ...none, report: report(page, "refused", uniqueNotes([...classification.notes, ...layout.notes])), refusals: [refusal] };
  }

  const title = readPageTitle(layout.above);
  if (title.creditTitle !== null) {
    // The rows are quoted in the evidence, so the user still sees what was
    // on the page, but none of them becomes a line item.
    const quoted = title.creditRow ? [title.creditRow, ...tableRows(table)] : tableRows(table);
    const refusal = pageRefusal({ code: "CREDIT_OR_RETURN_PAGE", page, title: title.creditTitle }, asEvidence(page, quoted));
    const pageReport = { ...report(page, "refused", uniqueNotes([...classification.notes, ...layout.notes])), titleLines: title.titleLines };
    return { ...none, report: pageReport, refusals: [refusal] };
  }

  const conventions = pageConventions(table);
  const decision = decideRoles(table, conventions, page);
  const built =
    decision.refusal?.code === "AMBIGUOUS_COLUMNS"
      ? { items: [], refusals: [], notes: [], ambiguousNumbers: false }
      : buildItems(page, table, decision, conventions);

  const notes = uniqueNotes([
    ...classification.notes,
    ...layout.notes,
    ...decision.notes,
    ...built.notes,
    ...(title.summaryTitle !== null ? [NOTES.summaryPage(page, title.summaryTitle)] : []),
  ]);
  // The page refusal (AMBIGUOUS_COLUMNS or COLUMN_MEANING_UNKNOWN) comes
  // first, then the row refusals, which buildItems gives top to bottom.
  const refusals = [...(decision.refusal ? [decision.refusal] : []), ...built.refusals];
  const pageReport: PageReport = {
    page,
    status: statusOf("extracted", refusals, built.items.length),
    titleLines: title.titleLines,
    itemCount: built.items.length,
    columns: decision.columns,
    notes,
  };
  return { report: pageReport, items: built.items, refusals, ambiguousNumbers: built.ambiguousNumbers, conventions };
}

/** The parts used in production. */
export const defaultDeps: EngineDeps = {
  load: defaultLoader,
  processPage,
  analysePage,
};

// ---------------------------------------------------------------------------
// Time limits
// ---------------------------------------------------------------------------

export interface EngineOptions {
  /** The longest one page may take while pdf.js is waiting, in milliseconds. */
  pageMs: number;
  /**
   * After this many milliseconds, no new page is started in pass 1 (reading
   * the pages). A page that starts just in time can still run for a while, so
   * this is well below the route's 60-second limit. Pass 2 has no budget of
   * its own: it only works on text that is already read, and each page still
   * has its pageMs limit while it waits.
   */
  totalMs: number;
  /** The clock. Tests replace it to make the budget easy to test. */
  now: () => number;
}

/**
 * 8 seconds per page is far more than a normal page needs (each of the sample
 * pages takes well under half a second), so only a truly stuck page hits it.
 */
export const DEFAULT_OPTIONS: EngineOptions = {
  pageMs: 8_000,
  totalMs: 30_000,
  now: () => performance.now(),
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** What pass 1 gives for one page: its findings, or why it failed. */
type PassOne = { ok: true; findings: PageFindings } | { ok: false; cause: "error" | "timeout" | "budget" };

/** A page that failed, as a report and a refusal. */
function failedPage(page: number, cause: "error" | "timeout" | "budget"): PageAnalysis {
  return {
    report: report(page, "refused"),
    items: [],
    refusals: [pageRefusal({ code: "PAGE_LOAD_FAILED", page, cause })],
    ambiguousNumbers: false,
    conventions: CONVENTIONS,
  };
}

/** Records a page problem for the server log. */
function diagnostic(
  page: number,
  stage: PageDiagnostic["stage"],
  cause: PageDiagnostic["cause"],
  error?: unknown,
  ms?: number,
): PageDiagnostic {
  return {
    page,
    stage,
    cause,
    ...(error instanceof Error ? { errorName: error.name, errorMessage: error.message } : {}),
    ...(ms !== undefined ? { ms: Math.round(ms) } : {}),
  };
}

/**
 * Reads a PDF and returns everything the contract needs, except the request id
 * and the file name, which the route adds.
 */
export async function parsePdf(
  bytes: Uint8Array,
  deps: EngineDeps = defaultDeps,
  options: EngineOptions = DEFAULT_OPTIONS,
): Promise<EngineOutcome> {
  const opened = await openDocument(bytes, deps.load);
  if (!opened.ok) return { kind: "refused", refusal: opened.refusal };

  const { doc, pdfjs } = opened;
  const started = options.now();
  const diagnostics: PageDiagnostic[] = [];

  try {
    // Pass 1: one page at a time, in page order. Reading pages one by one
    // keeps memory low and makes the time budget simple to check.
    const passOne: PassOne[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const pageStarted = options.now();
      if (pageStarted - started >= options.totalMs) {
        passOne.push({ ok: false, cause: "budget" });
        diagnostics.push(diagnostic(page, "read", "budget"));
        continue;
      }
      const outcome = await settlePage(() => deps.processPage(doc, pdfjs, page), options.pageMs);
      if (outcome.ok) {
        passOne.push({ ok: true, findings: outcome.value });
        const took = options.now() - pageStarted;
        if (took > options.pageMs) diagnostics.push(diagnostic(page, "read", "slow", undefined, took));
      } else {
        passOne.push({ ok: false, cause: outcome.cause });
        diagnostics.push(diagnostic(page, "read", outcome.cause, outcome.error));
      }
    }

    const found = passOne.flatMap((first) => (first.ok ? [first.findings] : []));

    // Pass 2: per page. A failure here is contained the same way as in pass 1.
    const analyses: PageAnalysis[] = [];
    for (const [index, first] of passOne.entries()) {
      const page = index + 1;
      if (!first.ok) {
        analyses.push(failedPage(page, first.cause));
        continue;
      }
      const outcome = await settlePage(() => deps.analysePage(first.findings), options.pageMs);
      if (outcome.ok) {
        analyses.push(outcome.value);
      } else {
        analyses.push(failedPage(page, outcome.cause));
        diagnostics.push(diagnostic(page, "analyse", outcome.cause, outcome.error));
      }
    }

    // The evidence gate, over every item of every page, with each page's own
    // stream text and number conventions. It runs in production, not only in
    // tests.
    const streamTexts = new Map(found.map((findings) => [findings.page, findings.streamText]));
    const checked = withGateResults(analyses, streamTexts);

    // The format the pages share. A page with no table allows every
    // convention, so it doesn't change the result.
    const numberFormat = numberFormatOf(
      sharedConventions(checked.map((analysis) => analysis.conventions)),
      checked.some((analysis) => analysis.ambiguousNumbers),
    );
    return { kind: "read", result: assemble(doc.numPages, numberFormat, checked), diagnostics };
  } finally {
    // Close the document and free its memory. pdf.js 6 closes a document
    // through its loading task (there is no doc.destroy()). A failure here
    // must not hide the result, so it is ignored.
    await doc.loadingTask.destroy().catch(() => {});
  }
}

/**
 * Runs the evidence gate over the items of all pages. An item that fails is
 * removed, and its EVIDENCE_CHECK_FAILED refusal joins its page's refusals in
 * row order (the page refusal stays first). Then each page's item count and
 * status are set again, because a page can lose items here.
 */
function withGateResults(analyses: readonly PageAnalysis[], streamTexts: ReadonlyMap<number, string>): PageAnalysis[] {
  const conventionsByPage = new Map(analyses.map((analysis) => [analysis.report.page, analysis.conventions]));
  const gate = evidenceGate(
    analyses.flatMap((analysis) => analysis.items),
    streamTexts,
    (page) => conventionsByPage.get(page) ?? CONVENTIONS,
  );
  return analyses.map((analysis) => {
    const { page } = analysis.report;
    const items = gate.items.filter((item) => item.page === page);
    const gateRefusals = gate.refusals.filter((refusal) => refusal.page === page);
    const refusals = orderRefusals([...analysis.refusals, ...gateRefusals]);
    return {
      ...analysis,
      items,
      refusals,
      report: {
        ...analysis.report,
        itemCount: items.length,
        status: statusOf(analysis.report.status, refusals, items.length),
      },
    };
  });
}

/**
 * One page's refusals in the contract's order: the page refusal first, then
 * the row refusals by rowIndex. The sort is stable,
 * so refusals of the same row keep their order.
 */
function orderRefusals(refusals: readonly Refusal[]): Refusal[] {
  const rank = (refusal: Refusal) => (refusal.scope === "page" ? -1 : (refusal.rowIndex ?? 0));
  return [...refusals].sort((a, b) => rank(a) - rank(b));
}

/**
 * Puts the per-page analyses together in the order the contract requires:
 * pages in page order, items by page then row, and refusals as document
 * findings first, then each page's refusals in page order.
 */
function assemble(pageCount: number, numberFormat: NumberFormat, analyses: PageAnalysis[]): EngineResult {
  const pages = analyses.map((analysis) => ({ ...analysis.report, itemCount: analysis.items.length }));
  const items = analyses.flatMap((analysis) => analysis.items);
  const pageRefusals = analyses.flatMap((analysis) => analysis.refusals);

  // When nothing was found and nothing was refused, say so plainly, instead of
  // returning an empty list the user might read as "the file has no lines".
  const findings: Refusal[] = [];
  if (items.length === 0 && pageRefusals.length === 0) {
    findings.push(findingRefusal({ code: "NO_LINE_ITEMS_FOUND" }));
  }

  return {
    pageCount,
    numberFormat,
    pages,
    items,
    refusals: [...findings, ...pageRefusals],
    // The printed totals are not read yet.
    totals: { stated: [], gstBasis: "unstated", checks: [] },
  };
}
