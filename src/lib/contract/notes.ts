/**
 * The words the user sees for every note.
 *
 * A note is something the user should know that is NOT a refusal: no line item
 * or total was left out because of it. A note may still say that some text
 * outside the table was skipped, such as a sideways stamp. Notes are shown next
 * to each page on screen.
 *
 *   info     background, for example "we found nothing to read on page 3"
 *   warning  asks for care (none yet; Part 5 adds the first ones)
 *
 * Like the refusal messages in codes.ts, all note wording lives here, so a test
 * can check every sentence at once. More notes are added as the engine grows.
 */
import type { Note } from "./schema";

function info(text: string): Note {
  return { level: "info", text };
}

/** Every note the engine can add, by name. Each takes the facts it needs and returns a Note. */
export const NOTES = {
  /**
   * A page where pdf.js found no text, no images and no drawings. This is
   * usually a blank page. It can also be a page whose content is damaged in a
   * way pdf.js skips without an error, so the wording claims only what we know.
   */
  blankPage: (page: number): Note => info(`We found nothing to read on page ${page}.`),

  /** A page with real text that also draws images (a logo, a photo, a signature). */
  imagesNotRead: (page: number): Note =>
    info(`Page ${page} has images as well as text. We read the text but not the images.`),

  /**
   * Some sideways text (like a "PAID" stamp or a watermark) on a page where
   * most numbers are upright. It is left out so it can't be mixed into the
   * table.
   */
  rotatedTextIgnored: (page: number): Note =>
    info(`On page ${page}, some sideways text (like a stamp or watermark) was ignored.`),
} as const;
