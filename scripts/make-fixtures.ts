/**
 * Writes every test fixture to out/demo/, so you can open them in a PDF viewer
 * or upload them to the web page by hand.
 *
 *   pnpm fixtures
 *
 * The files are generated, so they are not committed (out/ is in .gitignore).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  brokenLastPage,
  brokenMiddleEntry,
  buildPdf,
  certificateProtected,
  conflictingNotes,
  docket,
  empty,
  encrypted,
  imageOnlyMiddle,
  mismatchRow,
  multiPage,
  notPdf,
  numbersOnlyRow,
  oneCellTotal,
  ownerOnly,
  rotatedStamp,
  shapesOnly,
  shiftedColumns,
  threePages,
  titledPages,
  totalAfterScan,
  totalGap,
  truncated,
  unknownLabelTotal,
  unparseableCell,
} from "../tests/fixtures/build";
import { LANGUAGE_FIXTURES } from "../tests/fixtures/languages";

const OUT = join("out", "demo");

/** "twoLineHeader" becomes "two-line-header". */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

const fixtures: Record<string, () => Uint8Array | Promise<Uint8Array>> = {
  "clean.pdf": () => buildPdf(),
  "three-pages.pdf": threePages,
  "image-only-middle.pdf": imageOnlyMiddle,
  "broken-last-page.pdf": brokenLastPage,
  "broken-middle-entry.pdf": brokenMiddleEntry,
  "encrypted.pdf": encrypted,
  "certificate-protected.pdf": certificateProtected,
  "shapes-only.pdf": shapesOnly,
  "owner-password-only.pdf": ownerOnly,
  "truncated.pdf": truncated,
  "not-a-pdf.pdf": notPdf,
  "empty.pdf": empty,
  "docket.pdf": docket,
  "multi-page.pdf": multiPage,
  "rotated-stamp.pdf": rotatedStamp,
  "shifted-columns.pdf": shiftedColumns,
  "titled-pages.pdf": titledPages,
  "mismatch-row.pdf": mismatchRow,
  "unparseable-cell.pdf": unparseableCell,
  "numbers-only-row.pdf": numbersOnlyRow,
  // The printed totals and the contradiction scan.
  "conflicting-notes.pdf": conflictingNotes,
  "one-cell-total.pdf": oneCellTotal,
  "total-gap.pdf": totalGap,
  "unknown-label-total-matching.pdf": () => unknownLabelTotal({ matches: true }),
  "unknown-label-total-differing.pdf": () => unknownLabelTotal({ matches: false }),
  "total-after-scan.pdf": totalAfterScan,
  // A headerless table: the default rows with no heading row.
  "headerless-table.pdf": () =>
    buildPdf({ pages: [{ columns: [43, 71, 326, 377, 428, 502].map((x) => ({ header: "", x })) }] }),
  // 5 MB: over the 4 MB limit, so the page never sends it.
  "too-large-5mb.pdf": () => {
    const bytes = new Uint8Array(5 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    return bytes;
  },
  // The language and layout fixtures, named after their builder: "lang-french.pdf", ...
  ...Object.fromEntries(Object.entries(LANGUAGE_FIXTURES).map(([name, fixture]) => [`lang-${kebab(name)}.pdf`, fixture.build])),
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const [name, build] of Object.entries(fixtures)) {
    const bytes = await build();
    writeFileSync(join(OUT, name), bytes);
    console.log(`${name.padEnd(34)} ${String(bytes.length).padStart(7)} bytes`);
  }
  console.log(`\nWritten to ${OUT}/`);
}

void main();
