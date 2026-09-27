/**
 * The evidence gate: the last check before anything is sent.
 *
 * Where it sits: after every page has been turned into line items (items.ts),
 * before the result is put together. It runs in production, not only in
 * tests.
 *
 * The brief's hard rule is "never output a number you can't trace to its
 * cell". The gate proves three things for every field that has a value:
 *
 *   1. `raw` is exactly the characters at `span` in the row's text, so the
 *      quoted text and its position always agree. (That the span covers a
 *      whole cell, and not the "2" inside "H3.2", comes from items.ts, which
 *      takes every span from a cell's own offsets.)
 *   2. The row's words exist on the cited page, in the page's own text
 *      (streamText). streamText is built straight from pdf.js in read-page.ts,
 *      not from our rebuilt rows, so it is an independent copy.
 *   3. Reading `raw` again with the page's number format gives the same
 *      value, the same currency and the same price unit.
 *
 * What it does not prove: that the number is in the right column (the role
 * agreement and the arithmetic check do that), or that the pdf.js text
 * matches what is printed (a hidden OCR layer can be wrong).
 *
 * An item with one failing field is removed and replaced by a visible
 * EVIDENCE_CHECK_FAILED row refusal that quotes its row. It is never dropped
 * silently, and it never affects the other items.
 *
 * The printed totals go through the same checks (totalsGate), so a total
 * that can't be proved is never used to check the lines.
 *
 * How to read it: checkField holds the checks for one field, in the order
 * listed on EvidenceProblem. evidenceGate runs it over every item, and
 * totalsGate over every printed total.
 */
import { MONEY_ROLES, type Field, type LineItem, type Refusal, type Role } from "@/lib/contract/schema";

import { analyseNumber, currencyCode, readNumber, type Convention } from "./numbers";
import { rowRefusal, totalsRefusal } from "./refusals";
import type { TotalsCandidate } from "./totals";

/** Why a field failed the gate. The checks run in this order, and the first failure is returned. */
export type EvidenceProblem =
  /** The field has a value but no span. */
  | "no-span"
  /** `sourceText.slice(span)` is not exactly `raw`. */
  | "span-mismatch"
  /** A word of `sourceText` is not in the page's own text (streamText). */
  | "not-on-page"
  /** Reading `raw` again gives a different value, currency or price unit. */
  | "value-mismatch";

/** Every whitespace character, including the special spaces (U+00A0, U+202F, U+2009), which `\s` also matches. */
const WHITESPACE = /\s+/u;

/**
 * True when every word of `sourceText` appears somewhere in `streamText`.
 *
 * A word is a run of text between whitespace. streamText has no whitespace
 * at all (read-page.ts removes it), so a word never holds any either after
 * the split. The words don't have to appear in the same order: pdf.js gives
 * text in the order it was drawn, which is not always the reading order.
 */
function wordsOnPage(sourceText: string, streamText: string): boolean {
  return sourceText
    .split(WHITESPACE)
    .filter((word) => word !== "")
    .every((word) => streamText.includes(word));
}

/**
 * Checks one field that has a value. `role` is its column role, or
 * "statedTotal" for a printed total (a figure totals.ts read below a table).
 * `conventions` are the number conventions of the field's page. Returns null
 * when the field passes, or the first problem found.
 *
 * A field without a value (a text field such as a description or a code) has
 * no number to prove, so it passes at once.
 *
 * The currency is compared only for the money roles and printed totals, and
 * the price unit only for unitPrice, because the contract forbids them on the
 * other fields. A field that leaves `currency` or `per` out counts as null, so
 * it passes only when reading `raw` again also gives none.
 */
export function checkField(
  role: Role | "statedTotal",
  field: Field,
  sourceText: string,
  streamText: string,
  conventions: readonly Convention[],
): EvidenceProblem | null {
  if (field.value === undefined) return null;

  if (field.span === undefined) return "no-span";
  const [start, end] = field.span;
  if (sourceText.slice(start, end) !== field.raw) return "span-mismatch";

  if (!wordsOnPage(sourceText, streamText)) return "not-on-page";

  const parts = analyseNumber(field.raw);
  const reading = readNumber(parts, conventions);
  if (reading.status !== "ok" || reading.value !== field.value) return "value-mismatch";

  const moneyRoles: readonly string[] = MONEY_ROLES;
  if (moneyRoles.includes(role) || role === "statedTotal") {
    if ((field.currency ?? null) !== currencyCode(parts.currencyMarker)) return "value-mismatch";
  }
  if (role === "unitPrice" && (field.per ?? null) !== parts.per) return "value-mismatch";

  return null;
}

/** The items that passed, and one EVIDENCE_CHECK_FAILED refusal for each item that didn't. */
export interface GateResult {
  items: LineItem[];
  refusals: Refusal[];
}

/** The printed totals that passed the gate, the ones that didn't, and a refusal for each one that didn't. */
export interface TotalsGateResult {
  candidates: TotalsCandidate[];
  rejected: TotalsCandidate[];
  refusals: Refusal[];
}

/**
 * Runs the same checks on every printed total (totals.ts) that has a value:
 * its span slices back to its raw text, its row's words are on its page, and
 * reading the raw text again gives the same value and currency. A total that
 * fails is removed and replaced by a visible EVIDENCE_CHECK_FAILED totals
 * refusal that quotes its row, so it can never be used in a check.
 *
 * A total whose amount has two readings has no value to prove; it passes
 * through, and totals.ts refuses it as AMBIGUOUS_NUMBER_FORMAT.
 */
export function totalsGate(
  candidates: readonly TotalsCandidate[],
  streamTexts: ReadonlyMap<number, string>,
  pageConventions: (page: number) => readonly Convention[],
): TotalsGateResult {
  const result: TotalsGateResult = { candidates: [], rejected: [], refusals: [] };
  for (const candidate of candidates) {
    const streamText = streamTexts.get(candidate.page);
    const problem =
      streamText === undefined
        ? "not-on-page"
        : checkField("statedTotal", candidate.amount, candidate.sourceText, streamText, pageConventions(candidate.page));
    if (problem === null) {
      result.candidates.push(candidate);
      continue;
    }
    result.rejected.push(candidate);
    result.refusals.push(
      totalsRefusal(
        { code: "EVIDENCE_CHECK_FAILED", page: candidate.page, raw: candidate.amount.raw },
        `p${candidate.page}-r${candidate.rowIndex}-EVIDENCE_CHECK_FAILED`,
        [{ page: candidate.page, sourceText: candidate.sourceText }],
        candidate.page,
      ),
    );
  }
  return result;
}

/**
 * Finds the first field of an item that fails the gate. Returns the failing
 * field's raw text, "" when the item fails without a single field to blame
 * (its page has no streamText), or null when the item passes.
 */
function firstFailure(
  item: LineItem,
  streamText: string | undefined,
  conventions: readonly Convention[],
): string | null {
  // An item whose page has no streamText points at a page we never read, so
  // nothing on it can be proved.
  if (streamText === undefined) return "";
  for (const [roleName, field] of Object.entries(item.fields)) {
    if (!field) continue;
    if (checkField(roleName as Role, field, item.sourceText, streamText, conventions) !== null) return field.raw;
  }
  return null;
}

/**
 * Runs checkField on every field with a value of every item. A failing item
 * is removed and replaced by a visible EVIDENCE_CHECK_FAILED row refusal that
 * quotes its row. It is never dropped silently. `streamTexts` maps a page
 * number to that page's streamText (see read-page.ts), and `pageConventions`
 * gives each page's number conventions (each page is read in its own format,
 * see numbers.ts). The items that pass keep their order, and so do the
 * refusals.
 */
export function evidenceGate(
  items: readonly LineItem[],
  streamTexts: ReadonlyMap<number, string>,
  pageConventions: (page: number) => readonly Convention[],
): GateResult {
  const result: GateResult = { items: [], refusals: [] };
  for (const item of items) {
    const failedRaw = firstFailure(item, streamTexts.get(item.page), pageConventions(item.page));
    if (failedRaw === null) {
      result.items.push(item);
      continue;
    }
    // The message names the failing cell when there is one. Without one it
    // says "a value" instead (see codes.ts).
    const facts = failedRaw === "" ? { page: item.page } : { page: item.page, raw: failedRaw };
    result.refusals.push(
      rowRefusal({ code: "EVIDENCE_CHECK_FAILED", ...facts }, item.rowIndex, [
        { page: item.page, sourceText: item.sourceText },
      ]),
    );
  }
  return result;
}
