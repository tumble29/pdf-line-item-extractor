/**
 * Tests for src/lib/engine/read-page.ts, on real PDFs built by the fixtures.
 *
 * They check that positions come out the way the rest of the engine expects:
 * measured from the top-left, one record per piece of text, pieces that are
 * only spaces dropped, and images counted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDocument } from "@/lib/engine/open";
import type { PDFDocumentProxy, PdfJs } from "@/lib/engine/pdfjs";
import { readPage, type RawPage } from "@/lib/engine/read-page";

import { DEFAULT_COLUMNS, imageOnlyMiddle, shapesOnly } from "../fixtures/build";

let doc: PDFDocumentProxy;
let pdfjs: PdfJs;
let textPage: RawPage;
let imagePage: RawPage;

beforeAll(async () => {
  const opened = await openDocument(await imageOnlyMiddle());
  if (!opened.ok) throw new Error("fixture failed to open");
  ({ doc, pdfjs } = opened);
  textPage = await readPage(doc, pdfjs, 1);
  imagePage = await readPage(doc, pdfjs, 2);
});

afterAll(async () => {
  await doc.loadingTask.destroy();
});

/** The piece whose text is exactly `str`. */
function find(page: RawPage, str: string) {
  const found = page.pieces.find((piece) => piece.str === str);
  if (!found) throw new Error(`no piece "${str}" on page ${page.page}`);
  return found;
}

describe("readPage", () => {
  it("places each header where the fixture drew it, measured from the left", () => {
    for (const column of DEFAULT_COLUMNS) {
      expect(find(textPage, column.header).x).toBeCloseTo(column.x, 0);
    }
  });

  it("measures y from the top, so later rows have larger y", () => {
    expect(find(textPage, "Qty").y).toBeLessThan(find(textPage, "12").y);
    expect(find(textPage, "12").y).toBeLessThan(find(textPage, "8").y);
  });

  it("keeps pieces on one line at the same baseline", () => {
    expect(find(textPage, "12").y).toBeCloseTo(find(textPage, "$186.00").y, 3);
  });

  it("gives the font size, the width and a zero angle for normal text", () => {
    const qty = find(textPage, "Qty");
    expect(qty.fontSize).toBeCloseTo(9, 3);
    expect(qty.width).toBeGreaterThan(0);
    expect(qty.angle).toBeCloseTo(0, 5);
  });

  it("drops pieces that are only spaces", () => {
    expect(textPage.pieces.every((piece) => piece.str.trim().length > 0)).toBe(true);
  });

  it("numbers the pieces in stream order", () => {
    expect(textPage.pieces.map((piece) => piece.order)).toEqual(textPage.pieces.map((_, index) => index));
  });

  it("keeps an untouched copy of the page text with no whitespace", () => {
    // "Pine batten 45x19" with its spaces removed.
    expect(textPage.streamText).toContain("Pinebatten45x19");
    expect(textPage.streamText).toContain("$186.00");
    expect(textPage.streamText).not.toMatch(/\s/);
  });

  it("counts images, and finds no text on an image-only page", () => {
    expect(textPage.imageCount).toBe(0);
    expect(imagePage.imageCount).toBeGreaterThan(0);
    expect(imagePage.pieces).toHaveLength(0);
  });

  it("counts drawings on a page of shapes with no text", async () => {
    const opened = await openDocument(await shapesOnly());
    if (!opened.ok) throw new Error("fixture failed to open");
    const page = await readPage(opened.doc, opened.pdfjs, 1);
    await opened.doc.loadingTask.destroy();
    expect(page.pieces).toHaveLength(0);
    expect(page.imageCount).toBe(0);
    expect(page.drawingCount).toBeGreaterThan(0);
  });

  it("reports the page size in points (A4 is 595 x 842)", () => {
    expect(textPage.width).toBeCloseTo(595.28, 1);
    expect(textPage.height).toBeCloseTo(841.89, 1);
  });
});
