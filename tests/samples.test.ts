/**
 * The six sample PDFs, read end to end and compared with their expected
 * outcomes (tests/sample-expectations.ts, from PLAN Part 1).
 *
 * Where this fits: the other engine tests use invented fixtures. This one
 * checks the real files the brief gave us, through the same parsePdf the
 * route uses. `pnpm samples` runs the same comparison and prints it.
 *
 * How to read it: every PDF in samples/ gets two tests: it matches its
 * expected outcome (every difference is listed when it doesn't), and the
 * whole result passes the contract, as the route checks before it sends a
 * reply. A PDF with no expected outcome fails, so a new sample can't be
 * skipped by accident. The tests are skipped when samples/ is absent.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ParseResult } from "@/lib/contract/schema";
import { parsePdf, type EngineResult } from "@/lib/engine";

import { SAMPLE_EXPECTATIONS, compareWithExpectation } from "./sample-expectations";

/** The samples folder at the repository root, found from this file so the working directory does not matter. */
const FOLDER = fileURLToPath(new URL("../samples", import.meta.url));

/** The sample file names, sorted, or none when the folder is absent. */
const files = existsSync(FOLDER)
  ? readdirSync(FOLDER)
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .sort()
  : [];

/** Reads one sample. A whole-file refusal fails the test, because every sample opens. */
async function read(name: string): Promise<EngineResult> {
  const outcome = await parsePdf(new Uint8Array(readFileSync(join(FOLDER, name))));
  if (outcome.kind !== "read") throw new Error(`${name} was refused as a whole file: ${outcome.refusal.code}`);
  return outcome.result;
}

describe.skipIf(!existsSync(FOLDER))("the sample PDFs", () => {
  it("has an expected outcome for every sample, and a sample for every expected outcome", () => {
    expect(files).toEqual(Object.keys(SAMPLE_EXPECTATIONS).sort());
  });

  describe.each(files)("%s", (name) => {
    it("matches its expected outcome", async () => {
      const expected = SAMPLE_EXPECTATIONS[name];
      expect(expected, `no expected outcome for ${name}`).toBeDefined();
      // An empty list means no difference; otherwise Vitest prints them all.
      expect(compareWithExpectation(expected, await read(name))).toEqual([]);
    });

    it("fits the contract as a whole", async () => {
      const result = await read(name);
      const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: name, ...result });
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });
  });
});
