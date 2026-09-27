/**
 * Tests for POST /api/parse (src/app/api/parse/route.ts), called directly with
 * a Request, the way Next.js calls it.
 *
 * For every path, the test checks what the web page relies on:
 *   - the status, and the content type (application/problem+json for a Problem)
 *   - that the body fits the contract (ParseResult or Problem)
 *   - that the `x-request-id` header matches the body's requestId
 *   - that exactly one log line is written, and it holds no document text
 * The engine's own bugs are simulated by replacing one function with a mock,
 * and must always come back as INTERNAL, never as a problem with the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { MAX_PAGES, MAX_UPLOAD_BYTES } from "@/lib/contract/limits";
import { ParseResult, Problem, type DocumentCode } from "@/lib/contract/schema";

import { DEFAULT_ROWS, buildPdf, empty, encrypted, notPdf, truncated } from "../fixtures/build";

// The engine and the PDF reader can be replaced per test, to simulate our own
// bugs. By default each mock calls the real function.
const engine = vi.hoisted(() => ({ override: null as null | ((bytes: Uint8Array) => Promise<unknown>) }));
vi.mock("@/lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine")>();
  return {
    ...actual,
    parsePdf: (bytes: Uint8Array) => (engine.override ? engine.override(bytes) : actual.parsePdf(bytes)),
  };
});
const reader = vi.hoisted(() => ({ override: null as null | (() => never) }));
vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("unpdf")>();
  return {
    ...actual,
    getDocumentProxy: (...args: Parameters<typeof actual.getDocumentProxy>) =>
      reader.override ? reader.override() : actual.getDocumentProxy(...args),
  };
});

// Imported after the mocks, so the route uses them.
const { GET, POST } = await import("@/app/api/parse/route");

const URL_ = "http://localhost/api/parse";

/** A POST with the given bytes as the "file" field. */
function upload(bytes: Uint8Array, name = "test.pdf", type = "application/pdf"): Request {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }));
  return new Request(URL_, { method: "POST", body: form });
}

/** The reply's status, content type, header id and parsed body, checked against the contract. */
async function replyOf(response: Response) {
  const body = await response.json();
  const contentType = response.headers.get("content-type") ?? "";
  const headerId = response.headers.get("x-request-id");
  const schema = body.kind === "result" ? ParseResult : Problem;
  const parsed = schema.safeParse(body);
  expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues[0])).toBe("ok");
  expect(headerId).toBe(body.requestId);
  return { status: response.status, contentType, body };
}

let logSpy: MockInstance;
let errorSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  engine.override = null;
  reader.override = null;
  vi.restoreAllMocks();
});

/** Every log line written during the test, parsed. */
function logLines(): Record<string, unknown>[] {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls].map(([line]) => JSON.parse(String(line)));
}

describe("POST /api/parse: a file that is read", () => {
  it("answers 200 with a ParseResult, and logs one line with counts and codes but no document text", async () => {
    const { status, body } = await replyOf(await POST(upload(await buildPdf(), "Tawhiri quote.pdf")));
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: "result", fileName: "Tawhiri quote.pdf", pageCount: 1 });
    expect(body.items).toHaveLength(DEFAULT_ROWS.length);

    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ requestId: body.requestId, status: 200, pageCount: 1, itemCount: 3 });
    const text = JSON.stringify(lines[0]);
    for (const row of DEFAULT_ROWS) expect(text).not.toContain(row[1]);
    expect(text).not.toContain("Tawhiri");
  });
});

describe("POST /api/parse: a whole file refused", () => {
  const cases: [DocumentCode, number, () => Promise<Request> | Request][] = [
    ["NO_FILE", 400, () => new Request(URL_, { method: "POST", body: new FormData() })],
    ["NO_FILE", 400, () => new Request(URL_, { method: "POST", body: "not a form", headers: { "content-type": "text/plain" } })],
    ["EMPTY_FILE", 422, () => upload(empty())],
    ["FILE_TOO_LARGE", 413, () => upload(new Uint8Array(MAX_UPLOAD_BYTES + 1))],
    ["NOT_A_PDF", 415, () => upload(notPdf(), "notes.pdf")],
    ["ENCRYPTED", 422, async () => upload(await encrypted())],
    ["CORRUPT_FILE", 422, async () => upload(await truncated())],
    ["TOO_MANY_PAGES", 422, async () => upload(await buildPdf({ pages: Array.from({ length: MAX_PAGES + 1 }, () => ({ rows: [] })) }))],
  ];

  it.each(cases)("%s answers %i as problem+json with its sentence", async (code, expectedStatus, makeRequest) => {
    const { status, contentType, body } = await replyOf(await POST(await makeRequest()));
    expect(status).toBe(expectedStatus);
    expect(contentType).toBe("application/problem+json");
    expect(body).toMatchObject({ kind: "problem", code, status: expectedStatus });
    expect(body.detail).toBe(body.refusal.message);
    expect(logLines()).toEqual([expect.objectContaining({ requestId: body.requestId, status: expectedStatus, code })]);
  });

  it("logs the error's name, and no text from the request, when the body can't be read as a form", async () => {
    const request = new Request(URL_, { method: "POST", body: "not a form", headers: { "content-type": "text/plain" } });
    const { body } = await replyOf(await POST(request));
    expect(body.code).toBe("NO_FILE");
    expect(logLines()[0]).toMatchObject({ code: "NO_FILE", formError: { name: "TypeError", mediaType: "text/plain", clientAborted: false } });
    expect(JSON.stringify(logLines()[0])).not.toContain("not a form");
  });

  it("turns away a request whose declared size is too large, before reading its body", async () => {
    const formData = vi.fn();
    const request = { headers: new Headers({ "content-length": String(50 * 1024 * 1024) }), formData } as unknown as Request;
    const { status, body } = await replyOf(await POST(request));
    expect(status).toBe(413);
    expect(body.code).toBe("FILE_TOO_LARGE");
    expect(formData).not.toHaveBeenCalled();
  });
});

describe("POST /api/parse: our own bugs", () => {
  it("answers INTERNAL, not a problem with the file, when the engine throws", async () => {
    engine.override = async () => {
      throw new TypeError("cannot read properties of undefined (reading 'cells')");
    };
    const { status, contentType, body } = await replyOf(await POST(upload(await buildPdf())));
    expect(status).toBe(500);
    expect(contentType).toBe("application/problem+json");
    expect(body.code).toBe("INTERNAL");
    expect(body.detail).toContain(`reference ${body.requestId.slice(0, 8)}`);
    expect(body.detail).toContain("This is our bug, not a problem with your file.");
    // The log line is an error line, with the error's name and stack.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logLines()[0]).toMatchObject({ status: 500, code: "INTERNAL", error: { name: "TypeError" } });
  });

  it("answers INTERNAL, not CORRUPT_FILE, when the PDF reader fails with a TypeError", async () => {
    reader.override = () => {
      throw new TypeError("pdfjs is not a function");
    };
    const { status, body } = await replyOf(await POST(upload(await buildPdf())));
    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL");
  });

  it("answers INTERNAL when our own reply doesn't fit the contract, and logs only where and what kind", async () => {
    engine.override = async () => ({
      kind: "read",
      diagnostics: [],
      result: { pageCount: 1, numberFormat: { decimal: ".", grouping: ".", settled: true }, pages: [], items: [], refusals: [], totals: {} },
    });
    const { status, body } = await replyOf(await POST(upload(await buildPdf())));
    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    const [line] = logLines();
    expect(line.contractIssues).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.any(String), code: expect.any(String) })]));
  });
});

describe("GET /api/parse", () => {
  it("answers 405 with a hint on how to use the route", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await response.json()).detail).toContain("POST");
  });
});
