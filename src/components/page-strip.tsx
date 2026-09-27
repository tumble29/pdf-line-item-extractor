/**
 * One card per page: what happened to it, its title line, and its notes.
 *
 * The status is said in words (format.ts, pageStatusLabel: "Read", "Read,
 * with 2 warnings", "Partly read: 1 line left out", "Not read", "No lines
 * listed: all 3 lines were left out", "Nothing found to read"), with a mark
 * and a colour as extra signals, never the only one. Every page that isn't
 * read in full says why: a page refused as a whole shows the page refusal's
 * sentence, and a page whose every line was left out points to the "Lines
 * left out" cards. Warning notes carry an icon and the word "Warning"; info
 * notes are shown plainly. Nothing is hidden in a tooltip.
 */
import type { PageReport, Refusal } from "@/lib/contract/schema";

import { pageStatusLabel, plural } from "./format";
import { Sentence } from "./refusal-list";

/** The mark and colours of each status. */
const STATUS_STYLE: Record<PageReport["status"], { mark: string; className: string }> = {
  extracted: { mark: "✓", className: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" },
  partial: { mark: "◐", className: "border-amber-500 bg-amber-50 dark:bg-amber-950/40" },
  refused: { mark: "✕", className: "border-rose-500 bg-rose-50 dark:bg-rose-950/40" },
  blank: { mark: "○", className: "border-neutral-400 bg-neutral-50 dark:bg-neutral-900" },
};

function PageCard({ page, pageRefusal, linesLeftOut }: { page: PageReport; pageRefusal: Refusal | undefined; linesLeftOut: number }) {
  const style = STATUS_STYLE[page.status];
  const warned = page.status === "extracted" && page.notes.some((note) => note.level === "warning");
  // A page that was read, but none of whose lines could be listed.
  const everyLineLeftOut = page.status === "refused" && !pageRefusal && linesLeftOut > 0;
  return (
    <li className={`min-w-0 rounded-lg border p-3 ${warned ? STATUS_STYLE.partial.className : style.className}`}>
      <p className="font-semibold">
        <span aria-hidden="true">{warned ? "⚠" : style.mark} </span>
        Page {page.page}: {pageStatusLabel(page, { pageRefused: pageRefusal !== undefined, linesLeftOut })}
        {page.itemCount > 0 && <span className="font-normal"> · {plural(page.itemCount, "line item")}</span>}
      </p>
      {/* The first two title lines: usually the sender, then the page's own title. */}
      {page.titleLines.length > 0 && (
        <p className="mt-1 text-sm text-neutral-600 wrap-anywhere dark:text-neutral-400">“{page.titleLines.slice(0, 2).join(" · ")}”</p>
      )}
      {pageRefusal && (
        <p className="mt-1 text-sm">
          <Sentence text={pageRefusal.message} />
        </p>
      )}
      {everyLineLeftOut && <p className="mt-1 text-sm">Why each line was left out is under &ldquo;Lines left out&rdquo; above.</p>}
      {page.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {page.notes.map((note, k) => (
            <li key={k} className={note.level === "warning" ? "font-medium" : "text-neutral-700 dark:text-neutral-300"}>
              {note.level === "warning" ? (
                <>
                  <span aria-hidden="true">⚠ </span>
                  Warning: {note.text}
                </>
              ) : (
                <>
                  <span aria-hidden="true">ⓘ </span>
                  {note.text}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Every page, in order. */
export function PageStrip({ pages, refusals }: { pages: readonly PageReport[]; refusals: readonly Refusal[] }) {
  return (
    <section aria-labelledby="pages-heading" className="mt-6">
      <h2 id="pages-heading" className="text-lg font-semibold">
        Pages
      </h2>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {pages.map((page) => (
          <PageCard
            key={page.page}
            page={page}
            pageRefusal={refusals.find((refusal) => refusal.scope === "page" && refusal.page === page.page)}
            linesLeftOut={refusals.filter((refusal) => refusal.scope === "row" && refusal.page === page.page).length}
          />
        ))}
      </ul>
    </section>
  );
}
