/**
 * Language and layout fixtures: test PDFs in other languages, other number
 * formats and other table layouts, built in memory with pdfkit.
 *
 * Why these exist
 * ---------------
 * All six sample PDFs come from one supplier template. Rules tuned only on
 * them could depend on that template by accident. These fixtures rebuild the
 * shapes the prototypes were measured on (French, German and Vietnamese
 * tables, English header words the vocabulary doesn't know, reordered and
 * right-aligned columns, a page with no table, a discount column, wrapped
 * descriptions, two-line and centred headers, one text piece per word).
 * Every company, item, address and price here is invented.
 *
 * How to read this file
 * ---------------------
 *   1. The font and the number formatters (money is kept in integer minor
 *      units, like cents, so qty x price = total is always exact).
 *   2. `drawTable`: one generic table page, described by a `TableSpec`.
 *   3. One spec per fixture, and one builder function per fixture.
 *   4. `LANGUAGE_FIXTURES`: what each builder draws (headers, rows, row count),
 *      so tests can assert the engine's result against it.
 *
 * pdfkit measures y from the TOP of the page, and every text is drawn with
 * `lineBreak: false`, so it stays on one line exactly where it is placed.
 *
 * A known pdf.js behaviour
 * ------------------------
 * The French fixture draws "1 195,20 €" with U+202F (a narrow no-break space)
 * as the grouping mark and U+00A0 (a no-break space) before "€". The PDF file
 * really holds those two characters (the font's character map says so, and
 * fixtures.test.ts checks it). But pdf.js 6.1 gives both back as a normal
 * space, U+0020, even with its text normalisation turned off. So the engine
 * never sees U+202F or U+00A0 from a real PDF. `asReadBack` applies the same
 * change, for tests that compare drawn text with what pdf.js reads.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import PDFDocument from "pdfkit";

// ---------------------------------------------------------------------------
// The font
// ---------------------------------------------------------------------------

/**
 * pdfkit's built-in fonts (Helvetica and the others) can only draw Western
 * European letters. They can't draw Vietnamese letters like "ơ" or "ố", or
 * U+202F. So these fixtures use DejaVu Sans, an open-licence font that covers
 * all of them. It comes from the `dejavu-fonts-ttf` dev dependency, found
 * through Node's module resolution, never from the operating system.
 */
const require = createRequire(import.meta.url);
const FONT_PATH = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const BOLD_FONT_PATH = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

/** The font files, read once and shared by every builder. */
let fontCache: { regular: Buffer; bold: Buffer } | null = null;
function fonts(): { regular: Buffer; bold: Buffer } {
  fontCache ??= { regular: readFileSync(FONT_PATH), bold: readFileSync(BOLD_FONT_PATH) };
  return fontCache;
}

// ---------------------------------------------------------------------------
// Number formats (all money in integer minor units)
// ---------------------------------------------------------------------------

/** A narrow no-break space (U+202F). French uses it to group thousands. */
const NARROW_NBSP = " ";
/** A no-break space (U+00A0). French and German put one before "€". */
const NBSP = " ";

/** Puts `mark` between groups of three digits: group("1195", ".") is "1.195". */
function group(digits: string, mark: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, mark);
}

/** Whole units and the two-digit minor part of an amount in cents. */
function split(cents: number): [string, string] {
  return [String(Math.trunc(cents / 100)), String(cents % 100).padStart(2, "0")];
}

/** The number formats the fixtures use. Each takes an amount in minor units. */
export const FORMATS = {
  /** English (NZ/AU): 119520 cents is "$1,195.20". */
  en: (cents: number): string => {
    const [whole, minor] = split(cents);
    return `$${group(whole, ",")}.${minor}`;
  },
  /** French, as Intl fr-FR prints it: 119520 cents is "1 195,20 €" with U+202F and U+00A0. */
  fr: (cents: number): string => {
    const [whole, minor] = split(cents);
    return `${group(whole, NARROW_NBSP)},${minor}${NBSP}€`;
  },
  /** German, as Intl de-DE prints it: 119520 cents is "1.195,20 €" with U+00A0. */
  de: (cents: number): string => {
    const [whole, minor] = split(cents);
    return `${group(whole, ".")},${minor}${NBSP}€`;
  },
  /** Vietnamese dong, which has no minor unit: 1195200 dong is "1.195.200", with no currency marker. */
  vi: (dong: number): string => group(String(dong), "."),
} as const;

/** The name of one of the number formats above. */
export type FormatName = keyof typeof FORMATS;

/**
 * Changes drawn text into what pdf.js 6.1 reads back: U+202F and U+00A0
 * become a normal space (see the header comment of this file).
 */
export function asReadBack(text: string): string {
  return text.replace(/[  ]/gu, " ");
}

// ---------------------------------------------------------------------------
// The generic table page
// ---------------------------------------------------------------------------

/** How a text sits against its x position. */
type Align = "left" | "right" | "centre";

/** One column of a table fixture. */
interface ColumnSpec {
  /** The header text on the main header line. */
  header: string;
  /** For "left": the left edge. For "right": the right edge. */
  x: number;
  /** How the cells (and, unless `headerAlign` says otherwise, the header) sit against `x`. Default "left". */
  align?: "left" | "right";
  /** "centre" puts the header in the middle of the column's cells instead. */
  headerAlign?: Align;
  /** A second header line above the main one, for two-line headers ("Unit" above "Price"). */
  headerAbove?: string;
}

/** One table row: its cells, plus description lines that wrap below it. */
interface RowSpec {
  cells: string[];
  /** Extra lines of the description, drawn below the row in the description column. */
  wrap?: string[];
}

/** A whole table page. */
interface TableSpec {
  company: string;
  title: string;
  /** "Label: value" lines between the title and the table. */
  labels: string[];
  columns: ColumnSpec[];
  /** Which column the wrapped description lines go into. */
  descriptionColumn: number;
  rows: RowSpec[];
  /** A total below the table: the label at `labelX`, the amount in column `valueColumn`. */
  total?: { label: string; labelX: number; value: string; valueColumn: number };
  /** Notes below the total, each on its own line at the left margin. */
  notes: string[];
  /** Draw every word as its own text piece (one `doc.text` call per word). */
  perWord?: boolean;
}

/** Where each part of a table page is drawn, in points from the top. */
const LAYOUT = {
  left: 43,
  right: 553,
  companyY: 50,
  titleY: 74,
  firstLabelY: 96,
  labelGap: 14,
  headerY: 176,
  /**
   * The upper line of a two-line header sits 10 pt (about 1.1 x the font size)
   * above the main line: far enough to be its own row (rows.ts joins pieces
   * within 0.35 x the font size), close enough to count as part of the header
   * (table.ts merges a line less than 1.3 x the font size above).
   */
  headerAboveGap: 10,
  separatorY: 186,
  firstRowY: 198,
  /** The distance between two table rows, as in the samples. */
  rowGap: 17,
  /**
   * A wrapped description line sits 10.5 pt below its row. That is less than
   * 0.8 x the row gap (13.6 pt) and less than 1.3 x the font size (11.7 pt),
   * the two limits table.ts uses to join a continuation line to its row.
   */
  wrapGap: 10.5,
  /** Totals sit about twice the row gap below the last row, as in the samples. */
  totalGap: 34,
  noteGap: 17,
  /** The first note sits 28 pt below the total, as in the prototype corpus. */
  notesAfterTotalGap: 28,
  fontSize: 9,
  companySize: 14,
  titleSize: 11,
} as const;

/**
 * Two cells on one line must be at least one font size (9 pt) apart. Two
 * things join text that is closer: pdf.js itself joins text up to 0.6 x the
 * font size apart into one item (with a space), and rows.ts joins pieces
 * closer than 0.4 x the font size into one cell. A gap of 1 font size leaves
 * a clear margin above both. The drawer throws when a spec breaks this, so a
 * fixture can never merge two cells by accident.
 */
const MIN_CELL_GAP = LAYOUT.fontSize;

/** A text's left and right edge, in points from the left. */
interface Box {
  text: string;
  left: number;
  right: number;
}

/** Creates a pdfkit document with the fixture fonts registered. */
function newDocument(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.registerFont("body", fonts().regular);
  doc.registerFont("bold", fonts().bold);
  return doc;
}

/** Collects a pdfkit document's output into one byte array (see collect() in build.ts). */
function collect(doc: PDFKit.PDFDocument): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
  });
}

/** Where `text` starts and ends when placed at `x` with this alignment, in the current font. */
function boxOf(doc: PDFKit.PDFDocument, text: string, x: number, align: Align): Box {
  const width = doc.widthOfString(text);
  const left = align === "right" ? x - width : align === "centre" ? x - width / 2 : x;
  return { text, left, right: left + width };
}

/**
 * Draws one text at its box. With `perWord`, every word becomes its own
 * `doc.text` call, and the words are one space width apart, as if the line had
 * been drawn in one piece.
 *
 * Separate `doc.text` calls are not enough on their own: pdf.js joins text
 * drawn close together back into one item, with a space (measured: a gap of
 * one space width comes back as "Unit Price"). A change of font doesn't stop
 * this either. pdf.js does always start a new item at the start of a "marked
 * content" section, the tags that tagged (accessible) PDFs put around their
 * text. So each word is wrapped in its own "Span" section, as some PDF
 * generators do, and pdf.js then gives one piece per word.
 */
function draw(doc: PDFKit.PDFDocument, box: Box, y: number, perWord: boolean): void {
  if (!perWord) {
    doc.text(box.text, box.left, y, { lineBreak: false });
    return;
  }
  const space = doc.widthOfString(" ");
  let x = box.left;
  for (const word of box.text.split(" ")) {
    doc.markContent("Span");
    doc.text(word, x, y, { lineBreak: false });
    doc.endMarkedContent();
    x += doc.widthOfString(word) + space;
  }
}

/** Throws when two texts on one line are closer than MIN_CELL_GAP. */
function assertApart(boxes: Box[], where: string): void {
  const sorted = [...boxes].sort((a, b) => a.left - b.left);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].left - sorted[i - 1].right < MIN_CELL_GAP) {
      throw new Error(`fixture layout (${where}): "${sorted[i - 1].text}" and "${sorted[i].text}" are too close`);
    }
  }
}

/** Draws a text line of one piece (or one piece per word) at the left margin. */
function line(doc: PDFKit.PDFDocument, text: string, y: number, perWord: boolean, x: number = LAYOUT.left): void {
  draw(doc, boxOf(doc, text, x, "left"), y, perWord);
}

/** Draws one table page from its spec. */
function drawTable(doc: PDFKit.PDFDocument, spec: TableSpec): void {
  const perWord = spec.perWord ?? false;
  doc.addPage({ size: "A4", margin: 0 });

  doc.font("bold").fontSize(LAYOUT.companySize);
  line(doc, spec.company, LAYOUT.companyY, perWord);
  doc.font("body").fontSize(LAYOUT.titleSize);
  line(doc, spec.title, LAYOUT.titleY, perWord);
  doc.fontSize(LAYOUT.fontSize);
  spec.labels.forEach((label, i) => line(doc, label, LAYOUT.firstLabelY + i * LAYOUT.labelGap, perWord));

  // Body cells first: a centred header needs to know where its cells are.
  const cellBoxes: Box[][] = spec.rows.map((row) =>
    row.cells.map((cell, i) => boxOf(doc, cell, spec.columns[i].x, spec.columns[i].align ?? "left")),
  );

  // The header line (and the line above it, for two-line headers).
  const headerBoxes: Box[] = [];
  const aboveBoxes: Box[] = [];
  spec.columns.forEach((column, i) => {
    const align = column.headerAlign ?? column.align ?? "left";
    let x = column.x;
    if (align === "centre") {
      const cells = cellBoxes.map((boxes) => boxes[i]).filter((box) => box.text !== "");
      x = (Math.min(...cells.map((box) => box.left)) + Math.max(...cells.map((box) => box.right))) / 2;
    }
    headerBoxes.push(boxOf(doc, column.header, x, align));
    if (column.headerAbove) aboveBoxes.push(boxOf(doc, column.headerAbove, x, align));
  });
  assertApart(headerBoxes, "header");
  assertApart(aboveBoxes, "header line above");
  headerBoxes.forEach((box) => draw(doc, box, LAYOUT.headerY, perWord));
  aboveBoxes.forEach((box) => draw(doc, box, LAYOUT.headerY - LAYOUT.headerAboveGap, perWord));

  // The dashed separator under the header, across the whole table width.
  const dashes = "-".repeat(Math.floor((LAYOUT.right - LAYOUT.left) / doc.widthOfString("-")));
  doc.text(dashes, LAYOUT.left, LAYOUT.separatorY, { lineBreak: false });

  // The rows, each followed by its wrapped description lines.
  let y: number = LAYOUT.firstRowY;
  let lastRowY = y;
  spec.rows.forEach((row, r) => {
    const boxes = cellBoxes[r].filter((box) => box.text !== "");
    assertApart(boxes, `row ${r + 1}`);
    boxes.forEach((box) => draw(doc, box, y, perWord));
    lastRowY = y;
    for (const wrapped of row.wrap ?? []) {
      lastRowY += LAYOUT.wrapGap;
      line(doc, wrapped, lastRowY, perWord, spec.columns[spec.descriptionColumn].x);
    }
    y = lastRowY + LAYOUT.rowGap;
  });

  // Below the table: the total, then the notes.
  let belowY = lastRowY + LAYOUT.totalGap;
  if (spec.total) {
    const column = spec.columns[spec.total.valueColumn];
    const label = boxOf(doc, spec.total.label, spec.total.labelX, "left");
    const value = boxOf(doc, spec.total.value, column.x, column.align ?? "left");
    assertApart([label, value], "total");
    draw(doc, label, belowY, perWord);
    draw(doc, value, belowY, perWord);
    belowY += LAYOUT.notesAfterTotalGap;
  }
  spec.notes.forEach((note, i) => line(doc, note, belowY + i * LAYOUT.noteGap, perWord));
}

/** Builds a one-page PDF from a table spec. */
function buildTable(spec: TableSpec): Promise<Uint8Array> {
  const doc = newDocument();
  const done = collect(doc);
  drawTable(doc, spec);
  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Rows from items (so the arithmetic is always exact)
// ---------------------------------------------------------------------------

/** One invented item: line number, description, quantity, unit and unit price in minor units. */
type Item = [no: number, description: string, qty: number, unit: string, price: number];

/**
 * Turns items into the six cells No | Description | Qty | Unit | Price | Total,
 * with the total computed here as qty x price in minor units, so every row's
 * arithmetic is exact. Also returns the sum of the totals.
 */
function standardRows(items: Item[], format: (minor: number) => string): { rows: RowSpec[]; sum: number } {
  let sum = 0;
  const rows = items.map(([no, description, qty, unit, price]) => {
    sum += qty * price;
    return { cells: [String(no), description, String(qty), unit, format(price), format(qty * price)] };
  });
  return { rows, sum };
}

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

/** French: "1 245,00 €" style values, each value one text piece. */
const FRENCH: TableSpec = (() => {
  const { rows, sum } = standardRows(
    [
      [1, "Panneau OSB 18 mm 2500x1250", 24, "panneau", 2890],
      [2, "Laine de verre 100 mm, rouleau", 30, "rouleau", 4166],
      [3, "Tasseau sapin 27x40 2,4 m", 60, "pièce", 345],
      [4, "Mortier colle, sac 25 kg", 18, "sac", 1275],
      [5, "Pointes inox 2,5x50 (boîte)", 6, "boîte", 1990],
    ],
    FORMATS.fr,
  );
  return {
    company: "Bois et Isolants Ferrand SARL",
    title: "Bon de livraison",
    labels: ["Bon n° : BL-7731", "Date : 14 mars 2026", "Livré à : Atelier Berthier, chemin des Saules", "Commandé par : J. Lemaire"],
    columns: [
      { header: "Article", x: 43 },
      { header: "Désignation", x: 84 },
      { header: "Qté", x: 290 },
      { header: "Unité", x: 325 },
      { header: "Prix unitaire", x: 385 },
      { header: "Montant", x: 485 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Total :", labelX: 325, value: FORMATS.fr(sum), valueColumn: 5 },
    notes: ["Livraison contrôlée, rien à signaler."],
  };
})();

/** German: "1.196,00 €" style values. */
const GERMAN: TableSpec = (() => {
  const { rows, sum } = standardRows(
    [
      [1, "Holzfaserplatte 22 mm 1250x600", 40, "Platte", 1890],
      [2, "Dampfbremsfolie 1,5 x 50 m", 3, "Rolle", 6490],
      [3, "Konstruktionsholz 60x120, 5 m", 16, "Stk", 7475],
      [4, "Tellerkopfschrauben 6x80", 12, "Paket", 1135],
      [5, "Klebeband 60 mm", 10, "Rolle", 829],
    ],
    FORMATS.de,
  );
  return {
    company: "Holzhandel Brandauer GmbH",
    title: "Lieferschein",
    labels: ["Lieferschein-Nr.: LS-4418", "Datum: 14.03.2026", "Lieferadresse: Werkstatt Vogt, Ahornweg", "Besteller: K. Vogel"],
    columns: [
      { header: "Pos.", x: 43 },
      { header: "Bezeichnung", x: 75 },
      { header: "Menge", x: 290 },
      { header: "Einheit", x: 335 },
      { header: "Einzelpreis", x: 395 },
      { header: "Gesamt", x: 485 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Summe:", labelX: 335, value: FORMATS.de(sum), valueColumn: 5 },
    notes: ["Lieferung vollständig erhalten."],
  };
})();

/** Vietnamese: dong with "." grouping, no decimals and no currency marker. */
const VIETNAMESE: TableSpec = (() => {
  const { rows, sum } = standardRows(
    [
      [1, "Gạch ốp tường 30x60, loại A", 40, "hộp", 185000],
      [2, "Xi măng trắng, bao 40 kg", 6, "bao", 212000],
      [3, "Keo chà ron chống thấm", 15, "gói", 38500],
      [4, "Nẹp nhôm góc 2,5 m", 24, "thanh", 46000],
      [5, "Vữa dán gạch, bao 25 kg", 10, "bao", 129000],
    ],
    FORMATS.vi,
  );
  return {
    company: "Công ty Vật liệu Hoa Sen",
    title: "Phiếu giao hàng",
    labels: ["Số phiếu: PX-2207", "Ngày: 14/03/2026", "Giao đến: Cửa hàng Minh Châu, đường Hoa Sen", "Người nhận: Trần Thị Lan"],
    columns: [
      { header: "STT", x: 43 },
      { header: "Mô tả", x: 75 },
      { header: "SL", x: 290 },
      { header: "ĐVT", x: 325 },
      { header: "Đơn giá", x: 385 },
      { header: "Thành tiền", x: 475 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Tổng cộng:", labelX: 325, value: FORMATS.vi(sum), valueColumn: 5 },
    notes: ["Hàng đã được kiểm tra khi nhận."],
  };
})();

/** English, but with header words the vocabulary doesn't know. */
const ENGLISH_SYNONYMS: TableSpec = (() => {
  const { rows, sum } = standardRows(
    [
      [1, "Cedar weatherboard 180mm 5.4m", 24, "length", 4725],
      [2, "Galvanised nails 65mm 5kg", 3, "tub", 3890],
      [3, "Building paper roll 1.2x25m", 2, "roll", 8450],
      [4, "Flashing tape 75mm", 6, "roll", 2195],
    ],
    FORMATS.en,
  );
  return {
    company: "Tussock Timber Traders",
    title: "Delivery Docket",
    labels: ["Document No: TTT-3094", "Date: 9 March 2026", "Delivered to: Lot 4, Fantail Rise", "Ordered by: R. Moana"],
    columns: [
      { header: "Ref", x: 43 },
      { header: "Material", x: 72 },
      { header: "Count", x: 290 },
      { header: "Pack", x: 335 },
      { header: "Cost", x: 395 },
      { header: "Value", x: 485 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Total:", labelX: 335, value: FORMATS.en(sum), valueColumn: 5 },
    notes: ["Goods received in good order."],
  };
})();

/**
 * English with the columns in another order (the line total before the unit
 * price, a code column, no line number), and the numeric columns and their
 * headers right-aligned.
 */
const REORDERED_RIGHT_ALIGNED: TableSpec = (() => {
  const items: [string, string, number, string, number][] = [
    ["Acoustic ceiling tile 600x600", "ACT-60", 48, "ea", 1275],
    ["Suspension wire 2m", "SW-2M", 150, "ea", 85],
    ["Main runner 3.6m", "MR-36", 30, "ea", 1490],
    ["Wall angle 3m", "WA-30", 20, "ea", 620],
    ["Insulation blanket R3.2", "IB-32", 12, "pack", 9340],
  ];
  let sum = 0;
  const rows = items.map(([description, code, qty, unit, price]) => {
    sum += qty * price;
    return { cells: [description, code, String(qty), unit, FORMATS.en(qty * price), FORMATS.en(price)] };
  });
  return {
    company: "Kanuka Ceiling Systems",
    title: "Packing List",
    labels: ["Document No: KCS-5520", "Date: 11 March 2026", "Delivered to: 16 Matai Street", "Ordered by: D. Rewi"],
    columns: [
      { header: "Description", x: 43 },
      { header: "Code", x: 230 },
      { header: "Qty", x: 325, align: "right" },
      { header: "Unit", x: 340 },
      { header: "Line Total", x: 460, align: "right" },
      { header: "Unit Price", x: 553, align: "right" },
    ],
    descriptionColumn: 0,
    rows,
    total: { label: "Total:", labelX: 340, value: FORMATS.en(sum), valueColumn: 4 },
    notes: ["Please check all items on arrival."],
  };
})();

/**
 * Some rows with qty 1, and a "Disc %" column between the unit price and the
 * line total. One row has a 10% discount; its line total is qty x price minus
 * 10%, so its arithmetic is right once the discount is counted.
 */
const QTY_ONE_DISC: TableSpec = (() => {
  const items: [number, string, number, string, number, number][] = [
    [1, "Oak stair tread 1000x250", 1, "ea", 38900, 0],
    [2, "Brass cabinet knob 30mm", 16, "ea", 725, 0],
    [3, "Soft close runner 500mm", 8, "pair", 2450, 10],
    [4, "Wood glue 750ml", 1, "bottle", 1680, 0],
    [5, "Veneer edging roll 22mm", 3, "roll", 2195, 0],
  ];
  let sum = 0;
  const rows = items.map(([no, description, qty, unit, price, discount]) => {
    // Every amount here divides exactly (19600 x 90 / 100 = 17640), so no rounding happens.
    const total = (qty * price * (100 - discount)) / 100;
    sum += total;
    return { cells: [String(no), description, String(qty), unit, FORMATS.en(price), discount ? `${discount}%` : "", FORMATS.en(total)] };
  });
  return {
    company: "Rata Joinery Supplies",
    title: "Packing List",
    labels: ["Document No: RJS-8812", "Date: 12 March 2026", "Delivered to: Unit 2, 40 Totara Road", "Ordered by: S. Hira"],
    columns: [
      { header: "Item", x: 43 },
      { header: "Description", x: 78 },
      { header: "Qty", x: 250 },
      { header: "Unit", x: 285 },
      { header: "Unit Price", x: 340 },
      { header: "Disc %", x: 420 },
      { header: "Line Total", x: 485 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Total:", labelX: 340, value: FORMATS.en(sum), valueColumn: 6 },
    notes: ["Discount on row 3 as agreed."],
  };
})();

/** A description that wraps onto a second line: once on the first row, once later. */
const WRAPPED_DESCRIPTION: TableSpec = (() => {
  const { rows, sum } = standardRows(
    [
      [1, "Treated plywood 17mm 2400x1200,", 10, "sheet", 6890],
      [2, "Hex bolt M12x150 galvanised", 20, "ea", 185],
      [3, "Concrete mix 20kg bag, rapid", 40, "bag", 1195],
      [4, "Post bracket 90mm", 6, "ea", 1450],
    ],
    FORMATS.en,
  );
  rows[0].wrap = ["structural grade, CD face"];
  rows[2].wrap = ["setting, pallet of forty"];
  return {
    company: "Pukeko Building Supplies",
    title: "Packing List",
    labels: ["Document No: PBS-1147", "Date: 13 March 2026", "Delivered to: Site 3, Kaka Crescent", "Ordered by: T. Paora"],
    columns: [
      { header: "Item", x: 43 },
      { header: "Description", x: 78 },
      { header: "Qty", x: 300 },
      { header: "Unit", x: 345 },
      { header: "Unit Price", x: 405 },
      { header: "Line Total", x: 490 },
    ],
    descriptionColumn: 1,
    rows,
    total: { label: "Total:", labelX: 345, value: FORMATS.en(sum), valueColumn: 5 },
    notes: ["All items checked on arrival."],
  };
})();

/** The English rows shared by the three layout fixtures (two-line headers, centred headers, one piece per word). */
const LAYOUT_ROWS = standardRows(
  [
    [1, "Fence paling 100x19 1.8m", 50, "ea", 395],
    [2, "Post concrete 20kg", 12, "bag", 1150],
    [3, "Rail 100x50 4.8m", 8, "length", 2475],
    [4, "Gate hinge kit black", 2, "set", 3290],
  ],
  FORMATS.en,
);

/** The English layout page; `columns` changes per fixture. */
function layoutSpec(columns: ColumnSpec[], perWord = false): TableSpec {
  return {
    company: "Weka Fencing Depot",
    title: "Packing slip",
    labels: ["Document No: WFD-2031", "Date: 16 March 2026", "Delivered to: 3 Harakeke Lane", "Ordered by: M. Kereama"],
    columns,
    descriptionColumn: 1,
    rows: LAYOUT_ROWS.rows,
    total: { label: "Total:", labelX: 345, value: FORMATS.en(LAYOUT_ROWS.sum), valueColumn: 5 },
    notes: ["Thank you for your order."],
    perWord,
  };
}

/** The English layout columns, with one header per line. */
const LAYOUT_COLUMNS: ColumnSpec[] = [
  { header: "Item", x: 43 },
  { header: "Description", x: 78 },
  { header: "Qty", x: 300 },
  { header: "Unit", x: 345 },
  { header: "Unit Price", x: 405 },
  { header: "Line Total", x: 490 },
];

/** "Unit" above "Price" and "Line" above "Total". */
const TWO_LINE_HEADER = layoutSpec(
  LAYOUT_COLUMNS.map((column) => {
    const words = column.header.split(" ");
    return words.length === 2 ? { ...column, headerAbove: words[0], header: words[1] } : column;
  }),
);

/** Every header centred over its column's cells, so it shares no edge with them. */
const CENTRED_HEADERS = layoutSpec(LAYOUT_COLUMNS.map((column) => ({ ...column, headerAlign: "centre" as const })));

/** Every word drawn as its own text piece. */
const ONE_PIECE_PER_WORD = layoutSpec(LAYOUT_COLUMNS, true);

// ---------------------------------------------------------------------------
// The page with no table
// ---------------------------------------------------------------------------

/** The label/value pairs of the no-table page's summary block. */
const NO_TABLE_PAIRS: [string, string][] = [
  ["Subtotal", "$240.00"],
  ["GST 15%", "$36.00"],
  ["Total", "$276.00"],
  ["Amount paid", "$0.00"],
  ["Balance due", "$276.00"],
];

/**
 * A page of letterhead, text lines and "Label: value" lines, an address block
 * on the right, and a two-column key/value block that looks a little like a
 * table. It has no line-item table: no line has three cells.
 */
function drawNoTable(doc: PDFKit.PDFDocument): void {
  doc.addPage({ size: "A4", margin: 0 });
  doc.font("bold").fontSize(LAYOUT.companySize);
  line(doc, "Kowhai Hire and Repairs Ltd", 50, false);
  doc.font("body").fontSize(LAYOUT.fontSize);
  line(doc, "22 Quay Road, Seaview 5010", 68, false);
  line(doc, "Phone 04 555 0187", 80, false);
  doc.fontSize(LAYOUT.titleSize);
  line(doc, "Tax Invoice", 104, false);
  doc.fontSize(LAYOUT.fontSize);
  const labels = ["Invoice No: KHR-6620", "Date: 17 March 2026", "Customer: P. Tawhiri", "Job: Mower repair and service"];
  labels.forEach((label, i) => line(doc, label, 126 + i * LAYOUT.labelGap, false));
  ["Bill to:", "P. Tawhiri", "8 Ruru Street", "Seaview 5010"].forEach((text, i) => line(doc, text, 126 + i * LAYOUT.labelGap, false, 330));
  line(doc, "Work carried out as quoted. Parts and labour are listed on the job card.", 220, false);
  NO_TABLE_PAIRS.forEach(([label, value], i) => {
    const y = 260 + i * LAYOUT.rowGap;
    line(doc, label, y, false, 380);
    draw(doc, boxOf(doc, value, LAYOUT.right, "right"), y, false);
  });
  line(doc, "Payment by bank transfer. Please quote the invoice number.", 260 + NO_TABLE_PAIRS.length * LAYOUT.rowGap + 20, false);
}

// ---------------------------------------------------------------------------
// The builders
// ---------------------------------------------------------------------------

/** French headers, "1 245,00 €" values with U+202F grouping and U+00A0 before "€". */
export function french(): Promise<Uint8Array> {
  return buildTable(FRENCH);
}

/** German headers, "1.196,00 €" values. */
export function german(): Promise<Uint8Array> {
  return buildTable(GERMAN);
}

/** Vietnamese headers, "7.400.000" dong values with no decimals and no currency marker. */
export function vietnamese(): Promise<Uint8Array> {
  return buildTable(VIETNAMESE);
}

/** English with unknown header words: Ref | Material | Count | Pack | Cost | Value. */
export function englishSynonyms(): Promise<Uint8Array> {
  return buildTable(ENGLISH_SYNONYMS);
}

/** Description | Code | Qty | Unit | Line Total | Unit Price, numbers right-aligned. */
export function reorderedRightAligned(): Promise<Uint8Array> {
  return buildTable(REORDERED_RIGHT_ALIGNED);
}

/** A page of text, label lines and a two-column key/value block, with no table. */
export function noTable(): Promise<Uint8Array> {
  const doc = newDocument();
  const done = collect(doc);
  drawNoTable(doc);
  doc.end();
  return done;
}

/** Rows with qty 1, and a "Disc %" column between the unit price and the line total. */
export function qtyOneDisc(): Promise<Uint8Array> {
  return buildTable(QTY_ONE_DISC);
}

/** A description wrapping onto a second line on the first row and on a later row. */
export function wrappedDescription(): Promise<Uint8Array> {
  return buildTable(WRAPPED_DESCRIPTION);
}

/** "Unit" above "Price" and "Line" above "Total". */
export function twoLineHeader(): Promise<Uint8Array> {
  return buildTable(TWO_LINE_HEADER);
}

/** Headers centred over their columns. */
export function centredHeaders(): Promise<Uint8Array> {
  return buildTable(CENTRED_HEADERS);
}

/** Every word is its own `doc.text` call, so pdf.js gives one piece per word. */
export function onePiecePerWord(): Promise<Uint8Array> {
  return buildTable(ONE_PIECE_PER_WORD);
}

// ---------------------------------------------------------------------------
// What each builder draws
// ---------------------------------------------------------------------------

/** What one fixture draws, for tests to compare the engine's result with. */
export interface FixtureExpectation {
  build: () => Promise<Uint8Array>;
  /** Number of pages. */
  pageCount: number;
  /**
   * The header of each column, left to right, as a reader sees it. A two-line
   * header is joined with one space, top line first ("Unit Price"). Empty
   * when the page has no table.
   */
  headers: string[];
  /** The number of line items (a wrapped description is still one item). 0 when there is no table. */
  rowCount: number;
  /** The cells of each row as drawn, left to right, "" for an empty cell. Wrapped lines are not included. */
  rows: string[][];
  /** Wrapped description lines: the row they belong to (from 0) and the extra lines. */
  wrapped: { row: number; lines: string[] }[];
  /** The text lines drawn below the table: the total (label and amount joined by a space), then the notes. */
  after: string[];
  /** The number format the fixture's money values use. */
  format: FormatName;
  /**
   * Which columns hold the quantity, the unit price and the line total, so a
   * test can check qty x price = total. Null when the rows can't be checked
   * this way (no table, or a discount column changes the total).
   */
  maths: { qty: number; price: number; total: number } | null;
}

/** Builds the expectation of a table fixture from its spec. */
function expectation(
  build: () => Promise<Uint8Array>,
  spec: TableSpec,
  format: FormatName,
  maths: FixtureExpectation["maths"],
): FixtureExpectation {
  return {
    build,
    pageCount: 1,
    headers: spec.columns.map((column) => (column.headerAbove ? `${column.headerAbove} ${column.header}` : column.header)),
    rowCount: spec.rows.length,
    rows: spec.rows.map((row) => [...row.cells]),
    wrapped: spec.rows.flatMap((row, index) => (row.wrap ? [{ row: index, lines: [...row.wrap] }] : [])),
    after: [...(spec.total ? [`${spec.total.label} ${spec.total.value}`] : []), ...spec.notes],
    format,
    maths,
  };
}

/** The standard column order No | Description | Qty | Unit | Price | Total. */
const STANDARD_MATHS = { qty: 2, price: 4, total: 5 };

/** Every language and layout fixture, with what it draws. */
export const LANGUAGE_FIXTURES = {
  french: expectation(french, FRENCH, "fr", STANDARD_MATHS),
  german: expectation(german, GERMAN, "de", STANDARD_MATHS),
  vietnamese: expectation(vietnamese, VIETNAMESE, "vi", STANDARD_MATHS),
  englishSynonyms: expectation(englishSynonyms, ENGLISH_SYNONYMS, "en", STANDARD_MATHS),
  reorderedRightAligned: expectation(reorderedRightAligned, REORDERED_RIGHT_ALIGNED, "en", { qty: 2, price: 5, total: 4 }),
  noTable: {
    build: noTable,
    pageCount: 1,
    headers: [],
    rowCount: 0,
    rows: [],
    wrapped: [],
    after: [],
    format: "en",
    maths: null,
  },
  qtyOneDisc: expectation(qtyOneDisc, QTY_ONE_DISC, "en", null),
  wrappedDescription: expectation(wrappedDescription, WRAPPED_DESCRIPTION, "en", STANDARD_MATHS),
  twoLineHeader: expectation(twoLineHeader, TWO_LINE_HEADER, "en", STANDARD_MATHS),
  centredHeaders: expectation(centredHeaders, CENTRED_HEADERS, "en", STANDARD_MATHS),
  onePiecePerWord: expectation(onePiecePerWord, ONE_PIECE_PER_WORD, "en", STANDARD_MATHS),
} as const satisfies Record<string, FixtureExpectation>;

/** The name of one language or layout fixture. */
export type LanguageFixtureName = keyof typeof LANGUAGE_FIXTURES;

/** The label/value pairs on the no-table page, for tests that check none of them becomes an item. */
export const NO_TABLE_KEY_VALUES: readonly (readonly [string, string])[] = NO_TABLE_PAIRS;
