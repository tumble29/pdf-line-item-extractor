/**
 * Small helpers that turn parts of a result into words for the page.
 *
 * Everything the engine says (refusal messages, notes, check reasons) is shown
 * exactly as sent. These helpers only name things the engine gives as data:
 * a page's status, a column without a heading, a file size, how numbers are
 * written, the summary counts, and the kind of a printed total. Each one says
 * only what the result proves. One more helper lays out the server's JSON for
 * reading, without changing it.
 */
import type { NumberFormat, PageReport, ParseResult, StatedTotal } from "@/lib/contract/schema";

/**
 * A file size in megabytes with one decimal ("1.2 MB"), in KB below 0.1 MB
 * ("24 KB"), and in bytes below 1 KB ("0 bytes"), so an empty file never
 * looks like it has something in it.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  const mb = bytes / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "1 page", "3 pages". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the page strip knows about a page besides its report. */
export interface PageFacts {
  /** True when the page itself was refused (a page-scope refusal). */
  pageRefused: boolean;
  /** How many of its lines were left out (row-scope refusals on this page). */
  linesLeftOut: number;
}

/**
 * The words for a page's status, in the page strip. They only claim what the
 * result shows:
 *   - "refused" covers two cases. A page refused as a whole is "Not read". A
 *     page that was read, but whose every line was left out, says so.
 *   - "partial" says how many lines were left out, when some were.
 *   - "blank" means we found nothing to read, which is less than "the page is
 *     empty": there may be something on it we can't see.
 *   - A read page with warnings says how many.
 */
export function pageStatusLabel(page: PageReport, facts: PageFacts): string {
  switch (page.status) {
    case "extracted": {
      const warnings = page.notes.filter((note) => note.level === "warning").length;
      if (warnings === 0) return "Read";
      return warnings === 1 ? "Read, with a warning" : `Read, with ${warnings} warnings`;
    }
    case "partial":
      return facts.linesLeftOut > 0 ? `Partly read: ${plural(facts.linesLeftOut, "line")} left out` : "Partly read";
    case "refused":
      if (facts.pageRefused || facts.linesLeftOut === 0) return "Not read";
      return `No lines listed: ${facts.linesLeftOut === 1 ? "its one line was" : `all ${facts.linesLeftOut} lines were`} left out`;
    case "blank":
      return "Nothing found to read";
  }
}

/** A column's heading as printed, or "Column 3 (no heading)" when it has none. `position` counts from 0. */
export function columnName(header: string | null, position: number): string {
  return header ?? `Column ${position + 1} (no heading)`;
}

/** What the summary knows about the numbers besides the number format. */
export interface NumberFacts {
  /** True when some line or total was refused because its number had two readings. */
  twoReadings: boolean;
  /** How many pages had a table we read (pages with columns). */
  tablePages: number;
}

/**
 * A sentence or two about how the document writes numbers, or null when there
 * is nothing worth saying (the usual "." decimals, or no numbers at all).
 * Each sentence is said only when the result proves it:
 *
 *   - "," decimals: "Numbers on this document use '.' between thousands and ','
 *     as the decimal mark, like 1.195,20."
 *   - pages that write numbers differently: only with two or more pages of
 *     tables, and no AMBIGUOUS_NUMBER_FORMAT refusal. The engine sets
 *     `settled` to false only for that refusal or for pages that differ, so
 *     an unknown, unsettled format with no such refusal means the pages differ.
 *     With such a refusal, the two can't be told apart, so this sentence is
 *     left out rather than risk a false one.
 *   - a number with two readings: only when such a refusal was sent
 */
export function numberFormatSentence(format: NumberFormat, facts: NumberFacts): string | null {
  const sentences: string[] = [];
  if (format.decimal === ",") {
    // Name the thousands mark only when the document proves one. Some
    // documents (Vietnamese dong) never print decimals at all, so the sentence
    // describes the format rather than claiming decimals were seen.
    const grouping = format.grouping === "." || format.grouping === " " || format.grouping === "'" ? format.grouping : null;
    const name = grouping === " " ? "a space" : `'${grouping}'`;
    sentences.push(
      grouping === null
        ? "Numbers on this document use ',' as the decimal mark, like 15,50."
        : `Numbers on this document use ${name} between thousands and ',' as the decimal mark, like 1${grouping}195,20.`,
    );
  }
  const unknown = format.decimal === null && format.grouping === null && !format.settled;
  if (unknown && facts.tablePages >= 2 && !facts.twoReadings) {
    sentences.push("The pages don't all write numbers the same way, so each page was read in its own way.");
  }
  if (facts.twoReadings) {
    sentences.push("Some numbers could be read two ways, so the lines or totals that hold them were left out (listed below).");
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/**
 * The summary of a result, in parts: how many line items from how many pages,
 * how many things we couldn't read or check, and how many warnings. `listed`
 * is true when some of them are listed further down the page. The summary
 * banner shows the parts, and the page's live region reads them out.
 *
 * The pages counted are the pages that gave items ("from 2 of 3 pages"), so
 * the count never claims a page we got nothing from.
 */
export function summaryParts(result: ParseResult): { parts: string[]; listed: boolean } {
  const items = result.items.length;
  const refused = result.refusals.length;
  const warnings = result.pages.reduce((count, page) => count + page.notes.filter((note) => note.level === "warning").length, 0);
  const pagesWithItems = new Set(result.items.map((item) => item.page)).size;
  const from = pagesWithItems === result.pageCount ? plural(result.pageCount, "page") : `${pagesWithItems} of ${result.pageCount} pages`;
  const parts = [
    items > 0
      ? `${plural(items, "line item")} read from ${from}`
      : `No line items were read from ${result.pageCount === 1 ? "this page" : `these ${result.pageCount} pages`}`,
    // A refusal is not always something we couldn't read: a total that
    // disagrees with the lines, or two counts that contradict each other, was
    // read, but couldn't be checked or trusted.
    ...(refused > 0 ? [`${plural(refused, "thing", "things")} we couldn't read or check`] : []),
    ...(warnings > 0 ? [plural(warnings, "warning")] : []),
  ];
  return { parts, listed: refused + warnings > 0 };
}

/** The summary as one sentence, for the live region: "3 line items read from 1 page · 1 warning, listed below." */
export function summarySentence(result: ParseResult): string {
  const { parts, listed } = summaryParts(result);
  return `${parts.join(" · ")}${listed ? ", listed below" : ""}.`;
}

/**
 * A JSON text laid out for reading, two spaces per level. Parsing and writing
 * it again keeps the keys in the order the server sent them, and changes no
 * value. A text that isn't JSON is returned as it is, so nothing is ever lost.
 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** How a printed total's kind is named on the page. */
export function totalLabel(total: StatedTotal): string {
  const words: Record<StatedTotal["label"], string> = {
    subtotal: "Subtotal",
    gst: "GST",
    total: "Total",
    amount_due: "Amount due",
  };
  return words[total.label];
}
