/**
 * Builds test PDFs in memory with pdfkit.
 *
 * Why build PDFs instead of storing them
 * --------------------------------------
 * Each fixture is made by code, so a reader can see exactly what is inside it
 * (which text, at which position, which page is broken). Nothing is copied
 * from the sample PDFs: every name, description and price here is invented.
 *
 * The layout
 * ----------
 * Pages look like a simple delivery docket: a supplier line, a title, a
 * header row, a dashed line and three item rows. Lines below the table (a
 * total, a note) are added only when a test passes `after`. Every page has
 * its own header row, so pages never depend on each other. Column positions
 * are parameters, so later tests can move them.
 *
 * pdfkit measures y from the TOP of the page, so y = 176 is 176 points down.
 * Every text is drawn with `lineBreak: false`, so it stays on one line exactly
 * where it is placed.
 *
 * Builders for special cases
 * --------------------------
 *   imageOnlyMiddle  3 pages; page 2 is only an image (a "scan")
 *   shapesOnly       1 page of drawn boxes and no text (like text saved as outlines)
 *   encrypted        needs a password to open
 *   certificateProtected  protected with certificate security, which pdf.js can't open
 *   ownerOnly        has an owner password only; opens without one
 *   brokenLastPage   3 pages; the file's list of pages points at a missing
 *                    object for page 3, so reading page 3 fails
 *   brokenMiddleEntry  3 pages with the entry for page 2 broken; records a
 *                    pdf.js limitation (it then loses page 3 too)
 *   truncated        the first half of a valid PDF
 *   notPdf, empty    not a PDF at all
 *
 * Builders for engine rules (Part 5)
 * ----------------------------------
 *   docket           Description | Qty | Unit: three columns and no prices
 *   multiPage        3 pages; a "Carried forward" row on page 2, a subtotal on page 3
 *   rotatedStamp     a normal table with a "PAID" stamp turned 45 degrees
 *   shiftedColumns   Item | Description | Qty | Weight | Unit Price at other x
 *                    positions, prices with "/bag" and "/ea", one weight saying "total"
 *   titledPages      5 pages whose titles use a summary, returns, credit and
 *                    acceptance word, and a "Summary: ..." label line on page 5
 *   mismatchRow      one row where qty x price is not the line total
 *   unparseableCell  one price cell that is not a clean number ("$12.50 box")
 *   numbersOnlyRow   one row with numbers and no description
 *
 * Builders for the printed totals and the contradiction scan
 * -----------------------------------------------------------
 *   conflictingNotes   a count above the table and a different one below it,
 *                      plus lines that must not count ("Site 1 of 4", a date,
 *                      a document number)
 *   oneCellTotal       "Total: $413.50" drawn as one piece; the lines match
 *   twoPieceTotals     any totals block, each label and amount drawn apart
 *   totalGap           the lines add up to less than the printed total
 *   unknownLabelTotal  a German-style page with a figure under a label the
 *                      vocabulary doesn't know, equal to the lines or not
 *   totalAfterScan     3 pages, page 2 a scan, and a total on page 3
 *
 * The language and layout fixtures (French, German, two-line headers, ...) are
 * in languages.ts, because they need a Unicode font.
 */
import PDFDocument from "pdfkit";

import { TINY_PNG } from "./png";

/** One column: its header text and where it starts, in points from the left. */
export interface ColumnSpec {
  header: string;
  x: number;
}

/** One page of a fixture. Leave a field out to get the default. */
export interface PageSpec {
  title?: string;
  columns?: ColumnSpec[];
  rows?: string[][];
  /** Lines printed below the table, like a total or a note. */
  after?: string[];
  /** Draw only an image on this page, and no text: a scanned page. */
  imageOnly?: boolean;
  /** Draw only boxes on this page, and no text: a page whose text was saved as shapes. */
  shapesOnly?: boolean;
  /** Also draw a small image in the top right corner, like a company logo. */
  logo?: boolean;
  /**
   * Totals lines drawn after the table (after `after`), each with its label
   * and its amount as two separate pieces: the label in the unit price
   * column, the amount in the line total column.
   */
  totals?: { label: string; amount: string }[];
  /**
   * Lines of a small separate table drawn last, below everything else: each
   * line is its pieces, each at its own x. Used for a totals box whose columns
   * don't line up with the item table's.
   */
  box?: { x: number; text: string }[][];
}

export interface PdfOptions {
  pages?: PageSpec[];
  /** Turn off compression so the raw PDF text can be edited (damagePageTree needs this). */
  compress?: boolean;
  userPassword?: string;
  ownerPassword?: string;
}

/** The default columns, left to right. */
export const DEFAULT_COLUMNS: ColumnSpec[] = [
  { header: "Item", x: 43 },
  { header: "Description", x: 71 },
  { header: "Qty", x: 326 },
  { header: "Unit", x: 377 },
  { header: "Unit Price", x: 428 },
  { header: "Line Total", x: 502 },
];

/**
 * The default rows. Every row multiplies correctly (12 x $15.50 = $186.00),
 * and every price has two decimals with "." as the decimal mark, so a page on
 * its own is enough to show how its numbers are written.
 */
export const DEFAULT_ROWS: string[][] = [
  ["1", "Pine batten 45x19", "12", "length", "$15.50", "$186.00"],
  ["2", "Deck screws 10g box", "8", "box", "$22.25", "$178.00"],
  ["3", "Joist hanger 90mm", "5", "ea", "$9.90", "$49.50"],
];

/** Where each part of a page is drawn, in points from the top. */
const LAYOUT = {
  supplierY: 57,
  titleY: 77,
  headerY: 176,
  separatorY: 186,
  firstRowY: 198,
  rowGap: 17,
  afterGap: 34,
  fontSize: 9,
} as const;

/**
 * Collects a pdfkit document's output into one byte array. Call it before
 * drawing (so no output is missed), and call `doc.end()` after drawing; the
 * promise resolves when pdfkit has written the last byte.
 */
function collect(doc: PDFKit.PDFDocument): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
  });
}

/** Draws one text exactly at (x, y), on one line. */
function text(doc: PDFKit.PDFDocument, str: string, x: number, y: number): void {
  doc.text(str, x, y, { lineBreak: false });
}

/** Draws one docket page. */
function drawPage(doc: PDFKit.PDFDocument, spec: PageSpec, pageNumber: number, pageCount: number): void {
  if (spec.imageOnly) {
    doc.image(TINY_PNG, 60, 60, { width: 400 });
    return;
  }
  if (spec.shapesOnly) {
    for (let row = 0; row < 5; row++) doc.rect(43, 176 + row * 17, 500, 12).fill("#999999");
    return;
  }
  const columns = spec.columns ?? DEFAULT_COLUMNS;
  const rows = spec.rows ?? DEFAULT_ROWS;

  if (spec.logo) doc.image(TINY_PNG, 480, 40, { width: 60 });
  doc.fontSize(LAYOUT.fontSize);
  text(doc, "Example Supplies Ltd", 43, LAYOUT.supplierY);
  text(doc, spec.title ?? `Delivery docket - Site ${pageNumber} of ${pageCount}`, 43, LAYOUT.titleY);
  for (const column of columns) text(doc, column.header, column.x, LAYOUT.headerY);
  text(doc, "-".repeat(118), 43, LAYOUT.separatorY);
  rows.forEach((row, rowIndex) => {
    const y = LAYOUT.firstRowY + rowIndex * LAYOUT.rowGap;
    row.forEach((cell, cellIndex) => {
      if (cell !== "" && columns[cellIndex]) text(doc, cell, columns[cellIndex].x, y);
    });
  });
  const afterY = LAYOUT.firstRowY + (rows.length - 1) * LAYOUT.rowGap + LAYOUT.afterGap;
  const after = spec.after ?? [];
  after.forEach((line, index) => text(doc, line, 43, afterY + index * LAYOUT.rowGap));
  const totals = spec.totals ?? [];
  totals.forEach(({ label, amount }, index) => {
    const y = afterY + (after.length + index) * LAYOUT.rowGap;
    text(doc, label, columns[4]?.x ?? 428, y);
    text(doc, amount, columns[5]?.x ?? 502, y);
  });
  const boxY = afterY + (after.length + totals.length) * LAYOUT.rowGap + LAYOUT.afterGap;
  (spec.box ?? []).forEach((line, index) => {
    for (const { x, text: str } of line) text(doc, str, x, boxY + index * LAYOUT.rowGap);
  });
}

/** Builds a PDF from page specs. With no options: one default docket page. */
export async function buildPdf(options: PdfOptions = {}): Promise<Uint8Array> {
  const pages = options.pages ?? [{}];
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    autoFirstPage: false,
    compress: options.compress ?? true,
    ...(options.userPassword ? { userPassword: options.userPassword } : {}),
    ...(options.ownerPassword ? { ownerPassword: options.ownerPassword, permissions: { printing: "lowResolution" } } : {}),
  });
  const done = collect(doc);
  pages.forEach((spec, index) => {
    doc.addPage({ size: "A4", margin: 0 });
    drawPage(doc, spec, index + 1, pages.length);
  });
  doc.end();
  return done;
}

/** Three normal docket pages. */
export function threePages(): Promise<Uint8Array> {
  return buildPdf({ pages: [{}, {}, {}] });
}

/** Three pages; page 2 is only an image, like a scanned page. */
export function imageOnlyMiddle(): Promise<Uint8Array> {
  return buildPdf({ pages: [{}, { imageOnly: true }, {}] });
}

/** One page of drawn boxes with no text at all. */
export function shapesOnly(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ shapesOnly: true }] });
}

/** A PDF that needs a password to open. */
export function encrypted(): Promise<Uint8Array> {
  return buildPdf({ userPassword: "secret" });
}

/**
 * A PDF protected with certificate (public-key) security instead of a
 * password. pdf.js can't open this kind of protection, and reports "unknown
 * encryption method". The file is protected, not damaged, so it must be
 * refused as ENCRYPTED, never as CORRUPT_FILE.
 *
 * pdfkit can't make this kind of file, so we add the protection entry to the
 * file's trailer (the dictionary at the end that says how to read the file).
 */
export async function certificateProtected(): Promise<Uint8Array> {
  const pdf = Buffer.from(await buildPdf({ compress: false })).toString("latin1");
  const trailer = "trailer" + String.fromCharCode(10) + "<<"; // "trailer", a line break, then "<<"
  if (!pdf.includes(trailer)) throw new Error("certificateProtected: no trailer found");
  const encrypt = "/Encrypt << /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Length 128 /Recipients [<3082>] >>";
  return new Uint8Array(Buffer.from(pdf.replace(trailer, `${trailer} ${encrypt}`), "latin1"));
}

/**
 * A PDF with only an owner password. That password limits what a reader may
 * do (here: printing). Anyone can still open and read it, so it must open.
 */
export function ownerOnly(): Promise<Uint8Array> {
  return buildPdf({ ownerPassword: "owner" });
}

/**
 * Makes one page of a 3-page PDF unreadable, by damaging the file's list of
 * pages.
 *
 * A PDF lists its pages in a "page tree": `/Kids [7 0 R 11 0 R 14 0 R]` means
 * "the pages are objects 7, 11 and 14". We replace one reference with the
 * number of an object that doesn't exist.
 *
 * The replacement number has the same number of digits as the original, so
 * the file keeps its exact length and every byte offset in it stays correct.
 * Object numbers change with the content, so we look them up instead of
 * hardcoding them.
 *
 * `which` is the page to damage, counting from 0.
 */
async function damagePageTree(which: number): Promise<Uint8Array> {
  const bytes = await buildPdf({ pages: [{}, {}, {}], compress: false });
  const pdf = Buffer.from(bytes).toString("latin1");

  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(pdf);
  if (!kids) throw new Error("damagePageTree: no page tree found");
  const refs = [...kids[1].matchAll(/(\d+) 0 R/g)];
  if (refs.length <= which) throw new Error("damagePageTree: not enough pages");

  const existing = new Set([...pdf.matchAll(/(\d+) 0 obj/g)].map((match) => Number(match[1])));
  const original = refs[which][1];
  let missing = 10 ** original.length - 1; // for "11": 99, 98, ... with the same digit count
  while (existing.has(missing) && missing >= 10 ** (original.length - 1)) missing--;
  if (existing.has(missing)) throw new Error("damagePageTree: no free object number with the same length");

  // Replace exactly that one reference inside the Kids array.
  const kidsStart = kids.index + kids[0].indexOf("[") + 1;
  const refStart = kidsStart + (refs[which].index ?? 0);
  const broken = pdf.slice(0, refStart) + String(missing) + pdf.slice(refStart + original.length);
  return new Uint8Array(Buffer.from(broken, "latin1"));
}

/**
 * Three pages where page 3 can't be read. pdf.js still counts 3 pages, reads
 * pages 1 and 2 normally, and fails only when page 3 is opened. This is the
 * real-file containment case: one broken page, the others unaffected.
 */
export function brokenLastPage(): Promise<Uint8Array> {
  return damagePageTree(2);
}

/**
 * Three pages where the entry for page 2 is broken.
 *
 * This records a limitation of pdf.js, not of our code: when an entry in the
 * middle of the page list is broken, pdf.js recounts the pages and stops at the
 * broken entry. It then reports 2 pages, and page 3 can't be reached at all.
 * pdf.js gives no way to see the page count the file itself declares, so we
 * can't detect the missing page. A test checks this behaviour, and the README
 * will list it.
 */
export function brokenMiddleEntry(): Promise<Uint8Array> {
  return damagePageTree(1);
}

/**
 * The first half of a valid PDF. We cut at 50%, not near the end: pdf.js
 * repairs a file that is only missing its last few bytes.
 */
export async function truncated(): Promise<Uint8Array> {
  const bytes = await buildPdf();
  return bytes.slice(0, Math.floor(bytes.length / 2));
}

/** A plain text file with a .pdf name. */
export function notPdf(): Uint8Array {
  return new TextEncoder().encode("Hello. This is a text file, not a PDF.\n");
}

/** A file with no bytes at all. */
export function empty(): Uint8Array {
  return new Uint8Array(0);
}

/** Wraps bytes as a File, the way an upload arrives at the route. */
export function asFile(bytes: Uint8Array, name = "test.pdf", type = "application/pdf"): File {
  return new File([bytes as BlobPart], name, { type });
}

// ---------------------------------------------------------------------------
// Builders for engine rules (Part 5)
// ---------------------------------------------------------------------------

/**
 * Builds a PDF like `buildPdf`, then lets `extra` draw more on each page (a
 * stamp, a label line). `extra` gets the page index, counting from 0.
 */
function buildWith(pages: PageSpec[], extra: (doc: PDFKit.PDFDocument, index: number) => void): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  const done = collect(doc);
  pages.forEach((spec, index) => {
    doc.addPage({ size: "A4", margin: 0 });
    drawPage(doc, spec, index + 1, pages.length);
    extra(doc, index);
  });
  doc.end();
  return done;
}

/** The columns of the docket fixture: three columns, no prices. */
export const DOCKET_COLUMNS: ColumnSpec[] = [
  { header: "Description", x: 43 },
  { header: "Qty", x: 300 },
  { header: "Unit", x: 360 },
];

/** The rows of the docket fixture. */
export const DOCKET_ROWS: string[][] = [
  ["Rough sawn fence rail 150x50", "20", "length"],
  ["Coach screw 12x100", "40", "ea"],
  ["Chain link mesh 1.8m roll", "2", "roll"],
];

/**
 * A docket with Description | Qty | Unit and no prices. Three columns is the
 * smallest table the detector reads (a two-column block is kept out on
 * purpose, so label/value blocks are never read as tables).
 */
export function docket(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ columns: DOCKET_COLUMNS, rows: DOCKET_ROWS }] });
}

/**
 * The pages of the multi-page fixture. Each page has its own rows, and every
 * row multiplies correctly. Page 2's table starts with a "Carried forward" row
 * that repeats page 1's lines total ($365.10). Page 3 ends with a subtotal of
 * every line on all three pages ($1,144.95). The carried-forward row must
 * never become an item, or its money is counted twice.
 */
export const MULTI_PAGE = {
  pages: [
    [
      ["1", "Macrocarpa sleeper 200x100 2.4m", "6", "length", "$42.00", "$252.00"],
      ["2", "Garden edging steel 1.2m", "10", "ea", "$8.75", "$87.50"],
      ["3", "Landscape pins 150mm pack", "4", "pack", "$6.40", "$25.60"],
    ],
    [
      ["", "Carried forward", "", "", "", "$365.10"],
      ["4", "Weed mat 1.8x50m roll", "1", "roll", "$96.00", "$96.00"],
      ["5", "Bark mulch 40L bag", "25", "bag", "$11.20", "$280.00"],
      ["6", "Drip line 16mm 100m", "2", "roll", "$58.90", "$117.80"],
    ],
    [
      ["7", "Irrigation timer 4 zone", "1", "ea", "$129.00", "$129.00"],
      ["8", "Joiner elbow 16mm pack", "3", "pack", "$4.35", "$13.05"],
      ["9", "Compost 30L bag", "15", "bag", "$9.60", "$144.00"],
    ],
  ],
  carriedForward: "$365.10",
  subtotalLine: "Subtotal: $1,144.95",
  /** Line items only: the carried-forward row is not one. */
  itemCount: 9,
} as const;

/** Three pages with the header on every page, a carried-forward row on page 2 and a subtotal on page 3. */
export function multiPage(): Promise<Uint8Array> {
  const pages = MULTI_PAGE.pages;
  return buildPdf({
    pages: pages.map((rows, index) => ({
      rows: rows.map((row) => [...row]),
      after: index === pages.length - 1 ? [MULTI_PAGE.subtotalLine] : undefined,
    })),
  });
}

/** The angle of the stamp, in degrees. It is far above the 5-degree tilt that a scan can give (see classify-page.ts). */
export const STAMP_ANGLE = 45;

/**
 * A normal table with a large "PAID" stamp turned 45 degrees across it, as a
 * rubber stamp or a watermark would be. The stamp must be dropped with a note,
 * and the table read as normal.
 */
export function rotatedStamp(): Promise<Uint8Array> {
  return buildWith([{}], (doc) => {
    doc.save();
    doc.rotate(-STAMP_ANGLE, { origin: [300, 250] });
    doc.fontSize(36).text("PAID", 300, 250, { lineBreak: false });
    doc.restore();
  });
}

/**
 * The columns of the shifted-columns fixture. The x positions differ from
 * DEFAULT_COLUMNS (Qty at 300, not 326; the fourth column at 360, not 377), so
 * a detector that expects fixed positions fails on it.
 */
export const SHIFTED_COLUMNS: ColumnSpec[] = [
  { header: "Item", x: 43 },
  { header: "Description", x: 75 },
  { header: "Qty", x: 300 },
  { header: "Weight", x: 360 },
  { header: "Unit Price", x: 455 },
];

/**
 * The rows of the shifted-columns fixture. There is no line total. Every unit
 * price ends in "/<unit>". Exactly one weight cell says "total": it gives the
 * weight of the whole line, while the others give the weight of one item. That
 * must give the mixed-wording warning.
 */
export const SHIFTED_ROWS: string[][] = [
  ["1", "Garden lime 20kg sack", "6", "20kg", "$14.40 /bag"],
  ["2", "Brass hinge 75mm", "12", "85g", "$3.15 /ea"],
  ["3", "Cup hook set", "4", "600g total", "$2.60 /ea"],
  ["4", "Bamboo stakes 1.2m", "3", "2.5kg", "$9.80 /bundle"],
];

/** The line below the shifted-columns table: a total label with no amount. */
export const SHIFTED_AFTER_LINE = "Total load weight: see each line.";

/** Item | Description | Qty | Weight | Unit Price at shifted positions, with a total label below that has no amount. */
export function shiftedColumns(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ columns: SHIFTED_COLUMNS, rows: SHIFTED_ROWS, after: [SHIFTED_AFTER_LINE] }] });
}

/**
 * The titles of the five titled pages, in order. Each is a "Name - Title"
 * line. Pages 1 to 4 use a summary word, a returns word, a credit word and an
 * acceptance word. Page 5's title has none of them. Instead, a "Summary: ..."
 * label line sits above its header (TITLED_PAGES_LABEL_LINE). That line must
 * NOT give the summary warning, because label lines are not titles.
 */
export const TITLED_PAGE_TITLES = [
  "Kestrel Road Run 12 - Weekly Summary",
  "Kestrel Road Run 12 - Returns Slip",
  "Kestrel Road Run 12 - Credit Memo",
  "Kestrel Road Run 12 - Customer Acceptance",
  "Kestrel Road Run 12 - Yard Pickup",
] as const;

/** The label line above page 5's header. */
export const TITLED_PAGES_LABEL_LINE = "Summary: 9 crates packed at the yard";

/**
 * Where the label line on page 5 is drawn: 26 pt above the header. So it is
 * clearly its own line, and it is never merged into the header (table.ts
 * merges a second header line only when it is less than 1.3 x the font size
 * above, which is 11.7 pt here).
 */
const LABEL_LINE_Y = 150;

/** Five pages with the same table and the titles above. */
export function titledPages(): Promise<Uint8Array> {
  const pages: PageSpec[] = TITLED_PAGE_TITLES.map((title) => ({ title }));
  return buildWith(pages, (doc, index) => {
    if (index === pages.length - 1) text(doc, TITLED_PAGES_LABEL_LINE, 43, LABEL_LINE_Y);
  });
}

/** The row of mismatchRow() whose arithmetic is wrong, counting from 0: 8 x $22.25 is $178.00, not $187.00. */
export const MISMATCH_ROW_INDEX = 1;

/** The default page, with one row whose line total is not qty x unit price. */
export function mismatchRow(): Promise<Uint8Array> {
  const rows = DEFAULT_ROWS.map((row) => [...row]);
  rows[MISMATCH_ROW_INDEX][5] = "$187.00";
  return buildPdf({ pages: [{ rows }] });
}

/** The price cell of unparseableCell() that is not a clean number: a unit word with no "/". */
export const UNPARSEABLE_PRICE = "$12.50 box";

/** The default page, with one unit price cell that has a unit word after it without a "/". */
export function unparseableCell(): Promise<Uint8Array> {
  const rows = DEFAULT_ROWS.map((row) => [...row]);
  rows[1] = ["2", "Tile spacers 3mm", "4", "box", UNPARSEABLE_PRICE, "$50.00"];
  return buildPdf({ pages: [{ rows }] });
}

/** The row added by numbersOnlyRow(): numbers in every numeric column, and an empty description. */
export const NUMBERS_ONLY_ROW: string[] = ["4", "", "6", "ea", "$3.00", "$18.00"];

/** The default page plus a fourth row that has numbers but no description. */
export function numbersOnlyRow(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ rows: [...DEFAULT_ROWS, NUMBERS_ONLY_ROW] }] });
}

// ---------------------------------------------------------------------------
// The printed totals and the contradiction scan
// ---------------------------------------------------------------------------

/** What DEFAULT_ROWS add up to: $186.00 + $178.00 + $49.50. */
export const DEFAULT_ROWS_SUM = "$413.50";

/**
 * The lines of conflictingNotes(). The title line (a "Label: value" line
 * above the table) says 8 crates, a note below says 9. The other lines each
 * hold a number that is not a count and must not cause a refusal.
 */
export const CONFLICTING_NOTES = {
  above: "Loading: 8 crates packed at the yard",
  below: [
    "Driver notes: 9 crates unloaded on site.",
    "Site 1 of 4, Page 1 of 2",
    "Delivered 24 August 2026 before 10 am",
    "Docket No: 5512 crates checked 3 times",
    "Crates stay on site 14, Tirau for 2 days",
  ],
} as const;

/** One page whose notes around the table give two different counts of crates. */
export function conflictingNotes(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ title: CONFLICTING_NOTES.above, after: [...CONFLICTING_NOTES.below] }] });
}

/** The default page with "Total: $413.50" drawn as one piece; it equals the lines. */
export function oneCellTotal(): Promise<Uint8Array> {
  return buildPdf({ pages: [{ after: [`Total: ${DEFAULT_ROWS_SUM}`] }] });
}

/** The default page with a totals block, each label and amount drawn as two pieces. */
export function twoPieceTotals(totals: { label: string; amount: string }[]): Promise<Uint8Array> {
  return buildPdf({ pages: [{ totals }] });
}

/** The printed total of totalGap(): $36.50 more than the lines. */
export const TOTAL_GAP_STATED = "$450.00";

/** The default page with a total that is more than the lines add up to, and no subtotal or GST line. */
export function totalGap(): Promise<Uint8Array> {
  return twoPieceTotals([{ label: "Total:", amount: TOTAL_GAP_STATED }]);
}

/** German-style rows ("15,50"), which add up to 413,50. */
export const GERMAN_STYLE_ROWS: string[][] = [
  ["1", "Kantholz 45x19 gehobelt", "12", "Stk", "15,50", "186,00"],
  ["2", "Terrassenschrauben Box", "8", "Box", "22,25", "178,00"],
  ["3", "Balkenschuh verzinkt 90", "5", "Stk", "9,90", "49,50"],
];

/**
 * A German-style page with a figure below the table under a label the
 * vocabulary doesn't know ("Endbetrag"). With `matches`, the figure equals
 * the lines (413,50); without, it doesn't (450,00).
 */
export function unknownLabelTotal(options: { matches: boolean }): Promise<Uint8Array> {
  const amount = options.matches ? "413,50" : "450,00";
  return buildPdf({ pages: [{ rows: GERMAN_STYLE_ROWS.map((row) => [...row]), totals: [{ label: "Endbetrag:", amount }] }] });
}

/** Three pages; page 2 is only an image (a scan), and page 3 prints a total covering all three. */
export function totalAfterScan(): Promise<Uint8Array> {
  return buildPdf({
    pages: [{}, { imageOnly: true }, { totals: [{ label: "Total:", amount: "$827.00" }] }],
  });
}
