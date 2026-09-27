/**
 * Builds pages by hand, as plain objects, without making a PDF.
 *
 * Many rules only look at the positioned text pieces (classification, and in
 * Part 5 table detection). Testing them with hand-made pieces is faster than
 * building a PDF, and lets a test set exact angles, positions and characters,
 * for example a sideways number or a broken character.
 */
import type { RawPage, TextPiece } from "@/lib/engine/read-page";

/** One text piece. Width defaults to a rough estimate from the text length. */
export function piece(str: string, x: number, y: number, extras: Partial<TextPiece> = {}): TextPiece {
  const fontSize = extras.fontSize ?? 9;
  return {
    str,
    x,
    y,
    width: extras.width ?? str.length * fontSize * 0.5,
    fontSize,
    angle: extras.angle ?? 0,
    order: extras.order ?? 0,
  };
}

/**
 * A page made from pieces. Each piece is copied and gets its stream order from
 * its position in the list, so the caller's pieces are not changed.
 * `streamText` is built the same way read-page.ts builds it (all text joined,
 * whitespace removed).
 */
export function rawPage(
  pieces: TextPiece[],
  options: { page?: number; imageCount?: number; drawingCount?: number } = {},
): RawPage {
  const ordered = pieces.map((p, order) => ({ ...p, order }));
  return {
    page: options.page ?? 1,
    width: 595,
    height: 842,
    pieces: ordered,
    imageCount: options.imageCount ?? 0,
    drawingCount: options.drawingCount ?? 0,
    streamText: ordered.map((p) => p.str.replace(/\s+/gu, "")).join(""),
  };
}

/** A small upright table: a header and two rows of numbers. Used as a "normal page". */
export function uprightTable(): TextPiece[] {
  return [
    piece("Description", 71, 176),
    piece("Qty", 326, 176),
    piece("Line Total", 502, 176),
    piece("Pine batten 45x19", 71, 198),
    piece("12", 326, 198),
    piece("$186.00", 502, 198),
    piece("Deck screws 10g box", 71, 215),
    piece("8", 326, 215),
    piece("$178.00", 502, 215),
  ];
}
