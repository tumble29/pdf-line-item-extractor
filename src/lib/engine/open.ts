/**
 * Step 2 of the pipeline: open the PDF.
 *
 * Opening can fail for two very different reasons, and the user must be told
 * the right one:
 *
 *   1. The file's fault. The PDF is protected (ENCRYPTED) or damaged
 *      (CORRUPT_FILE). pdf.js signals these with its own error classes.
 *   2. Our fault. Anything else, like a TypeError or a bundling problem, is a
 *      bug in our code or in pdf.js. It is NOT turned into "your file is
 *      damaged", because that would be a false reason. It is thrown again to
 *      the caller, and the route turns it into an INTERNAL problem ("This is
 *      our bug, not a problem with your file").
 *
 * How pdf.js reports errors
 * -------------------------
 * pdf.js reads the file in its "worker" code and sends errors back as one of
 * a few classes. Most errors arrive as `UnknownErrorException`, with the
 * original error written in its `details` field, for example
 * "FormatError: unknown encryption method" or "TypeError: ...". We read
 * `details` to tell a damaged file from a JavaScript bug.
 *
 * One limit to know: pdf.js sometimes catches its own internal errors and
 * reports them as "Invalid Root reference" (an InvalidPDFException). We can't
 * tell those apart from a really damaged file, so a rare pdf.js bug can still
 * be reported as CORRUPT_FILE.
 */
import { getDocumentProxy } from "unpdf";

import { MAX_PAGES } from "@/lib/contract/limits";

import { documentRefusal, type DocumentRefusal } from "./refusals";
import { loadPdfJs, type PDFDocumentProxy, type PdfJs } from "./pdfjs";

/** An opened document, or the reason the file was refused. */
export type OpenResult =
  | { ok: true; doc: PDFDocumentProxy; pdfjs: PdfJs }
  | { ok: false; refusal: DocumentRefusal };

/** How a document is loaded. Tests replace this to simulate bugs and odd files. */
export type DocumentLoader = (data: Uint8Array) => Promise<PDFDocumentProxy>;

/**
 * The normal loader.
 *
 * `verbosity: 0` keeps pdf.js from printing its warnings to the server log.
 * Real refusals are still reported through the errors it throws.
 */
export const defaultLoader: DocumentLoader = (data) => getDocumentProxy(data, { verbosity: 0 });

/**
 * Errors whose `details` start with one of these names are JavaScript bugs
 * (in our code or in pdf.js), never a problem with the file.
 */
const JAVASCRIPT_BUG = /^(TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError|InternalError)\b/;

/**
 * pdf.js messages that mean the file is protected in a way pdf.js can't open,
 * for example certificate security ("unknown encryption method") or an
 * unsupported encryption ("unsupported encryption algorithm").
 */
const UNSUPPORTED_PROTECTION = /encryption (method|algorithm)/i;

/** The text of an error's `details` field, if pdf.js set one. */
function detailsOf(error: unknown): string {
  const details = (error as { details?: unknown } | null)?.details;
  return typeof details === "string" ? details : "";
}

/**
 * Opens a PDF from its bytes.
 *
 * The bytes are copied first: pdf.js takes ownership of the buffer it is given
 * and empties it, and the caller may still need the original.
 */
export async function openDocument(bytes: Uint8Array, load: DocumentLoader = defaultLoader): Promise<OpenResult> {
  const pdfjs = await loadPdfJs();
  let doc: PDFDocumentProxy;
  try {
    doc = await load(new Uint8Array(bytes));
  } catch (error) {
    if (error instanceof pdfjs.PasswordException) {
      // Without a password, pdf.js always reports "a password is needed".
      // A file with only an owner password (for example "no printing") opens
      // normally and never reaches this line.
      return { ok: false, refusal: documentRefusal({ code: "ENCRYPTED" }) };
    }

    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    const details = detailsOf(error);

    // A JavaScript error inside pdf.js: a bug, not the file's fault.
    if (JAVASCRIPT_BUG.test(details)) throw error;

    // Protection pdf.js doesn't support: the file is protected, not damaged.
    if (name === "UnknownErrorException" && (UNSUPPORTED_PROTECTION.test(message) || UNSUPPORTED_PROTECTION.test(details))) {
      return { ok: false, refusal: documentRefusal({ code: "ENCRYPTED" }) };
    }

    // The file's structure is broken. InvalidPDFException is exported by unpdf,
    // so it is checked with `instanceof`; UnknownErrorException is not exported,
    // so it is matched by name. (pdf.js's FormatError never reaches us under its
    // own name: it arrives as an UnknownErrorException, with "FormatError" in
    // `details`.)
    if (error instanceof pdfjs.InvalidPDFException || name === "UnknownErrorException") {
      return { ok: false, refusal: documentRefusal({ code: "CORRUPT_FILE" }) };
    }

    // Anything else is our bug. Don't blame the file.
    throw error;
  }

  // A PDF that says it has no pages (or a negative number of them) has nothing
  // we can read, so we treat it as damaged.
  if (!Number.isInteger(doc.numPages) || doc.numPages < 1) {
    await doc.loadingTask.destroy();
    return { ok: false, refusal: documentRefusal({ code: "CORRUPT_FILE" }) };
  }
  // A page list can point at the same page again and again, so a tiny file can
  // claim thousands of pages. We refuse those up front (see MAX_PAGES).
  if (doc.numPages > MAX_PAGES) {
    const pageCount = doc.numPages;
    await doc.loadingTask.destroy();
    return { ok: false, refusal: documentRefusal({ code: "TOO_MANY_PAGES", pageCount, limit: MAX_PAGES }) };
  }
  return { ok: true, doc, pdfjs };
}
