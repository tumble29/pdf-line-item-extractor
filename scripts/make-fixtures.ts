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
  empty,
  encrypted,
  imageOnlyMiddle,
  notPdf,
  ownerOnly,
  shapesOnly,
  threePages,
  truncated,
} from "../tests/fixtures/build";

const OUT = join("out", "demo");

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
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const [name, build] of Object.entries(fixtures)) {
    const bytes = await build();
    writeFileSync(join(OUT, name), bytes);
    console.log(`${name.padEnd(26)} ${String(bytes.length).padStart(7)} bytes`);
  }
  console.log(`\nWritten to ${OUT}/`);
}

void main();
