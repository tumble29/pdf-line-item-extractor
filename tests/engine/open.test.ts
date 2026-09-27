/**
 * Tests for src/lib/engine/open.ts: opening a PDF.
 *
 * The key rule: a problem with the FILE gets a refusal (ENCRYPTED or
 * CORRUPT_FILE), but a problem in OUR code (or in pdf.js) is thrown again, so
 * the route can answer "this is our bug". We must never tell a user their file
 * is damaged when the fault is ours.
 */
import { describe, expect, it } from "vitest";

import { parsePdf, defaultDeps } from "@/lib/engine";
import { MAX_PAGES } from "@/lib/contract/limits";
import { openDocument, type DocumentLoader } from "@/lib/engine/open";
import type { PDFDocumentProxy } from "@/lib/engine/pdfjs";

import { buildPdf, certificateProtected, encrypted, ownerOnly, truncated } from "../fixtures/build";

/** A loader that returns a stand-in document with the given page count, to test the checks after opening. */
function fakeDocument(numPages: number): DocumentLoader {
  return async () => ({ numPages, loadingTask: { destroy: async () => {} } }) as unknown as PDFDocumentProxy;
}

/** An error shaped like the ones pdf.js sends back from its worker code. */
function pdfjsError(name: string, message: string, details?: string): Error {
  const error = new Error(message) as Error & { details?: string };
  error.name = name;
  if (details !== undefined) error.details = details;
  return error;
}

describe("openDocument", () => {
  it("opens a normal PDF", async () => {
    const opened = await openDocument(await buildPdf({ pages: [{}, {}] }));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.doc.numPages).toBe(2);
      await opened.doc.loadingTask.destroy();
    }
  });

  it("refuses a password-protected PDF as ENCRYPTED", async () => {
    const opened = await openDocument(await encrypted());
    expect(opened.ok || opened.refusal.code).toBe("ENCRYPTED");
  });

  it("opens a PDF with only an owner password, because anyone may read it", async () => {
    const opened = await openDocument(await ownerOnly());
    expect(opened.ok).toBe(true);
    if (opened.ok) await opened.doc.loadingTask.destroy();
  });

  it("refuses a certificate-protected PDF as ENCRYPTED, not as damaged", async () => {
    const opened = await openDocument(await certificateProtected());
    expect(opened.ok || opened.refusal.code).toBe("ENCRYPTED");
  });

  it("refuses a truncated PDF as CORRUPT_FILE", async () => {
    const opened = await openDocument(await truncated());
    expect(opened.ok || opened.refusal.code).toBe("CORRUPT_FILE");
  });

  it("refuses a file that starts like a PDF but has nothing after the header", async () => {
    const opened = await openDocument(new TextEncoder().encode("%PDF-1.7\nthis is not a real PDF body\n"));
    expect(opened.ok || opened.refusal.code).toBe("CORRUPT_FILE");
  });

  it("refuses a file that says it has no pages, or a negative number of pages", async () => {
    for (const count of [0, -5]) {
      const opened = await openDocument(await buildPdf(), fakeDocument(count));
      expect(opened.ok || opened.refusal.code).toBe("CORRUPT_FILE");
    }
  });

  it("refuses a file with more pages than we read, before reading any page", async () => {
    const opened = await openDocument(await buildPdf(), fakeDocument(MAX_PAGES + 1));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.refusal.code).toBe("TOO_MANY_PAGES");
      expect(opened.refusal.message).toBe(
        `This file has ${MAX_PAGES + 1} pages. We read files of up to ${MAX_PAGES} pages. Split it into smaller files and try again.`,
      );
    }
    expect((await openDocument(await buildPdf(), fakeDocument(MAX_PAGES))).ok).toBe(true);
  });

  it("throws a JavaScript error from inside pdf.js again, instead of calling the file damaged", async () => {
    // pdf.js wraps its own errors as UnknownErrorException and keeps the
    // original in `details`. A TypeError there is a bug, not a damaged file.
    const pdfjsBug: DocumentLoader = async () => {
      throw pdfjsError("UnknownErrorException", "cannot read properties of undefined", "TypeError: cannot read properties of undefined");
    };
    await expect(openDocument(await buildPdf(), pdfjsBug)).rejects.toThrow("cannot read properties of undefined");
  });

  it("treats a pdf.js format error as a damaged file", async () => {
    const damaged: DocumentLoader = async () => {
      throw pdfjsError("UnknownErrorException", "Bad FCHECK in flate stream", "FormatError: Bad FCHECK in flate stream");
    };
    const opened = await openDocument(await buildPdf(), damaged);
    expect(opened.ok || opened.refusal.code).toBe("CORRUPT_FILE");
  });

  it("throws our own bugs again instead of blaming the file", async () => {
    const buggyLoader = async () => {
      throw new TypeError("cannot read properties of undefined");
    };
    await expect(openDocument(await buildPdf(), buggyLoader)).rejects.toThrow(TypeError);
    // And the engine as a whole does the same, so the route answers INTERNAL.
    await expect(parsePdf(await buildPdf(), { ...defaultDeps, load: buggyLoader })).rejects.toThrow(TypeError);
  });

  it("leaves the caller's bytes untouched", async () => {
    // pdf.js empties the buffer it is given, so openDocument must pass a copy.
    const bytes = await buildPdf();
    const length = bytes.length;
    const opened = await openDocument(bytes);
    expect(bytes.length).toBe(length);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    if (opened.ok) await opened.doc.loadingTask.destroy();
  });
});
