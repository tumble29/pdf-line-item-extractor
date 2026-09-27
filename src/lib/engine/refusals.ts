/**
 * Builds refusal objects in the exact shape the contract requires.
 *
 * Every part of the engine creates refusals through these helpers, never by
 * hand. That keeps three things consistent everywhere:
 *   - the id, which follows a fixed form per scope (see `Refusal` in schema.ts)
 *   - the scope, page and row fields
 *   - the message, which always comes from codes.ts
 *
 * Each helper takes the code and its facts as one object, the same object
 * `refusalMessage` takes, so TypeScript checks that the facts fit the code.
 */
import { refusalMessage, type RefusalInput } from "@/lib/contract/codes";
import type { DocumentCode, Evidence, Refusal } from "@/lib/contract/schema";

/** The facts for a whole-file refusal. */
type DocumentInput = Extract<RefusalInput, { code: DocumentCode }>;

/** The codes that refuse a whole page, and their facts. */
type PageCode =
  | "NO_TEXT_LAYER"
  | "GARBLED_TEXT"
  | "ROTATED_TEXT"
  | "PAGE_LOAD_FAILED"
  | "NO_TABLE_FOUND"
  | "AMBIGUOUS_COLUMNS"
  | "COLUMN_MEANING_UNKNOWN"
  | "CREDIT_OR_RETURN_PAGE";
type PageInput = Extract<RefusalInput, { code: PageCode }>;

/** The findings about the whole document that sit next to the items in a normal result. */
type FindingInput = Extract<RefusalInput, { code: "CONFLICTING_FIGURES" | "NO_LINE_ITEMS_FOUND" }>;

/** The codes that refuse one row (one line item), and their facts. */
type RowCode =
  | "UNPARSEABLE_NUMBER"
  | "NO_DESCRIPTION"
  | "ARITHMETIC_MISMATCH"
  | "AMBIGUOUS_NUMBER_FORMAT"
  | "EVIDENCE_CHECK_FAILED";
type RowInput = Extract<RefusalInput, { code: RowCode }>;

/** A refusal of the whole file, before anything could be read. */
export type DocumentRefusal = Refusal & { code: DocumentCode; scope: "document" };

/**
 * A refusal of the whole file: no file, an empty file, too large, not a PDF,
 * password-protected, or damaged. The route sends it as a 4xx Problem.
 *
 * Example:
 *   documentRefusal({ code: "ENCRYPTED" })
 *   -> { id: "doc-ENCRYPTED", code: "ENCRYPTED", scope: "document",
 *        message: "This PDF is password-protected...", evidence: [] }
 */
export function documentRefusal(input: DocumentInput): DocumentRefusal {
  return {
    id: `doc-${input.code}`,
    code: input.code,
    scope: "document",
    message: refusalMessage(input),
    evidence: [],
  };
}

/**
 * A refusal of one page. The other pages are not affected.
 *
 * `evidence` quotes what was on the page, when there is text to quote. A
 * scanned page has none, so its evidence is empty.
 */
export function pageRefusal(input: PageInput, evidence: Evidence[] = []): Refusal {
  return {
    id: `p${input.page}-${input.code}`,
    code: input.code,
    scope: "page",
    page: input.page,
    message: refusalMessage(input),
    evidence,
  };
}

/**
 * A refusal of one row: that line is left out, and the rest of the page is
 * still read. `evidence` should quote the row as printed, so the user can see
 * exactly which line was left out and why.
 *
 * Example:
 *   rowRefusal({ code: "UNPARSEABLE_NUMBER", page: 1, raw: "$12.50 box" }, 7, [{ page: 1, sourceText: "3 Nails $12.50 box" }])
 *   -> { id: "p1-r7-UNPARSEABLE_NUMBER", scope: "row", page: 1, rowIndex: 7, ... }
 */
export function rowRefusal(input: RowInput, rowIndex: number, evidence: Evidence[]): Refusal {
  return {
    id: `p${input.page}-r${rowIndex}-${input.code}`,
    code: input.code,
    scope: "row",
    page: input.page,
    rowIndex,
    message: refusalMessage(input),
    evidence,
  };
}

/**
 * A finding about the whole document that is reported next to the items,
 * inside a normal result (for example "no line items found").
 *
 * `suffix` is added to the id when the same code can appear more than once,
 * like CONFLICTING_FIGURES, which gets one refusal per repeated word.
 */
export function findingRefusal(input: FindingInput, evidence: Evidence[] = [], suffix?: string): Refusal {
  return {
    id: suffix ? `doc-${input.code}-${suffix}` : `doc-${input.code}`,
    code: input.code,
    scope: "document",
    message: refusalMessage(input),
    evidence,
  };
}
