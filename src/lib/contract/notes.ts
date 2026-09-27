/**
 * The words the user sees for every note.
 *
 * A note is something the user should know that is NOT a refusal. Most notes
 * are background: a sideways stamp that was ignored, a column shown as
 * printed. Some notes say that a line was not listed on purpose, because it is
 * not a line item: a total carried from another page, a total inside the
 * table, or the lines of another table on the page. Those notes quote the
 * line, so nothing is left out silently. Notes are shown next to each page on
 * screen.
 *
 *   info     background, for example "we found nothing to read on page 3"
 *   warning  asks for care, for example "this page's lines may repeat other pages"
 *
 * Like the refusal messages in codes.ts, all note wording lives here, so a test
 * can check every sentence at once (tests/copy.test.ts).
 */
import type { Note } from "./schema";

function info(text: string): Note {
  return { level: "info", text };
}

function warning(text: string): Note {
  return { level: "warning", text };
}

/** Joins quoted examples: 'a', 'b' and 'c'. */
function quoted(examples: readonly string[]): string {
  const items = examples.map((example) => `'${example}'`);
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every note the engine can add, by name. Each takes the facts it needs and returns a Note. */
export const NOTES = {
  // --- Page contents --------------------------------------------------------

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

  // --- The table ------------------------------------------------------------

  /** A line inside the table with no numbers, such as a section heading ("Stage 1 - Framing"). */
  sectionHeading: (page: number, text: string): Note =>
    info(`On page ${page}, the line '${text}' inside the table has no numbers, so we kept it as a heading, not a line item.`),

  /**
   * A short line with a number between two parts of one table, such as a
   * discount under an item ("Less 10% trade discount -$18.60") or a subtotal.
   * It has fewer cells than a line item, so we can't tell what its number
   * belongs to.
   */
  shortLineInTable: (page: number, text: string): Note =>
    warning(
      `On page ${page}, the line '${text}' inside the table isn't a full line item (it may be a discount or a subtotal), ` +
        "so we didn't list it.",
    ),

  /**
   * Descriptions that go on to the next line, when numbers follow the
   * description on its first line. A quoted field must be one unbroken piece
   * of its row's text, so the description field holds the first line only;
   * the item's source text holds every line.
   */
  descriptionWraps: (page: number): Note =>
    info(
      `On page ${page}, some descriptions go on to the next line. The description shows the first line; ` +
        "the line's source text shows all of it.",
    ),

  /** A "carried forward" or "brought forward" line: a total from another page, skipped so it isn't counted twice. */
  carriedForwardSkipped: (page: number, text: string): Note =>
    info(`On page ${page}, the line '${text}' carries a total from another page, so we skipped it to avoid counting it twice.`),

  /**
   * A line in the table that is a total, not an item: it starts with a word
   * like "Total" or "Subtotal" and has no unit price, or its amount is the sum
   * of the line totals above it. Listing it would count its money twice.
   */
  totalsRowSkipped: (page: number, text: string): Note =>
    info(`On page ${page}, the line '${text}' is a total, not a line item, so we didn't list it.`),

  /**
   * Another table on the page, which we didn't read. We read one table of line
   * items per page: the one with the most number columns.
   */
  otherTableNotRead: (page: number, firstRow: string): Note =>
    warning(`Page ${page} has another table, starting '${firstRow}'. We didn't read it, so its lines are not in the list.`),

  // --- Columns --------------------------------------------------------------

  /** A column we don't read, because we couldn't tell what it holds. Its cells are shown as printed. */
  columnNotRead: (page: number, header: string): Note =>
    info(`We couldn't tell what the '${header}' column on page ${page} holds, so we show its cells as printed.`),

  /**
   * A column that we read by its heading only; the numbers didn't confirm it.
   * `roleWord` is a plain word such as "the quantity" or "a code".
   */
  headerOnlyRole: (page: number, header: string, roleWord: string): Note =>
    info(`On page ${page}, we read the '${header}' column as ${roleWord} because of its heading. The numbers didn't confirm it.`),

  /**
   * A text column whose heading and cell shapes disagree. The heading wins,
   * because no number depends on a text column. `looksLike` and `headingSays`
   * are plain words, like "codes" and "item number".
   */
  headingFollowed: (page: number, header: string, looksLike: string, headingSays: string): Note =>
    info(`The '${header}' column on page ${page} looks like ${looksLike}, but its heading says ${headingSays}, so we followed the heading.`),

  /** A heading that matches two roles equally, like "Qty Unit", so it gives no opinion. */
  headingTwoMeanings: (page: number, header: string): Note =>
    warning(`On page ${page}, the heading '${header}' could mean two different things, so we didn't use it.`),

  /**
   * A column we don't read where some cells say "total" and others don't
   * (like "25kg" next to "480g total"). Adding them up would mix per-item
   * figures with totals, so they are only shown as printed.
   */
  mixedTotalWording: (page: number, header: string, examples: readonly string[]): Note =>
    warning(
      `On page ${page}, the '${header}' column mixes per-item figures and totals (${quoted(examples)}), ` +
        "so we kept them as printed text and didn't read them as numbers.",
    ),

  // --- Titles and headings ----------------------------------------------------

  /** A page titled Summary or Acceptance: its lines may repeat lines from other pages. */
  summaryPage: (page: number, title: string): Note =>
    warning(`Page ${page} is titled '${title}'. Its lines may repeat lines from other pages.`),

  /**
   * A table whose headings contain no word we know. That suggests the page is
   * in another language, and the returns and credit check reads the page's
   * title with English words only.
   */
  unknownHeadings: (page: number): Note =>
    warning(
      `We didn't recognise the headings on page ${page}. Our check for returns and credit pages knows only English words, ` +
        "so it may not work on this page.",
    ),

  /** A table with no heading row at all, so its language can't be seen from the headings. Same reason as `unknownHeadings`. */
  noHeadings: (page: number): Note =>
    warning(
      `The table on page ${page} has no headings, so we couldn't tell its language. Our check for returns and credit pages ` +
        "knows only English words, so it may not work on this page.",
    ),
} as const;
