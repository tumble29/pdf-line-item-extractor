/**
 * The engine: turns the bytes of a PDF into a result.
 *
 * Where this fits
 * ---------------
 * The brief has two parts: Part A is the API (this engine plus the route in
 * src/app/api/parse), Part B is the web page. The code is built in steps:
 * Part 4 (this code) opens, reads and classifies pages; Part 5 adds rows,
 * tables, the number format and line items; Part 6 reads and checks totals;
 * Part 7 hardens the route.
 *
 * The pipeline
 * ------------
 *   open        open the file; a protected, damaged or oversized file refuses
 *               the whole file
 *   pass 1      per page, one at a time: read the page and classify it
 *               (Part 5 adds: build rows and find the table)
 *   document    decide the number format for the whole document (Part 5)
 *   pass 2      per page: read the line items from the table (Part 5)
 *   assemble    put pages, items and refusals together in the contract's order
 *
 * The number format needs a whole-document step between the two passes,
 * because it is decided from the numbers on every page together ("1.200" means
 * 1200 or 1.2 depending on how the other numbers are written).
 *
 * Containment
 * -----------
 * Every page runs inside `settlePage` (isolate.ts). A page that throws becomes
 * a PAGE_LOAD_FAILED refusal for that page only. The other pages are read
 * exactly as if nothing had happened; tests/engine/containment.test.ts checks
 * this.
 *
 * Time limits
 * -----------
 * There are two limits, and it matters what each can do:
 *   - per page (pageMs): a page that doesn't finish in time is refused. This
 *     works while pdf.js is waiting. It can't stop pdf.js in the middle of a
 *     long calculation, because JavaScript can't interrupt running code; such
 *     a page finishes late, and we log it as slow.
 *   - per document (totalMs): once it is used up, no new page is started, and
 *     the pages not reached are refused with the "took too long" reason.
 * A single extremely heavy page can still run past the route's 60-second limit.
 * The platform then ends the request, and the web page shows its own "took too
 * long" message (Part 8). The real fix is to read the file in a separate
 * worker thread that can be stopped; that is listed for later.
 *
 * What this function never does
 * -----------------------------
 * It never reports our own bug as a problem with the file. An unexpected error
 * while opening is thrown again to the caller, and the route answers INTERNAL.
 */
import { NOTES } from "@/lib/contract/notes";
import type { LineItem, NumberFormat, PageReport, ParseResult, Refusal } from "@/lib/contract/schema";

import { classifyPage, type PageClassification } from "./classify-page";
import { settlePage } from "./isolate";
import { defaultLoader, openDocument, type DocumentLoader } from "./open";
import type { PDFDocumentProxy, PdfJs } from "./pdfjs";
import { readPage } from "./read-page";
import { findingRefusal, pageRefusal, type DocumentRefusal } from "./refusals";

// ---------------------------------------------------------------------------
// Types passed between the stages
// ---------------------------------------------------------------------------

/** What pass 1 learns about one page. Part 5 adds the rows and the table. */
export interface PageFindings {
  page: number;
  /** The page text in stream order with all whitespace removed (see read-page.ts). */
  streamText: string;
  classification: PageClassification;
}

/** What pass 2 produces for one page: its report, its items and its refusals. */
export interface PageAnalysis {
  report: PageReport;
  items: LineItem[];
  refusals: Refusal[];
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
  /** Pass 1 for one page. The default reads and classifies it. */
  processPage: (doc: PDFDocumentProxy, pdfjs: PdfJs, page: number) => Promise<PageFindings>;
  /** Pass 2 for one page. The default turns the classification into a page report. */
  analysePage: (findings: PageFindings) => PageAnalysis | Promise<PageAnalysis>;
}

/** Pass 1: read the page and decide what kind of page it is. */
async function readAndClassify(doc: PDFDocumentProxy, pdfjs: PdfJs, page: number): Promise<PageFindings> {
  const raw = await readPage(doc, pdfjs, page);
  return { page, streamText: raw.streamText, classification: classifyPage(raw) };
}

/** An empty page report, filled in by the callers below. */
function report(page: number, status: PageReport["status"], notes: PageReport["notes"] = []): PageReport {
  return { page, status, titleLines: [], itemCount: 0, columns: [], notes };
}

/**
 * Pass 2, until Part 5 adds table reading: the classification alone decides
 * the page report. A text page is reported as read, with no items yet.
 */
function analyseClassification(findings: PageFindings): PageAnalysis {
  const { page, classification } = findings;
  switch (classification.kind) {
    case "blank":
      // Not a refusal: there was nothing to read.
      return { report: report(page, "blank", [NOTES.blankPage(page)]), items: [], refusals: [] };
    case "refused":
      return { report: report(page, "refused"), items: [], refusals: [pageRefusal({ ...classification.reason, page })] };
    case "text":
      return { report: report(page, "extracted", classification.notes), items: [], refusals: [] };
  }
}

/** The parts used in production. */
export const defaultDeps: EngineDeps = {
  load: defaultLoader,
  processPage: readAndClassify,
  analysePage: analyseClassification,
};

// ---------------------------------------------------------------------------
// Time limits
// ---------------------------------------------------------------------------

export interface EngineOptions {
  /** The longest one page may take while pdf.js is waiting, in milliseconds. */
  pageMs: number;
  /**
   * After this many milliseconds, no new page is started. A page that starts
   * just in time can still run for a while, so this is well below the route's
   * 60-second limit (30 + 8 = 38 seconds for a normal slow page).
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

    // Document step: the number format. Part 5 decides it from the tables
    // found in pass 1. Until then the marks are unknown (null), and `settled`
    // is true because no number was refused over its format.
    const numberFormat: NumberFormat = { decimal: null, grouping: null, settled: true };

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

    return { kind: "read", result: assemble(doc.numPages, numberFormat, analyses), diagnostics };
  } finally {
    // Close the document and free its memory. pdf.js 6 closes a document
    // through its loading task (there is no doc.destroy()). A failure here
    // must not hide the result, so it is ignored.
    await doc.loadingTask.destroy().catch(() => {});
  }
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
    // The totals are read and checked in Part 6.
    totals: { stated: [], gstBasis: "unstated", checks: [] },
  };
}
