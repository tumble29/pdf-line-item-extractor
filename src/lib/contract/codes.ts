/**
 * The words the user sees for every refusal, plus the HTTP title of each
 * whole-file problem.
 *
 * Why this file exists
 * --------------------
 * The brief says a refusal must reach the person in plain language, never as a
 * vague, generic error. So every refusal code has exactly one message function
 * here, and nothing else in the app writes refusal text. The engine only
 * decides *which* code applies and passes the facts (the page number, the raw
 * text it saw, and so on). This file turns those facts into a sentence.
 *
 * Keeping all the wording in one place also means:
 *   - a test can check every message at once (tests/copy.test.ts)
 *   - TypeScript forces a message to exist for every code, because the table
 *     below is typed against the full list of codes in schema.ts
 *
 * The rules about codes (which scope each code may have, which HTTP status a
 * whole-file refusal uses) live in schema.ts, because they are part of the
 * contract. This file is only about wording.
 *
 * Numbers inside messages
 * -----------------------
 * Numbers read from the document are quoted exactly as printed ("$95.00"). A
 * new number that we calculated ourselves, like the sum of the lines, is always
 * followed by "(calculated by us)", so the user can never mistake it for
 * something the document said. The engine formats calculated numbers before
 * passing them in, because only the engine knows the document's number format.
 *
 * One exception: the two readings in AMBIGUOUS_NUMBER_FORMAT ("1200 or 1.2")
 * are not labelled. They are not new numbers; they are the same printed
 * characters read in two ways.
 */
import type { DocumentCode, RefusalCode, Role, StatedTotal } from "./schema";

// ---------------------------------------------------------------------------
// Small wording helpers
// ---------------------------------------------------------------------------

/** How each role is named inside a sentence. */
const ROLE_WORDS: Record<Role, { one: string; many: string }> = {
  itemNo: { one: "item number", many: "item numbers" },
  code: { one: "code", many: "codes" },
  description: { one: "description", many: "descriptions" },
  quantity: { one: "quantity", many: "quantities" },
  unit: { one: "unit", many: "units" },
  unitPrice: { one: "unit price", many: "unit prices" },
  lineTotal: { one: "line total", many: "line totals" },
};

/** How each kind of printed total is named inside a sentence. */
const TOTAL_WORDS: Record<StatedTotal["label"], string> = {
  subtotal: "subtotal",
  gst: "GST",
  total: "total",
  amount_due: "amount due",
};

/** "two", "three" and so on for small counts, digits above ten. */
function countWord(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[n] ?? String(n);
}

/** Joins a list the way people write it: "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Names a set of pages: "page 2", "pages 1 and 2", "pages 1 to 4", or
 * "pages 1, 3 and 5". Duplicates are removed and the pages are sorted first.
 * The engine always passes at least one page; an empty list gives "the
 * document" so a sentence still reads correctly.
 */
export function pagesText(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "the document";
  if (sorted.length === 1) return `page ${sorted[0]}`;
  const isRun = sorted.length >= 3 && sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  if (isRun) return `pages ${sorted[0]} to ${sorted[sorted.length - 1]}`;
  return `pages ${listText(sorted.map(String))}`;
}

/** A column, as the engine describes it to this file. `position` counts from 1, left to right. */
export interface ColumnRef {
  header: string | null;
  position: number;
}

/** Names a column in a sentence: "the 'Qty' column", or "column 3" when it has no heading. */
export function columnLabel(column: ColumnRef): string {
  return column.header ? `the '${column.header}' column` : `column ${column.position}`;
}

/** Just the quoted heading, or "column 3". Used inside lists. */
function columnName(column: ColumnRef): string {
  return column.header ? `'${column.header}'` : `column ${column.position}`;
}

/**
 * Formats a file size in megabytes with at most one decimal.
 *
 * 1 MB here is 1024 x 1024 bytes, the same unit as the upload limit.
 *
 * The file's size is rounded UP. Without that, a 4.04 MB file would show as
 * "4 MB", and the message "This file is 4 MB. The limit is 4 MB." would make no
 * sense. Rounding up shows "4.1 MB" instead.
 *
 * The limit itself is rounded normally (roundUp = false), because it is a
 * round number and must be shown as it is: "4 MB", not "4.1 MB".
 */
export function megabytes(bytes: number, roundUp = true): string {
  const mb = bytes / (1024 * 1024);
  const tenths = roundUp ? Math.ceil(mb * 10) / 10 : Math.round(mb * 10) / 10;
  return `${tenths.toFixed(1).replace(/\.0$/, "")} MB`;
}

// ---------------------------------------------------------------------------
// The facts each message needs ("contexts")
// ---------------------------------------------------------------------------

/** For refusals that need nothing but their code. */
type NoContext = Record<never, never>;

/** Most page refusals only need the page number. */
interface PageContext {
  page: number;
}

/** At least two of something. Used where a message compares things. */
type TwoOrMore<T> = [T, T, ...T[]];

/** A figure as printed ("14 pallets" or "$500.00") and the page it is on. */
interface Mention {
  text: string;
  page: number;
}

/**
 * The facts for every refusal code. TypeScript rejects a call with a missing
 * or wrong fact.
 */
export interface MessageContexts {
  NO_FILE: NoContext;
  EMPTY_FILE: NoContext;
  FILE_TOO_LARGE: { sizeBytes: number; limitBytes: number };
  NOT_A_PDF: { fileName: string };
  ENCRYPTED: NoContext;
  CORRUPT_FILE: NoContext;

  /**
   * `mostly` is true when the page is a scan with a few words of real text on
   * it, and false when it has no text at all.
   */
  NO_TEXT_LAYER: PageContext & { mostly: boolean };
  GARBLED_TEXT: PageContext;
  ROTATED_TEXT: PageContext;
  /**
   * `cause` says why the page failed:
   *   - "error":   reading the page threw
   *   - "timeout": this page took longer than its own time limit
   *   - "budget":  the whole document ran out of time before this page
   */
  PAGE_LOAD_FAILED: PageContext & { cause: "error" | "timeout" | "budget" };
  NO_TABLE_FOUND: PageContext;
  /**
   * Two ways columns can be ambiguous:
   *   - "numbersVsHeader": the numbers say one role, the heading says another.
   *     The engine only builds this when the two roles differ.
   *   - "sameRole": two or more columns ended up with the same role.
   */
  AMBIGUOUS_COLUMNS:
    | (PageContext & { kind: "numbersVsHeader"; column: ColumnRef; numbersRole: Role; headerRole: Role })
    | (PageContext & { kind: "sameRole"; role: Role; columns: TwoOrMore<ColumnRef> });
  COLUMN_MEANING_UNKNOWN: PageContext;
  /** `title` is the part of the title line that contains the credit or return word, as printed. */
  CREDIT_OR_RETURN_PAGE: PageContext & { title: string };

  /** `raw` is the cell exactly as printed. */
  UNPARSEABLE_NUMBER: PageContext & { raw: string };
  /** `rowText` is the row as printed, so the user can find it on the page. */
  NO_DESCRIPTION: PageContext & { rowText: string };
  /**
   * `quantity`, `unitPrice` and `lineTotal` are the cells as printed.
   * `expected` is quantity x unit price, already formatted by the engine.
   * `columnBetween` is the heading of a column between the price and the
   * total, like "Disc %". We don't read that column, but it may explain the
   * difference.
   */
  ARITHMETIC_MISMATCH: PageContext & {
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    expected: string;
    columnBetween?: string | null;
  };
  /**
   * `readings` are the two values the cell could have, already written out
   * ("1200" and "1.2"). `target` says what was left out: a line item, or a
   * printed total.
   */
  AMBIGUOUS_NUMBER_FORMAT: PageContext & { raw: string; readings: [string, string]; target: "line" | "total" };
  /** `raw` is the value that failed the check, when there is one to quote. */
  EVIDENCE_CHECK_FAILED: PageContext & { raw?: string };

  /** Each mention is a figure as printed ("14 pallets") and its page. */
  CONFLICTING_FIGURES: { mentions: TwoOrMore<Mention> };
  /**
   * `sum` and `difference` are calculated by the engine and already formatted.
   * `stated` is the printed total, exactly as printed.
   */
  TOTALS_DISAGREE: { pages: number[]; label: StatedTotal["label"]; sum: string; stated: string; difference: string };
  /**
   * Three reasons a total couldn't be checked:
   *   - "pageNotRead":      a page that the total covers wasn't fully read
   *   - "missingLineTotal": a line that the total covers has no line total
   *   - "twoAmounts":       the same total is printed with different amounts
   * `totalPage` is the page where the total is printed. `page` is the page
   * that caused the problem.
   */
  TOTALS_UNVERIFIABLE:
    | {
        reason: "pageNotRead";
        label: StatedTotal["label"];
        totalPage: number;
        page: number;
        status: "partial" | "refused" | "blank";
      }
    | { reason: "missingLineTotal"; label: StatedTotal["label"]; totalPage: number; page: number }
    | { reason: "twoAmounts"; label: StatedTotal["label"]; amounts: TwoOrMore<Mention> };
  NO_LINE_ITEMS_FOUND: NoContext;
}

/**
 * What the engine passes to `refusalMessage`: the code and its facts in one
 * object, for example `{ code: "NO_TEXT_LAYER", page: 4, mostly: false }`.
 *
 * Putting the code inside the object makes this a true union type. So if the
 * code and the facts don't match, the program doesn't compile, even when the
 * code comes from a variable. (With two separate arguments, TypeScript could
 * accept `refusalMessage(someCode, {})`, and the user would see "NaN MB".)
 */
export type RefusalInput = {
  [Code in RefusalCode]: { code: Code } & MessageContexts[Code];
}[RefusalCode];

// ---------------------------------------------------------------------------
// The table: one message function per refusal code
// ---------------------------------------------------------------------------

/**
 * Every refusal code and its wording.
 *
 * The type `{ [Code in RefusalCode]: ... }` means TypeScript fails the build if
 * a code from schema.ts has no entry here, so a refusal can never reach the
 * user without a sentence.
 */
export const REFUSAL_MESSAGES: { [Code in RefusalCode]: (context: MessageContexts[Code]) => string } = {
  // --- The whole file ------------------------------------------------------
  NO_FILE: () => "No file arrived with the upload. Choose a PDF and try again.",
  EMPTY_FILE: () => "This file is empty, so there's nothing to read.",
  FILE_TOO_LARGE: ({ sizeBytes, limitBytes }) =>
    `This file is ${megabytes(sizeBytes)}. The limit is ${megabytes(limitBytes, false)}. ` +
    "Try a smaller copy, for example with smaller images, or split it into several files.",
  // The name claims to be a PDF in the confusing case, so we say so and suggest a fix.
  NOT_A_PDF: ({ fileName }) =>
    /\.pdf$/i.test(fileName)
      ? "This file isn't a PDF, even though its name ends in .pdf. It may be another kind of file " +
        "that was renamed. Save or export it as a PDF and try again."
      : "This file isn't a PDF. Choose a PDF file and try again.",
  ENCRYPTED: () => "This PDF is password-protected. Remove the password and upload it again.",
  CORRUPT_FILE: () => "This file is damaged and couldn't be opened. Try downloading or exporting it again.",

  // --- One page ------------------------------------------------------------
  NO_TEXT_LAYER: ({ page, mostly }) =>
    mostly
      ? `Page ${page} is mostly a scanned picture. Only a few words on it can be read as text. ` +
        "We don't read scans, so nothing on it was extracted."
      : `Page ${page} is a scanned picture. We don't read scans, so nothing on it was extracted.`,
  GARBLED_TEXT: ({ page }) =>
    `The text on page ${page} turned into random symbols when we read it, so we didn't use any of it.`,
  ROTATED_TEXT: ({ page }) =>
    `Most of the numbers on page ${page} are printed sideways, so we could misread which column ` +
    "they belong to. We skipped the page.",
  PAGE_LOAD_FAILED: ({ page, cause }) => {
    if (cause === "timeout") {
      return `Page ${page} couldn't be read because it took too long. The other pages weren't affected.`;
    }
    if (cause === "budget") {
      // Several pages can run out of time, so we don't claim that every page
      // before this one was read. We only say what is true for all of them.
      return (
        `Page ${page} wasn't read because reading the whole file took too long. ` +
        "Pages read before the time ran out are listed as usual."
      );
    }
    // "error": the cause could be the page, or our own code. We don't blame the
    // page, and we say only what the user needs to know.
    return `Page ${page} couldn't be read. Our program stopped while reading it. The other pages weren't affected.`;
  },
  NO_TABLE_FOUND: ({ page }) => `Page ${page} has text, but we couldn't find a table of line items on it.`,
  AMBIGUOUS_COLUMNS: (context) => {
    if (context.kind === "numbersVsHeader") {
      const { page, column, numbersRole, headerRole } = context;
      return (
        `On page ${page}, the numbers in ${columnLabel(column)} look like ${ROLE_WORDS[numbersRole].many}, ` +
        `but its heading says ${ROLE_WORDS[headerRole].one}. ` +
        "We can't tell which is right, so we didn't read the lines on this page."
      );
    }
    const { page, role, columns } = context;
    return (
      `Page ${page} has ${countWord(columns.length)} columns that could be the ${ROLE_WORDS[role].one} ` +
      `(${listText(columns.map(columnName))}). We can't tell which is right, so we didn't read the lines on this page.`
    );
  },
  COLUMN_MEANING_UNKNOWN: ({ page }) =>
    `We found a table on page ${page}, but we couldn't tell which column is the quantity, the price or the total. ` +
    "So we didn't read any numbers from it. Its rows are shown as printed.",
  CREDIT_OR_RETURN_PAGE: ({ page, title }) =>
    `Page ${page} is titled '${title}', so its amounts may be refunds or credits rather than sales. ` +
    "We didn't list them as normal items.",

  // --- One row -------------------------------------------------------------
  UNPARSEABLE_NUMBER: ({ page, raw }) => `'${raw}' on page ${page} isn't a number we can read, so that line was left out.`,
  NO_DESCRIPTION: ({ page, rowText }) =>
    `A row on page ${page} has numbers but no description ('${rowText}'), so we didn't attach them to any line.`,
  ARITHMETIC_MISMATCH: ({ page, quantity, unitPrice, lineTotal, expected, columnBetween }) => {
    const main =
      `On page ${page}, ${quantity} × ${unitPrice} is ${expected} (calculated by us), ` +
      `but the document says ${lineTotal}. We can't tell which is right, so we left this line out.`;
    // A discount or tax column between the price and the total can explain
    // the difference. We mention it, but we still refuse: guessing the
    // discount would be inventing a number.
    return columnBetween
      ? `${main} There is a '${columnBetween}' column between the price and the total, which may explain the difference.`
      : main;
  },
  AMBIGUOUS_NUMBER_FORMAT: ({ page, raw, readings, target }) =>
    `'${raw}' on page ${page} could mean ${readings[0]} or ${readings[1]}, and nothing else in the document ` +
    `shows which one is right, so ${target === "line" ? "that line was left out" : "we didn't use that total"}.`,
  EVIDENCE_CHECK_FAILED: ({ page, raw }) =>
    `We found ${raw ? `'${raw}'` : "a value"} on page ${page} but couldn't match it to the exact text on the page, ` +
    "so we left it out.",

  // --- The document as a whole, and the totals ------------------------------
  CONFLICTING_FIGURES: ({ mentions }) => {
    if (mentions.length === 2) {
      const [first, second] = mentions;
      return (
        `The document says ${first.text} in one place (page ${first.page}) and ${second.text} in another ` +
        `(page ${second.page}). We can't tell which one is right.`
      );
    }
    const listed = mentions.map((mention) => `${mention.text} (page ${mention.page})`);
    return `The document gives different figures: ${listText(listed)}. We can't tell which one is right.`;
  },
  TOTALS_DISAGREE: ({ pages, label, sum, stated, difference }) =>
    `The lines on ${pagesText(pages)} add up to ${sum} (calculated by us), but the ${TOTAL_WORDS[label]} ` +
    `says ${stated}. The difference is ${difference} (calculated by us).`,
  TOTALS_UNVERIFIABLE: (context) => {
    const label = TOTAL_WORDS[context.label];
    if (context.reason === "pageNotRead") {
      const what = {
        partial: "was only partly read",
        refused: "couldn't be read",
        blank: "is blank",
      }[context.status];
      return `We couldn't check the ${label} on page ${context.totalPage} because page ${context.page} ${what}.`;
    }
    if (context.reason === "missingLineTotal") {
      return (
        `We couldn't check the ${label} on page ${context.totalPage} because a line on page ${context.page} ` +
        "has no line total."
      );
    }
    const amounts = context.amounts.map((amount) => `${amount.text} on page ${amount.page}`);
    return (
      `The document shows ${countWord(context.amounts.length)} different amounts for the ${label} ` +
      `(${listText(amounts)}), so we couldn't check it.`
    );
  },
  NO_LINE_ITEMS_FOUND: () => "We read every page but found no table of line items.",
};

/**
 * The sentence for one refusal. This is the only function the engine calls to
 * word a refusal.
 *
 * Example:
 *   refusalMessage({ code: "NO_TEXT_LAYER", page: 4, mostly: false })
 *   -> "Page 4 is a scanned picture. We don't read scans, so nothing on it was extracted."
 */
export function refusalMessage(input: RefusalInput): string {
  // `RefusalInput` already guarantees the facts match the code. TypeScript
  // can't follow that link through the table lookup, so we tell it here.
  const message = REFUSAL_MESSAGES[input.code] as (context: RefusalInput) => string;
  return message(input);
}

// ---------------------------------------------------------------------------
// Whole-file problems (HTTP replies)
// ---------------------------------------------------------------------------

/**
 * The short title of each whole-file problem, shown with the HTTP reply. The
 * HTTP status itself is part of the contract, so it lives in schema.ts
 * (DOCUMENT_HTTP_STATUS).
 */
export const DOCUMENT_PROBLEM_TITLES: Record<DocumentCode, string> = {
  NO_FILE: "No file",
  EMPTY_FILE: "Empty file",
  FILE_TOO_LARGE: "File too large",
  NOT_A_PDF: "Not a PDF",
  ENCRYPTED: "Password-protected PDF",
  CORRUPT_FILE: "Damaged PDF",
};

/**
 * Our own failure. It is never a refusal of the user's file, so it has its own
 * wording, and it always gives a reference the user can quote to us.
 */
export const INTERNAL_PROBLEM = {
  title: "Our code failed",
  message: ({ reference }: { reference: string }) =>
    `Something in our code failed while reading this file (reference ${reference}). ` +
    "This is our bug, not a problem with your file.",
} as const;

/**
 * The `type` field of a Problem: a stable identifier per kind of problem,
 * for example "/problems/encrypted" or "/problems/internal".
 */
export function problemType(code: DocumentCode | "INTERNAL"): string {
  return `/problems/${code.toLowerCase().replace(/_/g, "-")}`;
}
