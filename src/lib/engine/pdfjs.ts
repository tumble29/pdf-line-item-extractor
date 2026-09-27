/**
 * Access to pdf.js, the PDF reader we use (through the unpdf package).
 *
 * unpdf bundles Mozilla's pdf.js in a form that runs on a server with no
 * browser and no canvas. We use it for three things:
 *   - opening the file (getDocumentProxy)
 *   - reading each page's text pieces with their positions (getTextContent)
 *   - counting the image drawing commands on a page (getOperatorList), which
 *     tells us when a page is a scanned picture
 *
 * This file only holds the shared types and the loader, so every engine
 * module talks about pdf.js the same way.
 */
import { getResolvedPDFJS } from "unpdf";

export type { PDFDocumentProxy, PDFPageProxy } from "unpdf/pdfjs";

/** The pdf.js module itself: its classes (PasswordException, ...), constants (OPS) and helpers (Util). */
export type PdfJs = Awaited<ReturnType<typeof getResolvedPDFJS>>;

/** Loads pdf.js. unpdf keeps one copy, so calling this many times is cheap. */
export function loadPdfJs(): Promise<PdfJs> {
  return getResolvedPDFJS();
}
