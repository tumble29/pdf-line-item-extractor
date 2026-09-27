/**
 * The brief's hard rule, checked over every PDF the tests can build and over
 * the six samples: never output a number without its source.
 *
 * For every file, and every field of every line item:
 *   - a field with a value has a span, and `sourceText.slice(span)` is exactly
 *     its raw text, so the number and its quoted source always agree
 *   - the evidence gate had nothing to refuse. The gate is a safety net: on
 *     our own files, every item should already be right before it runs.
 *   - the whole result fits the contract, as the route checks before sending
 *
 * The step tests check each rule on its own; this test makes sure no
 * combination of rules on a real PDF breaks the hard rule. All fixture text is
 * invented.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ParseResult } from "@/lib/contract/schema";
import { parsePdf } from "@/lib/engine";

import {
  brokenLastPage,
  docket,
  imageOnlyMiddle,
  mismatchRow,
  multiPage,
  numbersOnlyRow,
  ownerOnly,
  rotatedStamp,
  shapesOnly,
  shiftedColumns,
  threePages,
  titledPages,
  unparseableCell,
} from "../fixtures/build";
import { LANGUAGE_FIXTURES } from "../fixtures/languages";

/** Every builder of a file that opens, by name. */
const BUILDERS: Record<string, () => Promise<Uint8Array>> = {
  threePages,
  imageOnlyMiddle,
  shapesOnly,
  ownerOnly,
  brokenLastPage,
  docket,
  multiPage,
  rotatedStamp,
  shiftedColumns,
  titledPages,
  mismatchRow,
  unparseableCell,
  numbersOnlyRow,
  ...Object.fromEntries(Object.entries(LANGUAGE_FIXTURES).map(([name, fixture]) => [name, fixture.build])),
};

/** The sample files, when the samples folder is there. Found from this file, so the working directory does not matter. */
const SAMPLES_DIR = fileURLToPath(new URL("../../samples", import.meta.url));
const SAMPLES = existsSync(SAMPLES_DIR) ? readdirSync(SAMPLES_DIR).filter((name) => name.endsWith(".pdf")) : [];

/** Checks the hard rule on one file. */
async function expectHardRule(bytes: Uint8Array): Promise<void> {
  const outcome = await parsePdf(bytes);
  if (outcome.kind !== "read") throw new Error(`the file was refused: ${outcome.refusal.code}`);
  const { result } = outcome;

  for (const item of result.items) {
    for (const [role, field] of Object.entries(item.fields)) {
      if (!field) continue;
      if (field.value !== undefined) expect(field.span, `${item.id} ${role} has a value but no span`).toBeDefined();
      if (field.span) expect(item.sourceText.slice(field.span[0], field.span[1]), `${item.id} ${role}`).toBe(field.raw);
    }
  }
  expect(result.refusals.filter((refusal) => refusal.code === "EVIDENCE_CHECK_FAILED")).toEqual([]);

  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...result });
  expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues[0])).toBe("ok");
}

describe("the hard rule: every number points at its own printed text", () => {
  it.each(Object.keys(BUILDERS))("%s", async (name) => {
    await expectHardRule(await BUILDERS[name]());
  });

  it.skipIf(SAMPLES.length === 0).each(SAMPLES)("sample %s", async (name) => {
    await expectHardRule(new Uint8Array(readFileSync(path.join(SAMPLES_DIR, name))));
  });
});
