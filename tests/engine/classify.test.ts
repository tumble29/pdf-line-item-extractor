/**
 * Tests for src/lib/engine/classify-page.ts, with hand-made pages.
 *
 * Each rule that refuses a page gets a test that should refuse, and a close
 * case that should NOT refuse (for example one sideways stamp on a normal
 * table must not refuse the whole page).
 */
import { describe, expect, it } from "vitest";

import { classifyPage, GARBLED_SHARE } from "@/lib/engine/classify-page";

import { piece, rawPage, uprightTable } from "../fixtures/items";

describe("classifyPage", () => {
  it("calls a page with no text, no images and no drawings blank", () => {
    expect(classifyPage(rawPage([]))).toEqual({ kind: "blank" });
  });

  it("refuses a page with images and no text as a scan", () => {
    expect(classifyPage(rawPage([], { imageCount: 1 }))).toEqual({
      kind: "refused",
      reason: { code: "NO_TEXT_LAYER", form: "scan" },
    });
  });

  it("refuses a page with drawings and no text, instead of calling it blank", () => {
    // Text saved as outlines looks like this: many shapes, no text at all.
    expect(classifyPage(rawPage([], { drawingCount: 120 }))).toEqual({
      kind: "refused",
      reason: { code: "NO_TEXT_LAYER", form: "shapes" },
    });
  });

  it("reads a normal page as text, with nothing removed and no notes", () => {
    const pieces = uprightTable();
    const result = classifyPage(rawPage(pieces));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.pieces).toHaveLength(pieces.length);
      expect(result.notes).toEqual([]);
    }
  });

  it("refuses a page whose text is mostly broken characters", () => {
    const broken = [piece("���", 71, 198), piece("", 326, 198), piece("ok", 400, 198)];
    expect(classifyPage(rawPage(broken))).toEqual({ kind: "refused", reason: { code: "GARBLED_TEXT" } });
  });

  it("keeps a page with only a few broken characters", () => {
    const pieces = [...uprightTable(), piece("�", 10, 10)];
    // One broken character among many letters stays under the 20% limit.
    expect(GARBLED_SHARE).toBe(0.2);
    expect(classifyPage(rawPage(pieces)).kind).toBe("text");
  });

  it("counts ligatures as normal letters, not as broken ones", () => {
    const pieces = [piece("ﬁttings", 71, 198), piece("12", 326, 198)]; // "fittings" written with the ﬁ ligature
    expect(classifyPage(rawPage(pieces)).kind).toBe("text");
  });

  it("refuses a page when most of its numbers are sideways", () => {
    const sideways = uprightTable().map((p) => ({ ...p, angle: 90 }));
    expect(classifyPage(rawPage(sideways))).toEqual({ kind: "refused", reason: { code: "ROTATED_TEXT", allText: false } });
  });

  it("counts upside-down text as sideways", () => {
    const upsideDown = uprightTable().map((p) => ({ ...p, angle: 180 }));
    expect(classifyPage(rawPage(upsideDown))).toEqual({ kind: "refused", reason: { code: "ROTATED_TEXT", allText: false } });
  });

  it("drops one sideways stamp from a normal table, with a note", () => {
    const stamp = piece("PAID", 300, 400, { angle: 45 });
    const result = classifyPage(rawPage([...uprightTable(), stamp], { page: 3 }));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.pieces.map((p) => p.str)).not.toContain("PAID");
      expect(result.notes).toEqual([{ level: "info", text: "On page 3, some sideways text (like a stamp or watermark) was ignored." }]);
    }
  });

  it("allows a small tilt, like a slightly crooked line", () => {
    const tilted = uprightTable().map((p) => ({ ...p, angle: 3 }));
    expect(classifyPage(rawPage(tilted)).kind).toBe("text");
  });

  it("refuses a page where everything is sideways, even with no numbers, with its own reason", () => {
    // For example a page whose only text is a diagonal "COPY" watermark.
    const words = [piece("Delivery", 100, 100, { angle: 90 }), piece("notes", 100, 150, { angle: 90 })];
    expect(classifyPage(rawPage(words))).toEqual({ kind: "refused", reason: { code: "ROTATED_TEXT", allText: true } });
  });

  it("reads a page with text and images, noting that the images were not read", () => {
    const result = classifyPage(rawPage(uprightTable(), { page: 2, imageCount: 1 }));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.imageCount).toBe(1);
      expect(result.notes[0]?.text).toContain("Page 2 has images as well as text");
    }
  });
});
