/**
 * Deciding what each column means.
 *
 * Where it sits: table.ts has found the table and its columns by layout, and
 * numbers.ts has found the page's number conventions. This file gives each
 * column a role (quantity, unit price, line total, description, ...) or no
 * role. items.ts then reads the cells of the role columns.
 *
 * Two opinions are asked for every column, and then compared:
 *
 *   1. The numbers (`inferFromNumbers`). This never reads a word, so it works
 *      in any language. Strongest clue first:
 *        - the product check: quantity x unit price = line total on most rows
 *        - which factor is the price: a currency marker it shares with the
 *          line total, or thousands grouping like the line total's
 *        - a money column with "/unit" on its cells is a unit price
 *        - a column counting 1, 2, 3 ... is the item number
 *        - text columns by their shapes: the one column of long phrases is the
 *          description, short words are units, unique letter-and-digit tokens
 *          are codes
 *   2. The header words (vocabulary.ts). English only. A second opinion.
 *
 * The agreement (see `decideRoles`) turns the two opinions into one role, or
 * into a page refusal when they disagree about a number column. Column
 * POSITION is never used: a table with its columns in another order gets the
 * same roles.
 *
 * The rule behind every choice here: when the numbers can't tell for sure,
 * they give no opinion. A wrong role is the worst possible outcome, because
 * it produces a confident wrong number, while a missing role only means a
 * column is shown as printed.
 *
 * How to read it: `decideRoles` at the bottom is the whole step. Above it, in
 * order: the facts about one column (`describeColumn`), the product check
 * (`findTriple`, `looksMoreLikeTheTotal`, `orientFactors`), the rest of the
 * numbers opinion (`inferFromNumbers`), and the agreement between the two
 * opinions.
 */
import { ROLE_WORDS } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import type { Column, Evidence, Note, Refusal, Role, RoleSource } from "@/lib/contract/schema";

import type { Convention, NumberParts, Reading } from "./numbers";
import { analyseNumber, isNumericColumn, readNumber } from "./numbers";
import { pageRefusal } from "./refusals";
import type { Table } from "./table";
import { hasDescriptionHeader, headerOpinion, startsWithTotalsLabel } from "./vocabulary";

/** A product triple (quantity x price = total) needs at least this many rows where neither factor is 1. */
export const MIN_DISCRIMINATING_ROWS = 2;

/** What the engine decided about a table's columns. */
export interface RoleDecision {
  /**
   * One contract Column per table column, in the same order: the header as
   * printed, the key, the role (or null), where the role came from
   * (roleSource), and the kind.
   */
  columns: Column[];
  /**
   * A page refusal when the columns can't be used safely:
   *   - AMBIGUOUS_COLUMNS: the product check makes a column a quantity, unit
   *     price or line total and its heading says something else, or two
   *     columns have the same one of those roles. The page's lines are NOT listed, and no column keeps
   *     a quantity, unit price or line total role.
   *   - COLUMN_MEANING_UNKNOWN: no column is a quantity, unit price or line
   *     total. The rows ARE still listed, as printed, with no numbers read.
   * Otherwise null.
   */
  refusal: Refusal | null;
  /**
   * Notes about the columns: a role from the heading only, a heading followed
   * for a text column, a heading with two meanings, each headed column we
   * don't read, and the unknown-headings or no-headings warning (see
   * contract/notes.ts). On an AMBIGUOUS_COLUMNS page the notes about single
   * columns are left out, because no line is listed and the refusal explains
   * the columns.
   */
  notes: Note[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A column is a percent column when at least this share of its non-empty
 * cells end in "%". Half, because a discount column is often empty on most
 * rows, and its few filled cells all say "%".
 * A percent column never gets a role from the numbers.
 */
const PERCENT_COLUMN_SHARE = 0.5;

/**
 * A column "has a currency marker" or "has /unit prices" when at least this
 * share of its non-empty cells do. Half: most cells must agree, but one cell
 * printed without "$" does not change the column.
 */
const MARKED_COLUMN_SHARE = 0.5;

/**
 * The description's cells must be at least this many characters long on
 * average. Why 8: units ("ea", "sheet") and codes ("ADH-400") are shorter,
 * and a real description ("Pine batten 45x19") is longer.
 */
const DESCRIPTION_MIN_LENGTH = 8;

/**
 * The description must also be at least this many times longer on average
 * than the next longest text column. Why 1.5: if two text columns are about
 * the same length, we can't tell which one is the description, so neither is.
 */
const DESCRIPTION_LENGTH_RATIO = 1.5;

/**
 * A unit cell is a single word of letters (and dots, as in "l.m."), at most
 * this many characters. Why 10: the longest common units ("bundle",
 * "length", "rouleau") fit, while a short description usually has spaces.
 */
const UNIT_MAX_LENGTH = 10;

/** A code is one token of 2 to this many characters. Why 20: product codes and SKUs are short. */
const CODE_MAX_LENGTH = 20;

/**
 * The number roles: the only columns whose cells are read as numbers. The
 * other four roles (itemNo, code, description, unit) are text roles, and no
 * number depends on them.
 */
const NUMBER_ROLES: readonly Role[] = ["quantity", "unitPrice", "lineTotal"];

// ---------------------------------------------------------------------------
// The facts about one column
// ---------------------------------------------------------------------------

/** What the numbers opinion needs to know about one column. */
interface ColumnFacts {
  /** Each body row's cell split into markers and a core ("" for an empty cell). */
  parts: NumberParts[];
  /** Each body row's cell read under the page's conventions. */
  readings: Reading[];
  /** How many cells are not empty. */
  filled: number;
  /** The non-empty cells, trimmed. */
  texts: string[];
  /** True when the column counts as numeric (numbers.ts, NUMERIC_COLUMN_SHARE). */
  numeric: boolean;
  /** Share of non-empty cells with "%" at the end. */
  percentShare: number;
  /** Share of non-empty cells with a currency marker. */
  currencyShare: number;
  /** The currency marker most cells use ("$", "€", "KGS"), or null when no cell has one. */
  marker: string | null;
  /** Share of non-empty cells with a "/unit" suffix. */
  perShare: number;
  /** The number of decimals most read values have, or null when nothing was read. */
  usualDecimals: number | null;
  /** The average length of the non-empty cells. */
  meanLength: number;
  /** Share of non-empty cells with a space in them (more than one word). */
  spaceShare: number;
}

/** A reading that gave a value. */
type Read = Extract<Reading, { status: "ok" }>;

/** True for a reading that gave a value. */
function isRead(reading: Reading): reading is Read {
  return reading.status === "ok";
}

/** The share of `items` for which `test` is true, or 0 when there are none. */
function shareOf<T>(items: readonly T[], test: (item: T) => boolean): number {
  return items.length === 0 ? 0 : items.filter(test).length / items.length;
}

/** The value that appears most often (the first one on a tie), or null for an empty list. */
function mostCommon<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Collects the facts about column `position` of the table. */
function describeColumn(table: Table, position: number, conventions: readonly Convention[]): ColumnFacts {
  const parts = table.body.map((bodyRow) => {
    const cell = bodyRow.cells[position];
    return cell ? analyseNumber(cell.text, cell.joinSpaces) : analyseNumber("");
  });
  const readings = parts.map((cell) => readNumber(cell, conventions));
  const nonEmpty = parts.filter((cell) => cell.raw.trim() !== "");
  const texts = nonEmpty.map((cell) => cell.raw.trim());
  const read = readings.filter(isRead);
  return {
    parts,
    readings,
    filled: nonEmpty.length,
    texts,
    numeric: isNumericColumn(parts),
    percentShare: shareOf(nonEmpty, (cell) => cell.percent),
    currencyShare: shareOf(nonEmpty, (cell) => cell.currencyMarker !== null),
    marker: mostCommon(nonEmpty.flatMap((cell) => (cell.currencyMarker !== null ? [cell.currencyMarker] : []))),
    perShare: shareOf(nonEmpty, (cell) => cell.per !== null),
    usualDecimals: mostCommon(read.map((reading) => reading.dp)),
    meanLength: texts.length === 0 ? 0 : texts.reduce((sum, text) => sum + text.length, 0) / texts.length,
    spaceShare: shareOf(texts, (text) => /\s/u.test(text)),
  };
}

/** A numeric column that is not a percent column. Only these take part in the product check. */
function isNumberColumn(facts: ColumnFacts): boolean {
  return facts.numeric && facts.percentShare < PERCENT_COLUMN_SHARE;
}

/** True when a column has a currency marker on most of its cells. */
function isMarked(facts: ColumnFacts): boolean {
  return facts.currencyShare >= MARKED_COLUMN_SHARE;
}

/** True when a column's non-empty cells count 1, 2, 3 ... (or n, n+1, ... with n at least 1), with no currency. */
function isSequence(facts: ColumnFacts): boolean {
  if (facts.filled < 2 || facts.currencyShare > 0) return false;
  const values: number[] = [];
  for (let row = 0; row < facts.parts.length; row++) {
    if (facts.parts[row].raw.trim() === "") continue;
    const reading = facts.readings[row];
    if (!isRead(reading) || reading.dp !== 0 || !Number.isInteger(reading.value)) return false;
    values.push(reading.value);
  }
  return values.every((value, k) => (k === 0 ? value >= 1 : value === values[k - 1] + 1));
}

// ---------------------------------------------------------------------------
// The product check: quantity x unit price = line total
// ---------------------------------------------------------------------------

/**
 * How far a x b may be from c: one unit of c's last printed digit (0.01 for
 * "$48.00", 1 for "7.400.000"), plus a tiny margin for floating point.
 * A price printed rounded to the cent makes the product differ by less than
 * that on normal quantities.
 */
function toleranceFor(dp: number): number {
  return Math.pow(10, -dp) + 1e-9;
}

/** A triple a x b = c that passed the rules, with how many rows support it. */
interface Triple {
  /** The two factor columns (positions), in no particular meaning. */
  a: number;
  b: number;
  /** The product column (the line total). */
  c: number;
  /** Rows where a x b = c. */
  support: number;
  /** Supporting rows where neither factor is 1. */
  discriminating: number;
}

/** The result of the product check. */
type TripleResult =
  /** No triple passed the rules. */
  | { kind: "none" }
  /** Exactly one triple passed the rules. */
  | { kind: "found"; triple: Triple }
  /** Two or more triples passed, so we can't tell which one is quantity x price = total. */
  | { kind: "rival" };

/**
 * Tests every pair of number columns {a, b} against every other number
 * column c: on how many rows is a x b = c?
 *
 * A row is checkable when all three cells were read and none of the values
 * is 0. A row with a 0 proves nothing either way (0 x anything is 0), so it is
 * not counted at all. A triple is accepted only when:
 *   - at least 2 rows support it (one row can match by chance)
 *   - more than half of the checkable rows support it
 *   - at least half of all body rows support it
 *   - at least MIN_DISCRIMINATING_ROWS supporting rows have no factor 1.
 *     With a factor 1, "1 x price = price" also fits a price column copied
 *     into the total column, so those rows prove nothing about which column
 *     is which.
 *
 * When two or more triples are accepted, the result is "rival". A timber
 * quote can hold two true products (pieces x length = metres, and metres x
 * price per metre = value), and only one of them is about money, so we never
 * pick one.
 */
function findTriple(facts: readonly ColumnFacts[], numberColumns: readonly number[], rowCount: number): TripleResult {
  const accepted: Triple[] = [];
  for (let i = 0; i < numberColumns.length; i++) {
    for (let k = i + 1; k < numberColumns.length; k++) {
      for (const c of numberColumns) {
        const a = numberColumns[i];
        const b = numberColumns[k];
        if (c === a || c === b) continue;
        let support = 0;
        let discriminating = 0;
        let checkable = 0;
        for (let row = 0; row < rowCount; row++) {
          const ra = facts[a].readings[row];
          const rb = facts[b].readings[row];
          const rc = facts[c].readings[row];
          if (!isRead(ra) || !isRead(rb) || !isRead(rc)) continue;
          if (ra.value === 0 || rb.value === 0 || rc.value === 0) continue;
          checkable++;
          if (Math.abs(ra.value * rb.value - rc.value) <= toleranceFor(rc.dp)) {
            support++;
            if (ra.value !== 1 && rb.value !== 1) discriminating++;
          }
        }
        if (support >= 2 && support * 2 > checkable && support * 2 >= rowCount && discriminating >= MIN_DISCRIMINATING_ROWS) {
          accepted.push({ a, b, c, support, discriminating });
        }
      }
    }
  }
  if (accepted.length === 0) return { kind: "none" };
  if (accepted.length > 1) return { kind: "rival" };
  return { kind: "found", triple: accepted[0] };
}

/**
 * True when a number column outside the product looks more like the money
 * total than the product's own line total does. The product is then probably
 * about something else (pieces x length = metres), and it is not trusted.
 * Two signs:
 *
 *   1. The other column has a currency marker, and the product's total has
 *      none: the money is in the other column.
 *   2. Neither has a currency marker, the other column shows at least as many
 *      decimals as the total, and its value is at least the total's on every
 *      row where both were read (at least 2 rows). It may be the real total:
 *      one that includes GST, or the value of a whole pack. The decimals rule
 *      keeps plain counts, like a weight in kilograms or a numeric product
 *      code, from counting as money.
 */
function looksMoreLikeTheTotal(other: ColumnFacts, total: ColumnFacts): boolean {
  if (isMarked(total)) return false;
  if (isMarked(other)) return true;
  if (other.usualDecimals === null || total.usualDecimals === null || other.usualDecimals < total.usualDecimals) return false;
  let compared = 0;
  for (let row = 0; row < total.readings.length; row++) {
    const mine = total.readings[row];
    const theirs = other.readings[row];
    if (!isRead(mine) || !isRead(theirs)) continue;
    compared++;
    if (theirs.value < mine.value) return false;
  }
  return compared >= 2;
}

/** For a column: how many read values are 1000 or more, and how many of those are printed with thousands marks. */
function groupingOf(facts: ColumnFacts): { big: number; grouped: number } {
  const big = facts.readings.filter(isRead).filter((reading) => Math.abs(reading.value) >= 1000);
  return { big: big.length, grouped: big.filter((reading) => reading.grouped).length };
}

/**
 * Decides which factor of the product is the unit price, from the way the
 * values are written only. Two clues, tried in this order:
 *
 *   1. Currency: the line total and one factor carry the SAME currency marker,
 *      and the other factor has none. The one with the marker is the price.
 *      (A quantity like "50 KGS" carries a marker too, because KGS is also a
 *      currency code, but not the total's "$", so it proves nothing.)
 *   2. Grouping: the line total groups its thousands ("1,195.20"), one factor
 *      groups its thousands too, and the other factor has values of 1000 or
 *      more written without grouping. The grouped one is the price.
 *
 * Decimals are NOT a clue. "7.50 x 85 = 637.50" is 7.5 hours at 85 an hour,
 * so the factor with the total's decimals can be the quantity just as well
 * as the price, and multiplying can't tell them apart.
 *
 * Returns null when no clue decides. Then both factors stay unknown, and the
 * line total is still known.
 */
function orientFactors(facts: readonly ColumnFacts[], triple: Triple): { price: number; quantity: number } | null {
  const { a, b, c } = triple;
  const [fa, fb, fc] = [facts[a], facts[b], facts[c]];
  const priceIs = (price: number) => ({ price, quantity: price === a ? b : a });

  // 1. The line total's currency marker, on one factor only.
  if (isMarked(fc)) {
    const sharesMarker = (column: ColumnFacts) => isMarked(column) && column.marker === fc.marker;
    if (sharesMarker(fa) && fb.currencyShare === 0) return priceIs(a);
    if (sharesMarker(fb) && fa.currencyShare === 0) return priceIs(b);
  }

  // 2. Thousands grouping like the line total.
  const [ga, gb, gc] = [groupingOf(fa), groupingOf(fb), groupingOf(fc)];
  if (gc.big > 0 && gc.grouped === gc.big) {
    if (ga.big > 0 && ga.grouped === ga.big && gb.big > 0 && gb.grouped === 0) return priceIs(a);
    if (gb.big > 0 && gb.grouped === gb.big && ga.big > 0 && ga.grouped === 0) return priceIs(b);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Opinion 1: the numbers (and the shapes of text cells)
// ---------------------------------------------------------------------------

/**
 * Letters and dots only, 1 to UNIT_MAX_LENGTH characters: "ea", "sheet",
 * "l.m.". \p{L} is any letter in any script, so "pièce" and "hộp" fit too.
 */
const UNIT_CELL = new RegExp(`^[\\p{L}.]{1,${UNIT_MAX_LENGTH}}$`, "u");

/** One token of 2 to CODE_MAX_LENGTH characters with no spaces. */
const CODE_CELL = new RegExp(`^\\S{2,${CODE_MAX_LENGTH}}$`, "u");

/** A measurement like "25kg" or "1.8m": digits, then 1 to 3 letters. Such a cell is not a code. */
const MEASUREMENT = /^[\d.,]+\s*\p{L}{1,3}$/u;

/** True when a cell could be a code: one token that mixes digits with letters or hyphens, and is not a measurement. */
function looksLikeCode(text: string): boolean {
  return CODE_CELL.test(text) && /\d/.test(text) && /[\p{L}-]/u.test(text) && !MEASUREMENT.test(text);
}

/**
 * True for a column of phrases: its cells are on average at least
 * DESCRIPTION_MIN_LENGTH characters long, and at least half of them have more
 * than one word. A description is such a column; a code ("PBS-1147-A") is
 * long but one word.
 */
function isPhraseColumn(facts: ColumnFacts): boolean {
  return facts.meanLength >= DESCRIPTION_MIN_LENGTH && facts.spaceShare >= 0.5;
}

/**
 * What the numbers (and the shapes of the text cells) say about each column,
 * by position. null means no opinion. Never reads a word, never uses position.
 */
function inferFromNumbers(facts: readonly ColumnFacts[], rowCount: number): (Role | null)[] {
  const roles: (Role | null)[] = facts.map(() => null);
  const positions = facts.map((_, position) => position);
  const numberColumns = positions.filter((position) => isNumberColumn(facts[position]));
  const counting = new Set(numberColumns.filter((position) => isSequence(facts[position])));

  // 1. The product check, first without the columns that count 1, 2, 3 ...
  //    An item number can equal the quantity on a few rows by chance (item 2
  //    buys 2), and then "item number x price = total" passes too. Only when
  //    no product is found without them are they tried as well.
  //    A product that isn't trusted (a rival product, or a column that looks
  //    more like the money total) gives no number role at all, not even by
  //    the "/unit" rule below, because we can't tell which columns are which.
  let product = findTriple(
    facts,
    numberColumns.filter((position) => !counting.has(position)),
    rowCount,
  );
  if (product.kind === "none" && counting.size > 0) product = findTriple(facts, numberColumns, rowCount);
  let trusted: Triple | null = null;
  if (product.kind === "found") {
    const { a, b, c } = product.triple;
    const outside = numberColumns.filter((position) => position !== a && position !== b && position !== c);
    if (!outside.some((position) => looksMoreLikeTheTotal(facts[position], facts[c]))) trusted = product.triple;
  }
  const factors = new Set<number>();
  if (trusted) {
    const { a, b, c } = trusted;
    roles[c] = "lineTotal";
    factors.add(a).add(b);
    const [aCounts, bCounts] = [counting.has(a), counting.has(b)];
    if (aCounts !== bCounts) {
      // One factor counts 1, 2, 3 ...: it is the item number or a quantity
      // that happens to count up, and we can't tell which, so it gets no
      // role. The other factor is the price either way.
      roles[aCounts ? b : a] = "unitPrice";
    } else if (!aCounts) {
      const oriented = orientFactors(facts, trusted);
      if (oriented) {
        roles[oriented.price] = "unitPrice";
        roles[oriented.quantity] = "quantity";
      }
    }
  }

  // 2. No product column: a money column with "/unit" on most cells is a
  //    unit price ("$68.00 /bag"). Only when exactly one column fits.
  if (product.kind === "none") {
    const perUnit = numberColumns.filter(
      (position) => isMarked(facts[position]) && facts[position].perShare >= MARKED_COLUMN_SHARE,
    );
    if (perUnit.length === 1) roles[perUnit[0]] = "unitPrice";
  }

  // 3. The item number: a column that counts 1, 2, 3 ... and is not a factor
  //    of the product. Two such columns means we can't tell which one it is,
  //    so neither gets the role.
  const sequences = [...counting].filter((position) => roles[position] === null && !factors.has(position));
  if (sequences.length === 1) roles[sequences[0]] = "itemNo";

  // 4. Text columns: description, then unit and code.
  const textColumns = positions.filter(
    (position) =>
      roles[position] === null &&
      !facts[position].numeric &&
      facts[position].percentShare < PERCENT_COLUMN_SHARE &&
      facts[position].filled > 0,
  );
  // The description is the one column of phrases, and it must also be
  // clearly longer than every other text column. With two columns of phrases
  // (a description and a delivery address), we can't tell which is which.
  const phrases = textColumns.filter((position) => isPhraseColumn(facts[position]));
  if (phrases.length === 1) {
    const [candidate] = phrases;
    const length = facts[candidate].meanLength;
    const others = textColumns.filter((position) => position !== candidate);
    if (others.every((position) => length >= DESCRIPTION_LENGTH_RATIO * facts[position].meanLength)) {
      roles[candidate] = "description";
    }
  }
  for (const position of textColumns) {
    if (roles[position] !== null) continue;
    const texts = facts[position].texts;
    if (texts.length < 2) continue;
    if (texts.every((text) => UNIT_CELL.test(text))) {
      roles[position] = "unit";
    } else if (texts.every(looksLikeCode) && new Set(texts).size === texts.length) {
      roles[position] = "code";
    }
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Opinion 2 and the agreement
// ---------------------------------------------------------------------------

/** True for quantity, unit price and line total: the roles numbers are read from. */
function isNumberRole(role: Role): boolean {
  return NUMBER_ROLES.includes(role);
}

/** A column in the form codes.ts uses in refusal messages (position counts from 1). */
function columnRef(table: Table, position: number): { header: string | null; position: number } {
  return { header: table.columns[position].header, position: position + 1 };
}

/** One column's decision, with the note it needs if it keeps its role. */
interface Decided {
  role: Role | null;
  source: RoleSource;
  /** The note that explains this role, kept only while the column keeps the role. */
  note: Note | null;
}

/** No role, no note. */
const NO_ROLE: Decided = { role: null, source: null, note: null };

/**
 * Decides every column's role: from the numbers first (the product check,
 * currency markers, "/unit" prices, 1..n item numbers, text shapes), then the
 * header words as a second opinion (vocabulary.ts). Column position is never
 * used. `page` is used in note and refusal wording.
 *
 * The agreement, per column:
 *
 *   numbers   heading   result
 *   R         R         R, roleSource "both"
 *   R         S         R is a number role (from the product check):
 *                         AMBIGUOUS_COLUMNS (never swapped)
 *                       R is a text role (from the cells' shapes):
 *                         S, roleSource "header", and a note
 *   R         -         R, roleSource "numbers"
 *   -         S         S, roleSource "header", and a note
 *   -         -         no role
 *
 * Then, for roles held by more than one column:
 *   - a quantity, unit price or line total held twice gives AMBIGUOUS_COLUMNS
 *   - a text role held twice (two columns of short words both look like
 *     units) is kept only by the column whose heading names it, if exactly
 *     one does; the others lose it. No number depends on a text role, so the
 *     page is still read.
 * A table with no quantity, unit price or line total gives
 * COLUMN_MEANING_UNKNOWN. On an AMBIGUOUS_COLUMNS page, no column keeps a
 * quantity, unit price or line total role, so the page report never shows a
 * role the engine just said it can't trust.
 */
export function decideRoles(table: Table, conventions: readonly Convention[], page: number): RoleDecision {
  // The facts come from the lines that may be items. A line that starts with
  // a totals label ("Total 25 $413.50") is not one, so its numbers must not
  // change what a column means. (items.ts moves such lines out of the table.)
  const itemRows: Table = {
    ...table,
    body: table.body.filter((bodyRow) => !startsWithTotalsLabel(bodyRow.row.cells[0]?.text ?? "")),
  };
  const rowCount = itemRows.body.length;
  const facts = table.columns.map((column) => describeColumn(itemRows, column.position, conventions));
  const numbersSay = inferFromNumbers(facts, rowCount);
  const pageNotes: Note[] = [];

  // Opinion 2: the header words. "Item" means the line number only next to a
  // description-like heading, so the whole header row is looked at first.
  const besideDescription = hasDescriptionHeader(table.columns.map((column) => column.header));
  let anyHeaderKnown = false;
  const headerSays: (Role | null)[] = table.columns.map((column) => {
    if (column.header === null) return null;
    const opinion = headerOpinion(column.header, besideDescription);
    if (opinion.role !== null) {
      anyHeaderKnown = true;
      return opinion.role;
    }
    if (opinion.tie) {
      // Words of two roles: the heading has known words, but no opinion.
      anyHeaderKnown = true;
      pageNotes.push(NOTES.headingTwoMeanings(page, column.header));
    }
    return null;
  });

  // The agreement, per column.
  let refusalInput: Parameters<typeof pageRefusal>[0] | null = null;
  const disputed = new Set<number>();
  const decided: Decided[] = [];
  for (const column of table.columns) {
    const fromNumbers = numbersSay[column.position];
    const fromHeader = headerSays[column.position];
    const header = column.header ?? "";
    if (fromNumbers !== null && fromHeader !== null && fromNumbers !== fromHeader) {
      if (isNumberRole(fromNumbers)) {
        // The product check and the words disagree. Swapping would be a
        // guess, so the page is refused. Only the first such column is
        // quoted; one is enough to refuse the page.
        disputed.add(column.position);
        refusalInput ??= {
          code: "AMBIGUOUS_COLUMNS",
          kind: "numbersVsHeader",
          page,
          column: columnRef(table, column.position),
          numbersRole: fromNumbers,
          headerRole: fromHeader,
        };
        decided.push(NO_ROLE);
      } else {
        // The numbers only gave a clue from the cells' shapes (a column that
        // counts 1, 2, 3, or short words). A heading is a stronger clue than
        // that: a quantity column can count 1, 2, 3 too. If the heading
        // names a number role, the cells are then read as numbers and
        // checked like any other.
        const note = NOTES.headingFollowed(page, header, ROLE_WORDS[fromNumbers].many, ROLE_WORDS[fromHeader].one);
        decided.push({ role: fromHeader, source: "header", note });
      }
    } else if (fromNumbers !== null && fromHeader !== null) {
      decided.push({ role: fromNumbers, source: "both", note: null });
    } else if (fromNumbers !== null) {
      decided.push({ role: fromNumbers, source: "numbers", note: null });
    } else if (fromHeader !== null) {
      const note = NOTES.headerOnlyRole(page, header, `the ${ROLE_WORDS[fromHeader].one}`);
      decided.push({ role: fromHeader, source: "header", note });
    } else {
      decided.push(NO_ROLE);
    }
  }

  // Roles held by more than one column, left to right.
  const seen = new Set<Role>();
  for (const { role } of decided) {
    if (role === null || seen.has(role)) continue;
    seen.add(role);
    const holders = decided.flatMap((other, position) => (other.role === role ? [position] : []));
    if (holders.length < 2) continue;
    if (isNumberRole(role)) {
      // Two columns that could both be the quantity (or the price, or the
      // total): the numbers would be read from a guess.
      if (refusalInput === null) {
        const [first, second, ...rest] = holders.map((position) => columnRef(table, position));
        refusalInput = { code: "AMBIGUOUS_COLUMNS", kind: "sameRole", page, role, columns: [first, second, ...rest] };
      }
      for (const position of holders) disputed.add(position);
    } else {
      const named = holders.filter((position) => decided[position].source !== "numbers");
      const keep = named.length === 1 ? named[0] : null;
      for (const position of holders) if (position !== keep) decided[position] = NO_ROLE;
    }
  }
  for (const position of disputed) decided[position] = NO_ROLE;

  const ambiguous = refusalInput !== null;
  if (ambiguous) {
    // Nothing is listed on this page, and the refusal names the columns, so
    // no column keeps a number role (see the function comment).
    decided.forEach((one, position) => {
      if (one.role !== null && isNumberRole(one.role)) decided[position] = NO_ROLE;
    });
  }

  // No quantity, unit price or line total at all: the rows are listed as
  // printed, and no number is read.
  if (refusalInput === null && !decided.some(({ role }) => role !== null && isNumberRole(role))) {
    refusalInput = { code: "COLUMN_MEANING_UNKNOWN", page };
  }

  // The notes about single columns: the note of each role that was kept, and
  // one for each headed column we don't read. Left out on an ambiguous page.
  const columnNotes: Note[] = [];
  if (!ambiguous) {
    table.columns.forEach((column, position) => {
      const one = decided[position];
      if (one.role !== null && one.note) columnNotes.push(one.note);
      if (one.role === null && column.header !== null) columnNotes.push(NOTES.columnNotRead(page, column.header));
    });
  }

  // The returns and credit check reads English title words only. When no
  // heading is known, the page is probably in another language, so say that
  // the check may not have worked.
  if (table.headerRows.length === 0) pageNotes.push(NOTES.noHeadings(page));
  else if (!anyHeaderKnown) pageNotes.push(NOTES.unknownHeadings(page));

  const columns: Column[] = table.columns.map((column, position) => ({
    header: column.header,
    key: column.key,
    role: decided[position].role,
    roleSource: decided[position].source,
    kind: column.kind,
  }));

  // The refusal quotes the header row(s) and every body row, as printed.
  const evidence: Evidence[] = [...table.headerRows, ...table.body.map((bodyRow) => bodyRow.row)].map((row) => ({
    page,
    sourceText: row.text,
  }));
  const refusal = refusalInput === null ? null : pageRefusal(refusalInput, evidence);
  return { columns, refusal, notes: [...columnNotes, ...pageNotes] };
}
