/**
 * Finding the table on a page by its LAYOUT, in any language, without reading
 * any words.
 *
 * rows.ts has already turned the page into rows of cells. This file finds the
 * line-item table among those rows. It looks only at where the cells are and
 * at their shapes (NUM, NUMX or TEXT, from shapes.ts). It never reads a word,
 * so it works the same for English, French or Vietnamese. The one exception is
 * a "carried forward" line, which is found by its words (see below).
 *
 * The idea is "body first, header attached by overlap":
 *
 *   1. Set aside "carried forward" lines. They repeat a total from another
 *      page, so they must never become a line item.
 *   2. Find the bodies. A body starts at a row with at least MIN_CELLS cells
 *      and a number. Its cells start the columns. The next rows join while
 *      their cells line up with the columns (left, right or centre edge). A
 *      thin line of text just under a row is a wrapped description (a
 *      continuation). The body ends at the first row that fits neither rule.
 *      That is how the totals and the notes under the table stay outside it.
 *   3. Attach each body's header. It is the all-text row right above the
 *      body. Each header cell goes to the column it overlaps most. A second
 *      header line just above it is merged in ("Unit" above "Price").
 *   4. Choose the item table: of all the tables found, the first one with the
 *      most number columns. A small block such as a payment schedule
 *      ("Deposit | 14 days | $124.05") has fewer number columns than a table of
 *      items with a quantity, a price and a total. Other tables are not read,
 *      and the page gets a warning note for each.
 *   5. Look further down the page. A later run of rows that lines up with the
 *      same columns continues the table: the lines in between are section
 *      headings, or short lines such as a discount under an item.
 *
 * Why body first: a header is often centred over its column, so it shares no
 * edge with the cells. The body cells share edges with each other much more
 * reliably. These rules found every table on the six samples and on the
 * language and layout test pages in tests/fixtures.
 *
 * How to read it: `findTable` at the bottom is the whole step. Above it, in
 * order: the column helpers, `matchRow` (does a row fit the columns?),
 * `growBody` (step 2), `attachHeader` (step 3), the later runs (step 5), and
 * the functions that turn a run into the exported `Table`.
 */
import type { Note } from "@/lib/contract/schema";
import { NOTES } from "@/lib/contract/notes";

import type { Cell, Row } from "./rows";
import { CARRIED_FORWARD, findWord } from "./vocabulary";

/**
 * Cell edges must line up within this many font sizes to be in the same
 * column. At font size 9 this is 3.15 pt. Cells of one column in real
 * documents share an edge to well under 1 pt, and the gap between two columns
 * is many font sizes. It can't be much smaller either: on the test pages,
 * moving cells sideways by 2 pt or more already starts to split columns.
 */
export const ALIGN_TOL = 0.35;
/**
 * A table row needs at least this many cells. A "Label: value" line or a
 * two-column key/value block (like "Total" and "$276.00") has only 1 or 2, so
 * they are never read as a table. The price is that a real two-column table
 * is missed, which is a known and accepted limit.
 */
export const MIN_CELLS = 3;
/**
 * A wrapped line joins the row above when it is closer than this share of the
 * normal row gap. In the samples a wrapped line would sit about half a row gap
 * below its row, while notes and totals sit about two row gaps below the last
 * row. 0.8 keeps both cases clearly apart.
 */
export const CONT_GAP = 0.8;
/**
 * A second header line must be closer than this many font sizes to the header
 * below it. Two lines of one header are printed about one line height apart
 * (1.1 to 1.2 font sizes). The "Label: value" lines above a table are further
 * away. The same limit is used for a wrapped line under the FIRST body row,
 * when the normal row gap is not known yet.
 */
export const HEADER_LINE_GAP = 1.3;
/**
 * A column is numeric when at least this share of its body cells look like
 * numbers. Half, because a quantity or price column can have a few text cells
 * ("n/a", "POA") and is still a number column.
 */
export const NUMERIC_KIND_SHARE = 0.5;

/**
 * The header may be at most this many row gaps above the first body row. In
 * the samples it is a little more than one row gap above, because a dashed
 * line sits between them. Two row gaps leaves room for that and no more.
 */
const HEADER_MAX_PITCHES = 2;
/**
 * The header may also be this many font sizes above the first body row, when
 * that is more than the limit above. This matters when the table has only
 * one body row, so no row gap is known.
 */
const HEADER_MAX_FONT_SIZES = 3;
/**
 * A line with a number between two parts of a table (a discount under an
 * item, a subtotal) keeps the two parts together only when the rows keep the
 * table's spacing: each step, from the table to the line and from the line to
 * the next part, may be at most this many normal row gaps. A totals block
 * followed by a new table usually leaves a clear gap, so it is not joined.
 */
const JOIN_MAX_PITCHES = 1.5;

/** One column of a table, as found from the layout. */
export interface TableColumn {
  /** The column's position, left to right, starting at 0. */
  position: number;
  /**
   * The header exactly as printed, or null when the column has no heading.
   * A two-line header is joined with one space, top line first ("Unit Price").
   * Two header cells over one column are joined with one space, left to right.
   */
  header: string | null;
  /**
   * A mechanical key made from the header: NFC, lower case, only letters and
   * digits, camelCase ("Unit Price" -> "unitPrice", "Prix unitaire" ->
   * "prixUnitaire", "QTY." -> "qty"). When nothing is left ("#") or there is
   * no header, it is `col{n}` with n = position + 1. A repeated key gets 2, 3...
   * ("weight2").
   */
  key: string;
  /** "numeric" when at least NUMERIC_KIND_SHARE of the body cells are NUM or NUMX, else "text". */
  kind: "numeric" | "text";
  /**
   * The column's band on the page, in points: a cell belongs to this column
   * when its horizontal centre is inside [x0, x1). Used only inside the engine.
   *
   * The bands touch. The border between two columns is halfway across the
   * empty space between them. That space starts at the right-most edge of the
   * left column (its body and header cells) and ends at the left-most edge of
   * the right column. The first band starts at its column's left-most edge and
   * the last band ends at its column's right-most edge. So a wrapped line that
   * is a little longer than every cell above it still falls into its own
   * column.
   */
  x0: number;
  x1: number;
}

/** One body row of a table. */
export interface TableRow {
  /** The main row. Its `index` is the line item's rowIndex. */
  row: Row;
  /** Wrapped lines that belong to this row (a description on two lines), top to bottom. */
  continuations: Row[];
  /**
   * The cell in each column, by column position; null when that column is
   * empty in this row. Cells from `continuations` are NOT merged in here.
   * A cell that reaches into a neighbouring column is a copy of the row's cell
   * with extra join spaces (see `markJoinedCells`); its text and offsets are
   * the same.
   */
  cells: (Cell | null)[];
}

/** A table found on a page. */
export interface Table {
  /** The columns, left to right. */
  columns: TableColumn[];
  /** The header row(s): none, one, or two for a two-line header (top line first). */
  headerRows: Row[];
  /** The body rows, top to bottom. */
  body: TableRow[];
}

/** Everything the layout tells us about a page. */
export interface PageLayout {
  /** Every row on the page (from rows.ts). */
  rows: Row[];
  /** The table, or null when the page has no table. */
  table: Table | null;
  /**
   * Rows above the table: above the header, or above the first body row when
   * there is no header. Title lines and "Label: value" lines live here.
   * When there is no table, every row of the page is here.
   * Carried-forward lines that were set aside are never here, and neither
   * are the rows of another table above the item table.
   */
  above: Row[];
  /**
   * Rows after the table's last body row (and its wrapped lines): printed
   * totals and notes. The rows of another table that was not read are here
   * too. Carried-forward lines that were set aside are never here. Empty when
   * there is no table.
   */
  below: Row[];
  /**
   * Notes found while detecting: a carried-forward line that was set aside,
   * a section heading or a short line between two parts of one table, another
   * table that wasn't read (see NOTES in contract/notes.ts).
   */
  notes: Note[];
}

// ---------------------------------------------------------------------------
// Columns while they are being built
// ---------------------------------------------------------------------------

/**
 * A column while the body grows. It remembers the edges of every body cell,
 * so a new cell can be compared with the column's typical (median) edges.
 *
 * The three edge lists are kept sorted from small to large, so the median is
 * simply the middle entry. Without that, every comparison would have to sort
 * the column again, and a page with hundreds of rows and many columns would
 * take many seconds.
 */
interface Column {
  lefts: number[];
  rights: number[];
  centres: number[];
  /** The body cells in this column, top to bottom. */
  cells: Cell[];
}

/** A column in a finished run: a body column, or a header-only column (a header over no body cells). */
interface FinalColumn {
  /** The body column, or null for a header-only column. */
  body: Column | null;
  /** The header text parts of the top header line (two-line headers), left to right. */
  topParts: string[];
  /** The header text parts of the main header line, left to right. */
  mainParts: string[];
  /** The header cells over this column, for its band. */
  headerCells: Cell[];
}

/** One body row while the body grows. */
interface BodyRow {
  row: Row;
  continuations: Row[];
  /** The cell of each column in this row. A column that is missing here is empty in this row. */
  cells: Map<Column, Cell>;
}

/** A run of rows that line up: the body of a table, without its header. */
interface Run {
  columns: Column[];
  body: BodyRow[];
  /** The median distance between two body rows, or null with only one body row. */
  pitch: number | null;
  /** Index (in the searched row list) of the run's first body row. */
  startIndex: number;
  /** Index (in the searched row list) of the run's last row: its last body row or that row's last wrapped line. */
  endIndex: number;
}

/**
 * The median of a list of numbers that is already sorted. With an even count
 * this takes the upper of the two middle values. The list must not be empty.
 */
function medianOfSorted(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)];
}

/** Puts `value` into a sorted list at its place, so the list stays sorted. */
function insertSorted(list: number[], value: number): void {
  // Binary search for the first entry that is larger than `value`.
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] <= value) low = middle + 1;
    else high = middle;
  }
  list.splice(low, 0, value);
}

function newColumn(): Column {
  return { lefts: [], rights: [], centres: [], cells: [] };
}

function addCell(column: Column, cell: Cell): void {
  insertSorted(column.lefts, cell.x0);
  insertSorted(column.rights, cell.x1);
  insertSorted(column.centres, (cell.x0 + cell.x1) / 2);
  column.cells.push(cell);
}

/** The horizontal span that the column's body cells cover. The lists are sorted, so this is the first left and the last right. */
function bandOf(column: Column): { lo: number; hi: number } {
  return { lo: column.lefts[0], hi: column.rights[column.rights.length - 1] };
}

/** How much two spans [a0, a1] and [b0, b1] overlap, in points. Zero or less means they don't. */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/**
 * How far a cell is from lining up with a column: the smallest of the
 * distances between its left edge, right edge and centre and the column's
 * median left edge, right edge and centre. Left-aligned, right-aligned and
 * centred columns are all found this way, without knowing which one it is.
 */
function edgeDistance(cell: Cell, column: Column): number {
  return Math.min(
    Math.abs(cell.x0 - medianOfSorted(column.lefts)),
    Math.abs(cell.x1 - medianOfSorted(column.rights)),
    Math.abs((cell.x0 + cell.x1) / 2 - medianOfSorted(column.centres)),
  );
}

/** True when a row has at least one cell that looks like a number (NUM or NUMX). */
function hasNumber(row: Row): boolean {
  return row.cells.some((cell) => cell.shape !== "TEXT");
}

/** "numeric" when at least NUMERIC_KIND_SHARE of the column's body cells look like numbers. */
function kindOf(column: Column | null): "numeric" | "text" {
  if (!column || column.cells.length === 0) return "text";
  const numbers = column.cells.filter((cell) => cell.shape !== "TEXT").length;
  return numbers / column.cells.length >= NUMERIC_KIND_SHARE ? "numeric" : "text";
}

/** How many of a run's columns are numeric. Used to choose the item table (step 4). */
function numericColumnCount(run: Run): number {
  return run.columns.filter((column) => kindOf(column) === "numeric").length;
}

/** The y of a body row's last line: its last wrapped line, or the row itself. */
function lastLineY(bodyRow: BodyRow): number {
  const { continuations } = bodyRow;
  return continuations.length > 0 ? continuations[continuations.length - 1].y : bodyRow.row.y;
}

// ---------------------------------------------------------------------------
// Matching a row to the columns
// ---------------------------------------------------------------------------

/**
 * How a row's cells fit the columns: for each cell, the column it lines up
 * with, or null when the cell starts a new column. `fresh` counts the nulls.
 */
interface RowMatch {
  map: (Column | null)[];
  fresh: number;
}

/**
 * Matches a row's cells to the columns. Returns null when the row doesn't fit.
 *
 * Each cell goes to the column whose edges it is closest to, when that
 * distance is at most `tolerance`. Two cells in one column means the row
 * doesn't fit. A cell that lines up with no column may start a new column
 * (a column that was empty in the rows so far, like a "Disc %" column), but
 * only one such cell per row, and only when it overlaps no existing column.
 */
function matchRow(row: Row, columns: readonly Column[], tolerance: number): RowMatch | null {
  const used = new Set<Column>();
  const map: (Column | null)[] = [];
  let fresh = 0;
  for (const cell of row.cells) {
    let best: Column | null = null;
    let bestDistance = Infinity;
    for (const column of columns) {
      const distance = edgeDistance(cell, column);
      if (distance <= tolerance && distance < bestDistance) {
        best = column;
        bestDistance = distance;
      }
    }
    if (best) {
      if (used.has(best)) return null;
      used.add(best);
      map.push(best);
      continue;
    }
    const clash = columns.some((column) => {
      const band = bandOf(column);
      return overlap(cell.x0, cell.x1, band.lo, band.hi) > 0;
    });
    if (clash) return null;
    fresh++;
    map.push(null);
  }
  if (fresh > 1) return null;
  return { map, fresh };
}

// ---------------------------------------------------------------------------
// Step 2: the body
// ---------------------------------------------------------------------------

/** True for a row that may start a table body: at least MIN_CELLS cells, and a number. */
function canStartBody(row: Row): boolean {
  return row.cells.length >= MIN_CELLS && hasNumber(row);
}

/**
 * Grows a table body from `rows[startIndex]` downwards.
 *
 * A row joins as a body row when it matches the columns (see matchRow), has
 * at least MIN_CELLS cells of which at least MIN_CELLS - 1 line up with
 * existing columns, and has a number.
 *
 * Otherwise it joins the last body row as a continuation (a wrapped
 * description) when all of its cells line up with existing TEXT columns, it
 * starts no new column, and it is close to the line just above it (the body
 * row, or its previous wrapped line): less than CONT_GAP x the median row
 * gap. Right after the first body row no row gap is known yet, so the limit
 * is HEADER_LINE_GAP x the font size.
 *
 * The first row that fits neither rule ends the body.
 */
function growBody(rows: readonly Row[], startIndex: number): Run {
  const start = rows[startIndex];
  const tolerance = ALIGN_TOL * start.fontSize;
  const columns: Column[] = [];
  const firstCells = new Map<Column, Cell>();
  for (const cell of start.cells) {
    const column = newColumn();
    addCell(column, cell);
    columns.push(column);
    firstCells.set(column, cell);
  }
  const body: BodyRow[] = [{ row: start, continuations: [], cells: firstCells }];
  const pitches: number[] = [];
  let endIndex = startIndex;

  for (let j = startIndex + 1; j < rows.length; j++) {
    const row = rows[j];
    const last = body[body.length - 1];
    const match = matchRow(row, columns, tolerance);
    const aligned = match ? match.map.filter((column) => column !== null).length : 0;
    if (match && row.cells.length >= MIN_CELLS && aligned >= MIN_CELLS - 1 && hasNumber(row)) {
      const cells = new Map<Column, Cell>();
      match.map.forEach((matched, k) => {
        let column = matched;
        if (!column) {
          column = newColumn();
          columns.push(column);
        }
        addCell(column, row.cells[k]);
        cells.set(column, row.cells[k]);
      });
      // The row gap is measured between body rows, so a row with a wrapped
      // description counts as one taller row.
      insertSorted(pitches, row.y - last.row.y);
      body.push({ row, continuations: [], cells });
      endIndex = j;
      continue;
    }
    const limit = pitches.length > 0 ? CONT_GAP * medianOfSorted(pitches) : HEADER_LINE_GAP * last.row.fontSize;
    const inTextColumns = match !== null && match.map.every((column) => column !== null && kindOf(column) === "text");
    // Measured from the line just above, so a description on three lines
    // keeps all of its wrapped lines.
    if (match && match.fresh === 0 && inTextColumns && row.y - lastLineY(last) < limit) {
      last.continuations.push(row);
      endIndex = j;
      continue;
    }
    break;
  }

  columns.sort((a, b) => bandOf(a).lo - bandOf(b).lo);
  return { columns, body, pitch: pitches.length > 0 ? medianOfSorted(pitches) : null, startIndex, endIndex };
}

// ---------------------------------------------------------------------------
// Step 3: the header
// ---------------------------------------------------------------------------

/** A header found for a run: its rows (top line first) and the final columns with their header parts. */
interface Header {
  rows: Row[];
  columns: FinalColumn[];
}

/** True for a row whose cells are all TEXT. */
function allText(row: Row): boolean {
  return row.cells.every((cell) => cell.shape === "TEXT");
}

/** The horizontal distance between a span and a column's band: 0 when they overlap. */
function distanceToBand(x0: number, x1: number, column: Column): number {
  const band = bandOf(column);
  return Math.max(0, band.lo - x1, x0 - band.hi);
}

/**
 * The body columns right next to a header cell that overlaps no column: the
 * nearest one that ends before the cell starts, and the nearest one that
 * starts after the cell ends. Zero, one or two columns.
 */
function neighboursOf(cell: Cell, finals: readonly FinalColumn[]): FinalColumn[] {
  let left: FinalColumn | null = null;
  let right: FinalColumn | null = null;
  for (const final of finals) {
    if (!final.body) continue;
    const band = bandOf(final.body);
    if (band.hi <= cell.x0 && (!left?.body || band.hi > bandOf(left.body).hi)) left = final;
    if (band.lo >= cell.x1 && (!right?.body || band.lo < bandOf(right.body).lo)) right = final;
  }
  return [left, right].filter((final): final is FinalColumn => final !== null);
}

/**
 * Finds the header of a run: the row right above the first body row, when it
 * is all TEXT, has at least 2 cells, and is no further above the first body
 * row than max(2 x row gap, 3 x font size). Returns null when there is none.
 *
 * Carried-forward lines were taken out of `rows` before the search. When one
 * sat between the header and the first body row, the distance is measured to
 * that line instead, because on the page it is the first line under the
 * header (`setAside` holds those lines).
 *
 * Each header cell goes to the column band it overlaps most. A header cell
 * that overlaps no band goes to the column right next to it (on its left or
 * its right) when that column got no header cell of its own. This happens
 * when headings are printed at the left of each column and the numbers at
 * the right, so they don't overlap. Otherwise the header cell makes a
 * header-only column: a column that is empty in every row, like a "Disc %"
 * column with no discounts. Two header cells over one band are both kept,
 * left to right.
 *
 * A second all-TEXT line directly above, closer than HEADER_LINE_GAP x the
 * font size, whose cells each overlap a header cell, is the top line of a
 * two-line header. Each of its cells goes to the column of the header cell it
 * overlaps most.
 */
function attachHeader(rows: readonly Row[], run: Run, setAside: readonly Row[]): Header | null {
  const headerIndex = run.startIndex - 1;
  if (headerIndex < 0) return null;
  const header = rows[headerIndex];
  const first = run.body[0].row;
  const betweenY = setAside.filter((row) => row.y > header.y && row.y < first.y).map((row) => row.y);
  const topOfBody = Math.min(first.y, ...betweenY);
  const maxGap = Math.max(HEADER_MAX_PITCHES * (run.pitch ?? 0), HEADER_MAX_FONT_SIZES * first.fontSize);
  if (header.cells.length < 2 || !allText(header) || topOfBody - header.y > maxGap) return null;

  const finals: FinalColumn[] = run.columns.map((body) => ({ body, topParts: [], mainParts: [], headerCells: [] }));
  const ownerOf = new Map<Cell, FinalColumn>();
  const give = (cell: Cell, final: FinalColumn) => {
    final.mainParts.push(cell.text);
    final.headerCells.push(cell);
    ownerOf.set(cell, final);
  };

  // First the header cells that overlap a column.
  const leftOver: Cell[] = [];
  for (const cell of header.cells) {
    let best: FinalColumn | null = null;
    let bestOverlap = 0;
    for (const final of finals) {
      if (!final.body) continue;
      const band = bandOf(final.body);
      const amount = overlap(cell.x0, cell.x1, band.lo, band.hi);
      if (amount > bestOverlap) {
        best = final;
        bestOverlap = amount;
      }
    }
    if (best) give(cell, best);
    else leftOver.push(cell);
  }

  // Then the ones that overlap none. Such a cell goes to the column right
  // next to it on its left or on its right, whichever is nearer, but only to
  // one that has no header cell yet. Otherwise it makes a header-only column.
  // Left to right, so when two cells want the same column, the left one gets
  // it. A column gets either the cells that overlap it or one such cell, so
  // its parts stay left to right.
  for (const cell of leftOver) {
    let nearest: FinalColumn | null = null;
    let nearestDistance = Infinity;
    for (const neighbour of neighboursOf(cell, finals)) {
      if (neighbour.headerCells.length > 0 || !neighbour.body) continue;
      const distance = distanceToBand(cell.x0, cell.x1, neighbour.body);
      if (distance < nearestDistance) {
        nearest = neighbour;
        nearestDistance = distance;
      }
    }
    if (nearest) {
      give(cell, nearest);
    } else {
      const headerOnly: FinalColumn = { body: null, topParts: [], mainParts: [], headerCells: [] };
      finals.push(headerOnly);
      give(cell, headerOnly);
    }
  }

  const headerRows = [header];
  const top = headerIndex > 0 ? rows[headerIndex - 1] : null;
  if (top && allText(top) && header.y - top.y < HEADER_LINE_GAP * header.fontSize) {
    // For each cell of the top line: the header cell below it that it overlaps most.
    const below = top.cells.map((cell) => {
      let best: Cell | null = null;
      let bestOverlap = 0;
      for (const headerCell of header.cells) {
        const amount = overlap(cell.x0, cell.x1, headerCell.x0, headerCell.x1);
        if (amount > bestOverlap) {
          best = headerCell;
          bestOverlap = amount;
        }
      }
      return best;
    });
    if (below.every((cell) => cell !== null)) {
      top.cells.forEach((cell, k) => {
        const owner = ownerOf.get(below[k] as Cell) as FinalColumn;
        owner.topParts.push(cell.text);
        owner.headerCells.push(cell);
      });
      headerRows.unshift(top);
    }
  }
  return { rows: headerRows, columns: finals };
}

/** True when a run is a table: a numeric column, and 2 body rows (1 is enough with a header). */
function isTable(run: Run, header: Header | null): boolean {
  return run.columns.some((column) => kindOf(column) === "numeric") && run.body.length >= (header ? 1 : 2);
}

// ---------------------------------------------------------------------------
// Step 5: later runs
// ---------------------------------------------------------------------------

/**
 * For a later run: the column of the table that each cell of each body row
 * lines up with. Returns null when any cell lines up with none of them (or
 * two cells with one), so the run is not part of the same table.
 */
function alignRun(run: Run, table: Run): Map<Column, Cell>[] | null {
  const tolerance = ALIGN_TOL * table.body[0].row.fontSize;
  const result: Map<Column, Cell>[] = [];
  for (const bodyRow of run.body) {
    const match = matchRow(bodyRow.row, table.columns, tolerance);
    if (!match || match.fresh > 0) return null;
    const cells = new Map<Column, Cell>();
    match.map.forEach((column, k) => cells.set(column as Column, bodyRow.row.cells[k]));
    result.push(cells);
  }
  return result;
}

/**
 * True when the lines between the table and a later run may sit inside one
 * table. Lines without numbers are headings ("Stage 2 - Decking") and are
 * always allowed, as before. A line with a number (a discount under an item,
 * a subtotal of a section) is allowed only when:
 *   - every one of its cells lines up with a column of the table, and
 *   - the rows keep the table's spacing: from the table's last line to the
 *     later run's first row there are at most JOIN_MAX_PITCHES row gaps per
 *     step. With no row gap known yet (both parts have one row), this can't
 *     be checked, so the parts are not joined.
 */
function mayJoin(between: readonly Row[], later: Run, table: Run): boolean {
  if (!between.some(hasNumber)) return true;
  const tolerance = ALIGN_TOL * table.body[0].row.fontSize;
  const linesUp = between.every((row) => {
    if (!hasNumber(row)) return true;
    const match = matchRow(row, table.columns, tolerance);
    return match !== null && match.fresh === 0;
  });
  const pitch = table.pitch ?? later.pitch;
  if (!linesUp || pitch === null) return false;
  const steps = between.length + 1;
  const distance = later.body[0].row.y - lastLineY(table.body[table.body.length - 1]);
  return distance <= steps * JOIN_MAX_PITCHES * pitch;
}

// ---------------------------------------------------------------------------
// Building the exported table
// ---------------------------------------------------------------------------

/**
 * The mechanical key for one header, before repeated keys are numbered (see
 * TableColumn.key). `position` counts from 0.
 *
 * The header is put in Unicode NFC form (so "é" typed as "e" plus an accent
 * is the same as "é"), lower-cased, and split into words at every character
 * that is not a letter or a digit (\p{L} and \p{N} are the Unicode classes,
 * so "Désignation" and "Mô tả" keep their letters). The words are joined in
 * camelCase: "Unit Price" -> "unitPrice", "Part No." -> "partNo",
 * "Disc %" -> "disc".
 */
export function columnKey(header: string | null, position: number): string {
  const words = (header ?? "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return `col${position + 1}`;
  return words
    .map((word, i) => {
      if (i === 0) return word;
      const [firstChar, ...rest] = Array.from(word);
      return firstChar.toUpperCase() + rest.join("");
    })
    .join("");
}

/**
 * Gives every column its final key: a repeated key gets 2, 3... in order from
 * the left ("weight", "weight2"). A number that is already taken (a header
 * that itself reads "Weight 2") is skipped, so every key stays different.
 */
function uniqueKeys(keys: readonly string[]): string[] {
  const taken = new Set<string>();
  return keys.map((key) => {
    let result = key;
    for (let n = 2; taken.has(result); n++) result = `${key}${n}`;
    taken.add(result);
    return result;
  });
}

/** The left-most and right-most edge of everything in a final column: its body cells and its header cells. */
function extentOf(final: FinalColumn): { lo: number; hi: number } {
  const lefts = [...(final.body?.lefts ?? []), ...final.headerCells.map((cell) => cell.x0)];
  const rights = [...(final.body?.rights ?? []), ...final.headerCells.map((cell) => cell.x1)];
  return { lo: Math.min(...lefts), hi: Math.max(...rights) };
}

/** True when a cell's text has a space in it. */
function hasSpace(cell: Cell): boolean {
  return /\s/u.test(cell.text);
}

/** A copy of `cell` in which every space counts as a join space (see Cell.joinSpaces). */
function withSpacesAsJoins(cell: Cell): Cell {
  const joinSpaces: number[] = [];
  for (let offset = 0; offset < cell.text.length; offset++) {
    if (/\s/u.test(cell.text[offset])) joinSpaces.push(offset);
  }
  return { ...cell, joinSpaces };
}

/**
 * Marks the number cells that are probably two cells run together.
 *
 * pdf.js joins text that is drawn close together into one piece with a space
 * in it, before rows.ts ever sees it. A quantity "2" drawn just left of a price
 * "150.00" can arrive as one cell "2 150.00", which a space-grouping format
 * would read as 2150. When such a cell reaches into the band of another
 * column, every space in it becomes a join space, so numbers.ts never reads
 * it as one number with a thousands space. The row is then refused as a
 * number we can't read, instead of giving a wrong value.
 *
 * A column's band here is made only from its number cells without a space,
 * so a joined cell never widens the band that it is tested against.
 * This can't catch a joined cell whose neighbouring column has no clean cell
 * anywhere in the table (see NumberParts.spaceAtJoin).
 */
function markJoinedCells(ordered: readonly FinalColumn[], body: TableRow[]): void {
  const bands = ordered.map((final) => {
    const clean = (final.body?.cells ?? []).filter((cell) => cell.shape !== "TEXT" && !hasSpace(cell));
    if (clean.length === 0) return null;
    return { lo: Math.min(...clean.map((cell) => cell.x0)), hi: Math.max(...clean.map((cell) => cell.x1)) };
  });
  for (const bodyRow of body) {
    bodyRow.cells = bodyRow.cells.map((cell, position) => {
      if (!cell || cell.shape === "TEXT" || !hasSpace(cell)) return cell;
      const reaches = bands.some(
        (band, other) => other !== position && band !== null && overlap(cell.x0, cell.x1, band.lo, band.hi) > 0,
      );
      return reaches ? withSpacesAsJoins(cell) : cell;
    });
  }
}

/**
 * Turns a run (with its header, if any) into the exported Table: columns in
 * left-to-right order with positions, headers, keys, kinds and bands, and each
 * body row's cells by column position.
 */
function toTable(run: Run, header: Header | null): Table {
  const finals: FinalColumn[] =
    header?.columns ?? run.columns.map((body) => ({ body, topParts: [], mainParts: [], headerCells: [] }));
  // Body columns sort by their body cells' left edge. A header-only column
  // sorts by its header's left edge, since it has no body cells.
  const sortKey = (final: FinalColumn): number =>
    final.body ? bandOf(final.body).lo : Math.min(...final.headerCells.map((cell) => cell.x0));
  const ordered = [...finals].sort((a, b) => sortKey(a) - sortKey(b));

  const extents = ordered.map(extentOf);
  const headers = ordered.map((final) => {
    const parts = [...final.topParts, ...final.mainParts];
    return parts.length > 0 ? parts.join(" ") : null;
  });
  const keys = uniqueKeys(headers.map((text, position) => columnKey(text, position)));
  const columns: TableColumn[] = ordered.map((final, position) => ({
    position,
    header: headers[position],
    key: keys[position],
    kind: kindOf(final.body),
    x0: position === 0 ? extents[0].lo : (extents[position - 1].hi + extents[position].lo) / 2,
    x1: position === ordered.length - 1 ? extents[position].hi : (extents[position].hi + extents[position + 1].lo) / 2,
  }));

  const body: TableRow[] = run.body.map((bodyRow) => ({
    row: bodyRow.row,
    continuations: [...bodyRow.continuations],
    cells: ordered.map((final) => (final.body ? (bodyRow.cells.get(final.body) ?? null) : null)),
  }));
  markJoinedCells(ordered, body);
  return { columns, headerRows: header?.rows ?? [], body };
}

// ---------------------------------------------------------------------------
// The whole step
// ---------------------------------------------------------------------------

/**
 * True for a carried-forward line: its first cell holds a carried-forward
 * label ("Carried forward", "b/f", from vocabulary.ts) and the row has a
 * number (the carried amount). A line with the words but no amount carries
 * no total, so it stays normal text.
 */
function isCarriedForward(row: Row): boolean {
  return hasNumber(row) && findWord(row.cells[0].text, CARRIED_FORWARD) !== null;
}

/** A table found in step 2 and 3: its body, and its header if it has one. */
interface Candidate {
  run: Run;
  header: Header | null;
}

/** Index (in the searched row list) of a candidate's first row: its top header line, or its first body row. */
function firstRowOf(candidate: Candidate): number {
  return candidate.run.startIndex - (candidate.header?.rows.length ?? 0);
}

/**
 * Finds the table on a page from its rows. `page` is the page number, used
 * only in note wording. Returns a layout with `table: null` when no run of
 * aligned rows qualifies.
 *
 * The input array and its rows are not changed.
 */
export function findTable(rows: readonly Row[], page: number): PageLayout {
  const notes: Note[] = [];

  // 1. Carried-forward lines are set aside before the search, so they can't
  //    become a line item (their amount would be counted twice), and can't
  //    sit between the header and the body.
  const setAside = rows.filter(isCarriedForward);
  for (const row of setAside) notes.push(NOTES.carriedForwardSkipped(page, row.text));
  const searched = rows.filter((row) => !setAside.includes(row));

  // 2 and 3. Every run of aligned rows that is a table, top to bottom. The
  //    search goes on after the end of each table found.
  const candidates: Candidate[] = [];
  for (let i = 0; i < searched.length; i++) {
    if (!canStartBody(searched[i])) continue;
    const run = growBody(searched, i);
    const header = attachHeader(searched, run, setAside);
    if (isTable(run, header)) {
      candidates.push({ run, header });
      i = run.endIndex;
    }
  }
  if (candidates.length === 0) return { rows: [...rows], table: null, above: searched, below: [], notes };

  // 4. The item table: the first table with the most number columns. The
  //    tables above it are not read; each gets a note, and their rows are
  //    kept out of `above` so they are never taken for the page's title.
  const chosen = candidates.reduce((best, candidate) =>
    numericColumnCount(candidate.run) > numericColumnCount(best.run) ? candidate : best,
  );
  const { run: table, header } = chosen;
  const skipped = new Set<Row>();
  for (const candidate of candidates) {
    if (candidate === chosen) break;
    notes.push(NOTES.otherTableNotRead(page, candidate.run.body[0].row.text));
    for (const row of searched.slice(firstRowOf(candidate), candidate.run.endIndex + 1)) skipped.add(row);
  }

  // 5. Later runs on the page.
  let i = table.endIndex + 1;
  while (i < searched.length) {
    if (!canStartBody(searched[i])) {
      i++;
      continue;
    }
    const later = growBody(searched, i);
    const between = searched.slice(table.endIndex + 1, i);
    // The same table goes on when every row of the later run lines up with the
    // table's columns and the lines in between may sit inside one table
    // (see mayJoin).
    const aligned = mayJoin(between, later, table) ? alignRun(later, table) : null;
    if (aligned) {
      for (const row of between) {
        notes.push(hasNumber(row) ? NOTES.shortLineInTable(page, row.text) : NOTES.sectionHeading(page, row.text));
      }
      later.body.forEach((bodyRow, k) => {
        for (const [column, cell] of aligned[k]) addCell(column, cell);
        table.body.push({ row: bodyRow.row, continuations: bodyRow.continuations, cells: aligned[k] });
      });
      table.endIndex = later.endIndex;
      i = later.endIndex + 1;
      continue;
    }
    if (isTable(later, attachHeader(searched, later, setAside))) {
      notes.push(NOTES.otherTableNotRead(page, later.body[0].row.text));
      i = later.endIndex + 1;
      continue;
    }
    i++;
  }

  return {
    rows: [...rows],
    table: toTable(table, header),
    above: searched.slice(0, firstRowOf(chosen)).filter((row) => !skipped.has(row)),
    below: searched.slice(table.endIndex + 1),
    notes,
  };
}
