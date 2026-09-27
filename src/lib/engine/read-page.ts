/**
 * Step 3 of the pipeline: read one page into positioned text pieces.
 *
 * A PDF has no rows or columns inside it. It only has drawing instructions
 * like "draw the text '48' at this spot". pdf.js gives us those as text items,
 * each with a transform matrix that says where it is and how it is turned.
 * This file turns each item into a simple record (a `TextPiece`) that the rest
 * of the engine can work with:
 *
 *   - x, y      where the text starts, measured from the TOP-LEFT of the page,
 *               the way people read (PDF itself measures from the bottom-left).
 *               y is the text's baseline.
 *   - width     so the right edge of upright text (x + width) is known
 *   - fontSize  so tolerances can grow with the text size
 *   - angle     0 for normal text. Positive means turned clockwise as seen on
 *               screen: text turned 45 degrees clockwise gives 45, and text
 *               that reads from bottom to top gives -90.
 *
 * It also counts what else the page draws:
 *   - images: a page with images and no text is a scanned picture
 *   - drawings: a page with lines and shapes but no text may have its text
 *     saved as outlines, which we can't read
 */
import type { PDFDocumentProxy, PdfJs } from "./pdfjs";

/** One piece of text on a page, as drawn by the PDF. */
export interface TextPiece {
  /** The text exactly as pdf.js gives it. Not trimmed. */
  str: string;
  /** Where the text starts, in points (1/72 inch) from the left of the page. For upright text this is the left edge. */
  x: number;
  /** Baseline, in points from the top of the page. y grows downwards. */
  y: number;
  /** Width in points. For upright text the right edge is `x + width`. */
  width: number;
  /** Font size in points. */
  fontSize: number;
  /** Angle in degrees, clockwise on screen, after the page's own rotation. 0 is normal reading direction. */
  angle: number;
  /** Position of this piece among the kept pieces, in stream order, starting at 0. Whitespace-only items are not counted. */
  order: number;
}

/** Everything the engine needs from one page. */
export interface RawPage {
  /** Page number, starting at 1. */
  page: number;
  /** Page width and height in points. */
  width: number;
  height: number;
  /** The text pieces, in stream order. Pieces that are only spaces are dropped. */
  pieces: TextPiece[];
  /** How many images the page draws. A scanned page draws at least one. */
  imageCount: number;
  /** How many lines, shapes and text-drawing commands the page has. Zero on a truly empty page. */
  drawingCount: number;
  /**
   * The page's text in stream order with all whitespace removed. It includes
   * sideways text too. The final evidence check (Part 5) uses it as an
   * independent copy of the page text: it is built straight from pdf.js, not
   * from our rebuilt rows.
   */
  streamText: string;
}

/** The part of a pdf.js text item we use. Marked-content items have no `str` and are skipped. */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

/** The font size used when pdf.js gives us none. */
const FALLBACK_FONT_SIZE = 10;

/** pdf.js drawing commands that paint lines, shapes or text (not images). */
const DRAWING_OP_NAMES = [
  "constructPath",
  "rawFillPath",
  "stroke",
  "closeStroke",
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
  "shadingFill",
  "showText",
  "showSpacedText",
  "nextLineShowText",
  "nextLineSetSpacingShowText",
];

/**
 * The sets of pdf.js command numbers we count, built once per pdf.js module:
 *   - images: every command whose name starts with "paint" and contains
 *     "Image". This covers normal images, inline images and image masks.
 *     Image masks matter: black-and-white scans are often drawn that way.
 *   - drawings: the line, shape and text commands above
 */
const opsCache = new WeakMap<object, { images: Set<number>; drawings: Set<number> }>();
function countedOps(pdfjs: PdfJs): { images: Set<number>; drawings: Set<number> } {
  let ops = opsCache.get(pdfjs.OPS);
  if (!ops) {
    const entries = Object.entries(pdfjs.OPS) as [string, number][];
    ops = {
      images: new Set(entries.filter(([name]) => name.startsWith("paint") && name.includes("Image")).map(([, code]) => code)),
      drawings: new Set(entries.filter(([name]) => DRAWING_OP_NAMES.includes(name)).map(([, code]) => code)),
    };
    opsCache.set(pdfjs.OPS, ops);
  }
  return ops;
}

/**
 * Reads one page. Throws if pdf.js can't read it; the caller wraps this call so
 * that one broken page never affects the others (see isolate.ts).
 */
export async function readPage(doc: PDFDocumentProxy, pdfjs: PdfJs, pageNumber: number): Promise<RawPage> {
  const page = await doc.getPage(pageNumber);
  try {
    // At scale 1, one viewport unit is one PDF point. The viewport's transform
    // flips the y axis (so y is measured from the top) and applies the page's
    // own rotation, so rotated pages come out upright.
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const pieces: TextPiece[] = [];
    let streamText = "";
    let order = 0;
    for (const item of content.items) {
      if (!isTextItem(item)) continue;
      // streamText gets every text item, including sideways ones that
      // classifyPage drops later. A whitespace-only item adds nothing here, so
      // skipping it below changes only `pieces`.
      streamText += item.str.replace(/\s+/gu, "");
      if (!item.str.trim()) continue; // pdf.js often gives pieces that are only spaces

      // Combine the page's transform with the item's own transform to get the
      // item's position on the page as a reader sees it.
      const [a, b, , , x, y] = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
      // The length of the item's vertical axis (transform[2], transform[3]) is
      // the font size in points, even when the text is turned. Some items have
      // a zero matrix; then we use pdf.js's height, then a fixed 10.
      const fontSize = Math.hypot(item.transform[2], item.transform[3]) || item.height || FALLBACK_FONT_SIZE;
      pieces.push({
        str: item.str,
        x,
        y,
        width: item.width,
        fontSize,
        angle: (Math.atan2(b, a) * 180) / Math.PI,
        order: order++,
      });
    }

    const operators = await page.getOperatorList();
    const counted = countedOps(pdfjs);
    let imageCount = 0;
    let drawingCount = 0;
    for (const op of operators.fnArray) {
      if (counted.images.has(op)) imageCount++;
      else if (counted.drawings.has(op)) drawingCount++;
    }

    return { page: pageNumber, width: viewport.width, height: viewport.height, pieces, imageCount, drawingCount, streamText };
  } finally {
    // Frees the memory pdf.js keeps for this page. The document stays open.
    page.cleanup();
  }
}
