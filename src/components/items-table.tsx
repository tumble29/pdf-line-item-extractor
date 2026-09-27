/**
 * The line items, one table per page, with the page's own columns.
 *
 * What the person sees, and why:
 *   - Every cell exactly as printed (`raw`): "$68.00 /bag" stays "$68.00 /bag",
 *     and "1 195,20 €" stays as it is. We never re-format a number.
 *   - Each column's heading as printed. A column with no heading is
 *     "Column 3 (no heading)".
 *   - A column we don't read (no role) is labelled "as printed, not read" and
 *     is never right-aligned like a number, so it can't be mistaken for one.
 *   - A column whose meaning comes from its heading only (roleSource "header")
 *     is labelled "meaning from heading only", the weaker case.
 *   - A value the document leaves empty says "not in document", never a blank
 *     or a zero.
 *   - "Source" on each row shows the row exactly as it was read from the page,
 *     with the characters of each number marked, so the person can see that
 *     the quantity "2" is the right "2" in the line. Each mark is underlined
 *     and followed by a small visible label with its column's heading ("Qty"),
 *     so colour is never the only signal and nothing hides in a tooltip.
 */
"use client";

import { Fragment, useId, useState } from "react";

import { ROLE_WORDS } from "@/lib/contract/codes";
import { NUMERIC_ROLES, type Column, type LineItem, type PageReport, type Role } from "@/lib/contract/schema";

import { columnName, plural } from "./format";

/** True for the roles that are read as numbers, and so are right-aligned. */
function isNumberRole(role: Role | null): boolean {
  return role !== null && (NUMERIC_ROLES as readonly Role[]).includes(role);
}

/** What one cell of the table holds: the printed text, or "not in document". */
function cellOf(item: LineItem, column: Column): { text: string; missing: boolean } {
  if (column.role === null) {
    const other = item.otherCells.find((cell) => cell.key === column.key);
    return { text: other?.raw ?? "", missing: false };
  }
  const field = item.fields[column.role];
  if (field) return { text: field.raw, missing: false };
  return { text: "not in document", missing: item.missing.includes(column.role) };
}

/** The label of a mark: the heading of the page's column with that role, or the role's plain name ("unit price"). */
function markLabel(role: Role, columns: readonly Column[]): string {
  return columns.find((column) => column.role === role)?.header ?? ROLE_WORDS[role].one;
}

/**
 * The row's text as read from the page, with the characters of each number
 * field marked and labelled. The spans never overlap, because each one is a
 * different cell of the row.
 */
function MarkedSource({ item, columns }: { item: LineItem; columns: readonly Column[] }) {
  const marks = NUMERIC_ROLES.flatMap((role) => {
    const span = item.fields[role]?.span;
    return span ? [{ start: span[0], end: span[1], role }] : [];
  }).sort((a, b) => a.start - b.start);
  const parts: { text: string; role: Role | null }[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) parts.push({ text: item.sourceText.slice(at, mark.start), role: null });
    parts.push({ text: item.sourceText.slice(mark.start, mark.end), role: mark.role });
    at = mark.end;
  }
  if (at < item.sourceText.length) parts.push({ text: item.sourceText.slice(at), role: null });
  return (
    <p className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">
      <span className="text-neutral-600 dark:text-neutral-400">
        Page {item.page}, line {item.rowIndex + 1}:{" "}
      </span>
      {parts.map((part, k) =>
        part.role ? (
          <Fragment key={k}>
            <mark className="rounded bg-yellow-200 px-0.5 text-neutral-900 underline decoration-2 underline-offset-2 dark:bg-yellow-700 dark:text-white">
              {part.text}
            </mark>
            {/* The label, in brackets for a screen reader: "2 (Qty)". */}
            <span className="ml-0.5 rounded bg-neutral-200 px-1 font-sans text-[10px] text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100">
              <span className="sr-only">(</span>
              {markLabel(part.role, columns)}
              <span className="sr-only">)</span>
            </span>
          </Fragment>
        ) : (
          <span key={k}>{part.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * One table row, and its source line. The source row is always on the page,
 * hidden until opened, so the button's aria-controls always points at it.
 * The button's name says which line it opens (for a list of buttons in a
 * screen reader), and aria-expanded says whether it is open.
 */
function ItemRow({ item, columns }: { item: LineItem; columns: readonly Column[] }) {
  const [open, setOpen] = useState(false);
  const sourceId = useId();
  return (
    <Fragment>
      <tr className="border-t border-neutral-200 align-top dark:border-neutral-800">
        {columns.map((column, position) => {
          const { text, missing } = cellOf(item, column);
          return (
            <td
              key={position}
              className={`px-2 py-1.5 ${isNumberRole(column.role) ? "text-right whitespace-nowrap tabular-nums" : "whitespace-pre-line"} ${missing ? "text-xs text-neutral-600 italic dark:text-neutral-400" : ""}`}
            >
              {text}
            </td>
          );
        })}
        <td className="px-2 py-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={sourceId}
            onClick={() => setOpen(!open)}
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Source
            <span className="sr-only">
              {" "}
              of page {item.page}, line {item.rowIndex + 1}
            </span>
          </button>
        </td>
      </tr>
      <tr id={sourceId} hidden={!open} className="bg-neutral-50 dark:bg-neutral-900">
        <td colSpan={columns.length + 1} className="px-2 py-2">
          <MarkedSource item={item} columns={columns} />
        </td>
      </tr>
    </Fragment>
  );
}

/** A column's heading cell, with its label when it is weaker than "read and confirmed". */
function HeadingCell({ column, position }: { column: Column; position: number }) {
  const label = column.role === null ? "as printed, not read" : column.roleSource === "header" ? "meaning from heading only" : null;
  return (
    <th scope="col" className={`px-2 py-1.5 font-semibold ${isNumberRole(column.role) ? "text-right" : "text-left"}`}>
      {columnName(column.header, position)}
      {label && <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">{label}</span>}
    </th>
  );
}

/** The items of one page, as a table with that page's columns. */
function PageTable({ page, items }: { page: PageReport; items: readonly LineItem[] }) {
  return (
    <div className="mt-3">
      <h3 className="text-sm font-semibold">
        Page {page.page} · {plural(items.length, "line item")}
      </h3>
      {/* `relative` keeps the screen-reader-only text (which is positioned
          absolutely) inside this scroll box; without it, that text can widen
          the whole page on a phone. */}
      <div className="relative mt-1 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-900">
            <tr>
              {page.columns.map((column, position) => (
                <HeadingCell key={position} column={column} position={position} />
              ))}
              <th scope="col" className="px-2 py-1.5 text-left font-semibold">
                <span className="sr-only">Where it came from</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ItemRow key={item.id} item={item} columns={page.columns} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Every page that has items, in page order. */
export function ItemsTable({ pages, items }: { pages: readonly PageReport[]; items: readonly LineItem[] }) {
  const withItems = pages.filter((page) => items.some((item) => item.page === page.page));
  if (withItems.length === 0) return null;
  return (
    <section aria-labelledby="items-heading" className="mt-6">
      <h2 id="items-heading" className="text-lg font-semibold">
        Line items ({items.length})
      </h2>
      {withItems.map((page) => (
        <PageTable key={page.page} page={page} items={items.filter((item) => item.page === page.page)} />
      ))}
    </section>
  );
}
