/**
 * Tests for the web page's call to the API (src/lib/client/parse-client.ts),
 * its words (transport-copy.ts) and its state (use-upload.ts).
 *
 * `fetch` is replaced by a stand-in for each way a reply can arrive, so every
 * outcome is tested without a server: a result, a refused file, our own bug,
 * the platform's 413 and 504 pages, a non-JSON reply, JSON that doesn't fit
 * the contract, a reply cut off on the way, a network failure, a file the
 * browser can't read, the Cancel button (also while the file is still being
 * read), our time limit, and a bug in the page's own code. Each outcome's
 * state is checked, and for every outcome but a result, the words the page
 * shows for it. Other tests check what is sent, the time limit and the upload
 * state.
 */
import { describe, expect, it } from "vitest";

import { INTERNAL_PROBLEM, refusalMessage } from "@/lib/contract/codes";
import { MAX_UPLOAD_BYTES } from "@/lib/contract/limits";
import { documentRefusal } from "@/lib/engine/refusals";
import { CLIENT_TIMEOUT_MS, parseFile, timeLimitMs, type ClientDeps, type UploadOutcome } from "@/lib/client/parse-client";
import { outcomeCopy } from "@/lib/client/transport-copy";
import { uploadReducer } from "@/lib/client/use-upload";
import { documentProblem, internalProblem } from "@/lib/server/problem";

/** A small PDF-looking file. Its contents don't matter: the server is a stand-in. */
const FILE = new File(["%PDF-1.7 test"], "test.pdf", { type: "application/pdf" });

/** A minimal ParseResult that fits the contract. */
const RESULT = {
  kind: "result",
  requestId: "req-1",
  fileName: "test.pdf",
  pageCount: 1,
  numberFormat: { decimal: ".", grouping: ",", settled: true },
  pages: [{ page: 1, status: "extracted", titleLines: [], itemCount: 0, columns: [], notes: [] }],
  items: [],
  refusals: [],
  totals: { stated: [], gstBasis: "unstated", checks: [] },
};

/** Words that must never reach the page. */
const FORBIDDEN = [/something went wrong/i, /an error occurred/i, /undefined/i, /\[object /i];

/** A stand-in fetch that answers with this status, body and content type (and request id, when given). */
function answering(status: number, body: string, contentType = "application/json", requestId?: string): ClientDeps {
  const headers: Record<string, string> = { "content-type": contentType };
  if (requestId) headers["x-request-id"] = requestId;
  return {
    fetch: async () => new Response(body, { status, headers }),
    timeoutMs: 75_000,
  };
}

/** Runs parseFile with a stand-in fetch and a signal that is never aborted. */
function run(deps: ClientDeps, file = FILE): Promise<UploadOutcome> {
  return parseFile(file, new AbortController().signal, deps);
}

/** The words the page shows for a non-result outcome, checked for forbidden phrases. */
function wordsOf(outcome: UploadOutcome): string {
  if (outcome.state === "result") throw new Error("a result has no single message");
  const { title, message } = outcomeCopy(outcome);
  for (const pattern of FORBIDDEN) {
    expect(title).not.toMatch(pattern);
    expect(message).not.toMatch(pattern);
  }
  return message;
}

describe("parseFile", () => {
  it("returns the result when the server read the file", async () => {
    const outcome = await run(answering(200, JSON.stringify(RESULT)));
    expect(outcome).toEqual({ state: "result", data: RESULT, reply: { status: 200, text: JSON.stringify(RESULT) } });
  });

  it("returns the refused file, with the server's own sentence, for our 422 problem", async () => {
    const problem = documentProblem(documentRefusal({ code: "ENCRYPTED" }), "req-2");
    const outcome = await run(answering(422, JSON.stringify(problem), "application/problem+json"));
    expect(outcome).toEqual({ state: "document_refused", problem, reply: { status: 422, text: JSON.stringify(problem) } });
    expect(wordsOf(outcome)).toBe(refusalMessage({ code: "ENCRYPTED" }));
  });

  it("returns our own bug for a 500 INTERNAL problem, never a refused file", async () => {
    const problem = internalProblem("3f1c9a52-8d7e-4b1a-9c55-0e2f6b7d4a10");
    const outcome = await run(answering(500, JSON.stringify(problem), "application/problem+json"));
    expect(outcome).toEqual({
      state: "server_bug",
      requestId: problem.requestId,
      detail: problem.detail,
      reply: { status: 500, text: JSON.stringify(problem) },
    });
    expect(wordsOf(outcome)).toBe(INTERNAL_PROBLEM.message({ reference: "3f1c9a52" }));
  });

  it("never sends a file over the limit, and says so with the server's own words", async () => {
    let sent = false;
    const deps: ClientDeps = {
      fetch: async () => {
        sent = true;
        return new Response("{}");
      },
      timeoutMs: 75_000,
    };
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf");
    const outcome = await run(deps, big);
    expect(sent).toBe(false);
    expect(outcome).toEqual({ state: "too_large_local", bytes: MAX_UPLOAD_BYTES + 1 });
    expect(wordsOf(outcome)).toBe(refusalMessage({ code: "FILE_TOO_LARGE", sizeBytes: MAX_UPLOAD_BYTES + 1, limitBytes: MAX_UPLOAD_BYTES }));
  });

  it("recognises a 413 page that isn't ours, and gives the file's size, not a limit it can't know", async () => {
    const outcome = await run(answering(413, "Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE\n", "text/plain"));
    expect(outcome).toEqual({ state: "too_large_platform", bytes: FILE.size });
    expect(wordsOf(outcome)).toContain("was turned away as too large");
    expect(wordsOf(outcome)).not.toContain("4.5");
  });

  it("recognises the platform's 504 page as the server taking too long", async () => {
    const outcome = await run(answering(504, "An error happened: FUNCTION_INVOCATION_TIMEOUT", "text/plain"));
    expect(outcome).toEqual({ state: "timeout", source: "server" });
    expect(wordsOf(outcome)).toContain("took too long");
  });

  it("returns a bad response, with its status, for a non-JSON body", async () => {
    const outcome = await run(answering(200, "<html>Gateway</html>", "text/html"));
    expect(outcome).toEqual({ state: "bad_response", status: 200, requestId: null, ours: false });
    expect(wordsOf(outcome)).toContain("status 200");
    expect(wordsOf(outcome)).toContain("Try again");
  });

  it.each([
    ["a result without numberFormat", { ...RESULT, numberFormat: undefined }, true],
    ["a result whose column has no roleSource", { ...RESULT, pages: [{ ...RESULT.pages[0], columns: [{ header: "Qty", key: "qty", role: "quantity", kind: "numeric" }] }] }, true],
    ["some other JSON", { hello: "world" }, false],
  ])("returns a bad response for JSON that doesn't fit the contract: %s", async (_name, body, ours) => {
    const outcome = await run(answering(200, JSON.stringify(body)));
    expect(outcome).toEqual({ state: "bad_response", status: 200, requestId: null, ours });
  });

  it("says to reload the page when our own JSON doesn't fit this version of the page, and keeps the request id", async () => {
    const outcome = await run(answering(200, JSON.stringify({ ...RESULT, numberFormat: undefined }), "application/json", "9d2e41b0-aaaa"));
    expect(outcome).toEqual({ state: "bad_response", status: 200, requestId: "9d2e41b0-aaaa", ours: true });
    expect(wordsOf(outcome)).toContain("Reload the page");
  });

  it("returns a bad response for our problem sent with the wrong status", async () => {
    const problem = documentProblem(documentRefusal({ code: "ENCRYPTED" }), "req-3");
    expect(await run(answering(200, JSON.stringify(problem)))).toEqual({ state: "bad_response", status: 200, requestId: null, ours: true });
  });

  it("keeps the reply's text exactly as it arrived, whatever its spacing and key order", async () => {
    // The page shows this text, so it must not be rebuilt from the parsed data
    // (which would put the keys in the schema's order).
    const text = `{ "requestId": "req-1",\n  "kind": "result", ${JSON.stringify(RESULT).slice(1).replace('"kind":"result","requestId":"req-1",', "")}`;
    const outcome = await run(answering(200, text));
    expect(outcome.state).toBe("result");
    expect(outcome.state === "result" && outcome.reply).toEqual({ status: 200, text });
  });

  it("sends the file's own bytes, name and type in the 'file' field", async () => {
    let sent: File | null = null;
    const deps: ClientDeps = {
      fetch: async (_input, init) => {
        sent = (init?.body as FormData).get("file") as File;
        return new Response(JSON.stringify(RESULT));
      },
      timeoutMs: 75_000,
    };
    await run(deps);
    const file = sent as unknown as File;
    expect(file.name).toBe("test.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.7 test");
  });

  it("returns file_unreadable, not a network failure, when the browser can't read the file", async () => {
    let sent = false;
    const unreadable = {
      name: "moved.pdf",
      size: 10,
      type: "application/pdf",
      arrayBuffer: async () => {
        throw new DOMException("The file could not be read.", "NotReadableError");
      },
    } as unknown as File;
    const outcome = await run(
      {
        fetch: async () => {
          sent = true;
          return new Response("{}");
        },
        timeoutMs: 75_000,
      },
      unreadable,
    );
    expect(sent).toBe(false);
    expect(outcome).toEqual({ state: "file_unreadable" });
    expect(wordsOf(outcome)).toContain("couldn't read this file from your device");
  });

  it("returns reply_cut, with the status, when the reply stops after the server answered", async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"kind":"res'));
        controller.error(new TypeError("network error"));
      },
    });
    const outcome = await run({
      fetch: async () => new Response(cut, { status: 200, headers: { "x-request-id": "5b7c0d21-bbbb" } }),
      timeoutMs: 75_000,
    });
    expect(outcome).toEqual({ state: "reply_cut", status: 200, requestId: "5b7c0d21-bbbb" });
    expect(wordsOf(outcome)).toContain("cut off");
  });

  it("stops at once on Cancel while the file is still being read, even if the read never ends", async () => {
    const controller = new AbortController();
    const stuck = { name: "cloud.pdf", size: 10, type: "application/pdf", arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) } as unknown as File;
    const pending = parseFile(stuck, controller.signal, answering(200, JSON.stringify(RESULT)));
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual({ state: "cancelled" });
  });

  it("stops at the time limit while the file is still being read", async () => {
    const stuck = { name: "cloud.pdf", size: 10, type: "application/pdf", arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) } as unknown as File;
    const outcome = await run({ ...answering(200, JSON.stringify(RESULT)), timeoutMs: 20 }, stuck);
    expect(outcome).toMatchObject({ state: "timeout", source: "client" });
  });

  it("returns page_bug, never a throw, when the page's own code fails", async () => {
    // A reply without headers makes the page's own code throw.
    const outcome = await run({ fetch: async () => ({ status: 200 }) as Response, timeoutMs: 75_000 });
    expect(outcome).toEqual({ state: "page_bug" });
    expect(wordsOf(outcome)).toContain("This is our bug, not a problem with your file.");
  });

  it("returns network when the server can't be reached", async () => {
    const outcome = await run({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      timeoutMs: 75_000,
    });
    expect(outcome).toEqual({ state: "network" });
    expect(wordsOf(outcome)).toContain("couldn't reach the server");
  });

  it("returns cancelled when the person presses Cancel", async () => {
    const controller = new AbortController();
    const deps: ClientDeps = {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          controller.abort();
        }),
      timeoutMs: 75_000,
    };
    const outcome = await parseFile(FILE, controller.signal, deps);
    expect(outcome).toEqual({ state: "cancelled" });
    expect(wordsOf(outcome)).toContain("cancelled");
  });

  it("returns a client timeout when we stop waiting, and says how long we waited", async () => {
    const deps: ClientDeps = {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
      timeoutMs: 20,
    };
    const outcome = await run(deps);
    expect(outcome).toEqual({ state: "timeout", source: "client", seconds: 0 });
    expect(wordsOf(outcome)).toContain("within 0 seconds");
    expect(wordsOf({ state: "timeout", source: "client", seconds: 159 })).toContain("within 159 seconds");
  });

  it("gives a large file extra time for sending it", () => {
    expect(timeLimitMs(0, CLIENT_TIMEOUT_MS)).toBe(75_000);
    // 4 MB at 50 KB a second takes about 84 seconds to send.
    expect(timeLimitMs(MAX_UPLOAD_BYTES, CLIENT_TIMEOUT_MS)).toBe(75_000 + 83_887);
  });
});

describe("uploadReducer", () => {
  const uploading = uploadReducer({ phase: "idle" }, { type: "start", fileName: "a.pdf", bytes: 10, startedAt: 5 });

  it("goes from idle to uploading to done, keeping the file's name", () => {
    expect(uploading).toEqual({ phase: "uploading", fileName: "a.pdf", bytes: 10, startedAt: 5 });
    expect(uploadReducer(uploading, { type: "finish", outcome: { state: "network" } })).toEqual({
      phase: "done",
      fileName: "a.pdf",
      outcome: { state: "network" },
    });
  });

  it("ignores an answer that arrives after starting over", () => {
    expect(uploadReducer({ phase: "idle" }, { type: "finish", outcome: { state: "network" } })).toEqual({ phase: "idle" });
  });

  it("starts over from any state", () => {
    expect(uploadReducer(uploading, { type: "reset" })).toEqual({ phase: "idle" });
  });
});
