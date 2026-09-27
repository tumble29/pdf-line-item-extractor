/**
 * Cell shapes: does a piece of text look like a number?
 *
 * This file answers one question, using only the characters, never any words:
 *
 *   NUM   a plain number, maybe with a sign, a currency or a percent sign:
 *         "48", "$1,195.20", "1.195,20 €", "1 195,20 €", "-12.00", "(12.00)", "15%"
 *   NUMX  a number followed by a short unit: "25kg", "$68.00 /bag", "480g total"
 *   TEXT  anything else: "Framing timber", "ADH-400", "ADH 400", "Total:"
 *
 * It accepts the common ways of writing numbers with the digits 0 to 9: "," or
 * "." as the decimal mark, and ",", ".", "'", a space, or a no-break space
 * between thousands. Other digit systems (for example Arabic-Indic digits)
 * come out as TEXT. It does NOT decide what the number is (1.195 could be one
 * point one nine five, or one thousand one hundred and ninety-five). That is
 * decided later, per page (numbers.ts).
 *
 * Who uses it:
 *   - classify-page.ts, to count how many numbers on a page are sideways
 *   - the table detector (table.ts), to tell number columns from text columns
 *
 * The rules come from an earlier prototype (kept outside this repository) that
 * found every table in the six sample files. Two changes since then: a currency
 * written as letters plus a symbol ("NZ$", "A$", "AU$") is accepted, and three
 * capital letters count as a currency only if they are a real currency code,
 * so a product code like "ADH 400" stays TEXT.
 */

export type CellShape = "NUM" | "NUMX" | "TEXT";

/**
 * The currency codes in use today (ISO 4217). Three capital letters before or
 * after a number count as a currency only when they are one of these. A code
 * missing from this list makes the cell TEXT, which is the safe direction: the
 * cell is then shown as printed instead of being read as a number.
 */
const CURRENCY_CODES = [
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
];

/**
 * Characters that can separate digit groups or mark decimals: "." "," "'" and
 * a space. `cellShape` turns every kind of space (no-break, narrow no-break,
 * thin) into a normal space before matching, so the French "1 195,20" with a
 * narrow no-break space also matches. The special spaces are listed here too,
 * so the pattern stays correct if it is ever used on its own.
 */
const SEPARATOR = "[.,'\\u00A0\\u202F\\u2009 ]";

/**
 * A currency marker: a symbol like "$" or "€" (\p{Sc} means any currency
 * symbol), one or two capital letters plus a symbol ("NZ$", "A$", "AU$"), or a
 * real three-letter currency code ("NZD", "EUR").
 */
const CURRENCY = `(?:[A-Z]{1,2}\\p{Sc}|\\p{Sc}|(?:${CURRENCY_CODES.join("|")}))`;

/** Digits, maybe split into groups by separators: "48", "1,195.20", "1 195,20". */
const DIGITS = `\\d+(?:${SEPARATOR}\\d+)*`;

/**
 * A whole plain number: optional "(", optional sign, optional currency before,
 * the digits, optional currency or "%" after, optional ")".
 * The sign is only allowed at the very start, so a product code like "ADH-400"
 * is not read as "ADH" followed by "-400".
 */
const NUMBER = new RegExp(`^\\(?[+\\-\\u2212]?(?:${CURRENCY}\\s?)?${DIGITS}(?:\\s?(?:${CURRENCY}|%))?\\)?$`, "u");

/** The start of a number, for spotting "number + short unit" like "25kg". */
const NUMBER_START = new RegExp(`^[+\\-\\u2212]?(?:${CURRENCY}\\s?)?${DIGITS}`, "u");

/**
 * A unit after a number may be at most this long, and at most two words.
 * "25kg" and "$68.00 /bag" pass; "400ml cartridge refill pack" does not, so a
 * description that starts with a number stays TEXT.
 */
const MAX_UNIT_LENGTH = 10;
const MAX_UNIT_WORDS = 2;

/**
 * The shape of one cell's text.
 *
 * Examples:
 *   cellShape("$1,195.20")    -> "NUM"
 *   cellShape("1.195,20 €")   -> "NUM"
 *   cellShape("25kg")         -> "NUMX"
 *   cellShape("$68.00 /bag")  -> "NUMX"
 *   cellShape("ADH-400")      -> "TEXT"
 *   cellShape("10mm GIB Standard board") -> "TEXT"
 */
export function cellShape(text: string): CellShape {
  const cell = text.trim().replace(/\s+/gu, " ");
  if (cell === "") return "TEXT";
  if (NUMBER.test(cell)) return "NUM";

  const start = cell.match(NUMBER_START);
  if (start) {
    const rest = cell.slice(start[0].length).trim();
    if (rest.length > 0 && rest.length <= MAX_UNIT_LENGTH && rest.split(" ").length <= MAX_UNIT_WORDS) {
      return "NUMX";
    }
  }
  return "TEXT";
}

/** True for NUM and NUMX: the text starts with a number and is short enough to be a cell value. */
export function looksLikeNumber(text: string): boolean {
  return cellShape(text) !== "TEXT";
}

/**
 * A separator line such as "-------", "=====" or "- - -": three or more
 * punctuation or symbol characters, maybe with spaces between them, and
 * nothing else. A currency sign doesn't count, so "$$$" is not a separator.
 * Tables often have one under the header; the detector drops it so it doesn't
 * merge with the header row.
 */
export function isSeparatorText(text: string): boolean {
  const cell = text.trim();
  return /^[\p{P}\p{S}\s]{3,}$/u.test(cell) && !/\p{Sc}/u.test(cell);
}
