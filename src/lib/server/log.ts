/**
 * The server log: one JSON line for every request to POST /api/parse.
 *
 * Why one line per request: when a user reports a problem, they quote the
 * reference from the page (the start of the request id). That finds exactly
 * one line here, which says what happened: how long it took, what the engine
 * found, and, for our own bug, the error and its stack.
 *
 * What is NEVER logged: any text from the document. Refusal messages and item
 * fields quote the document, so only codes and counts go in. The file name is
 * left out too, because a file name can hold a person's or a company's name.
 *
 * The line goes to standard output (console.log), or to standard error
 * (console.error) for a 500, so the platform shows our failures as errors.
 */
import type { NumberFormat, ParseResult } from "@/lib/contract/schema";
import type { PageDiagnostic } from "@/lib/engine";

/** At most this many page problems go into one line, so a bad file can't flood the log. */
export const MAX_LOGGED_PAGE_PROBLEMS = 20;

/** What one log line holds. */
export interface RequestLog {
  requestId: string;
  /** How long the request took, in milliseconds. */
  ms: number;
  /** The HTTP status of the reply. */
  status: number;
  /** For a Problem: the whole-file refusal's code, or INTERNAL. */
  code?: string;
  /** For a result: how many pages and line items. */
  pageCount?: number;
  itemCount?: number;
  /** For a result: how many refusals of each code. Codes only, because the messages quote the document. */
  refusalCodes?: Record<string, number>;
  /** For a result: the number format the pages share. */
  numberFormat?: NumberFormat;
  /** Page problems from the engine (a page that threw, timed out or was slow), at most MAX_LOGGED_PAGE_PROBLEMS. */
  pageProblems?: PageDiagnostic[];
  /** How many page problems there were in all, when there were any. */
  pageProblemCount?: number;
  /** For a result: the size of the reply in bytes, measured before it was sent. */
  replyBytes?: number;
  /**
   * When the upload couldn't be read as a form: the error's name only (its
   * message can quote the request's headers, such as the file name), the
   * body's media type without its parameters, and whether the browser had
   * already given up on the request.
   */
  formError?: { name: string; mediaType: string | null; clientAborted: boolean };
  /** For our own reply that didn't fit the contract: where and what kind, never the offending text. */
  contractIssues?: { path: string; code: string }[];
  /** For our own bug: the error's name, message and stack. */
  error?: { name: string; message: string; stack?: string };
}

/** The summary of a result for the log: counts and codes, and no document text. */
export function resultSummary(result: ParseResult, diagnostics: readonly PageDiagnostic[]): Omit<RequestLog, "requestId" | "ms" | "status"> {
  const refusalCodes: Record<string, number> = {};
  for (const refusal of result.refusals) refusalCodes[refusal.code] = (refusalCodes[refusal.code] ?? 0) + 1;
  return {
    pageCount: result.pageCount,
    itemCount: result.items.length,
    refusalCodes,
    numberFormat: result.numberFormat,
    ...(diagnostics.length > 0
      ? { pageProblems: diagnostics.slice(0, MAX_LOGGED_PAGE_PROBLEMS), pageProblemCount: diagnostics.length }
      : {}),
  };
}

/** An unknown thrown value as a log entry: its name, message and stack when it is an Error. */
export function errorSummary(error: unknown): NonNullable<RequestLog["error"]> {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "NonError", message: String(error) };
}

/** Writes one log line. A 500 goes to standard error, everything else to standard output. */
export function writeRequestLog(entry: RequestLog): void {
  const line = JSON.stringify(entry);
  if (entry.status >= 500) console.error(line);
  else console.log(line);
}
