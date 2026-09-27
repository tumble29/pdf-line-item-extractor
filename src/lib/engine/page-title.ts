/**
 * Reads a page's title, for the returns/credit check and the summary warning.
 *
 * Where it sits: after the table detector (table.ts) has found a table and the
 * rows above it (PageLayout.above). The page step then uses the result:
 *
 *   - creditTitle set   the page gets a CREDIT_OR_RETURN_PAGE page refusal,
 *                       with creditRow in its evidence
 *   - summaryTitle set  the rows are read as normal, plus a warning note that
 *                       they may repeat lines from other pages
 *   - titleLines        go into PageReport.titleLines
 *
 * How to read it: `isLabelLine` sorts the rows above the table into title
 * lines and "Label: value" lines. `readPageTitle` then looks for the words
 * from vocabulary.ts in them. The words are English only, so on a page in
 * another language this check finds nothing. roles.ts adds a warning when it
 * recognises none of the table's headings, because that suggests the page is
 * in another language and this check may have missed its title.
 */
import type { Row } from "./rows";
import { CREDIT_WORDS, findWord, SUMMARY_WORDS, type WordList } from "./vocabulary";

/** What the rows above a table say about the page. */
export interface PageTitle {
  /** The title lines: rows above the table that are not "Label: value" lines, as printed. */
  titleLines: string[];
  /**
   * When a title line, or the label part of a label line, contains a credit or
   * return word: the part of that line that contains it, split on " - ",
   * " – " or " | " ("Returns Note"). Otherwise null.
   */
  creditTitle: string | null;
  /** The row that `creditTitle` came from, for the refusal's evidence. */
  creditRow: Row | null;
  /** When a title line (never a label line) contains a summary word, and there is no credit word: the quoted part ("Summary"). */
  summaryTitle: string | null;
}

/**
 * The start of a "Label: value" line: 1 to 3 words (runs of characters that
 * are not spaces and not colons), maybe spaces, then a colon.
 *
 * Why 3 words at most: real labels are short ("Date", "Document No",
 * "Delivered to", "N° de document"). A longer run before a colon is usually a
 * sentence or a title, and we want to check titles.
 *
 * Group 1 is the label part, group 2 the spaces before the colon, and group 3
 * the character right after the colon (empty at the end of the line).
 */
const LABEL_START = /^\s*([^\s:]+(?:\s+[^\s:]+){0,2})(\s*):(.?)/u;

/** One digit, in any script. */
const DIGIT = /^\p{N}$/u;

/** The separators that split a title into parts: " - ", " – " (en dash) and " | ". */
const TITLE_SEPARATOR = / (?:-|–|\|) /u;

/**
 * Reads the label part of a "Label: value" line, or null when the line is not
 * one.
 *
 * A colon directly between two digits is not a label colon: it is a time or
 * a ratio ("Run 7 10:30"). Without this rule a title such as
 * "Summary - 10:30" would count as a label line, and its summary word would
 * be missed.
 */
function labelPart(text: string): string | null {
  const match = LABEL_START.exec(text);
  if (match === null) return null;
  const [, label, spaceBeforeColon, afterColon] = match;
  const lastBeforeColon = label.slice(-1);
  if (spaceBeforeColon === "" && DIGIT.test(lastBeforeColon) && DIGIT.test(afterColon)) return null;
  return label;
}

/**
 * True for a "Label: value" line: 1 to 3 words, then a colon, with or without
 * a space before it ("Document No:", "Delivered to:", "Summary:", "Date :").
 */
export function isLabelLine(text: string): boolean {
  return labelPart(text) !== null;
}

/**
 * The part of `line` to quote for a matched word: the first segment (split on
 * " - ", " – " or " | ") that contains a word from `lists`, trimmed. When the
 * line has no separator, or no single segment holds the word, it is the whole
 * line, trimmed.
 */
function quotedPart(line: string, lists: readonly WordList[]): string {
  const segments = line.split(TITLE_SEPARATOR);
  const segment = segments.find((part) => findWord(part, lists) !== null);
  return (segment ?? line).trim();
}

/**
 * Reads the title from the rows above a table (PageLayout.above).
 *
 * Rows are checked from the top down, and the first row with a match is the
 * one quoted. A credit or return word counts in a title line and in the label
 * part of a label line ("Credit Note: CN-1"), because a returns page is often
 * marked only by such a label. A summary word counts in title lines only: a
 * label line such as "Summary: 14 pallets loaded" describes the delivery, it
 * does not say that the page repeats other pages. When both kinds of word
 * appear, credit wins, because refusing a returns page is the safer outcome.
 */
export function readPageTitle(above: readonly Row[]): PageTitle {
  const titleLines: string[] = [];
  let creditTitle: string | null = null;
  let creditRow: Row | null = null;
  let summaryTitle: string | null = null;

  for (const row of above) {
    const label = labelPart(row.text);
    const isTitle = label === null;
    if (isTitle) titleLines.push(row.text);

    // For a label line only the label part is searched, so a value such as
    // "Reason: stock return" does not make the page a returns page. The quote
    // still comes from the whole line ("Credit Note: CN-1").
    const searched = isTitle ? row.text : label;
    if (creditTitle === null && findWord(searched, CREDIT_WORDS) !== null) {
      creditTitle = quotedPart(row.text, CREDIT_WORDS);
      creditRow = row;
    }
    if (summaryTitle === null && isTitle && findWord(row.text, SUMMARY_WORDS) !== null) {
      summaryTitle = quotedPart(row.text, SUMMARY_WORDS);
    }
  }

  return { titleLines, creditTitle, creditRow, summaryTitle: creditTitle === null ? summaryTitle : null };
}
