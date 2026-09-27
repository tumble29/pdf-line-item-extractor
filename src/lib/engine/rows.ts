/**
 * Grouping a page's text pieces into rows and cells.
 *
 * A PDF only says "draw this text at this spot". read-page.ts turns that into
 * positioned pieces. This file rebuilds the lines a person sees:
 *
 *   1. Rows. Pieces whose baselines are close (compared to the font size) are
 *      on the same row.
 *   2. Cells. Inside a row, pieces that are close from left to right are one
 *      cell. pdf.js often gives one piece per word, so "Pine" and "batten" are
 *      two pieces but one cell.
 *   3. Separator rows ("--------") are dropped, and the kept rows are
 *      numbered from the top. That number becomes an item's rowIndex.
 *
 * The next step (table.ts) finds the table in these rows. Every distance here
 * is a multiple of the font size, so the same rules work for small and large
 * text. The three numbers below were measured on the six sample files and on
 * the layout test pages in tests/fixtures.
 *
 * How to read it: `buildRows` at the bottom is the whole step. The helpers
 * above it each do one part: group into rows, split a row into cells, and
 * build the row's text with the cell offsets.
 */
import type { TextPiece } from "./read-page";
import { cellShape, isSeparatorText, type CellShape } from "./shapes";

/**
 * Pieces whose baselines are within this many font sizes are on the same row.
 * At font size 9 this is 3.15 pt. Rows in the samples are about 17 pt apart,
 * and the dash line under the header is about 10 pt below it, so neither
 * merges. It still keeps a row together when its baselines move by up to
 * 1.5 pt (tested in rows.test.ts).
 */
export const ROW_TOL = 0.35;
/**
 * Inside a row, pieces closer than this many font sizes are one cell. A word
 * space is about 0.25 font sizes wide, so words of one description join. The
 * gap between two columns is many font sizes, so columns stay apart.
 */
export const MERGE_GAP = 0.4;
/**
 * When two pieces of one cell are further apart than this many font sizes, a
 * space is put between them. A smaller gap means the pieces touch: one word
 * drawn in two parts ("Pin" + "e") must stay "Pine". At font size 9 this is
 * 0.9 pt, far less than a word space (about 2.25 pt).
 */
export const SPACE_GAP = 0.1;

/** One cell: one or more pieces of text that sit together on a row. */
export interface Cell {
  /**
   * The cell's text: its pieces left to right, each trimmed, joined with one
   * space when there is a visible gap between them (and with nothing when
   * they touch). No leading or trailing space.
   */
  text: string;
  /**
   * Left edge (x of the first piece) and right edge (x + width of the last
   * piece), in points. If an earlier piece reaches further right than the
   * last one (overlapping pieces), the right edge is the furthest one, so the
   * cell always covers all of its pieces.
   */
  x0: number;
  x1: number;
  /** The pieces that make up this cell, left to right. */
  pieces: TextPiece[];
  /**
   * Offsets in `text` of spaces that may sit between two separate values, so
   * numbers.ts never reads them as a thousands separator ("1" and "195,20"
   * must not become 1195.20). Here these are the spaces WE put between two
   * pieces. table.ts adds every space of a cell that reaches into a
   * neighbouring column, because pdf.js joins text drawn close together into
   * one piece on its own (see NumberParts.spaceAtJoin for what this can't
   * catch).
   */
  joinSpaces: number[];
  /** The cell's shape (NUM, NUMX or TEXT), from shapes.ts. */
  shape: CellShape;
  /** Where this cell's text sits in the row's `text`: [start, end). */
  start: number;
  end: number;
}

/** One row of text on a page. */
export interface Row {
  /**
   * The row's position on the page, top to bottom, starting at 0. Separator
   * rows ("-----") are dropped before counting. This becomes an item's rowIndex.
   */
  index: number;
  /**
   * The row's baseline, in points from the top of the page. It is the
   * baseline of the row's highest piece (the one that started the row).
   */
  y: number;
  /** The largest font size on the row. */
  fontSize: number;
  /** The cells, left to right. */
  cells: Cell[];
  /**
   * The cells' text joined by single spaces. This is the row's evidence
   * (`sourceText`); each cell's `start`/`end` point into it.
   */
  text: string;
}

/** A row while it is being built: its baseline, its font size and its pieces. */
interface RowGroup {
  y: number;
  fontSize: number;
  pieces: TextPiece[];
}

/**
 * Groups pieces into rows by baseline.
 *
 * Pieces are taken top to bottom (then left to right). A piece joins the
 * first row whose baseline is within ROW_TOL x the smaller of the two font
 * sizes. The smaller size is used so that a large title never pulls a nearby
 * line of small text into its row. The row keeps the baseline of the piece
 * that started it, so a row can't slowly drift down the page.
 */
function groupRows(pieces: readonly TextPiece[]): RowGroup[] {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: RowGroup[] = [];
  for (const piece of sorted) {
    const group = groups.find((g) => Math.abs(g.y - piece.y) <= ROW_TOL * Math.min(g.fontSize, piece.fontSize));
    if (group) {
      group.pieces.push(piece);
      group.fontSize = Math.max(group.fontSize, piece.fontSize);
    } else {
      groups.push({ y: piece.y, fontSize: piece.fontSize, pieces: [piece] });
    }
  }
  return groups.sort((a, b) => a.y - b.y);
}

/** A cell before it knows its place in the row's text. */
type LooseCell = Omit<Cell, "start" | "end">;

/**
 * Splits one row's pieces into cells, left to right.
 *
 * A piece joins the cell before it when the gap between the cell's right edge
 * and the piece's left edge is less than MERGE_GAP x the piece's font size.
 * Each piece's text is trimmed. Between two pieces of one cell we put one
 * space when the gap is more than SPACE_GAP x the font size, or when pdf.js
 * gave the space itself at the end or start of a piece ("Pine " + "batten":
 * pdf.js often counts the space in the width, so the measured gap is zero).
 * Every space we put in is recorded in `joinSpaces`.
 */
function splitCells(pieces: readonly TextPiece[]): LooseCell[] {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  const cells: LooseCell[] = [];
  let previousRaw = "";
  for (const piece of sorted) {
    const text = piece.str.trim();
    // A piece that is only spaces carries no text. read-page.ts already drops
    // these; this keeps the rule true for pieces from anywhere else.
    if (text === "") continue;
    const last = cells[cells.length - 1];
    const gap = last ? piece.x - last.x1 : 0;
    if (last && gap < MERGE_GAP * piece.fontSize) {
      const spaceInText = /\s$/u.test(previousRaw) || /^\s/u.test(piece.str);
      if (gap > SPACE_GAP * piece.fontSize || spaceInText) {
        last.joinSpaces.push(last.text.length);
        last.text += " ";
      }
      last.text += text;
      last.x1 = Math.max(last.x1, piece.x + piece.width);
      last.pieces.push(piece);
    } else {
      cells.push({ text, x0: piece.x, x1: piece.x + piece.width, pieces: [piece], joinSpaces: [], shape: "TEXT" });
    }
    previousRaw = piece.str;
  }
  for (const cell of cells) cell.shape = cellShape(cell.text);
  return cells;
}

/**
 * True for a row that is only a separator line: one "---------" across the
 * table, or one "-----" under each heading. Every cell must be separator text.
 * Otherwise a row of per-column underlines would look like a row of headings
 * to table.ts, because it is the nearest all-text row above the body.
 */
function isSeparatorRow(cells: readonly LooseCell[]): boolean {
  return cells.every((cell) => isSeparatorText(cell.text));
}

/**
 * Joins the cells into the row's text with single spaces, and gives each cell
 * its [start, end) offsets in that text, so `text.slice(start, end)` is the
 * cell's text again.
 */
function placeCells(cells: readonly LooseCell[]): { text: string; cells: Cell[] } {
  let text = "";
  const placed: Cell[] = [];
  for (const cell of cells) {
    if (text !== "") text += " ";
    const start = text.length;
    text += cell.text;
    placed.push({ ...cell, start, end: text.length });
  }
  return { text, cells: placed };
}

/**
 * Groups pieces into rows (by baseline) and cells (by horizontal gap), drops
 * separator rows, and numbers the rows from the top.
 *
 * The input is the page's upright pieces (classify-page.ts has already set
 * sideways text aside). The input array is not changed. A row whose pieces
 * are all empty after trimming has no cells and is dropped too, since it has
 * nothing to show.
 */
export function buildRows(pieces: readonly TextPiece[]): Row[] {
  const rows: Row[] = [];
  for (const group of groupRows(pieces)) {
    const cells = splitCells(group.pieces);
    // Separator rows are dropped BEFORE numbering, so rowIndex counts only
    // rows a reader would count.
    if (cells.length === 0 || isSeparatorRow(cells)) continue;
    const placed = placeCells(cells);
    rows.push({ index: rows.length, y: group.y, fontSize: group.fontSize, cells: placed.cells, text: placed.text });
  }
  return rows;
}
