/**
 * Tests for src/lib/engine/validate.ts: the checks that run before any PDF
 * code. Each problem must get its own refusal with its own sentence.
 */
import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES } from "@/lib/contract/limits";
import { Refusal } from "@/lib/contract/schema";
import { validateUpload } from "@/lib/engine/validate";

import { asFile, buildPdf, empty, notPdf } from "../fixtures/build";

describe("validateUpload", () => {
  it("accepts a PDF and returns its bytes and name", async () => {
    const bytes = await buildPdf();
    const check = await validateUpload(asFile(bytes, "docket.pdf"));
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.fileName).toBe("docket.pdf");
      expect(check.bytes.length).toBe(bytes.length);
    }
  });

  it("refuses a missing file field", async () => {
    const check = await validateUpload(null);
    expect(check.ok || check.refusal.code).toBe("NO_FILE");
  });

  it("refuses a text value sent instead of a file", async () => {
    const check = await validateUpload("not a file");
    expect(check.ok || check.refusal.code).toBe("NO_FILE");
  });

  it("refuses an empty file", async () => {
    const check = await validateUpload(asFile(empty()));
    expect(check.ok || check.refusal.code).toBe("EMPTY_FILE");
  });

  it("refuses a file over the limit without copying its bytes, and says both sizes", async () => {
    // A File whose bytes must never be read: reading them fails the test.
    class NeverRead extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("the bytes of an oversized file were read");
      }
    }
    const check = await validateUpload(new NeverRead([new Uint8Array(3 * 1024 * 1024)], "big.pdf"), 2 * 1024 * 1024);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.refusal.code).toBe("FILE_TOO_LARGE");
      expect(check.refusal.message).toContain("This file is 3 MB. The limit is 2 MB.");
    }
  });

  it("uses a 4 MB limit by default, below Vercel's 4.5 MB body limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
  });

  it("refuses a file without the %PDF- marker, even when named .pdf", async () => {
    const check = await validateUpload(asFile(notPdf(), "renamed.pdf"));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.refusal.code).toBe("NOT_A_PDF");
      expect(check.refusal.message).toContain("even though its name ends in .pdf");
    }
  });

  it("accepts the marker a little way into the file, as PDF readers do", async () => {
    const pdf = await buildPdf();
    const padded = new Uint8Array([...new TextEncoder().encode("junk before the header\n"), ...pdf]);
    expect((await validateUpload(asFile(padded))).ok).toBe(true);
  });

  it("refuses a marker that only appears after the first 1024 bytes", async () => {
    const late = new Uint8Array([...new Uint8Array(1100).fill(32), ...new TextEncoder().encode("%PDF-1.4")]);
    const check = await validateUpload(asFile(late));
    expect(check.ok || check.refusal.code).toBe("NOT_A_PDF");
  });

  it("builds refusals that fit the contract", async () => {
    for (const entry of [null, asFile(empty()), asFile(notPdf())]) {
      const check = await validateUpload(entry);
      if (!check.ok) expect(Refusal.safeParse(check.refusal).success).toBe(true);
    }
  });
});
