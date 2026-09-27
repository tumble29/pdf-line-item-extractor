/**
 * Finding figures that contradict each other in the text around the table.
 *
 * Where it sits: after every page is read. It looks at the text OUTSIDE the
 * tables (the lines above the header and below the last row), because a
 * document often says the same count twice: "Summary: 14 pallets loaded at
 * depot" at the top and "Driver notes: 16 pallets unloaded at site" at the
 * bottom. When the two numbers differ, we can't tell which one is right, so
 * the document gets one CONFLICTING_FIGURES refusal that quotes both lines. We
 * never pick one. Numbers inside the table are checked by the arithmetic and
 * totals rules instead, so they are not scanned here, and neither are the
 * rows of another table on the page (that is table text too).
 *
 * How it works:
 *   1. Find every "<number> <word>" pair inside one cell: a number that is a
 *      whole token (not glued to letters, a dash, a slash, a colon or a
 *      currency sign), a space, then a word ("14 pallets"). "KBS-10234",
 *      "400ml", "$5,122.40", "7:15 am" and "Site 14," are not pairs. Two
 *      cells of one row are never joined into a pair: "Order: 5521" and
 *      "Date: 3 May" side by side are not "5521 Date".
 *   2. Put the word in a simple singular form, so "pallets" and "pallet" are
 *      the same word.
 *   3. Leave out what is not a count of goods: small words ("Site 1 of 4"),
 *      time, rates and units ("30 days", "15 percent", "1200 mm"), months
 *      ("24 August 2026"), a postcode before a place name ("Hamilton 3204 New
 *      Zealand"), and any line that starts with a document-number label
 *      ("Docket No: 4471 Site B", where "4471 Site" is not a count of sites).
 *   4. The same word with two or more different values is a conflict, when
 *      the values come from more than one line. The same value written two
 *      ways ("1,000" and "1000") is not. Two values on one line are a size or
 *      a range ("1200 x 2400"), not a contradiction.
 *
 * The word lists are English (vocabulary.ts). The scan can still see a
 * conflict that isn't one, even in English: two numbers of the same word may
 * count different things ("3 sheets damaged, 45 sheets delivered"). In another
 * language it may miss a conflict, or see one in two dates with a French month
 * name. A false one is a visible refusal that quotes both lines, so the person
 * can judge. It also misses counts written differently ("Pallets: 14", "14
 * full pallets", "fourteen pallets").
 */
import type { Evidence, Refusal } from "@/lib/contract/schema";

import { findingRefusal } from "./refusals";
import type { Row } from "./rows";
import { DOCUMENT_NUMBER_LABELS, MONTHS, NOT_COUNT_WORDS, startsWithWord, type WordList } from "./vocabulary";

/** The text around the tables on one page. */
export interface OutsideText {
  page: number;
  /** The rows above the header and below the table, top to bottom. */
  rows: readonly Row[];
}

/**
 * A number that is a whole token, then spaces, then a word. `(?<!\S)` means
 * the number starts the text or follows a space, so nothing is glued to its
 * front ("KBS-10234", "7:15", "$5"). The number may have thousands marks or
 * one decimal part ("1,200", "2.5"). The word is letters with their accent
 * marks (\p{L}\p{M}), so a word in Hindi or Thai is not cut in half.
 */
const PAIR = /(?<!\S)(\d+(?:[.,]\d+)*)\s+([\p{L}\p{M}]+)/gu;

/** At most this many different values are quoted in one refusal, and this many lines in its evidence. */
const MAX_QUOTED = 5;

/** One "<number> <word>" found in the text. */
interface Mention {
  /** The number as printed ("1,200"). */
  number: string;
  /** Its value, the same for "1,200" and "1200". */
  value: string;
  /** The pair as printed ("14 pallets"), for the message. */
  text: string;
  page: number;
  row: Row;
}

/**
 * A simple English singular: "pallets" -> "pallet", "boxes" -> "box",
 * "batches" -> "batch", "deliveries" -> "delivery". A word ending in "ss"
 * ("glass") keeps its "s". Lower case, so "Pallets" and "pallets" match.
 */
export function singular(word: string): string {
  const lower = word.toLocaleLowerCase("en");
  if (lower.length > 3 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|sses)$/u.test(lower)) return lower.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

/** True when `word`, in lower case or in its singular form, is one of the words in `lists`. */
function isListed(word: string, lists: readonly WordList[]): boolean {
  const lower = word.toLocaleLowerCase("en");
  const one = singular(word);
  return lists.some((list) => list.words.includes(lower) || list.words.includes(one));
}

/**
 * The value of a count as printed, so the same count written two ways
 * matches: thousands marks are removed ("1,200" and "1200" are both "1200"),
 * and a decimal part loses its trailing zeros ("2.50" and "2.5"). A number
 * whose one "," or "." has exactly three digits after it ("1,200") is read as
 * a thousands mark, because counts of goods are whole numbers far more often
 * than they have three decimals.
 */
function valueOf(number: string): string {
  const marks = number.match(/[.,]/g) ?? [];
  if (marks.length === 0) return String(Number(number));
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(number)) return String(Number(number.replace(/[.,]/g, "")));
  if (marks.length === 1) return String(Number(number.replace(",", ".")));
  return number;
}

/**
 * True for a postcode or a street number before a place name: four or more
 * digits with no marks, then a word with a capital letter ("3204 New
 * Zealand", "2000 Australia"). Counts of goods are rarely written that way.
 */
function isPostcode(number: string, word: string): boolean {
  return /^\d{4,}$/.test(number) && /^\p{Lu}/u.test(word);
}

/**
 * Finds the counts that contradict each other in the text around the tables.
 * Returns one document-level CONFLICTING_FIGURES refusal per word, in the
 * order the word first appears. Each refusal quotes one mention of each
 * different value (at most MAX_QUOTED), and its evidence quotes the lines
 * involved (at most MAX_QUOTED), with their pages.
 *
 * It takes time in proportion to the number of pairs, so a long page of text
 * can't slow it down much.
 */
export function findConflictingFigures(pages: readonly OutsideText[]): Refusal[] {
  // Every mention of every word, in document order.
  const byWord = new Map<string, Mention[]>();
  for (const { page, rows } of pages) {
    for (const row of rows) {
      if (startsWithWord(row.text, DOCUMENT_NUMBER_LABELS) !== null) continue;
      for (const cell of row.cells) {
        for (const match of cell.text.normalize("NFC").matchAll(PAIR)) {
          const [text, number, word] = match;
          if (isListed(word, NOT_COUNT_WORDS) || isListed(word, MONTHS) || isPostcode(number, word)) continue;
          const key = singular(word);
          let mentions = byWord.get(key);
          if (!mentions) byWord.set(key, (mentions = []));
          mentions.push({ number, value: valueOf(number), text, page, row });
        }
      }
    }
  }

  const refusals: Refusal[] = [];
  for (const [word, mentions] of byWord) {
    // One mention of each different value, the first time it appears.
    const values = new Set<string>();
    const different: Mention[] = [];
    for (const mention of mentions) {
      if (values.has(mention.value)) continue;
      values.add(mention.value);
      different.push(mention);
    }
    if (different.length < 2) continue;
    // Two values on one line are a size or a range, not a contradiction.
    if (new Set(mentions.map((mention) => mention.row)).size < 2) continue;

    const quoted = different.slice(0, MAX_QUOTED);
    const [first, second, ...rest] = quoted.map((mention) => ({ text: mention.text, page: mention.page }));
    // The lines involved, once each and in document order: first the lines
    // of the values quoted in the message, then other lines, up to MAX_QUOTED.
    const rows: Mention[] = [];
    for (const mention of [...quoted, ...mentions]) {
      if (rows.length < MAX_QUOTED && !rows.some((chosen) => chosen.row === mention.row)) rows.push(mention);
    }
    rows.sort((a, b) => mentions.indexOf(a) - mentions.indexOf(b));
    const evidence: Evidence[] = rows.map((mention) => ({ page: mention.page, sourceText: mention.row.text }));
    refusals.push(findingRefusal({ code: "CONFLICTING_FIGURES", mentions: [first, second, ...rest] }, evidence, word));
  }
  return refusals;
}
