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
  docket,
  empty,
  encrypted,
  imageOnlyMiddle,
  mismatchRow,
  multiPage,
  notPdf,
  numbersOnlyRow,
  ownerOnly,
  rotatedStamp,
  shapesOnly,
  shiftedColumns,
  threePages,
  titledPages,
  truncated,
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
