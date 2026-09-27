/**
 * Reading numbers written in any common format, decided per page.
 *
 * Where it sits: after the table detector (table.ts) has found the columns.
 * roles.ts uses it to test the arithmetic between columns, items.ts uses it
 * to read the values that go into the output, and evidence.ts uses it to read
 * a value again and check it. The result's `numberFormat` also comes from here.
 *
 * The problem it solves: "1.200" is 1200 in Germany and 1.2 in New Zealand.
 * One cell alone often can't tell. So we never decide per cell. We decide per
 * page, from all the numbers in the page's table:
 *
 *   1. analyseNumber   splits a cell into markers ("$", "%", "/bag", "CR")
 *                      and a core of digits and separators ("1,195.20").
 *   2. validConventions lists the ways of writing numbers (the 8 CONVENTIONS)
 *                      under which a core makes sense.
 *   3. conventionsFor  keeps the conventions that the page's numbers allow.
 *   4. readNumber      reads one cell under the page's conventions. If the
 *                      remaining conventions give two different values, the
 *                      cell is ambiguous and is refused, never guessed.
 *
 * Why per page and not per document: one PDF can join pages from different
 * senders. A German page whose numbers are all like "1.200" can't tell its
 * format by itself, and borrowing the format of a New Zealand page in the
 * same file would read 1200 as 1.2. So a page never borrows: when its own
 * numbers don't settle a cell, the cell is refused.
 *
 * No words of any language are used here. Only digits, separators, currency
 * symbols and codes, "%", "CR" and a "/unit" suffix.
 */
import type { NumberFormat } from "@/lib/contract/schema";

/**
 * One way of writing numbers: the decimal mark, and the thousands mark
 * ("" means no thousands mark). "1,195.20" is { ".", "," }; "1.195,20" is
 * { ",", "." }; "1 195,20" is { ",", " " }.
 */
export interface Convention {
  decimal: "." | ",";
  grouping: "," | "." | " " | "'" | "";
}

/** The 8 conventions: decimal "." or ",", with grouping ",", ".", space, "'" or none (never equal to the decimal). */
export const CONVENTIONS: readonly Convention[] = [
  { decimal: ".", grouping: "," },
  { decimal: ".", grouping: " " },
  { decimal: ".", grouping: "'" },
  { decimal: ".", grouping: "" },
  { decimal: ",", grouping: "." },
  { decimal: ",", grouping: " " },
  { decimal: ",", grouping: "'" },
  { decimal: ",", grouping: "" },
];

/**
 * A column is numeric for the number format (and for roles.ts) when at least
 * this share of its non-empty cells have a number core.
 *
 * Why 0.6: it lets a numeric column hold a few text cells (such as "TBC" or
 * "n/a") and still count, while a text column with some numbers in it (a
 * description like "2 x 4 timber") does not. Well over half must be numbers,
 * so one or two stray words can't change what a column is.
 */
export const NUMERIC_COLUMN_SHARE = 0.6;

/** A cell split into its markers and its digits. */
export interface NumberParts {
  /** The cell as printed. */
  raw: string;
  /** The digits and separators left after the markers are removed ("1,195.20"), or null when the text is not a number. */
  core: string | null;
  /** The currency marker as printed ("$", "NZ$", "€", "NZD"), or null. */
  currencyMarker: string | null;
  /** True when the cell ends with "%". */
  percent: boolean;
  /** The unit after a "/" ("bag" in "$68.00 /bag"), or null. */
  per: string | null;
  /** True for "-12.00", "(12.00)" and "12.00 CR". */
  negative: boolean;
  /**
   * True when a space inside `core` may sit between two separate values (see
   * Cell.joinSpaces). Space grouping is then not allowed for this cell, so
   * "1" and "195,20" are never read together as 1195.20.
   *
   * This only helps when we can see the join: pdf.js returned two pieces, or
   * table.ts found that the cell reaches into a neighbouring column. pdf.js
   * itself joins text that is drawn close together into one piece with a
   * space, and when that happens inside one column we can't tell it apart
   * from a thousands space.
   */
  spaceAtJoin: boolean;
}

/** The value of a cell under a set of conventions. */
export type Reading =
  /** Every convention in the set gives this same value. `dp` is how many decimals were printed. */
  | { status: "ok"; value: number; dp: number; grouped: boolean }
  /** Two conventions in the set give different values ("1.200": 1200 or 1.2). The cell is refused. */
  | { status: "ambiguous"; values: [number, number] }
  /** It has a number core, but no convention in the set reads it. The cell is refused. */
  | { status: "unreadable" }
  /** Not a number at all. */
  | { status: "text" };

// ---------------------------------------------------------------------------
// Currency markers
// ---------------------------------------------------------------------------

/**
 * The currency codes in use today (ISO 4217). This is the same list as in
 * shapes.ts (which does not export it). Three capital letters count as a
 * currency marker only when they are one of these, so a product code like
 * "ADH 400" is not read as a price.
 */
const CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD",
  "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK",
  "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY",
  "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF",
  "XPF", "YER", "ZAR", "ZMW", "ZWG",
]);

/**
 * Currency symbols and prefixes that mean exactly one currency. Anything not
 * here gives no currency code. That includes "$" (used by many countries),
 * "¥" (Japan and China) and "C$" (Canada and Nicaragua). The engine never
 * guesses a currency.
 */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  "NZ$": "NZD",
  A$: "AUD",
  AU$: "AUD",
  US$: "USD",
  CA$: "CAD",
  HK$: "HKD",
  NT$: "TWD",
  R$: "BRL",
  "€": "EUR",
  "£": "GBP",
  "₫": "VND",
  "₹": "INR",
  "₪": "ILS",
  "₺": "TRY",
  "₴": "UAH",
  "₦": "NGN",
  "฿": "THB",
};

/**
 * A currency marker at the start of the text: one or two capital letters plus
 * a symbol ("NZ$", "A$"), a currency symbol alone (\p{Sc} means any currency
 * symbol), or three capital letters followed by a space or a digit ("NZD 45").
 * The letters are checked against CURRENCY_CODES afterwards.
 */
const MARKER_AT_START = /^([A-Z]{1,2}\p{Sc}|\p{Sc}|[A-Z]{3}(?=[\s\d]))\s*/u;

/** The same marker at the end of the text. Three letters must follow a digit or a space ("45 NZD"). */
const MARKER_AT_END = /\s*([A-Z]{1,2}\p{Sc}|\p{Sc}|(?<=[\d\s])[A-Z]{3})$/u;

/** True when a marker found by the patterns above is a real marker (letters-only markers must be ISO codes). */
function isCurrencyMarker(marker: string): boolean {
  return /\p{Sc}/u.test(marker) || CURRENCY_CODES.has(marker);
}

// ---------------------------------------------------------------------------
// Splitting a cell
// ---------------------------------------------------------------------------

/**
 * The special spaces that count as a normal space: no-break space (U+00A0),
 * narrow no-break space (U+202F, used in French numbers) and thin space
 * (U+2009). Each one is a single character, so replacing it with " " keeps
 * every offset in the text the same.
 */
const SPECIAL_SPACES = /[   ]/gu;

/** A "/unit" suffix: a slash and a word of letters and dots ("/bag", "/ea", "/l.m."). */
const PER_UNIT = /\s*\/\s*([\p{L}.]+)\s*$/u;

/** A core: digits, maybe with ".", ",", "'" or spaces between them, starting and ending with a digit. */
const CORE = /^\d(?:[\d.,' ]*\d)?$/;

/** Two separators in a row ("1,,000" or "1. 000") are never a valid number. */
const DOUBLE_SEPARATOR = /[.,' ]{2}/;

/**
 * Splits a cell into markers and a number core. `joinSpaces` are the offsets
 * of spaces we inserted between pieces (Cell.joinSpaces).
 *
 * The markers are removed in this order: a "/unit" at
 * the end, a "%" at the end, parentheses around everything (negative), a
 * leading "-" or "−" (negative), a currency marker at either end, and a
 * trailing "CR" (negative, as on a credit note). A sign right after a leading
 * currency marker ("$-12.00") is also accepted. Only one negative mark is
 * allowed: "(-12.00)" has two, so it has no core, because we can't be sure
 * what the writer meant.
 *
 * What is left must be digits with single separators between them.
 * Otherwise `core` is null and the cell is text.
 */
export function analyseNumber(text: string, joinSpaces: readonly number[] = []): NumberParts {
  const parts: NumberParts = {
    raw: text,
    core: null,
    currencyMarker: null,
    percent: false,
    per: null,
    negative: false,
    spaceAtJoin: false,
  };

  // Where the digits start and end in the text as printed. Every marker sits
  // outside this span, so the core (when there is one) is exactly this span.
  const firstDigit = text.search(/\d/);
  let lastDigit = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] >= "0" && text[i] <= "9") {
      lastDigit = i;
      break;
    }
  }
  parts.spaceAtJoin = firstDigit >= 0 && joinSpaces.some((offset) => offset > firstDigit && offset < lastDigit);

  let s = text.replace(SPECIAL_SPACES, " ").trim();
  if (s === "") return parts;

  // Set to false when a second negative mark is found (see above).
  let signsOk = true;
  const markNegative = () => {
    if (parts.negative) signsOk = false;
    parts.negative = true;
  };

  let match = s.match(PER_UNIT);
  if (match && match.index !== undefined) {
    parts.per = match[1];
    s = s.slice(0, match.index).trim();
  }

  match = s.match(/\s*%$/);
  if (match && match.index !== undefined) {
    parts.percent = true;
    s = s.slice(0, match.index).trim();
  }

  if (/^\(.*\)$/.test(s)) {
    markNegative();
    s = s.slice(1, -1).trim();
  }

  if (s.startsWith("-") || s.startsWith("−")) {
    markNegative();
    s = s.slice(1).trim();
  }

  // Take at most one currency marker, from the start or from the end.
  const takeMarker = (pattern: RegExp) => {
    if (parts.currencyMarker !== null) return;
    const found = s.match(pattern);
    if (!found || found.index === undefined || !isCurrencyMarker(found[1])) return;
    parts.currencyMarker = found[1];
    s = (s.slice(0, found.index) + s.slice(found.index + found[0].length)).trim();
  };
  takeMarker(MARKER_AT_START);
  takeMarker(MARKER_AT_END);

  match = s.match(/\s*CR$/);
  if (match && match.index !== undefined) {
    markNegative();
    s = s.slice(0, match.index).trim();
    // "12.00 € CR": the marker sits before the "CR", so look at the end again.
    takeMarker(MARKER_AT_END);
  }

  if (s.startsWith("-") || s.startsWith("−")) {
    markNegative();
    s = s.slice(1).trim();
  }

  if (signsOk && CORE.test(s) && !DOUBLE_SEPARATOR.test(s)) {
    parts.core = text.slice(firstDigit, lastDigit + 1);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

/** Escapes a character for use inside a regular expression. */
function escapeForRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The value of a core under one convention, without a sign. */
interface Parsed {
  value: number;
  dp: number;
  grouped: boolean;
}

/**
 * The value of a core under one convention, or null when the core is not
 * valid under it. Valid means:
 *   - it uses only digits, that decimal mark and that thousands mark
 *   - it has at most one decimal mark, with digits after it
 *   - when it has thousands marks: a lead of 1 to 3 digits that doesn't
 *     start with 0, then groups of exactly 3 digits ("1,195" yes, "1,95" no,
 *     "01,195" no)
 */
function parseUnder(core: string, convention: Convention): Parsed | null {
  const text = core.replace(SPECIAL_SPACES, " ");
  const { decimal, grouping } = convention;
  for (const character of text.replace(/\d/g, "")) {
    if (character !== decimal && character !== grouping) return null;
  }

  const halves = text.split(decimal);
  if (halves.length > 2) return null;
  const [whole, fraction] = halves;
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return null;

  let digits = whole;
  if (grouping !== "" && whole.includes(grouping)) {
    const mark = escapeForRegExp(grouping);
    if (!new RegExp(`^[1-9]\\d{0,2}(?:${mark}\\d{3})+$`).test(whole)) return null;
    digits = whole.split(grouping).join("");
  } else if (!/^\d+$/.test(whole)) {
    return null;
  }

  return {
    value: Number(fraction !== undefined ? `${digits}.${fraction}` : digits),
    dp: fraction?.length ?? 0,
    grouped: digits !== whole,
  };
}

/** The conventions under which a core is valid. `spaceAtJoin` rules out the space conventions. */
export function validConventions(core: string, spaceAtJoin = false): Convention[] {
  return CONVENTIONS.filter(
    (convention) => !(spaceAtJoin && convention.grouping === " ") && parseUnder(core, convention) !== null,
  );
}

/** Applies the sign, and never returns -0 (so a "(0.00)" cell is simply 0). */
function withSign(value: number, negative: boolean): number {
  return negative && value !== 0 ? -value : value;
}

/**
 * Reads a cell under a set of conventions (usually the document's).
 *
 * The value is given only when every convention in the set that reads the
 * core gives the same value. Two different values mean the document doesn't
 * prove which one is right, so the cell is "ambiguous" and must be refused.
 * The sign is applied to every value returned.
 */
export function readNumber(parts: NumberParts, conventions: readonly Convention[]): Reading {
  if (parts.core === null) return { status: "text" };

  // Distinct values in the order of the conventions, so the result is stable.
  const byValue = new Map<number, Parsed>();
  for (const convention of conventions) {
    if (parts.spaceAtJoin && convention.grouping === " ") continue;
    const parsed = parseUnder(parts.core, convention);
    if (parsed !== null && !byValue.has(parsed.value)) byValue.set(parsed.value, parsed);
  }

  const readings = [...byValue.values()];
  if (readings.length === 0) return { status: "unreadable" };
  if (readings.length > 1) {
    // A core has at most one kind of mark that could be a decimal mark, so
    // there are never more than two different values.
    return {
      status: "ambiguous",
      values: [withSign(readings[0].value, parts.negative), withSign(readings[1].value, parts.negative)],
    };
  }
  const [only] = readings;
  return { status: "ok", value: withSign(only.value, parts.negative), dp: only.dp, grouped: only.grouped };
}

/**
 * True when a cell has a core that at least one convention reads. items.ts
 * uses it to explain an "unreadable" cell: with a valid core, the cell is a
 * number written in another format than the rest of its page.
 */
export function hasValidCore(parts: NumberParts): boolean {
  return parts.core !== null && validConventions(parts.core, parts.spaceAtJoin).length > 0;
}

/** True when at least NUMERIC_COLUMN_SHARE of a column's non-empty cells have a number core valid under some convention. */
export function isNumericColumn(cells: readonly NumberParts[]): boolean {
  const nonEmpty = cells.filter((cell) => cell.raw.trim() !== "");
  if (nonEmpty.length === 0) return false;
  const numeric = nonEmpty.filter(hasValidCore).length;
  return numeric / nonEmpty.length >= NUMERIC_COLUMN_SHARE;
}

/**
 * The conventions for one page: the ones allowed by the most number cells of
 * its numeric columns. The engine calls this once per page with that page's
 * table (the caller passes only the numeric columns, see isNumericColumn).
 *
 * When every cell allows the same conventions, as on a normal page, this is
 * simply the conventions they all allow. When a few cells disagree (a "1,5"
 * among "1,250.00" cells), the conventions of the most cells win, and a cell
 * that fits none of them is refused later as written in another format.
 * Counting cells, instead of narrowing the set one cell at a time, gives the
 * same result in any order of cells, and one odd cell can't wipe out the
 * format of the whole page.
 *
 * When two formats tie (as many "1,234.50" cells as "1.234,50" cells), both
 * are kept. That is safe: a cell that both formats read the same way still has
 * one value, and a cell they read differently ("1.200") becomes ambiguous and
 * is refused.
 *
 * A cell with no number core, or with a core that fits no convention, is not
 * counted. With no counted cells at all, every convention is still possible.
 * The result keeps the order of CONVENTIONS and uses the same objects.
 */
export function conventionsFor(numericColumns: readonly (readonly NumberParts[])[]): Convention[] {
  const counts = CONVENTIONS.map(() => 0);
  let counted = 0;
  for (const column of numericColumns) {
    for (const cell of column) {
      if (cell.core === null) continue;
      const valid = validConventions(cell.core, cell.spaceAtJoin);
      if (valid.length === 0) continue;
      counted++;
      CONVENTIONS.forEach((convention, k) => {
        if (valid.includes(convention)) counts[k]++;
      });
    }
  }
  if (counted === 0) return [...CONVENTIONS];
  const most = Math.max(...counts);
  return CONVENTIONS.filter((_, k) => counts[k] === most);
}

/**
 * The conventions that every page allows, for the document's `numberFormat`.
 * Each page is read with its own conventions; this only reports what the
 * pages have in common. Pages that use different formats leave nothing in
 * common, and the document's format is then reported as unknown.
 */
export function sharedConventions(pages: readonly (readonly Convention[])[]): Convention[] {
  return CONVENTIONS.filter((convention) => pages.every((page) => page.includes(convention)));
}

/** The value every convention agrees on, or null when they differ (or there are none). */
function shared<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  return values.every((value) => value === values[0]) ? values[0] : null;
}

/**
 * The document's number format for the contract, from the conventions that
 * every page allows (sharedConventions). `decimal` and `grouping` are set only
 * when every one of those conventions agrees on them (grouping "" is reported
 * as "none"). `settled` is false when some cell had two readings, or when no
 * convention is left because the pages use different formats.
 */
export function numberFormatOf(conventions: readonly Convention[], anyAmbiguous: boolean): NumberFormat {
  if (conventions.length === 0) return { decimal: null, grouping: null, settled: false };
  const grouping = shared(conventions.map((convention) => convention.grouping));
  return {
    decimal: shared(conventions.map((convention) => convention.decimal)),
    grouping: grouping === "" ? "none" : grouping,
    settled: !anyAmbiguous,
  };
}

/**
 * The ISO 4217 code for a currency marker, only when the marker means exactly
 * one currency: "NZD" -> "NZD", "NZ$" -> "NZD", "A$" or "AU$" -> "AUD",
 * "€" -> "EUR", "£" -> "GBP", "₫" -> "VND". A bare "$", "¥" or unknown
 * marker -> null.
 */
export function currencyCode(marker: string | null): string | null {
  if (marker === null) return null;
  const trimmed = marker.trim();
  if (CURRENCY_CODES.has(trimmed)) return trimmed;
  return CURRENCY_SYMBOLS[trimmed] ?? null;
}

/**
 * True when a cell's currency marker is printed after the number ("1 195,20
 * €"), so a number we write in the same style puts it there too.
 */
export function markerIsAfter(parts: NumberParts): boolean {
  if (parts.currencyMarker === null) return false;
  return parts.raw.lastIndexOf(parts.currencyMarker) > parts.raw.search(/\d/);
}

/**
 * The largest number of decimals we write. Money needs 2, and a few unit
 * prices need 3 or 4; 10 is far more than any quote uses, and it keeps the
 * rounding below inside the precision of a JavaScript number.
 */
const MAX_DP = 10;

/**
 * Rounds to `dp` decimals and writes the digits, without a sign.
 *
 * `toFixed` alone rounds 1.005 down to "1.00", because 1.005 is stored as
 * 1.00499999…. Shifting the decimal point with an exponent in text ("1.005e2"
 * is exactly 100.5) avoids that.
 */
function roundedDigits(value: number, dp: number): string {
  const text = String(Math.abs(value));
  // Very small or very large values are already written with an exponent
  // ("1e-7"); the trick below would not work on them, so use toFixed.
  if (text.includes("e")) return Math.abs(value).toFixed(dp);
  const shifted = Math.round(Number(`${text}e${dp}`));
  return Number(`${shifted}e-${dp}`).toFixed(dp);
}

/**
 * Writes a number we calculated, in the document's own style, for a refusal
 * message: the same currency marker in the same place, the document's decimal
 * mark (or "." when unknown), its thousands mark (or none when unknown), and
 * `dp` decimals. Example: formatNumber(1538.2, 2, docConventions, "$") -> "$1,538.20".
 *
 * Spacing: a marker that ends in a letter ("NZD") gets a space before the
 * number, a marker that ends in a symbol ("$", "NZ$") does not. A marker after the number always
 * gets a space before it ("1 538,20 €"). A negative number starts with "-".
 */
export function formatNumber(
  value: number,
  dp: number,
  conventions: readonly Convention[],
  currencyMarker: string | null,
  markerAfter = false,
): string {
  const decimals = Math.min(MAX_DP, Math.max(0, Math.trunc(Number.isFinite(dp) ? dp : 0)));
  const decimal = shared(conventions.map((convention) => convention.decimal)) ?? ".";
  const grouping = shared(conventions.map((convention) => convention.grouping)) ?? "";

  const [whole, fraction] = roundedDigits(value, decimals).split(".");
  const groupedWhole = grouping === "" ? whole : whole.replace(/\B(?=(\d{3})+$)/g, grouping);
  let number = fraction !== undefined ? `${groupedWhole}${decimal}${fraction}` : groupedWhole;

  if (currencyMarker !== null && currencyMarker !== "") {
    if (markerAfter) number = `${number} ${currencyMarker}`;
    else number = /\p{L}$/u.test(currencyMarker) ? `${currencyMarker} ${number}` : `${currencyMarker}${number}`;
  }
  // Only a value that is still below zero after rounding gets a minus sign.
  return value < 0 && Number(roundedDigits(value, decimals)) !== 0 ? `-${number}` : number;
}
