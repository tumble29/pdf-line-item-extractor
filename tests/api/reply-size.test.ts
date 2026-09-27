/**
 * Tests for the reply-size check in POST /api/parse (route.ts, step 6).
 *
 * Vercel replaces a reply over 4.5 MB with its own plain-text page, which the
 * web page can't explain. So the route measures its reply before sending it,
 * and refuses one over MAX_REPLY_BYTES as TOO_MANY_LINES, with about how many
 * pages each part should have (reply-size.ts). Building a real 4 MB reply
 * would be slow, so these tests lower the limit instead: the
 * limits module is replaced by the real one with MAX_REPLY_BYTES read from
 * `limit.bytes`, which each test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { refusalMessage } from "@/lib/contract/codes";
import { Problem } from "@/lib/contract/schema";

import { buildPdf } from "../fixtures/build";

const limit = vi.hoisted(() => ({ bytes: 4 * 1024 * 1024 }));
vi.mock("@/lib/contract/limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contract/limits")>();
  return {
    ...actual,
    // A getter, so a test can change the limit after the route is imported.
    get MAX_REPLY_BYTES() {
      return limit.bytes;
    },
  };
});

// Imported after the mock, so the route uses it.
const { POST } = await import("@/app/api/parse/route");

/** A POST with the given PDF as the "file" field. */
function upload(bytes: Uint8Array): Request {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], "test.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/parse", { method: "POST", body: form });
}

/** A PDF with `pages` pages of the default three rows. */
const pdfOf = (pages: number) => buildPdf({ pages: Array.from({ length: pages }, () => ({})) });

/** 30 rows that each multiply correctly (2 x $5.00 = $10.00), or not when `wrongTotal` is set. */
function denseRows(wrongTotal = false): string[][] {
  return Array.from({ length: 30 }, (_, k) => [String(k + 1), `Timber length ${k + 1}`, "2", "ea", "$5.00", wrongTotal ? "$11.00" : "$10.00"]);
}

/** Pages `from` to `to` (counting from 1) of a file with 6 dense pages, then 4 pages of the default rows. */
function unevenPdf(from = 1, to = 10): Promise<Uint8Array> {
  const pages = Array.from({ length: 10 }, (_, k) => (k < 6 ? { rows: denseRows() } : {}));
  return buildPdf({ pages: pages.slice(from - 1, to) });
}

let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  limit.bytes = 4 * 1024 * 1024;
  vi.restoreAllMocks();
});

/** The one log line of the request, parsed. */
const logLine = () => JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

/** The size in bytes of a reply's body. */
async function sizeOf(response: Response): Promise<number> {
  return new TextEncoder().encode(await response.text()).byteLength;
}

describe("POST /api/parse: the size of the reply", () => {
  it("sends a reply under the limit, and logs its size", async () => {
    const response = await POST(upload(await pdfOf(1)));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const bytes = await sizeOf(response);
    expect(logLine()).toMatchObject({ status: 200, replyBytes: bytes });
  });

  it("refuses a reply over the limit as TOO_MANY_LINES, with a part size whose parts do fit", async () => {
    const full = await sizeOf(await POST(upload(await pdfOf(10))));
    limit.bytes = Math.floor(full / 2);
    const response = await POST(upload(await pdfOf(10)));
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = Problem.parse(await response.json());
    expect(body.code).toBe("TOO_MANY_LINES");
    // The log line holds the status really sent, with the counts and the size.
    expect(logLine()).toMatchObject({ status: 422, code: "TOO_MANY_LINES", itemCount: 30, replyBytes: full });
    const pages = Number(/files of about (\d+) pages/.exec(body.detail)?.[1]);
    expect(body.detail).toBe(refusalMessage({ code: "TOO_MANY_LINES", itemCount: 30, leftOutCount: 0, pagesPerFile: pages }));
    // A part of that many pages is sent.
    expect((await POST(upload(await pdfOf(pages)))).status).toBe(200);
  });

  it("sizes the parts by what each page adds, so the dense pages at the front still fit", async () => {
    const full = await sizeOf(await POST(upload(await unevenPdf())));
    // Dividing the reply evenly over the pages would suggest parts too large
    // for the dense pages at the front.
    limit.bytes = Math.floor(full * 0.95);
    const body = Problem.parse(await (await POST(upload(await unevenPdf()))).json());
    const pages = Number(/files of about (\d+) pages?/.exec(body.detail)?.[1]);
    expect(pages).toBeGreaterThanOrEqual(1);
    // Every part, in order, is sent: pages 1 to n, then n+1 to 2n, and so on.
    for (let first = 1; first <= 10; first += pages) {
      const response = await POST(upload(await unevenPdf(first, Math.min(10, first + pages - 1))));
      expect(response.status, `pages ${first} to ${first + pages - 1}`).toBe(200);
    }
  });

  it("counts the lines left out too, since each one is in the reply with its reason", async () => {
    // Every row fails the arithmetic check, so no line item is read at all.
    const pdf = await buildPdf({ pages: [{ rows: denseRows(true) }, { rows: denseRows(true) }] });
    limit.bytes = 1000;
    const body = Problem.parse(await (await POST(upload(pdf))).json());
    expect(body.code).toBe("TOO_MANY_LINES");
    expect(body.detail).toContain("(0 line items read, and 60 lines left out, each with its reason)");
  });

  it("names no page count when the file has one page only", async () => {
    limit.bytes = 100;
    const body = Problem.parse(await (await POST(upload(await pdfOf(1)))).json());
    expect(body.detail).toBe(refusalMessage({ code: "TOO_MANY_LINES", itemCount: 3, leftOutCount: 0, pagesPerFile: null }));
  });
});
