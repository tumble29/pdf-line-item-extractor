/**
 * Runs the engine over every PDF in a folder, prints what it found page by
 * page, and compares each file with its expected outcome. Use it to see the
 * engine's view of the six sample PDFs:
 *
 *   pnpm samples               reads samples/
 *   pnpm samples out/demo      reads another folder (for example the fixtures)
 *
 * For each file it prints: the time, the number format, and per page the
 * status, the item count, the refusal codes, the notes by level and the role
 * source of each column. It also counts the evidence gate's failures
 * (EVIDENCE_CHECK_FAILED), which should always be zero. The full result is
 * written to out/<name>.json, so it can be read in full.
 *
 * Then it compares the file with tests/sample-expectations.ts (the same
 * comparison as tests/samples.test.ts), prints every difference, and at the
 * end exits with code 1 if any file differs. A file with no expected outcome
 * (every fixture in out/demo, for example) is printed but not compared.
 *
 * It runs the same upload check and engine as the route, but not the route's
 * final contract check, so a reply that would fail that check still prints
 * here (tests/samples.test.ts checks the contract).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Note } from "../src/lib/contract/schema";
import { parsePdf } from "../src/lib/engine";
import { validateUpload } from "../src/lib/engine/validate";
import { SAMPLE_EXPECTATIONS, compareWithExpectation } from "../tests/sample-expectations";

const folder = process.argv[2] ?? "samples";
const OUTPUT_FOLDER = "out";

/** "2 info, 1 warning" for a list of notes. */
function notesByLevel(notes: readonly Note[]): string {
  const info = notes.filter((note) => note.level === "info").length;
  const warning = notes.filter((note) => note.level === "warning").length;
  return `${info} info, ${warning} warning`;
}

/** Reads, prints and compares one file. Returns the number of differences from its expected outcome. */
async function runFile(name: string): Promise<number> {
  const bytes = readFileSync(join(folder, name));
  const expected = SAMPLE_EXPECTATIONS[name];
  const started = performance.now();
  const upload = await validateUpload(new File([bytes], name, { type: "application/pdf" }));
  if (!upload.ok) {
    console.log(`\n${name}: whole file refused, ${upload.refusal.code}\n  "${upload.refusal.message}"`);
    return expected ? 1 : 0;
  }
  const outcome = await parsePdf(upload.bytes);
  const ms = Math.round(performance.now() - started);
  if (outcome.kind === "refused") {
    console.log(`\n${name}: whole file refused, ${outcome.refusal.code} (${ms} ms)\n  "${outcome.refusal.message}"`);
    return expected ? 1 : 0;
  }

  const { result } = outcome;
  mkdirSync(OUTPUT_FOLDER, { recursive: true });
  writeFileSync(join(OUTPUT_FOLDER, `${basename(name, ".pdf")}.json`), JSON.stringify(result, null, 2));

  const format = result.numberFormat;
  const gateFailures = result.refusals.filter((refusal) => refusal.code === "EVIDENCE_CHECK_FAILED").length;
  console.log(
    `\n${name}: ${result.pageCount} page(s), ${result.items.length} item(s), ${ms} ms, ` +
      `number format decimal ${JSON.stringify(format.decimal)} grouping ${JSON.stringify(format.grouping)} ` +
      `settled ${format.settled}, gate failures ${gateFailures}`,
  );

  for (const page of result.pages) {
    const refusals = result.refusals
      .filter((refusal) => refusal.page === page.page && (refusal.scope === "page" || refusal.scope === "row"))
      .map((refusal) => refusal.code);
    console.log(
      `  page ${String(page.page).padStart(2)}  ${page.status.padEnd(9)}  ${String(page.itemCount).padStart(2)} item(s)` +
        `  notes: ${notesByLevel(page.notes)}` +
        (refusals.length ? `  refused: ${refusals.join(", ")}` : ""),
    );
    if (page.columns.length > 0) {
      console.log(`           columns: ${page.columns.map((column) => `${column.key}=${column.roleSource ?? "none"}`).join(" ")}`);
    }
    for (const note of page.notes) console.log(`           ${note.level}: ${note.text}`);
  }
  const documentFindings = result.refusals.filter((refusal) => refusal.scope === "document");
  for (const finding of documentFindings) console.log(`  document: ${finding.code}`);
  // The printed totals, the check of the lines against them, and its refusals.
  for (const total of result.totals.stated) {
    console.log(`  stated ${total.label}${total.labelKnown ? "" : " (label not recognised)"} on page ${total.page}: ${total.amount.raw}`);
  }
  for (const check of result.totals.checks) {
    const detail = check.derived ? `lines add up to ${check.derived.value} (calculated by us)` : check.reason;
    console.log(`  check ${check.name}: ${check.outcome}, ${detail}`);
  }
  for (const refusal of result.refusals.filter((candidate) => candidate.scope === "totals")) {
    console.log(`  totals: ${refusal.code}`);
  }
  for (const failure of outcome.diagnostics) {
    console.log(`  log: page ${failure.page} ${failure.stage} ${failure.cause} ${failure.errorName ?? ""}`);
  }

  if (!expected) {
    console.log("  (no expected outcome for this file, so it was not compared)");
    return 0;
  }
  const differences = compareWithExpectation(expected, result);
  if (differences.length === 0) {
    console.log("  matches its expected outcome");
  } else {
    console.log(`  ${differences.length} difference(s) from its expected outcome:`);
    for (const difference of differences) console.log(`    - ${difference}`);
  }
  return differences.length;
}

async function main(): Promise<void> {
  const files = readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();

  let filesWithDifferences = 0;
  let compared = 0;
  for (const name of files) {
    if (SAMPLE_EXPECTATIONS[name]) compared++;
    if ((await runFile(name)) > 0) filesWithDifferences++;
  }

  console.log(`\n${compared} file(s) compared, ${filesWithDifferences} with differences.`);
  if (filesWithDifferences > 0) process.exitCode = 1;
}

void main();
