/**
 * The containment test: a problem on one page must not change anything else.
 *
 * The brief evaluates "whether problems in part of a file are contained, or
 * take down the rest of it". This file checks it in two ways:
 *
 *   1. Simulated failures. The same 3-page file is read four times: normally,
 *      with page 2 throwing, with page 2 hanging, and with page 2 failing only
 *      after we stopped waiting. Pages 1 and 3 must come out EXACTLY the same
 *      every time (same report, same items, same ids), and page 2 must be
 *      refused with the right reason.
 *   2. Real broken files: a scanned middle page, and a file whose last page
 *      can't be read.
 *
 * It also checks the document time budget, and records one known limitation
 * of pdf.js.
 *
 * Vitest fails the run on any unhandled promise rejection, so these tests also
 * prove that a failing page's error is always handled.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ParseResult } from "@/lib/contract/schema";
import { DEFAULT_OPTIONS, defaultDeps, parsePdf, type EngineDeps, type EngineOptions, type EngineOutcome } from "@/lib/engine";

import { brokenLastPage, brokenMiddleEntry, imageOnlyMiddle, shapesOnly, threePages } from "../fixtures/build";

/** A short page limit, so the hanging-page test is quick. */
const QUICK: EngineOptions = { ...DEFAULT_OPTIONS, pageMs: 500 };

let bytes: Uint8Array;

beforeAll(async () => {
  bytes = await threePages();
  // Read once to load pdf.js first, so loading the library doesn't make the
  // first real run go over the short page limit.
  await parsePdf(bytes);
});

/** The engine with page 2's reading replaced by `page2`. Pages 1 and 3 are read for real. */
function withPage2(page2: () => Promise<never>): EngineDeps {
  return {
    ...defaultDeps,
    processPage: (doc, pdfjs, page) => (page === 2 ? page2() : defaultDeps.processPage(doc, pdfjs, page)),
  };
}

/** The result, or a failed test if the whole file was refused. */
function read(outcome: EngineOutcome) {
  if (outcome.kind !== "read") throw new Error(`expected the file to be read, got ${outcome.refusal.code}`);
  return outcome.result;
}

/** Everything about one page: its report, its items and its refusals. */
function pageView(result: ReturnType<typeof read>, page: number) {
  return {
    report: result.pages[page - 1],
    items: result.items.filter((item) => item.page === page),
    refusals: result.refusals.filter((refusal) => refusal.page === page),
  };
}

/** Checks that a result fits the contract, as the route does before sending it. */
function expectValidContract(result: ReturnType<typeof read>) {
  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...result });
  expect(parsed.success ? "ok" : parsed.error.issues[0]?.message).toBe("ok");
}

describe("a failing page changes nothing else", () => {
  it("gives identical pages 1 and 3 whether page 2 works, throws, hangs or fails late", async () => {
    const normal = read(await parsePdf(bytes, defaultDeps, QUICK));
    const throwing = read(await parsePdf(bytes, withPage2(() => Promise.reject(new Error("page 2 is broken"))), QUICK));
    const hanging = read(await parsePdf(bytes, withPage2(() => new Promise(() => {})), QUICK));
    const lateFailure = read(
      await parsePdf(
        bytes,
        withPage2(() => new Promise((_, reject) => setTimeout(() => reject(new Error("too late")), 800))),
        QUICK,
      ),
    );

    for (const run of [throwing, hanging, lateFailure]) {
      expect(pageView(run, 1)).toEqual(pageView(normal, 1));
      expect(pageView(run, 3)).toEqual(pageView(normal, 3));
      expect(run.pageCount).toBe(3);
      expect(run.pages[1].status).toBe("refused");
      expectValidContract(run);
    }

    // Page 2's refusal says what happened, in plain words.
    expect(pageView(throwing, 2).refusals[0]).toMatchObject({
      code: "PAGE_LOAD_FAILED",
      message: "Page 2 couldn't be read: our reader hit an error on this page. The other pages weren't affected.",
    });
    expect(pageView(hanging, 2).refusals[0]?.message).toContain("because it took too long");
    expect(pageView(lateFailure, 2).refusals[0]?.message).toContain("because it took too long");

    // Wait until the late failure has happened, so an unhandled rejection
    // would be caught by this test and not by a later one.
    await new Promise((resolve) => setTimeout(resolve, 900));
  });

  it("refuses a scanned middle page and reads the pages around it", async () => {
    const result = read(await parsePdf(await imageOnlyMiddle()));
    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "refused", "extracted"]);
    expect(result.refusals.map((refusal) => refusal.id)).toEqual(["p2-NO_TEXT_LAYER"]);
    expectValidContract(result);
  });

  it("refuses an unreadable last page and reads the others", async () => {
    const outcome = await parsePdf(await brokenLastPage());
    const result = read(outcome);
    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "extracted", "refused"]);
    expect(result.refusals[0]).toMatchObject({ id: "p3-PAGE_LOAD_FAILED", code: "PAGE_LOAD_FAILED" });
    // The server log gets the technical reason; the user gets the sentence.
    if (outcome.kind === "read") expect(outcome.diagnostics).toMatchObject([{ page: 3, stage: "read", cause: "error" }]);
    expectValidContract(result);
  });
});

describe("pages with no readable text", () => {
  it("refuses a page of shapes with its own reason, instead of calling it blank", async () => {
    const result = read(await parsePdf(await shapesOnly()));
    expect(result.pages[0].status).toBe("refused");
    expect(result.refusals[0]?.message).toContain("has drawings but no text we can read");
  });
});

describe("the document time budget", () => {
  it("refuses the pages it didn't reach, and reads the ones before", async () => {
    // A fake clock that moves 20 ms every time it is read. The engine reads it
    // once at the start, then twice per page (when the page starts and when it
    // ends). Pages 1, 2 and 3 start 20, 60 and 100 ms after the start, so with
    // a 90 ms budget, pages 1 and 2 start in time and page 3 does not.
    let clock = 0;
    const options: EngineOptions = { ...DEFAULT_OPTIONS, totalMs: 90, now: () => (clock += 20) };
    const result = read(await parsePdf(bytes, defaultDeps, options));

    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "extracted", "refused"]);
    expect(result.refusals[0]).toMatchObject({ id: "p3-PAGE_LOAD_FAILED" });
    expect(result.refusals[0]?.message).toContain("reading the whole file took too long");
    expectValidContract(result);
  });
});

describe("slow pages", () => {
  it("keeps the result of a page that finished late, and logs it as slow", async () => {
    // pdf.js can do a heavy page in one long calculation that the page timer
    // can't interrupt. When that page finishes, its result is correct, so we
    // keep it, and log the page as slow. A fake clock that moves 10 seconds
    // per read makes every page "take" longer than the 8-second page limit.
    let clock = 0;
    const options: EngineOptions = { ...DEFAULT_OPTIONS, totalMs: 1_000_000, now: () => (clock += 10_000) };
    const outcome = await parsePdf(bytes, defaultDeps, options);
    const result = read(outcome);
    expect(result.pages.map((page) => page.status)).toEqual(["extracted", "extracted", "extracted"]);
    if (outcome.kind === "read") {
      expect(outcome.diagnostics.map((d) => d.cause)).toEqual(["slow", "slow", "slow"]);
    }
  });
});

describe("known limitation of pdf.js", () => {
  it("loses the pages after a broken entry in the middle of the page list", async () => {
    // The file declares 3 pages. pdf.js stops at the broken entry for page 2
    // and reports only 2, so page 3 can't be reached at all, and pdf.js gives
    // us no way to see the declared count. This test checks the behaviour,
    // so we notice if a pdf.js update changes it. The README will list it.
    const result = read(await parsePdf(await brokenMiddleEntry()));
    expect(result.pageCount).toBe(2);
    expect(result.pages[1].status).toBe("refused");
  });
});
