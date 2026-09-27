/**
 * Runs the engine over every PDF in a folder and prints what it found, page by
 * page. Use it to see the engine's view of the six sample PDFs:
 *
 *   pnpm samples               reads samples/
 *   pnpm samples out/demo      reads another folder (for example the fixtures)
 *
 * It runs the same upload check and engine as the route, but not the route's
 * final contract check, so a reply that would fail that check still prints here.
 *
 * Part 5 extends this with the items and a comparison against the expected
 * result for each sample.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parsePdf } from "../src/lib/engine";
import { validateUpload } from "../src/lib/engine/validate";

const folder = process.argv[2] ?? "samples";

async function main(): Promise<void> {
  const files = readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();

  for (const name of files) {
    const bytes = readFileSync(join(folder, name));
    const started = performance.now();
    const upload = await validateUpload(new File([bytes], name, { type: "application/pdf" }));
    if (!upload.ok) {
      console.log(`\n${name}: whole file refused, ${upload.refusal.code}\n  "${upload.refusal.message}"`);
      continue;
    }
    const outcome = await parsePdf(upload.bytes);
    const ms = Math.round(performance.now() - started);
    if (outcome.kind === "refused") {
      console.log(`\n${name}: whole file refused, ${outcome.refusal.code} (${ms} ms)\n  "${outcome.refusal.message}"`);
      continue;
    }

    const { result } = outcome;
    console.log(`\n${basename(name)}: ${result.pageCount} page(s), ${result.items.length} item(s), ${ms} ms`);
    for (const page of result.pages) {
      const refusals = result.refusals.filter((refusal) => refusal.page === page.page).map((refusal) => refusal.code);
      const notes = page.notes.map((note) => `${note.level}: ${note.text}`);
      console.log(
        `  page ${String(page.page).padStart(2)}  ${page.status.padEnd(9)}` +
          (refusals.length ? `  refused: ${refusals.join(", ")}` : "") +
          (notes.length ? `  notes: ${notes.join(" | ")}` : ""),
      );
    }
    const documentFindings = result.refusals.filter((refusal) => refusal.scope === "document");
    for (const finding of documentFindings) console.log(`  document: ${finding.code}`);
    for (const failure of outcome.diagnostics) console.log(`  log: page ${failure.page} ${failure.stage} ${failure.cause} ${failure.errorName ?? ""}`);
  }
}

void main();
