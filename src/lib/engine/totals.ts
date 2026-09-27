/**
 * The printed totals: reading them, and checking the lines against them.
 *
 * Where it sits: after the line items are built and checked. It has two
 * parts, used at two different moments:
 *
 *   1. `findTotalsCandidates` runs for each page in pass 2. It reads the
 *      figures printed below the table ("Total: $2,630.00", "GST 15%
 *      $36.00", "Summe: 1.234,50 €"), and the "Total" lines that items.ts
 *      moved out of the table. Each one becomes a candidate: its label, its
 *      amount with the amount's exact place in the row, and the kind of total
 *      the WHOLE label names (subtotal, GST, total, amount due), or no kind
 *      when vocabulary.ts doesn't know the label ("Total Qty", "Summe").
 *   2. `checkTotals` runs once for the whole document, after the evidence
 *      gate. It decides which printed figure the lines should add up to, adds
 *      the lines up, and says whether they match. It never picks a side: when
 *      the numbers disagree, both are quoted in a refusal.
 *
 * The rules, in the order checkTotals applies them:
 *   1. A figure whose amount can be read two ways ("1.200") is refused
 *      (AMBIGUOUS_NUMBER_FORMAT). It is never shown as a total or used. A
 *      figure under a totals label that looks like a count ("Total 25" under
 *      "$186.00" lines: a whole number, no currency marker, while every line
 *      total has decimals, and not the sum of the lines) is set aside with a
 *      note. It is not shown as a total, and it takes no part in the rules
 *      below.
 *   2. The figure must cover every line: it must sit on or after the last
 *      page that has lines (or that we couldn't read). A subtotal at the foot
 *      of page 1 of a 2-page invoice is shown, but it can't be the check.
 *   3. Which check: with a printed subtotal, the lines are checked against it
 *      ("lines_vs_subtotal"). Otherwise with a total ("lines_vs_total"). An
 *      amount due is shown, never checked.
 *   4. The check doesn't run when its figure has two readings, failed the
 *      evidence gate, or is a total next to a GST, tax or discount line with
 *      no subtotal: the total may or may not include that line.
 *   5. With no known subtotal or total, a figure under a label we don't know
 *      (for example in another language) is used as the total only when it
 *      equals the lines, and never when a tax or discount line is printed.
 *      Every figure we don't use gets a note that says why.
 *   6. Two figures of the same kind with different amounts ("Total $300.00"
 *      and "Grand total $330.00"): TOTALS_UNVERIFIABLE, quoting both.
 *   7. The lines are only added up when every page from page 1 to the
 *      figure's page was read in full, and every line there has a line total.
 *      Otherwise TOTALS_UNVERIFIABLE says which page or line stopped it.
 *   8. The sum is done in whole cents, and may differ from the printed figure
 *      by at most one cent per line, for rounding. A bigger difference is
 *      TOTALS_DISAGREE.
 *
 * We calculate two numbers here: the sum of the lines, and, when it doesn't
 * match, the difference. The sum is in TotalsCheck.derived, labelled
 * "calculated by us". Both appear in the TOTALS_DISAGREE message, each marked
 * "(calculated by us)" by codes.ts. Neither ever becomes a stated total.
 */
import { CHECK_REASONS, refusalMessage, type RefusalInput } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";
import type { Evidence, Field, LineItem, Note, PageReport, Refusal, StatedTotal, TotalsCheck } from "@/lib/contract/schema";

import type { TotalsRow } from "./items";
import {
  analyseNumber,
  currencyCode,
  formatNumber,
  markerIsAfter,
  readNumber,
  validConventions,
  type Convention,
  type NumberParts,
} from "./numbers";
import { totalsRefusal } from "./refusals";
import type { Row } from "./rows";
import { gstBasisOf, startsWithTotalsLabel, totalsLabelKind, type TotalKind } from "./vocabulary";

// ---------------------------------------------------------------------------
// Part 1: the candidates on one page
// ---------------------------------------------------------------------------

/** A figure printed next to the lines that may be a total, before any check. */
export interface TotalsCandidate {
  page: number;
  /** The row's index on the page (rows.ts), so a refusal id can point at it. */
  rowIndex: number;
  /** The row as rebuilt from the page, for the evidence ("Total: $5,122.40"). */
  sourceText: string;
  /** The label as printed, before the amount ("Total:"). Empty when the row has no label. */
  label: string;
  /** The kind of total the whole label names, or null when vocabulary.ts doesn't know the label. */
  kind: TotalKind | null;
  /**
   * The amount: its exact characters (`raw`), its place in `sourceText`
   * (`span`), its currency, and its value when it has exactly one reading.
   * Its header is the label as printed.
   */
  amount: Field;
  /** The amount's value and printed decimals, or its two readings. */
  reading: { status: "ok"; value: number; dp: number } | { status: "ambiguous"; values: [number, number] };
  /** The amount split into markers and digits, so a sum can be written in the same style. */
  parts: NumberParts;
}

/** What one page gives the totals step. */
export interface PageTotals {
  candidates: TotalsCandidate[];
  /** Notes about totals lines that have no amount, or an amount we couldn't read. */
  notes: Note[];
  /** How many lines look like a total (a totals label and a number) but gave no amount we could read. */
  unread: number;
}

/**
 * A percentage inside a label, like the "15%" in "GST 15%". It is the only
 * number a label may hold: "Page 1 of 8" and "Total 25" are not labels. A
 * label with a percentage is also a sign of a tax or discount line.
 */
const PERCENT = /\d+(?:[.,]\d+)?\s?%/gu;

/** True when `text` can be a label: it has a letter, and no digit outside a percentage. */
function isLabel(text: string): boolean {
  const withoutPercent = text.replace(PERCENT, "");
  return /\p{L}/u.test(withoutPercent) && !/\d/u.test(withoutPercent);
}

/** True when a label holds a percentage ("VAT 20%", "MwSt 19%", "Discount 10%"). */
function hasPercentage(label: string): boolean {
  return new RegExp(PERCENT.source, "u").test(label);
}

/**
 * The offsets in a row's text of the spaces that may sit between two separate
 * values: the space between two cells, and the spaces rows.ts put between two
 * pieces of one cell. A number is never read with such a space as its
 * thousands mark (see NumberParts.spaceAtJoin).
 */
function joinOffsets(row: Row): number[] {
  const offsets: number[] = [];
  row.cells.forEach((cell, k) => {
    if (k > 0) offsets.push(cell.start - 1);
    for (const offset of cell.joinSpaces) offsets.push(cell.start + offset);
  });
  return offsets;
}

/**
 * True when the page's own numbers allow a space as the thousands mark in a
 * total: the lines show it (every convention left has a space grouping), or
 * the page writes "," as its decimal mark, as in French ("2 499,30 €"),
 * where a space between thousands is the normal style.
 *
 * Otherwise a space inside a total's amount is taken as a join between two
 * values. That stops "Total 25 413.50" (25 items, $413.50) on an English page
 * from being read as 25,413.50.
 */
function spaceGroupingAllowed(conventions: readonly Convention[]): boolean {
  if (conventions.length === 0) return false;
  return conventions.every((convention) => convention.grouping === " ") || conventions.every((convention) => convention.decimal === ",");
}

/** The offset of every space in `text`. */
function spaceOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let k = 0; k < text.length; k++) if (/\s/u.test(text[k])) offsets.push(k);
  return offsets;
}

/**
 * Builds a candidate from a row, its label and its amount's place, or null
 * when the amount is not a number the page's format can read.
 */
function candidateOf(
  page: number,
  row: Row,
  label: string,
  start: number,
  end: number,
  joinSpaces: readonly number[],
  conventions: readonly Convention[],
): TotalsCandidate | null {
  const raw = row.text.slice(start, end);
  const joins = spaceGroupingAllowed(conventions) ? joinSpaces : spaceOffsets(raw);
  const parts = analyseNumber(raw, joins);
  // A percentage or a "/unit" price is never a total.
  if (parts.core === null || parts.percent || parts.per !== null) return null;
  const read = readNumber(parts, conventions);
  if (read.status !== "ok" && read.status !== "ambiguous") return null;
  const amount: Field = {
    header: label === "" ? null : label,
    raw,
    ...(read.status === "ok" ? { value: read.value } : {}),
    currency: currencyCode(parts.currencyMarker),
    span: [start, end],
  };
  return {
    page,
    rowIndex: row.index,
    sourceText: row.text,
    label,
    kind: label === "" ? null : totalsLabelKind(label),
    amount,
    reading: read.status === "ok" ? { status: "ok", value: read.value, dp: read.dp } : { status: "ambiguous", values: read.values },
    parts,
  };
}

/**
 * Reads a row below the table as a totals candidate: a label, then exactly
 * one number, and nothing after it. It works the same whether the label and
 * the amount are one text piece ("Total: $5,122.40") or two ("Total:" and
 * "$2,630.00"), because it looks at the row's text.
 *
 * The amount is the longest end of the row that is a number (so "1 195,20 €"
 * is kept whole), and everything before it is the label. Not candidates:
 *   - "Page 1 of 8" or "Total 25 $413.50": the label part holds a number
 *   - "Driver notes: 16 pallets unloaded": text after the number
 *   - "GST 15%": the only number is a percentage
 * A label like "Total Qty: 16" does give a candidate, but with no kind: the
 * words after "Total" say it is a count, so it is never taken as money unless
 * it equals the sum of the lines.
 */
export function readTotalRow(page: number, row: Row, conventions: readonly Convention[]): TotalsCandidate | null {
  const text = row.text;
  const joins = joinOffsets(row);
  for (let start = 1; start < text.length; start++) {
    // Only where a word starts: after a space, at a character that isn't one.
    if (!/\s/u.test(text[start - 1]) || /\s/u.test(text[start])) continue;
    const parts = analyseNumber(text.slice(start));
    if (parts.core === null) continue;
    // The longest end that is a number. What comes before it must be a label.
    const label = text.slice(0, start).trim();
    if (!isLabel(label)) return null;
    const joinSpaces = joins.filter((offset) => offset >= start).map((offset) => offset - start);
    return candidateOf(page, row, label, start, text.length, joinSpaces, conventions);
  }
  return null;
}

/**
 * Reads a "Total" line that items.ts moved out of the table. When the page has
 * a line-total column, the amount is the cell in that column, so a line that
 * also prints the total quantity ("Total 25 $413.50") still gives the right
 * amount. When that cell is empty, the line totals only a count ("Total 20"
 * under the quantity), so it holds no money total at all. The label is the
 * row's first cell. A page with no line-total column reads the row like a row
 * below the table.
 */
function readMovedRow(page: number, moved: TotalsRow, conventions: readonly Convention[]): TotalsCandidate | null {
  const { row, amount, hasTotalColumn } = moved;
  if (amount === null) return hasTotalColumn ? null : readTotalRow(page, row, conventions);
  const first = row.cells[0];
  const label = first === undefined || first.start === amount.start ? "" : first.text;
  return candidateOf(page, row, label, amount.start, amount.end, amount.joinSpaces, conventions);
}

/**
 * Finds the totals candidates of one page: the rows below the table and the
 * "Total" lines moved out of the table. The rows of another table on the page
 * are not read, except a row that starts with a totals label: a totals block
 * drawn as its own small table ("Subtotal | NZD | 413.50") still holds the
 * document's totals.
 *
 * A line below the table that starts with a totals label but has no amount
 * ("Total consignment weight: see individual lines.") gets an info note. One
 * that has a number we couldn't read as its amount ("Total: $500.00 NZD") gets
 * a different note, and is counted in `unread`, so the check can say that a
 * total is printed but unreadable.
 */
export function findTotalsCandidates(
  page: number,
  below: readonly Row[],
  moved: readonly TotalsRow[],
  otherTableRows: readonly Row[],
  conventions: readonly Convention[],
): PageTotals {
  const result: PageTotals = { candidates: [], notes: [], unread: 0 };
  for (const row of below) {
    const labelled = startsWithTotalsLabel(row.text);
    if (otherTableRows.includes(row) && !labelled) continue;
    const candidate = readTotalRow(page, row, conventions);
    if (candidate) {
      result.candidates.push(candidate);
    } else if (labelled && !/\d/u.test(row.text)) {
      result.notes.push(NOTES.totalLabelNoAmount(page, row.text));
    } else if (labelled) {
      result.notes.push(NOTES.totalAmountNotRead(page, row.text));
      result.unread++;
    }
  }
  for (const row of moved) {
    const candidate = readMovedRow(page, row, conventions);
    if (candidate) result.candidates.push(candidate);
  }
  result.candidates.sort((a, b) => a.rowIndex - b.rowIndex);
  return result;
}

// ---------------------------------------------------------------------------
// Part 2: the check, for the whole document
// ---------------------------------------------------------------------------

/** What checkTotals needs. */
export interface TotalsInput {
  /** The candidates that passed the evidence gate (and the ones with two readings, which have no value to check). */
  candidates: readonly TotalsCandidate[];
  /** The candidates the evidence gate rejected. They are never used, but they explain why a total wasn't checked. */
  rejected: readonly TotalsCandidate[];
  /** How many lines in the whole document look like a total but had an amount we couldn't read. */
  unreadTotals: number;
  /** Every page's report, with its final status. */
  pages: readonly PageReport[];
  /** Every line item that passed the evidence gate. */
  items: readonly LineItem[];
  /** Each page's number conventions (numbers.ts). */
  conventionsOf: (page: number) => readonly Convention[];
  /** The pages refused because no table was found on them (text pages, such as a cover letter or terms). */
  noTablePages: ReadonlySet<number>;
}

/** What checkTotals gives back. */
export interface TotalsResult {
  /** Every printed total we read and proved, in page and row order. */
  stated: StatedTotal[];
  /** Whether the line totals include GST, when the document says so in words. */
  gstBasis: "inclusive" | "exclusive" | "unstated";
  /** The one check of the lines against a printed total. */
  checks: TotalsCheck[];
  /** Refusals about the totals, in the contract's order. */
  refusals: Refusal[];
  /** Notes about printed figures, by page number. */
  notes: Map<number, Note[]>;
  /** True when a printed figure could be read two ways. */
  ambiguous: boolean;
}

/** The evidence for a candidate: its row, on its page. */
function evidenceOf(candidate: TotalsCandidate): Evidence {
  return { page: candidate.page, sourceText: candidate.sourceText };
}

/** A candidate as a contract StatedTotal. Only called for candidates with a value. */
function statedTotal(candidate: TotalsCandidate, label: TotalKind, labelKnown: boolean): StatedTotal {
  return { label, labelKnown, page: candidate.page, sourceText: candidate.sourceText, amount: candidate.amount };
}

/** A candidate whose amount has one reading. */
type ReadCandidate = TotalsCandidate & { reading: { status: "ok"; value: number; dp: number } };

function isRead(candidate: TotalsCandidate): candidate is ReadCandidate {
  return candidate.reading.status === "ok";
}

/** What the line totals of the whole document show, for telling a count from money. */
interface LineTotalFacts {
  /** True when at least one line total was read, and every one has decimals ("$186.00", never "$190"). */
  decimalsOnly: boolean;
  /** The most decimals any line total has, and the sum of all of them in that unit (whole cents for 2). */
  dp: number;
  sumUnits: number;
}

/**
 * What the line totals show, from every line total that could be read. The
 * facts don't depend on the order of the lines.
 */
function lineTotalFacts(input: TotalsInput): LineTotalFacts {
  const readings: { value: number; dp: number }[] = [];
  for (const item of input.items) {
    if (!item.fields.lineTotal) continue;
    const reading = readNumber(analyseNumber(item.fields.lineTotal.raw), input.conventionsOf(item.page));
    if (reading.status === "ok") readings.push(reading);
  }
  const dp = Math.max(0, ...readings.map((reading) => reading.dp));
  return {
    decimalsOnly: readings.length > 0 && readings.every((reading) => reading.dp > 0),
    dp,
    sumUnits: readings.reduce((sum, reading) => sum + Math.round(reading.value * 10 ** dp), 0),
  };
}

/**
 * True when a figure under a totals label looks like a count, not money:
 * "Total 25" under lines like "$186.00" is more likely the number of items.
 * All of these must hold:
 *   - no currency marker ("$", "NZD", "€" always mean money)
 *   - a whole number: a figure with decimals ("413.5") is never a count
 *   - every line total has decimals, so a whole number stands out
 *   - it isn't the sum of all the line totals ("Total 413" under lines that
 *     add up to 413.00 is money written without its cents)
 *
 * Known gap: on a document in whole dollars ("$190"), "Total 25" can't be
 * told from money, so it is still taken as a total (and then disagrees with
 * the lines, which is visible).
 */
function looksLikeCount(candidate: ReadCandidate, facts: LineTotalFacts): boolean {
  if (candidate.parts.currencyMarker !== null || candidate.reading.dp > 0 || !facts.decimalsOnly) return false;
  return Math.round(candidate.reading.value * 10 ** facts.dp) !== facts.sumUnits;
}

/** The page numbers from 1 to `last`. */
function pagesUpTo(last: number): number[] {
  return Array.from({ length: last }, (_, k) => k + 1);
}

/**
 * The last page a printed total must cover: the last page that has line
 * items, or that we couldn't read in full (it may hold lines). A blank page
 * holds nothing, and a text page with no table (a cover letter, terms and
 * conditions) is not counted either, so an invoice with its terms on the last
 * page can still be checked. 0 when no page counts.
 */
function lastLinesPage(input: TotalsInput): number {
  let last = 0;
  for (const report of input.pages) {
    const unreadLines = report.status === "partial" || (report.status === "refused" && !input.noTablePages.has(report.page));
    if (report.itemCount > 0 || unreadLines) last = Math.max(last, report.page);
  }
  return last;
}

/** Why the lines up to a page couldn't be added up, or what they add up to. */
type Sum =
  | { kind: "pageNotRead"; page: number; status: "partial" | "refused" | "blank" }
  | { kind: "missingLineTotal"; page: number }
  | { kind: "noLines" }
  | { kind: "added"; value: number; difference: number; matches: boolean; dp: number; fromItemIds: string[] };

/**
 * Adds up the line totals of every page from 1 to the candidate's page, and
 * compares the sum with the candidate's amount.
 *
 * The sum is done in whole units of the smallest decimal printed (cents for
 * "$186.00"), so no floating-point error builds up. The allowed difference is
 * one cent per line, whatever the number of decimals printed: with whole
 * dollars ("$454") that is no difference at all, until there are 100 lines.
 */
function addUpLines(candidate: ReadCandidate, input: TotalsInput): Sum {
  const pages = input.pages.filter((report) => report.page <= candidate.page);
  const notRead = pages.find((report) => report.status !== "extracted");
  if (notRead && notRead.status !== "extracted") return { kind: "pageNotRead", page: notRead.page, status: notRead.status };

  const items = input.items.filter((item) => item.page <= candidate.page);
  const withoutTotal = items.find((item) => item.fields.lineTotal?.value === undefined);
  if (withoutTotal) return { kind: "missingLineTotal", page: withoutTotal.page };
  if (items.length === 0) return { kind: "noLines" };

  // The most decimals printed on any line total or on the printed figure.
  const decimals = items.map((item) => {
    const reading = readNumber(analyseNumber(item.fields.lineTotal?.raw ?? ""), input.conventionsOf(item.page));
    return reading.status === "ok" ? reading.dp : 0;
  });
  const dp = Math.max(candidate.reading.dp, ...decimals);
  const scale = Math.pow(10, dp);
  const sumUnits = items.reduce((sum, item) => sum + Math.round((item.fields.lineTotal?.value ?? 0) * scale), 0);
  const statedUnits = Math.round(candidate.reading.value * scale);
  const differenceUnits = Math.abs(sumUnits - statedUnits);
  // One cent per line, in the units above: 1 unit per line with 2 decimals,
  // and less than one unit (so none) with whole numbers.
  const allowedUnits = Math.floor((items.length * scale) / 100);
  return {
    kind: "added",
    value: sumUnits / scale,
    difference: differenceUnits / scale,
    matches: differenceUnits <= allowedUnits,
    dp,
    fromItemIds: items.map((item) => item.id),
  };
}

/** A check that didn't run, with its reason. */
function notChecked(name: TotalsCheck["name"], pagesCovered: number[], reason: string): TotalsCheck {
  return { name, outcome: "not_checked", pagesCovered, reason };
}

/**
 * Writes a number we calculated in the style of a printed amount: its
 * decimals, its currency marker in the same place, and the marks its page
 * uses. When the page's own numbers don't show the thousands mark (no line
 * reaches 1,000), the printed amount itself may: "$1,612.90" shows ",", so
 * the sum is written "$1,538.20", not "$1538.20".
 */
function styled(value: number, dp: number, like: TotalsCandidate, input: TotalsInput): string {
  const page = input.conventionsOf(like.page);
  const fitting = like.parts.core === null ? [] : validConventions(like.parts.core, like.parts.spaceAtJoin);
  const narrowed = page.filter((convention) => fitting.includes(convention));
  const conventions = narrowed.length > 0 ? narrowed : page;
  return formatNumber(value, dp, conventions, like.parts.currencyMarker, markerIsAfter(like.parts));
}

/**
 * Checks the lines against the printed totals, for the whole document. See
 * the header of this file for the rules, numbered in the order below. The
 * input is never changed.
 */
export function checkTotals(input: TotalsInput): TotalsResult {
  const result: TotalsResult = { stated: [], gstBasis: "unstated", checks: [], refusals: [], notes: new Map(), ambiguous: false };
  const addNote = (candidate: TotalsCandidate, makeNote: (page: number, text: string) => Note) =>
    result.notes.set(candidate.page, [...(result.notes.get(candidate.page) ?? []), makeNote(candidate.page, candidate.sourceText)]);
  const refuse = (
    refusalInput: Extract<RefusalInput, { code: "TOTALS_UNVERIFIABLE" | "TOTALS_DISAGREE" }>,
    name: string,
    evidence: Evidence[],
    page: number,
  ) => {
    result.refusals.push(totalsRefusal(refusalInput, name, evidence, page));
    return refusalMessage(refusalInput);
  };

  // 1. A figure with two readings is refused, whatever its label. Its value is
  //    unknown, so it is never shown as a stated total or used.
  const twoReadings = new Map<TotalsCandidate, string>();
  for (const candidate of input.candidates) {
    if (candidate.reading.status !== "ambiguous") continue;
    const [first, second] = candidate.reading.values;
    const refusal = totalsRefusal(
      {
        code: "AMBIGUOUS_NUMBER_FORMAT",
        page: candidate.page,
        raw: candidate.amount.raw,
        readings: [String(first), String(second)],
        target: "total",
      },
      `p${candidate.page}-r${candidate.rowIndex}-AMBIGUOUS_NUMBER_FORMAT`,
      [evidenceOf(candidate)],
      candidate.page,
    );
    result.refusals.push(refusal);
    twoReadings.set(candidate, refusal.message);
  }
  result.ambiguous = twoReadings.size > 0;

  // A figure under a totals label that looks like a count ("Total 25") is
  // set aside with a note. From here on it is as if it weren't printed: it
  // doesn't choose the check, and it is no tax line.
  const facts = lineTotalFacts(input);
  const setAside = new Set<TotalsCandidate>();
  const read: ReadCandidate[] = [];
  for (const candidate of input.candidates.filter(isRead)) {
    if (candidate.kind !== null && looksLikeCount(candidate, facts)) {
      setAside.add(candidate);
      addNote(candidate, NOTES.totalNotMoney);
    } else read.push(candidate);
  }

  // Every known figure that was read is shown, whatever the check says.
  // `shown` keeps the candidates, so they can be put in page and row order.
  const unknown = read.filter((candidate) => candidate.kind === null);
  const shown: { candidate: ReadCandidate; label: TotalKind; labelKnown: boolean }[] = read
    .filter((candidate) => candidate.kind !== null)
    .map((candidate) => ({ candidate, label: candidate.kind as TotalKind, labelKnown: true }));

  const finish = (check: TotalsCheck, checkedLabel: string | null) => {
    result.checks.push(check);
    // A label says something about the lines only when they add up to it.
    result.gstBasis = gstBasisOfDocument(input.pages, check.outcome === "pass" ? checkedLabel : null);
    shown.sort((a, b) => a.candidate.page - b.candidate.page || a.candidate.rowIndex - b.candidate.rowIndex);
    result.stated = shown.map(({ candidate, label, labelKnown }) => statedTotal(candidate, label, labelKnown));
    return result;
  };

  // 2. A figure must sit on or after the last page with lines to cover them all.
  const lastPage = lastLinesPage(input);
  const covers = (candidate: TotalsCandidate) => candidate.page >= lastPage;
  const printed = [...input.candidates, ...input.rejected].filter((candidate) => !setAside.has(candidate));
  const printedCovering = (kind: TotalKind) => printed.some((candidate) => candidate.kind === kind && covers(candidate));

  // 3. Which check.
  const useSubtotal = printedCovering("subtotal");
  const name: TotalsCheck["name"] = useSubtotal ? "lines_vs_subtotal" : "lines_vs_total";
  const kind: TotalKind = useSubtotal ? "subtotal" : "total";
  const targets = read.filter((candidate) => candidate.kind === kind && covers(candidate));
  const ambiguousTarget = [...twoReadings.entries()].find(([candidate]) => candidate.kind === kind && covers(candidate));
  const rejectedTarget = input.rejected.some((candidate) => candidate.kind === kind && covers(candidate));

  // When a known figure of the checked kind is printed, a figure under an
  // unknown label is never used. It gets a note, so nothing is left unsaid.
  if (targets.length > 0 || ambiguousTarget || rejectedTarget) {
    for (const candidate of unknown) addNote(candidate, NOTES.unknownFigureIgnored);
  }

  // 4. The check's own figure can't be used, or a tax line makes it unsafe.
  if (ambiguousTarget) return finish(notChecked(name, [], ambiguousTarget[1]), null);
  if (targets.length === 0 && rejectedTarget) return finish(notChecked(name, [], CHECK_REASONS.totalNotProved), null);
  const taxLine = printed.some((candidate) => candidate.kind === "gst" || (candidate.kind === null && hasPercentage(candidate.label)));
  if (!useSubtotal && targets.length > 0 && taxLine) return finish(notChecked(name, [], CHECK_REASONS.gstNoSubtotal), null);

  // 5. No known subtotal or total covers the lines.
  if (targets.length === 0) {
    const early = read.filter((candidate) => (candidate.kind === "subtotal" || candidate.kind === "total") && !covers(candidate));
    for (const candidate of unknown.filter((one) => !covers(one))) addNote(candidate, NOTES.figureBeforeLines);
    const covering = unknown.filter(covers);
    // A tax or discount line means a figure equal to the lines is only the
    // net amount, not the total: none is used.
    if (taxLine && covering.length > 0) {
      for (const candidate of covering) addNote(candidate, NOTES.unknownFigureIgnoredTax);
      return finish(notChecked(name, [], CHECK_REASONS.gstNoSubtotal), null);
    }
    // A figure under an unknown label is used only when it equals the lines.
    // The last one that does is used; every other one gets a note that says
    // what happened to it.
    const sums = covering.map((candidate) => ({ candidate, sum: addUpLines(candidate, input) }));
    const chosen = sums.filter(({ sum }) => sum.kind === "added" && sum.matches).at(-1);
    for (const { candidate, sum } of sums) {
      if (candidate === chosen?.candidate) continue;
      if (sum.kind === "added") addNote(candidate, sum.matches ? NOTES.unknownFigureAlsoMatches : NOTES.unknownFigureNotPlaced);
      else addNote(candidate, NOTES.unknownFigureNotCompared);
    }
    if (chosen && chosen.sum.kind === "added") {
      shown.push({ candidate: chosen.candidate, label: "total", labelKnown: false });
      addNote(chosen.candidate, NOTES.unknownLabelTotalUsed);
      return finish(
        {
          name: "lines_vs_total",
          outcome: "pass",
          pagesCovered: pagesUpTo(chosen.candidate.page),
          derived: { label: "calculated by us", value: chosen.sum.value, fromItemIds: chosen.sum.fromItemIds },
        },
        chosen.candidate.label,
      );
    }
    const reason =
      early.length > 0
        ? CHECK_REASONS.earlyTotal
        : sums.some(({ sum }) => sum.kind === "added")
          ? CHECK_REASONS.unknownFigure
          : sums.length > 0
            ? CHECK_REASONS.unknownNotCompared
            : input.unreadTotals > 0
              ? CHECK_REASONS.totalNotRead
              : setAside.size > 0
                ? CHECK_REASONS.totalLooksLikeCount
                : CHECK_REASONS.nothingStated;
    return finish(notChecked(name, [], reason), null);
  }

  // 6. Two figures of the same kind with different amounts: we can't tell
  //    which one the lines should match.
  const distinct = targets.filter(
    (candidate, k) => targets.findIndex((other) => other.reading.value === candidate.reading.value) === k,
  );
  if (distinct.length > 1) {
    const [first, second, ...rest] = distinct.map((candidate) => ({ text: candidate.amount.raw, page: candidate.page }));
    const message = refuse(
      { code: "TOTALS_UNVERIFIABLE", reason: "twoAmounts", label: kind, amounts: [first, second, ...rest] },
      name,
      targets.map(evidenceOf),
      distinct[distinct.length - 1].page,
    );
    return finish(notChecked(name, [], message), null);
  }

  // 7. Add up the lines the figure covers, and 8. compare.
  const target = targets[targets.length - 1];
  const covered = pagesUpTo(target.page);
  const sum = addUpLines(target, input);
  if (sum.kind === "pageNotRead") {
    const message = refuse(
      {
        code: "TOTALS_UNVERIFIABLE",
        reason: "pageNotRead",
        label: kind,
        totalPage: target.page,
        page: sum.page,
        status: sum.status,
        noTable: input.noTablePages.has(sum.page),
      },
      name,
      [evidenceOf(target)],
      target.page,
    );
    return finish(notChecked(name, covered, message), null);
  }
  if (sum.kind === "missingLineTotal") {
    const message = refuse(
      { code: "TOTALS_UNVERIFIABLE", reason: "missingLineTotal", label: kind, totalPage: target.page, page: sum.page },
      name,
      [evidenceOf(target)],
      target.page,
    );
    return finish(notChecked(name, covered, message), null);
  }
  if (sum.kind === "noLines") return finish(notChecked(name, covered, CHECK_REASONS.noLines), null);

  const check: TotalsCheck = {
    name,
    outcome: sum.matches ? "pass" : "fail",
    pagesCovered: covered,
    derived: { label: "calculated by us", value: sum.value, fromItemIds: sum.fromItemIds },
  };
  if (!sum.matches) {
    refuse(
      {
        code: "TOTALS_DISAGREE",
        pages: covered,
        label: kind,
        sum: styled(sum.value, sum.dp, target, input),
        stated: target.amount.raw,
        difference: styled(sum.difference, sum.dp, target, input),
      },
      name,
      [evidenceOf(target)],
      target.page,
    );
  }
  return finish(check, target.label);
}

/**
 * Whether the line totals include GST, from the words only: the heading of
 * a line-total column ("Amount incl GST"), or else the label of the printed
 * figure the lines add up to, when the check passed ("Total ex GST"). A
 * label on a figure we didn't check, or that the lines don't add up to, says
 * nothing about the lines. "unstated" when neither says.
 */
function gstBasisOfDocument(pages: readonly PageReport[], checkedLabel: string | null): TotalsResult["gstBasis"] {
  const headers = pages.flatMap((report) =>
    report.columns.filter((column) => column.role === "lineTotal" && column.header !== null).map((column) => column.header as string),
  );
  for (const text of [...headers, ...(checkedLabel ? [checkedLabel] : [])]) {
    const basis = gstBasisOf(text);
    if (basis) return basis;
  }
  return "unstated";
}
