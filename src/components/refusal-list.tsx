/**
 * The list of everything we couldn't read or check, shown ABOVE the items
 * whenever there is anything in it, so it is never missed.
 *
 * Refusals are grouped by what they cover: the whole file (including counts
 * that contradict each other), whole pages, single lines, and the totals. Each
 * card shows the engine's sentence exactly as sent, the page, the lines it
 * quotes from the document, and the refusal's code in small print (for a
 * developer or for a bug report). The group headings differ from the page's
 * section headings ("Pages", "Totals"), so a screen reader's list of headings
 * never has two of the same name.
 *
 * One phrase in the sentences gets a visual mark: "(calculated by us)" becomes
 * a tag, so a number we worked out can't be mistaken for one from the page.
 * Two codes get extra words: on a returns or credit page, the quoted lines are
 * labelled "not listed as items"; and on a COLUMN_MEANING_UNKNOWN page (no
 * column could be read as a quantity, price or total), one line says where
 * its rows are shown. An AMBIGUOUS_COLUMNS page lists no rows.
 */
import type { Refusal } from "@/lib/contract/schema";

/** The groups, in the order they are shown. */
const GROUPS: { scope: Refusal["scope"]; title: string }[] = [
  { scope: "document", title: "About the whole file" },
  { scope: "page", title: "About whole pages" },
  { scope: "row", title: "Lines left out" },
  { scope: "totals", title: "About the totals" },
];

/** The phrase codes.ts adds after every number we calculated. */
const CALCULATED = "(calculated by us)";

/** A sentence with each "(calculated by us)" shown as a tag. */
export function Sentence({ text }: { text: string }) {
  const parts = text.split(CALCULATED);
  return (
    <>
      {parts.map((part, k) => (
        <span key={k}>
          {part}
          {k < parts.length - 1 && (
            <span className="mx-0.5 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-900 dark:text-sky-100">
              calculated by us
            </span>
          )}
        </span>
      ))}
    </>
  );
}

/** The quoted lines of a refusal, each with its page. */
function Quotes({ refusal }: { refusal: Refusal }) {
  if (refusal.evidence.length === 0) return null;
  const label =
    refusal.code === "CREDIT_OR_RETURN_PAGE"
      ? "What the page says (not listed as items):"
      : refusal.evidence.length === 1
        ? "The line:"
        : "The lines:";
  return (
    <div className="mt-2">
      <p className="text-xs text-neutral-600 dark:text-neutral-400">{label}</p>
      <ul className="mt-1 space-y-1">
        {refusal.evidence.map((quote, k) => (
          <li key={k} className="rounded bg-neutral-100 px-2 py-1 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-800">
            <span className="text-neutral-600 dark:text-neutral-400">Page {quote.page}: </span>
            {quote.sourceText}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One refusal. */
function RefusalCard({ refusal }: { refusal: Refusal }) {
  return (
    <li className="rounded-lg border border-amber-400 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
      <p>
        <span aria-hidden="true">⚠ </span>
        <Sentence text={refusal.message} />
      </p>
      {refusal.code === "COLUMN_MEANING_UNKNOWN" && refusal.page !== undefined && (
        <p className="mt-1 text-sm">You&apos;ll find them in the line items table below, under &ldquo;Page {refusal.page}&rdquo;.</p>
      )}
      <Quotes refusal={refusal} />
      <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
        {refusal.page !== undefined && `Page ${refusal.page}${refusal.rowIndex !== undefined ? `, line ${refusal.rowIndex + 1}` : ""} · `}
        {refusal.code}
      </p>
    </li>
  );
}

/** Every refusal, grouped. Nothing is shown when there are none. */
export function RefusalList({ refusals }: { refusals: readonly Refusal[] }) {
  if (refusals.length === 0) return null;
  return (
    <section aria-labelledby="refusals-heading" className="mt-6">
      <h2 id="refusals-heading" className="text-lg font-semibold">
        What we couldn&apos;t read or check ({refusals.length})
      </h2>
      {GROUPS.map(({ scope, title }) => {
        const inGroup = refusals.filter((refusal) => refusal.scope === scope);
        if (inGroup.length === 0) return null;
        return (
          <div key={scope} className="mt-3">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{title}</h3>
            <ul className="mt-2 space-y-2">
              {inGroup.map((refusal) => (
                <RefusalCard key={refusal.id} refusal={refusal} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
