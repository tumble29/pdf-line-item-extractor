/**
 * Every word the engine knows, in one place.
 *
 * The engine finds tables by layout, and decides what columns mean mainly from
 * the numbers. Words are used only where nothing else can work:
 *
 *   - header words     a SECOND opinion on what a column means (roles.ts)
 *   - page titles      the returns/credit check and the summary warning (page-title.ts)
 *   - totals labels    telling a "Total" line from a line item (items.ts)
 *   - carried forward  lines that repeat a total from another page (table.ts)
 *
 * This file is data plus the functions that match it (normaliseForMatching,
 * findWord, headerOpinion, hasDescriptionHeader and startsWithTotalsLabel),
 * and nothing else. It holds
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

/**
 * Labels of printed totals, per kind. items.ts uses them all together, to
 * tell a "Total" line from a line item. The kinds will matter when the printed
 * totals are read.
 */
export const TOTAL_LABELS: Record<"subtotal" | "gst" | "total" | "amount_due", readonly WordList[]> = {
  subtotal: [{ lang: "en", words: ["subtotal", "sub total", "sub-total", "total ex gst", "total excl gst"] }],
  gst: [{ lang: "en", words: ["gst"] }],
  total: [{ lang: "en", words: ["total", "total inc gst", "total incl gst", "grand total"] }],
  amount_due: [{ lang: "en", words: ["amount due", "balance", "balance due"] }],
};

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

/** Every totals label (subtotal, GST, total, amount due) in one list. */
const ALL_TOTAL_LABELS: readonly WordList[] = Object.values(TOTAL_LABELS).flat();

/**
 * True when `text` STARTS with a totals label (TOTAL_LABELS), as a whole word
 * ("Total", "Subtotal:", "GST 15%"). "Totally" does not count, and a label
 * later in the text ("Freight total") does not count either, because a line
 * item's description can contain such words. A label joined to a word by a
 * hyphen ("GST-free delivery") is part of that word, so it does not count.
 *
 * An English label may also have a plural "s" ("Totals"), as in findWord.
 * items.ts uses it to find "Total" lines inside a table, and roles.ts to keep
 * their numbers out of the column facts.
 */
export function startsWithTotalsLabel(text: string): boolean {
  const normal = normaliseForMatching(text);
  return ALL_TOTAL_LABELS.some((list) =>
    list.words.some((word) => {
      const label = normaliseForMatching(word);
      if (!normal.startsWith(label)) return false;
      const rest = normal.slice(label.length);
      const after = list.lang === "en" && rest.startsWith("s") ? rest.slice(1) : rest;
      // The label must end at a word boundary: the next character is not a
      // letter, a digit or a hyphen.
      return !/^[\p{L}\p{N}-]/u.test(after);
    }),
  );
}
