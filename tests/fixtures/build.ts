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
  (spec.after ?? []).forEach((line, index) => text(doc, line, 43, afterY + index * LAYOUT.rowGap));
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
