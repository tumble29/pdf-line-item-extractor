/**
 * Everything the page shows for a file that was read, in this order:
 *
 *   1. The summary: how many line items from how many pages, how many things
 *      we couldn't read or check, how many warnings. With no items it says so
 *      plainly, never "Success". One more line when the document writes
 *      numbers in an unusual way, or when some numbers could be read two ways.
 *      The summary is the screen's title, which the page focuses when it
 *      appears (`titleRef`).
 *   2. What we couldn't read or check (RefusalList), above the items, so it is
 *      seen.
 *   3. The totals: the printed totals, and whether the lines add up to them.
 *   4. The pages (PageStrip): each page's status, title and notes.
 *   5. The line items (ItemsTable).
 */
import type { Ref } from "react";

import type { ParseResult } from "@/lib/contract/schema";

import { numberFormatSentence, summaryParts, totalLabel } from "./format";
import { ItemsTable } from "./items-table";
import { PageStrip } from "./page-strip";
import { RefusalList, Sentence } from "./refusal-list";

function SummaryBanner({ result, titleRef }: { result: ParseResult; titleRef: Ref<HTMLHeadingElement> }) {
  const { parts, listed } = summaryParts(result);
  const formatLine = numberFormatSentence(result.numberFormat, {
    twoReadings: result.refusals.some((refusal) => refusal.code === "AMBIGUOUS_NUMBER_FORMAT"),
    tablePages: result.pages.filter((page) => page.columns.length > 0).length,
  });
  const clean = result.items.length > 0 && result.refusals.length === 0;
  return (
    <div
      className={`rounded-lg border p-4 ${clean ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "border-amber-500 bg-amber-50 dark:bg-amber-950/40"}`}
    >
      <p className="text-sm text-neutral-600 wrap-anywhere dark:text-neutral-400">{result.fileName}</p>
      <h2 ref={titleRef} tabIndex={-1} className="mt-1 text-lg font-semibold focus:outline-none">
        {parts.join(" · ")}
        {listed && <span className="font-normal">, listed below</span>}.
      </h2>
      {formatLine && <p className="mt-1 text-sm">{formatLine}</p>}
    </div>
  );
}

/**
 * The printed totals, and the one check of the lines against them. Left out
 * when the file has no line items and no printed total: there is nothing to
 * say then that the refusals don't already say.
 */
function TotalsSummary({ result }: { result: ParseResult }) {
  const { stated, checks, gstBasis } = result.totals;
  if (result.items.length === 0 && stated.length === 0) return null;
  const check = checks[0];
  // What the lines were checked against: the subtotal, or the total.
  const targetKind = check?.name === "lines_vs_subtotal" ? "subtotal" : "total";
  const target = stated.filter((total) => total.label === targetKind).at(-1);
  let outcome: string | null = null;
  if (check?.outcome === "pass") {
    outcome = target
      ? `The lines add up to the printed ${totalLabel(target).toLowerCase()} (${target.amount.raw}).`
      : `The lines add up to the printed ${targetKind}.`;
  } else if (check?.outcome === "fail") {
    outcome = `The lines don't add up to the printed ${targetKind}. The numbers are in the card above.`;
  } else if (check?.reason) {
    outcome = `Not checked: ${check.reason}`;
  }
  return (
    <section aria-labelledby="totals-heading" className="mt-6">
      <h2 id="totals-heading" className="text-lg font-semibold">
        Totals
      </h2>
      {stated.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {stated.map((total, k) => (
            <li key={k} className="wrap-anywhere">
              <span className="font-medium">{totalLabel(total)}</span>
              {!total.labelKnown && <span className="text-neutral-600 dark:text-neutral-400"> (label not recognised)</span>}
              <span className="text-neutral-600 dark:text-neutral-400"> · page {total.page}: </span>
              <span className="font-mono text-xs">“{total.sourceText}”</span>
            </li>
          ))}
        </ul>
      )}
      {outcome && (
        <p className="mt-2 text-sm">
          {check?.outcome === "pass" && <span aria-hidden="true">✓ </span>}
          <Sentence text={outcome} />
        </p>
      )}
      {gstBasis !== "unstated" && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          The document says its amounts {gstBasis === "inclusive" ? "include" : "don't include"} GST.
        </p>
      )}
    </section>
  );
}

export function ResultView({ result, titleRef }: { result: ParseResult; titleRef: Ref<HTMLHeadingElement> }) {
  return (
    <div>
      <SummaryBanner result={result} titleRef={titleRef} />
      <RefusalList refusals={result.refusals} />
      <TotalsSummary result={result} />
      <PageStrip pages={result.pages} refusals={result.refusals} />
      <ItemsTable pages={result.pages} items={result.items} />
    </div>
  );
}
