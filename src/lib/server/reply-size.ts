/**
 * The size of the route's reply, and how to split a file whose reply is too
 * large to send.
 *
 * Why this file exists: Vercel stops a reply over 4.5 MB and sends its own
 * plain-text page instead, which the web page can't explain. So the route
 * measures its reply first (limits.ts, MAX_REPLY_BYTES), and a file whose
 * reply is too large is refused as TOO_MANY_LINES, with a sentence that says
 * about how many pages each part should have.
 *
 * How the part size is found: the pages of a file can be very different
 * (40 lines on page 1, 2 lines on page 9), so dividing the reply evenly over
 * the pages can suggest parts that are still too large. Instead, each page's
 * own share of the reply is added up (its page report, its line items and its
 * refusals, as JSON), and the part size is the largest number of pages for
 * which every part, taken in order (pages 1 to n, n+1 to 2n, ...), fits.
 */
import type { ParseResult } from "@/lib/contract/schema";

/**
 * The share of the limit the estimate may fill. The estimate leaves out a
 * little (the commas between items, and the totals each part will have), so
 * it aims 10% below the limit.
 */
export const SPLIT_MARGIN = 0.9;

/** The size of a text in bytes, as it is sent (UTF-8). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * About how many pages each part of the file may have, so that the reply for
 * every part is under `limitBytes`. `replyBytes` is the size of the whole
 * reply. null when the file has one page only, or when even one page is too
 * much.
 */
export function pagesPerPart(result: ParseResult, replyBytes: number, limitBytes: number): number | null {
  if (result.pageCount <= 1) return null;

  // Each page's share: its report, its items and its refusals (a refusal of
  // the whole document belongs to no page).
  const perPage = new Array<number>(result.pageCount + 1).fill(0);
  const add = (page: number | undefined, value: unknown) => {
    if (page !== undefined && page >= 1 && page <= result.pageCount) perPage[page] += byteLength(JSON.stringify(value));
  };
  for (const report of result.pages) add(report.page, report);
  for (const item of result.items) add(item.page, item);
  for (const refusal of result.refusals) if (refusal.scope !== "document") add(refusal.page, refusal);

  // What every part carries whatever its pages: the fixed fields, the totals
  // and the whole-document refusals. It is what is left of the reply.
  const pageBytes = perPage.reduce((sum, bytes) => sum + bytes, 0);
  const budget = limitBytes * SPLIT_MARGIN - Math.max(0, replyBytes - pageBytes);
  if (budget <= 0) return null;

  // The largest n for which every part of n pages, in order, fits.
  for (let n = result.pageCount - 1; n >= 1; n--) {
    let fits = true;
    for (let first = 1; first <= result.pageCount && fits; first += n) {
      let part = 0;
      for (let page = first; page < first + n && page <= result.pageCount; page++) part += perPage[page];
      fits = part <= budget;
    }
    if (fits) return n;
  }
  return null;
}
