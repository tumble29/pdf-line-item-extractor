/**
 * Deciding what kind of page this is, before looking
 * for a table.
 *
 * Some pages can't be read safely at all. It is better to refuse them with a
 * clear reason than to read wrong numbers from them:
 *
 *   blank          nothing on the page: no text, no images, no drawings. Not a
 *                  refusal, only a note.
 *   NO_TEXT_LAYER  no text, but an image (a scanned picture) or drawings (text
 *                  saved as shapes). We don't read pictures or shapes (no OCR),
 *                  so the page is refused.
 *   GARBLED_TEXT   the text came out as broken characters (the PDF's font
 *                  can't be mapped back to letters), so none of it is trusted.
 *   ROTATED_TEXT   more than half of the numbers are sideways, or all of the
 *                  text is. Rows and columns would be guessed wrongly, so the
 *                  page is refused.
 *   text           a normal page. It goes on to table detection (table.ts).
 *
 * This is a pure function: it only looks at the page it is given, so it is easy
 * to test with hand-made pages.
 */
import { NOTES } from "@/lib/contract/notes";
import type { Note } from "@/lib/contract/schema";

import type { RawPage, TextPiece } from "./read-page";
import { looksLikeNumber } from "./shapes";

/** Why a page was refused, with the facts its message needs (everything except the page number). */
export type ClassificationRefusal =
  | { code: "NO_TEXT_LAYER"; form: "scan" | "shapes" }
  | { code: "GARBLED_TEXT" }
  | { code: "ROTATED_TEXT"; allText: boolean };

/** What classifyPage decided about one page. */
export type PageClassification =
  | { kind: "blank" }
  | { kind: "refused"; reason: ClassificationRefusal }
  | {
      kind: "text";
      /** The pieces to use: every piece except sideways stamps and watermarks. */
      pieces: TextPiece[];
      /** How many images the page draws. index.ts uses this for the "mostly scanned" case. */
      imageCount: number;
      notes: Note[];
    };

/**
 * More than this share of broken characters, and the page's text is not
 * trusted. A normal page can have a few broken characters (a bullet or a logo
 * drawn from a symbol font). At 20%, one character in five is wrong, so the
 * digits can't be trusted either.
 */
export const GARBLED_SHARE = 0.2;

/**
 * Text turned by more than this many degrees counts as sideways. A crooked
 * print or scan tilts text by a degree or two; stamps and watermarks are turned
 * much more (often 30 to 90 degrees). 5 degrees sits between the two.
 */
export const ROTATION_LIMIT_DEGREES = 5;

/**
 * Characters that mean the text could not be decoded:
 *   U+FFFD      the "replacement character" (usually shown as a question mark
 *               in a black diamond)
 *   \p{Co}      "private use" characters, which a PDF font uses when it has no
 *               mapping back to real letters
 */
const BROKEN_CHARACTER = /[�\p{Co}]/gu;

/** True when a piece is turned away from normal reading direction (including upside down). */
function isSideways(piece: TextPiece): boolean {
  return Math.abs(piece.angle) > ROTATION_LIMIT_DEGREES;
}

/**
 * The share of characters on the page that are broken. Text is normalised
 * first (NFKC), so that ligatures like "ﬁ" count as normal letters.
 */
function brokenShare(pieces: TextPiece[]): number {
  const text = pieces
    .map((piece) => piece.str)
    .join("")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
  if (text.length === 0) return 0;
  const broken = text.match(BROKEN_CHARACTER)?.length ?? 0;
  return broken / text.length;
}

/** Decides what kind of page this is. */
export function classifyPage(raw: RawPage): PageClassification {
  // No text at all: a scanned picture, a page of shapes, or nothing.
  if (raw.pieces.length === 0) {
    if (raw.imageCount > 0) return { kind: "refused", reason: { code: "NO_TEXT_LAYER", form: "scan" } };
    if (raw.drawingCount > 0) return { kind: "refused", reason: { code: "NO_TEXT_LAYER", form: "shapes" } };
    return { kind: "blank" };
  }

  if (brokenShare(raw.pieces) > GARBLED_SHARE) {
    return { kind: "refused", reason: { code: "GARBLED_TEXT" } };
  }

  // Sideways text. We only count pieces that look like numbers, because the
  // numbers are what we read. A sideways "PAID" stamp on an upright table is
  // harmless and is simply dropped; a table whose numbers are sideways is not.
  const numbers = raw.pieces.filter((piece) => looksLikeNumber(piece.str));
  const sidewaysNumbers = numbers.filter(isSideways);
  if (numbers.length > 0 && sidewaysNumbers.length > numbers.length / 2) {
    return { kind: "refused", reason: { code: "ROTATED_TEXT", allText: false } };
  }

  const upright = raw.pieces.filter((piece) => !isSideways(piece));
  if (upright.length === 0) {
    // Everything is sideways, even with no numbers: nothing is safe to read.
    return { kind: "refused", reason: { code: "ROTATED_TEXT", allText: true } };
  }

  const notes: Note[] = [];
  if (upright.length < raw.pieces.length) notes.push(NOTES.rotatedTextIgnored(raw.page));
  if (raw.imageCount > 0) notes.push(NOTES.imagesNotRead(raw.page));

  return { kind: "text", pieces: upright, imageCount: raw.imageCount, notes };
}
