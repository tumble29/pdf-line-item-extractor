/**
 * Every word the engine knows, in one place.
 *
 * The engine finds tables by layout, and decides what columns mean mainly from
 * the numbers. Words are used only where nothing else can work:
 *
 *   - header words     a SECOND opinion on what a column means (roles.ts)
 *   - page titles      the returns/credit check and the summary warning (page-title.ts)
 *   - totals labels    telling a "Total" line from a line item (items.ts), and
 *                      which kind of total a printed figure is (totals.ts)
 *   - GST words        whether the amounts include GST (totals.ts)
 *   - carried forward  lines that repeat a total from another page (table.ts)
 *   - counts           words that are not counts, months and document-number
 *                      labels, for the contradiction scan (contradictions.ts)
 *
 * This file is data plus the functions that match it, and nothing else. It holds
 * English only. Documents in other languages are still read: tables are found
 * by layout and columns by their numbers, and a page whose headings we don't
 * recognise gets a warning that the word-based checks may not work on it. To
 * support another language, add its words here with its language tag; no other
 * code changes.
 */
import type { Role } from "@/lib/contract/schema";

/** A list of words in one language. `lang` is a language tag like "en" or "fr". */
export interface WordList {
  lang: string;
  words: readonly string[];
}

// ---------------------------------------------------------------------------
// Header words (a second opinion on column roles)
// ---------------------------------------------------------------------------

/**
 * Header words per role. Matching ignores case, a trailing "." or ":", and
 * extra spaces. A phrase beats the words inside it, so "Unit Price" is
 * unitPrice, not unit, and "Line Total" is lineTotal, not itemNo (see
 * headerOpinion).
 *
 * "Each" is a unit price, as in "price each": a column headed "Each" holds
 * "$15.50", not "ea".
 *
 * "item" is special: next to a description-like header it means the line
 * number ("Item | Description | Qty"), and on its own it means the description.
 * `headerOpinion` handles that.
 */
export const HEADER_WORDS: Record<Role, readonly WordList[]> = {
  itemNo: [{ lang: "en", words: ["item", "#", "no", "line"] }],
  code: [{ lang: "en", words: ["code", "sku", "part no", "product code"] }],
  description: [{ lang: "en", words: ["description", "details", "particulars", "product"] }],
  quantity: [{ lang: "en", words: ["qty", "quantity"] }],
  unit: [{ lang: "en", words: ["unit", "uom"] }],
  unitPrice: [{ lang: "en", words: ["unit price", "unit cost", "price", "rate", "each"] }],
  lineTotal: [{ lang: "en", words: ["line total", "amount", "total", "ext", "extended"] }],
};

// ---------------------------------------------------------------------------
// Page titles
// ---------------------------------------------------------------------------

/** Words in a page title that mean its amounts may be money going back. */
export const CREDIT_WORDS: readonly WordList[] = [
  { lang: "en", words: ["returns", "return", "credit", "refund", "adjustment"] },
];

/** Words in a page title that mean its lines may repeat lines from other pages. */
export const SUMMARY_WORDS: readonly WordList[] = [{ lang: "en", words: ["summary", "acceptance"] }];

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** The kinds of printed total (the same four as StatedTotal.label in the contract). */
export type TotalKind = "subtotal" | "gst" | "total" | "amount_due";

/**
 * Labels of printed totals, per kind:
 *
 *   subtotal    the lines added up, before GST
 *   gst         the tax line
 *   total       what the whole document comes to
 *   amount_due  what is still to pay; shown, never checked against the lines
 *
 * They are used in two ways. To spot a "Total" line inside a table, the line
 * only has to START with one of them ("Total 25 $413.50", see
 * startsWithTotalsLabel). To give a printed figure its kind, the WHOLE label
 * must be one of them, maybe with a GST basis phrase after it (see
 * totalsLabelKind): "Total ex GST" is a subtotal, but "Total Qty" or "GST
 * No." is not a money total at all.
 */
export const TOTAL_LABELS: Record<TotalKind, readonly WordList[]> = {
  subtotal: [{ lang: "en", words: ["subtotal", "sub total", "sub-total", "net total", "total ex gst", "total excl gst", "total excluding gst"] }],
  gst: [{ lang: "en", words: ["gst", "total gst", "gst total", "gst amount"] }],
  total: [
    { lang: "en", words: ["total", "total inc gst", "total incl gst", "total including gst", "grand total", "invoice total"] },
  ],
  amount_due: [{ lang: "en", words: ["amount due", "amount payable", "balance", "balance due"] }],
};

/**
 * Words that say whether amounts include GST. A basis word and "gst" must both
 * be in the text, in either order ("Total incl GST", "GST inclusive"). The
 * tax word is its own list, so another tax name can be added later.
 */
export const GST_BASIS_WORDS = {
  inclusive: [{ lang: "en", words: ["inc", "incl", "including", "inclusive"] }],
  exclusive: [{ lang: "en", words: ["ex", "excl", "excluding", "exclusive"] }],
  tax: [{ lang: "en", words: ["gst"] }],
} as const satisfies Record<string, readonly WordList[]>;

/** The word "total", for spotting a column that mixes per-item figures and totals ("480g total"). */
export const TOTAL_WORD: readonly WordList[] = [{ lang: "en", words: ["total"] }];

// ---------------------------------------------------------------------------
// Carried forward
// ---------------------------------------------------------------------------

/** Lines that repeat a total from another page. Counting them as items would double-count money. */
export const CARRIED_FORWARD: readonly WordList[] = [
  { lang: "en", words: ["carried forward", "brought forward", "b/f", "c/f"] },
];

// ---------------------------------------------------------------------------
// The contradiction scan
// ---------------------------------------------------------------------------

/**
 * Words after a number that show it is not a count of goods, so two different
 * numbers before them are not a contradiction:
 *   - small words: "Site 1 of 4", "Page 1 of 8", "5 to 10", "3 x 4"
 *   - time: "valid for 30 days", "terms 7 days", "7 am", "2 years"
 *   - rates: "15 percent"
 *   - units of measure: "1200 mm x 2400 mm", "max load 1000 kg"
 * (Month names are their own list, below.) Words are compared in their
 * singular form, so "day" covers "days".
 */
export const NOT_COUNT_WORDS: readonly WordList[] = [
  { lang: "en", words: ["of", "to", "and", "or", "at", "in", "on", "the", "a", "an", "x", "by", "for", "from", "per", "with"] },
  { lang: "en", words: ["second", "minute", "min", "hour", "hr", "day", "week", "month", "year", "am", "pm", "working", "business"] },
  { lang: "en", words: ["percent", "pct"] },
  { lang: "en", words: ["mm", "cm", "m", "km", "kg", "g", "t", "l", "ml", "lm", "m2", "m3", "sqm", "mtr", "tonne", "litre", "metre"] },
];

/** Month names and their short forms, so a date ("24 August 2026") is never read as a count of "August". */
export const MONTHS: readonly WordList[] = [
  {
    lang: "en",
    words: [
      "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
      "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    ],
  },
];

/** Labels of document numbers. A line that starts with one ("Invoice No: 1234") holds no counts. */
export const DOCUMENT_NUMBER_LABELS: readonly WordList[] = [
  { lang: "en", words: ["document no", "doc no", "invoice no", "order no", "docket no", "po", "ref", "reference"] },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Normalises text for matching: Unicode NFC, lower case, no trailing "." or
 * ":", and single spaces.
 */
export function normaliseForMatching(text: string): string {
  // Spaces are tidied first, so a trailing "." or ":" is found even when a
  // space follows it ("Item: " becomes "item").
  return text
    .normalize("NFC")
    .toLocaleLowerCase("en")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.:]+$/u, "")
    .trim();
}

/** A regular expression special character, escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the longest word or phrase from `lists` that appears in `text` as a
 * whole word (not inside another word: "credit" matches "Credit Note" but not
 * "creditor"). An English word may also match with a trailing "s"
 * ("return" matches "Returns"). Returns the matched word as written in the
 * list, or null.
 */
export function findWord(text: string, lists: readonly WordList[]): string | null {
  const haystack = normaliseForMatching(text);
  const candidates = lists
    .flatMap((list) => list.words.map((word) => ({ word, lang: list.lang })))
    .sort((a, b) => b.word.length - a.word.length);
  for (const { word, lang } of candidates) {
    const needle = escapeRegExp(normaliseForMatching(word));
    const plural = lang === "en" ? "s?" : "";
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle}${plural}(?![\\p{L}\\p{N}])`, "u");
    if (pattern.test(haystack)) return word;
  }
  return null;
}

/** True when `word` appears in `text` as a whole word (English plurals allowed). */
function containsWholeWord(text: string, word: string, lang: string): boolean {
  const needle = escapeRegExp(normaliseForMatching(word));
  const plural = lang === "en" ? "s?" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${needle}${plural}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * What the header words say about one column.
 *
 *   { role }             the header matches words of exactly one role
 *   { role: null, tie }  no match (tie false), or words of two roles match and
 *                        neither is part of the other, like "Qty Unit" (tie true)
 *
 * A phrase beats the shorter words inside it: "Unit Price" matches "unit
 * price", "unit" and "price", but "unit" and "price" are part of "unit price",
 * so only unitPrice counts. The same makes "Line Total" lineTotal (not itemNo
 * from "line") and "Product Code" code (not description from "product").
 *
 * `besideDescription` is true when another header in the same row is
 * description-like; then "Item" means the line number, and on its own it
 * means the description.
 */
export function headerOpinion(header: string, besideDescription: boolean): { role: Role } | { role: null; tie: boolean } {
  const text = normaliseForMatching(header);

  // Every word of every role that appears in the header.
  const matches: { role: Role; word: string; lang: string }[] = [];
  for (const [role, lists] of Object.entries(HEADER_WORDS) as [Role, readonly WordList[]][]) {
    for (const list of lists) {
      for (const word of list.words) {
        if (containsWholeWord(text, word, list.lang)) matches.push({ role, word: normaliseForMatching(word), lang: list.lang });
      }
    }
  }

  // Drop a match that is part of a longer match ("unit" inside "unit price").
  const kept = matches.filter(
    (match) => !matches.some((other) => other.word !== match.word && containsWholeWord(other.word, match.word, match.lang)),
  );
  const roles = [...new Set(kept.map((match) => match.role))];
  if (roles.length === 0) return { role: null, tie: false };
  if (roles.length > 1) return { role: null, tie: true };

  const role = roles[0];
  // "Item" or "Items" on its own names the thing, so it is the description.
  if (role === "itemNo" && /^items?$/u.test(text) && !besideDescription) return { role: "description" };
  return { role };
}

/** True when a header row has a description-like header ("Description", "Details", ...). */
export function hasDescriptionHeader(headers: readonly (string | null)[]): boolean {
  // Uses the full header rule, not a plain word search, so "Product Code"
  // (a code, not a description) doesn't count. `besideDescription` is true
  // here so that "Item" itself is never counted as the description.
  return headers.some((header) => header !== null && headerOpinion(header, true).role === "description");
}

/**
 * The longest word or phrase from `lists` that `text` STARTS with, as a whole
 * word, or null. After the phrase, the next character must not be a letter,
 * a digit or a hyphen: "Total:" starts with "total", but "Totally" does not,
 * and neither does "GST-free delivery" (a hyphen joins the words into one).
 * An English word may also have a plural "s" ("Totals").
 */
export function startsWithWord(text: string, lists: readonly WordList[]): string | null {
  const normal = normaliseForMatching(text);
  let best: string | null = null;
  for (const list of lists) {
    for (const word of list.words) {
      const label = normaliseForMatching(word);
      if (!normal.startsWith(label)) continue;
      const rest = normal.slice(label.length);
      const after = list.lang === "en" && rest.startsWith("s") ? rest.slice(1) : rest;
      if (/^[\p{L}\p{N}-]/u.test(after)) continue;
      if (best === null || label.length > best.length) best = label;
    }
  }
  return best;
}

/**
 * True when `text` starts with a totals label ("Total", "Subtotal:", "GST
 * 15%", "Total 25 items"), whatever follows it. items.ts uses it to find
 * "Total" lines inside a table, roles.ts to keep their numbers out of the
 * column facts, and totals.ts to notice a totals line whose amount it can't
 * read. A label later in the line ("Freight total") does not count, because
 * a line item's description can contain such words.
 */
export function startsWithTotalsLabel(text: string): boolean {
  return (Object.values(TOTAL_LABELS) as (readonly WordList[])[]).some((lists) => startsWithWord(text, lists) !== null);
}

/** True when any word from `lists` appears in `text` as a whole word (English plurals allowed, as in findWord). */
function hasWholeWord(text: string, lists: readonly WordList[]): boolean {
  return findWord(text, lists) !== null;
}

/**
 * A label made ready for the exact-label rule: lower case, a percentage
 * removed ("GST 15%" -> "gst"), every mark that is not a letter, a digit, "#"
 * or a space turned into a space ("Total (excl. GST):" -> "total excl gst"),
 * a hyphen between two letters turned into a space ("Sub-total" -> "sub
 * total"), and single spaces. "#" is kept, so "GST #" is not "GST".
 */
function tidyLabel(text: string): string {
  return normaliseForMatching(text)
    .replace(/\d+(?:[.,]\d+)?\s?%/gu, " ")
    .replace(/(?<=\p{L})-(?=\p{L})/gu, " ")
    .replace(/[^\p{L}\p{N}#\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * What a phrase after a totals label says about GST: "inclusive" for "incl
 * GST", "including GST", "GST inclusive" or "inclusive of GST"; "exclusive"
 * for the same with "ex", "excl", "excluding" or "exclusive"; null for any
 * other words.
 */
function basisPhrase(rest: string): "inclusive" | "exclusive" | null {
  const words = rest.split(" ");
  // The lists hold fixed words; as plain string lists they can be searched for any word.
  const wordsOf = (lists: readonly WordList[]): readonly string[] => lists.flatMap((list) => list.words);
  const tax = wordsOf(GST_BASIS_WORDS.tax);
  const basisOf = (word: string | undefined): "inclusive" | "exclusive" | null => {
    if (word === undefined) return null;
    if (wordsOf(GST_BASIS_WORDS.inclusive).includes(word)) return "inclusive";
    if (wordsOf(GST_BASIS_WORDS.exclusive).includes(word)) return "exclusive";
    return null;
  };
  // "<basis> gst", "<basis> of gst", "gst <basis>".
  if (words.length === 2 && tax.includes(words[1])) return basisOf(words[0]);
  if (words.length === 3 && words[1] === "of" && tax.includes(words[2])) return basisOf(words[0]);
  if (words.length === 2 && tax.includes(words[0])) return basisOf(words[1]);
  return null;
}

/**
 * The kind of total a printed figure's label names, or null when the label is
 * not exactly a totals label. The whole label must be a label from
 * TOTAL_LABELS (an English plural "s" is fine, "Totals"), maybe followed by a
 * GST basis phrase:
 *
 *   "Total:", "TOTAL", "Grand total"          total
 *   "Total incl. GST", "Total (GST inclusive)" total
 *   "Total ex GST", "Total (excl. GST)"        subtotal: the lines before GST
 *   "Subtotal", "Sub-total:"                   subtotal
 *   "GST 15%", "Total GST"                     gst
 *   "Balance due"                              amount_due
 *   "Total Qty", "Total pallets", "GST No."    null: not a money total
 *
 * A figure with no kind is not ignored: totals.ts may still use it, but only
 * when it equals the sum of the lines.
 */
export function totalsLabelKind(text: string): TotalKind | null {
  const label = tidyLabel(text);
  for (const [kind, lists] of Object.entries(TOTAL_LABELS) as [TotalKind, readonly WordList[]][]) {
    for (const list of lists) {
      for (const word of list.words) {
        const phrase = tidyLabel(word);
        if (label === phrase || (list.lang === "en" && label === `${phrase}s`)) return kind;
      }
    }
  }
  // A label, then a GST basis phrase: "Total incl GST", "Subtotal ex GST".
  for (const [kind, lists] of Object.entries(TOTAL_LABELS) as [TotalKind, readonly WordList[]][]) {
    for (const list of lists) {
      for (const word of list.words) {
        const phrase = tidyLabel(word);
        if (!label.startsWith(`${phrase} `)) continue;
        const basis = basisPhrase(label.slice(phrase.length + 1));
        if (basis === null) continue;
        // A total that says it is before GST is the subtotal.
        return kind === "total" && basis === "exclusive" ? "subtotal" : kind;
      }
    }
  }
  return null;
}

/**
 * What a heading or a totals label says about GST: "inclusive" for "Total
 * incl GST" or "Amount (GST inclusive)", "exclusive" for "Total ex GST", or
 * null when it doesn't say. Both a basis word and the tax word must be there.
 */
export function gstBasisOf(text: string): "inclusive" | "exclusive" | null {
  if (!hasWholeWord(text, GST_BASIS_WORDS.tax)) return null;
  if (hasWholeWord(text, GST_BASIS_WORDS.inclusive)) return "inclusive";
  if (hasWholeWord(text, GST_BASIS_WORDS.exclusive)) return "exclusive";
  return null;
}
