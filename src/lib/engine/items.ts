/**
 * Turning the table's rows into line items with evidence.
 *
 * Where it sits: table.ts has found the table, numbers.ts has found the
 * page's number conventions, and roles.ts has decided what each column
 * means. This file reads the cells of each body row and builds one LineItem
 * per row, or one row refusal when the row can't be read safely. After this,
 * the evidence gate (evidence.ts) checks every number again.
 *
 * The rule this file follows: it never computes a value that goes into the
 * output. Every value is read from its own cell with readNumber, and every
 * field keeps the exact characters of its cell (`raw`) and where they sit in
 * the row (`span`). An empty cell is listed in `missing`; it is never filled
 * in. The only number we calculate is quantity x unit price for the
 * arithmetic check, and it only appears inside a refusal message, marked
 * "(calculated by us)" by codes.ts.
 *
 * For each body row, in this order:
 *   1. The totals safety net: a "Total" row that slipped into the body is
 *      moved out to `totalsRows`, with a note that quotes it.
 *   2. Every cell in a column with a role becomes a Field. Cells in columns
 *      with no role go to `otherCells`, as printed.
 *   3. The first problem in the row refuses the row: a number we can't read
 *      (UNPARSEABLE_NUMBER), a number with two readings
 *      (AMBIGUOUS_NUMBER_FORMAT), numbers with no description
 *      (NO_DESCRIPTION), or quantity x unit price that is not the line total
 *      (ARITHMETIC_MISMATCH). A refused row is not listed as an item. The
 *      other rows are not affected.
 *   4. A row with a line total but no unit price, whose line total is the sum
 *      of the line totals above it, is a running total ("Continued on next
 *      page $413.50"), so it is moved out to `totalsRows` too.
 *
 * How to read it: `buildItems` at the bottom is the whole step. Above it, in
 * order: the tolerance of the arithmetic check, the totals safety net, the
 * helpers for one cell, and `readRow`, which handles one body row.
 */
import { NUMERIC_ROLES, type Field, type LineItem, type Note, type OtherCell, type Refusal, type Role } from "@/lib/contract/schema";
import type { RefusalInput } from "@/lib/contract/codes";
import { NOTES } from "@/lib/contract/notes";

import {
  analyseNumber,
  currencyCode,
  formatNumber,
  hasValidCore,
  readNumber,
  type Convention,
  type NumberParts,
} from "./numbers";
import { rowRefusal } from "./refusals";
import type { RoleDecision } from "./roles";
import type { Cell, Row } from "./rows";
import type { Table, TableColumn, TableRow } from "./table";
import { TOTAL_WORD, findWord, startsWithTotalsLabel } from "./vocabulary";

/** What buildItems produces for one page. */
export interface ItemsResult {
  /** The line items that passed every check, top to bottom. */
  items: LineItem[];
  /** Row refusals (UNPARSEABLE_NUMBER, AMBIGUOUS_NUMBER_FORMAT, NO_DESCRIPTION, ARITHMETIC_MISMATCH), top to bottom. */
  refusals: Refusal[];
  /**
   * Notes from this step: each totals row moved out of the table, a column we
   * don't read that mixes per-item figures and totals, and descriptions that
   * go on to a second line. (Section headings come from table.ts, and the
   * column notes from roles.ts, so they are not repeated here.)
   */
  notes: Note[];
  /**
   * Body rows that turned out to be totals rows (see `isLabelledTotal` and
   * `isRunningTotal`). They are moved out of the table so their money is not
   * counted twice, and each one gets a note. The totals step will read them
   * as printed totals.
   */
  totalsRows: Row[];
  /** True when at least one cell was refused because it could be read two ways. */
  ambiguousNumbers: boolean;
}

/**
 * The largest difference allowed between quantity x unit price and the
 * printed line total: max(0.01, 0.005 x |quantity|) + 0.005. It allows a unit
 * price printed rounded to the cent, plus the rounding of the total. For a
 * $10,000 line with quantity 1 that is about 1.5 cents, not $50.
 *
 * Why these numbers: a unit price printed to the cent can be off by up to half
 * a cent, and that error is multiplied by the quantity (0.005 x |quantity|).
 * The printed total can be off by another half cent (+ 0.005). The floor of
 * one cent covers small quantities. A percentage tolerance would allow $50 on
 * a $10,000 line, which would hide a real mistake.
 */
export function arithmeticTolerance(quantity: number): number {
  return Math.max(0.01, 0.005 * Math.abs(quantity)) + 0.005;
}

/** The facts of a row refusal made here. */
type RowInput = Extract<
  RefusalInput,
  { code: "UNPARSEABLE_NUMBER" | "NO_DESCRIPTION" | "ARITHMETIC_MISMATCH" | "AMBIGUOUS_NUMBER_FORMAT" }
>;

/** The three roles that are read as numbers. */
type NumericRole = (typeof NUMERIC_ROLES)[number];

function isNumericRole(role: Role): role is NumericRole {
  return (NUMERIC_ROLES as readonly Role[]).includes(role);
}

// ---------------------------------------------------------------------------
// The totals safety net
// ---------------------------------------------------------------------------

/**
 * The totals safety net, part 1: the words. A body row is a totals row when
 * its first cell starts with a totals label ("Total", "Subtotal", "GST") and
 * its unit price cell is empty. table.ts finds the table by layout only, so a
 * "Total" line that lines up with the columns can end up in the body. Without
 * this rule it would become a line item, and its money would be counted twice.
 *
 * The quantity may be filled: a packing list often prints the total quantity
 * on its "Total" line ("Total 25 $413.50"). A row with a unit price is a real
 * line item, whatever its words. A column that doesn't exist counts as empty.
 */
function isLabelledTotal(bodyRow: TableRow, unitPriceAt: number | undefined): boolean {
  const first = bodyRow.row.cells[0];
  if (!first || !startsWithTotalsLabel(first.text)) return false;
  return unitPriceAt === undefined || !bodyRow.cells[unitPriceAt];
}

/**
 * The room for the computer's rounding in a sum of printed amounts. Numbers
 * like 0.1 are stored with a tiny error, so a sum can be off by far less than
 * half a cent, never more.
 */
const SUM_ROUNDING = 0.005;

/**
 * The totals safety net, part 2: the numbers, in any language. An item with a
 * line total but no unit price is a running total when its line total is the
 * sum of the line totals of the items above it: "Sous-total 413,50 €", or a
 * "Continued on next page" line. `above` holds those line totals, from the
 * top of the table or from the last totals row.
 *
 * It needs at least 2 items above (one item's total equal to the next line's
 * total proves nothing), and every row since the start must have been listed
 * with a line total (`complete`), because a sum with a gap in it can't be
 * checked. Printed amounts add up exactly, so the only room allowed is for
 * the computer's rounding.
 */
function isRunningTotal(item: LineItem, above: readonly number[], complete: boolean): boolean {
  const total = item.fields.lineTotal?.value;
  if (total === undefined || item.fields.unitPrice || !complete || above.length < 2) return false;
  const sum = above.reduce((running, value) => running + value, 0);
  return Math.abs(total - sum) < SUM_ROUNDING;
}

// ---------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------

/**
 * The column a cell of a wrapped line belongs to: the column whose band holds
 * the cell's centre. The first band is open to the left and the last band is
 * open to the right, so a line that is a little wider than the table still
 * has a column.
 */
function columnOfCell(columns: readonly TableColumn[], cell: Cell): number | null {
  const centre = (cell.x0 + cell.x1) / 2;
  for (let k = 0; k < columns.length; k++) {
    const afterStart = k === 0 || centre >= columns[k].x0;
    const beforeEnd = k === columns.length - 1 || centre < columns[k].x1;
    if (afterStart && beforeEnd) return columns[k].position;
  }
  return null;
}

/**
 * Where the description ends in `sourceText`, including its wrapped lines
 * when that is possible.
 *
 * sourceText is the main row, then "\n" and each wrapped line. A span is one
 * [start, end) range, and `sourceText.slice(span)` must give back `raw`
 * exactly. So a wrapped line can only be part of the description when
 * nothing but the description sits between them. That is true when:
 *   - the description is the LAST cell of the main row, and
 *   - every cell of the wrapped line is in the description column.
 * Then the description's raw is, for example, "Pine batten\nlong length",
 * with the "\n" kept, because that is what the slice gives.
 *
 * Otherwise (the usual layout, where numbers follow the description), the
 * description is only the main row's cell. The wrapped line is still shown in
 * the item's sourceText, but it is not added to the description, because the
 * slice would also contain the quantity and the prices.
 */
function descriptionEnd(bodyRow: TableRow, cell: Cell, position: number, columns: readonly TableColumn[]): number {
  let end = cell.end;
  if (cell.end !== bodyRow.row.text.length) return end;
  let offset = bodyRow.row.text.length;
  for (const line of bodyRow.continuations) {
    // +1 for the "\n" in front of each wrapped line.
    const lineEnd = offset + 1 + line.text.length;
    if (!line.cells.every((lineCell) => columnOfCell(columns, lineCell) === position)) break;
    end = lineEnd;
    offset = lineEnd;
  }
  return end;
}

/** True when the currency marker is printed after the number ("1 195,20 €"). */
function markerAfterNumber(parts: NumberParts): boolean {
  if (parts.currencyMarker === null) return false;
  return parts.raw.lastIndexOf(parts.currencyMarker) > parts.raw.search(/\d/);
}

/** A number cell that was read: its field, and what the arithmetic check needs. */
interface ReadCell {
  field: Field;
  value: number;
  /** How many decimals were printed. */
  dp: number;
  parts: NumberParts;
}

/**
 * Reads one cell of a quantity, unit price or line total column. Returns the
 * field, or the reason the row must be refused.
 *
 * A cell is refused (UNPARSEABLE_NUMBER) when:
 *   - it is not a number, or no convention of the page reads it (when some
 *     other convention does read it, the message says that it is written in
 *     another format than the rest of the page)
 *   - it is a percentage (a percent is never a quantity or a price)
 *   - it has a "/unit" ending but is not a unit price ("$12.50 /box" as a
 *     line total): only a unit price can be "per" something
 *   - it is a quantity with a currency symbol ("$5" as a quantity). Three
 *     capital letters are fine on a quantity: in "50 KGS" they are the unit,
 *     even though KGS is also a currency code, because a quantity is never
 *     money.
 * It is refused as AMBIGUOUS_NUMBER_FORMAT when the page's conventions give
 * it two values ("1.200": 1200 or 1.2).
 */
function readNumberCell(
  role: NumericRole,
  cell: Cell,
  header: string | null,
  conventions: readonly Convention[],
  page: number,
): { ok: true; read: ReadCell } | { ok: false; problem: RowInput } {
  const parts = analyseNumber(cell.text, cell.joinSpaces);
  const reading = readNumber(parts, conventions);
  const unparseable = { ok: false as const, problem: { code: "UNPARSEABLE_NUMBER" as const, page, raw: cell.text } };

  if (parts.percent) return unparseable;
  if (parts.per !== null && role !== "unitPrice") return unparseable;
  if (parts.currencyMarker !== null && role === "quantity" && /\p{Sc}/u.test(parts.currencyMarker)) return unparseable;
  if (reading.status === "ambiguous") {
    return {
      ok: false,
      problem: {
        code: "AMBIGUOUS_NUMBER_FORMAT",
        page,
        raw: cell.text,
        // Written plainly ("1200", "1.2"): these are the same printed
        // characters read two ways, not new numbers.
        readings: [String(reading.values[0]), String(reading.values[1])],
        target: "line",
      },
    };
  }
  if (reading.status === "unreadable" && hasValidCore(parts)) {
    return { ok: false, problem: { code: "UNPARSEABLE_NUMBER", page, raw: cell.text, otherFormat: true } };
  }
  if (reading.status !== "ok") return unparseable;

  const field: Field = { header, raw: cell.text, value: reading.value, span: [cell.start, cell.end] };
  if (role === "unitPrice" && parts.per !== null) field.per = parts.per;
  if (role !== "quantity") field.currency = currencyCode(parts.currencyMarker);
  return { ok: true, read: { field, value: reading.value, dp: reading.dp, parts } };
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/** What the whole table needs to read one row. */
interface Context {
  page: number;
  table: Table;
  /** The role of each column, by position. Numeric roles are removed when no number is read. */
  roles: (Role | null)[];
  /** The position of each role's column. */
  positionOf: Partial<Record<Role, number>>;
  conventions: readonly Convention[];
  /** False on a COLUMN_MEANING_UNKNOWN page: then no number is read and no check runs. */
  readNumbers: boolean;
}

/** The result of one row: an item, or a refusal (with a flag when a cell had two readings). */
type RowResult = { item: LineItem; refusal: null; ambiguous: false } | { item: null; refusal: Refusal; ambiguous: boolean };

/**
 * The header of a column we don't read that sits between the unit price and
 * the line total ("Disc %"), or null. It may explain an arithmetic mismatch,
 * so the refusal message names it. The check still runs: guessing a discount
 * would be inventing a number.
 */
function columnBetween(context: Context): string | null {
  const price = context.positionOf.unitPrice;
  const total = context.positionOf.lineTotal;
  if (price === undefined || total === undefined) return null;
  const low = Math.min(price, total);
  const high = Math.max(price, total);
  for (const column of context.table.columns) {
    if (column.position > low && column.position < high && context.roles[column.position] === null && column.header !== null) {
      return column.header;
    }
  }
  return null;
}

/** Reads one body row into a line item, or refuses it. */
function readRow(bodyRow: TableRow, context: Context): RowResult {
  const { page, table } = context;
  const row = bodyRow.row;
  // The row's evidence: the main row, then each wrapped line after a "\n".
  // Every span below is an offset into this text.
  const sourceText = [row.text, ...bodyRow.continuations.map((line) => line.text)].join("\n");
  const evidence = [{ page, sourceText }];

  const fields: Partial<Record<Role, Field>> = {};
  const otherCells: OtherCell[] = [];
  const missing: Role[] = [];
  const numbers: Partial<Record<NumericRole, ReadCell>> = {};
  let problem: RowInput | null = null;
  let ambiguous = false;

  for (const column of table.columns) {
    const role = context.roles[column.position];
    const cell = bodyRow.cells[column.position] ?? null;

    if (role === null) {
      // Shown as printed. An empty cell is kept as "" so every item has the
      // same other columns.
      otherCells.push({ header: column.header, key: column.key, raw: cell?.text ?? "" });
      continue;
    }
    if (cell === null) {
      // Never filled in, never calculated.
      missing.push(role);
      continue;
    }
    if (isNumericRole(role)) {
      const result = readNumberCell(role, cell, column.header, context.conventions, page);
      if (result.ok) {
        fields[role] = result.read.field;
        numbers[role] = result.read;
      } else {
        if (result.problem.code === "AMBIGUOUS_NUMBER_FORMAT") ambiguous = true;
        // The first problem from the left is the one the refusal names.
        problem ??= result.problem;
      }
      continue;
    }
    const end = role === "description" ? descriptionEnd(bodyRow, cell, column.position, table.columns) : cell.end;
    fields[role] = { header: column.header, raw: sourceText.slice(cell.start, end), span: [cell.start, end] };
  }

  const refuse = (input: RowInput): RowResult => ({
    item: null,
    refusal: rowRefusal(input, row.index, evidence),
    ambiguous,
  });

  if (problem) return refuse(problem);

  // Numbers with no description: we can't tell what they belong to. The row
  // is never merged with a nearby row, and never dropped silently.
  if (context.readNumbers && Object.keys(numbers).length > 0 && !fields.description) {
    return refuse({ code: "NO_DESCRIPTION", page, rowText: row.text });
  }

  // The arithmetic check, when the row has all three numbers.
  const { quantity, unitPrice, lineTotal } = numbers;
  if (quantity && unitPrice && lineTotal) {
    const product = quantity.value * unitPrice.value;
    if (Math.abs(product - lineTotal.value) > arithmeticTolerance(quantity.value)) {
      return refuse({
        code: "ARITHMETIC_MISMATCH",
        page,
        quantity: quantity.field.raw,
        unitPrice: unitPrice.field.raw,
        lineTotal: lineTotal.field.raw,
        // Written like the line total: its decimals, its currency marker, the
        // document's decimal and thousands marks.
        expected: formatNumber(
          product,
          lineTotal.dp,
          context.conventions,
          lineTotal.parts.currencyMarker,
          markerAfterNumber(lineTotal.parts),
        ),
        columnBetween: columnBetween(context),
      });
    }
  }

  const item: LineItem = {
    id: `p${page}-r${row.index}`,
    page,
    rowIndex: row.index,
    sourceText,
    fields,
    otherCells,
    missing,
  };
  return { item, refusal: null, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The mixed "total" wording warning. A column we don't read where
 * some cells contain the word "total" and others don't ("25kg" next to
 * "480g total") mixes per-item figures with totals. The note quotes two
 * examples, one of each kind, in the order they appear in the table.
 *
 * A column with no heading gets no note: the note names the column by its
 * heading, and notes.ts has no wording for a column without one.
 */
function mixedTotalNotes(context: Context, rows: readonly TableRow[]): Note[] {
  const notes: Note[] = [];
  for (const column of context.table.columns) {
    if (context.roles[column.position] !== null || column.header === null) continue;
    const texts = rows.flatMap((bodyRow) => {
      const cell = bodyRow.cells[column.position];
      return cell ? [cell.text] : [];
    });
    const withWord = texts.find((text) => findWord(text, TOTAL_WORD) !== null);
    const withoutWord = texts.find((text) => findWord(text, TOTAL_WORD) === null);
    if (withWord === undefined || withoutWord === undefined) continue;
    const examples = texts.indexOf(withWord) < texts.indexOf(withoutWord) ? [withWord, withoutWord] : [withoutWord, withWord];
    notes.push(NOTES.mixedTotalWording(context.page, column.header, examples));
  }
  return notes;
}

/**
 * True when an item's description goes on to a wrapped line that is not in
 * the description's raw text, so part of it is only in the item's sourceText
 * (see descriptionEnd for why that happens).
 */
function descriptionIsShort(item: LineItem, context: Context): boolean {
  const description = item.fields.description;
  const position = context.positionOf.description;
  if (!description?.span || position === undefined) return false;
  const bodyRow = context.table.body.find((row) => row.row.index === item.rowIndex);
  if (!bodyRow || description.span[1] > bodyRow.row.text.length) return false;
  return bodyRow.continuations.some((line) =>
    line.cells.some((cell) => columnOfCell(context.table.columns, cell) === position),
  );
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Builds the line items of one table. Never computes a value that goes into
 * the output: every number is read from its cell, and every cell keeps its
 * raw text and its span in the row. `decision.refusal` may be
 * COLUMN_MEANING_UNKNOWN (rows are then listed as printed, with no numbers);
 * it is never AMBIGUOUS_COLUMNS (the caller doesn't list those pages).
 *
 * On a COLUMN_MEANING_UNKNOWN page, each item has fields only for the text
 * roles that were decided (such as a description), every other cell is in
 * otherCells, no number is read, and no check runs (not even NO_DESCRIPTION,
 * which is about numbers).
 *
 * If an AMBIGUOUS_COLUMNS decision arrives anyway, nothing is listed: that
 * page's columns can't be trusted, so this is the safe answer.
 */
export function buildItems(page: number, table: Table, decision: RoleDecision, conventions: readonly Convention[]): ItemsResult {
  const result: ItemsResult = { items: [], refusals: [], notes: [], totalsRows: [], ambiguousNumbers: false };
  if (decision.refusal?.code === "AMBIGUOUS_COLUMNS") return result;

  const readNumbers = decision.refusal?.code !== "COLUMN_MEANING_UNKNOWN";
  const roles = table.columns.map((column) => {
    const role = decision.columns[column.position]?.role ?? null;
    return role !== null && isNumericRole(role) && !readNumbers ? null : role;
  });
  const positionOf: Partial<Record<Role, number>> = {};
  roles.forEach((role, position) => {
    if (role !== null) positionOf[role] ??= position;
  });
  const context: Context = { page, table, roles, positionOf, conventions, readNumbers };

  const itemRows: TableRow[] = [];
  // The line totals of the items since the top of the table or the last
  // totals row, for the running-total rule (see isRunningTotal).
  let above: number[] = [];
  let complete = true;
  const moveOut = (row: Row) => {
    result.totalsRows.push(row);
    result.notes.push(NOTES.totalsRowSkipped(page, row.text));
    above = [];
    complete = true;
  };

  for (const bodyRow of table.body) {
    if (isLabelledTotal(bodyRow, positionOf.unitPrice)) {
      moveOut(bodyRow.row);
      continue;
    }
    const rowResult = readRow(bodyRow, context);
    if (rowResult.item && isRunningTotal(rowResult.item, above, complete)) {
      moveOut(bodyRow.row);
      continue;
    }
    itemRows.push(bodyRow);
    if (rowResult.item) {
      result.items.push(rowResult.item);
      const total = rowResult.item.fields.lineTotal?.value;
      if (total === undefined) complete = false;
      else above.push(total);
    } else {
      result.refusals.push(rowResult.refusal);
      complete = false;
    }
    if (rowResult.ambiguous) result.ambiguousNumbers = true;
  }

  result.notes.push(...mixedTotalNotes(context, itemRows));
  if (result.items.some((item) => descriptionIsShort(item, context))) result.notes.push(NOTES.descriptionWraps(page));
  return result;
}
