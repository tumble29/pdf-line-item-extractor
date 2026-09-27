/**
 * The web page's one call to the API, and every way it can end.
 *
 * Why this file exists: between the server and the screen, a specific reason
 * ("this PDF is protected with a password") can easily turn into a vague
 * message ("upload failed") if some code catches every error the same way.
 * So the page never calls `fetch` itself. It calls `parseFile`, which never
 * throws, and always returns exactly one named outcome:
 *
 *   result              the file was read; the page shows the items and the refusals
 *   document_refused    the server refused the whole file; its sentence is shown as sent
 *   server_bug          our server code failed (INTERNAL); shown with its reference
 *   too_large_local     bigger than the limit, so it was never sent
 *   too_large_platform  something between us and the server turned it away as too large
 *   file_unreadable     the browser couldn't read the file from the device
 *   timeout             the server took too long (504), or we stopped waiting
 *   network             the server couldn't be reached at all
 *   reply_cut           the server answered, but its reply was cut off on the way
 *   bad_response        a reply that isn't ours, or doesn't fit the contract
 *   cancelled           the person pressed Cancel
 *   page_bug            this page's own code failed (our bug, never the file's)
 *
 * The order of the checks:
 *   1. The size, before anything is sent.
 *   2. The time limit starts, and from here on both it and the Cancel button
 *      can stop the upload at any moment.
 *   3. The file's bytes, read from the device. A file that was moved,
 *      deleted or changed after it was chosen fails here, not as a network
 *      problem.
 *   4. The request. If it fails: cancelled (the person's signal), a timeout
 *      (ours), or network.
 *   5. The reply's text, read once. If that fails after the server answered,
 *      the reply was cut off.
 *   6. JSON, then the contract (zod). A reply that fits: a result, or a
 *      Problem. A Problem with code INTERNAL is our bug, never "your file was
 *      refused".
 *   7. A reply that doesn't fit: the status decides. 413 and 504 come from
 *      the platform (Vercel sends its own plain-text pages for both);
 *      anything else is a bad response, with its status.
 * Anything that throws outside those steps is this page's own bug, and comes
 * back as page_bug.
 *
 * The words for each outcome that is not a server message are in
 * transport-copy.ts.
 */
import { MAX_UPLOAD_BYTES } from "@/lib/contract/limits";
import { ParseResult, Problem } from "@/lib/contract/schema";

/** Every way one upload can end. */
export type UploadOutcome =
  | { state: "result"; data: ParseResult }
  | { state: "document_refused"; problem: Problem }
  | { state: "server_bug"; requestId: string; detail: string }
  | { state: "too_large_local"; bytes: number }
  | { state: "too_large_platform"; bytes: number }
  | { state: "file_unreadable" }
  | { state: "timeout"; source: "server" }
  | { state: "timeout"; source: "client"; seconds: number }
  | { state: "network" }
  /**
   * For reply_cut and bad_response, `requestId` is the reply's x-request-id
   * header, when it has one: then the reply came from our route, and the id
   * finds its log line. For bad_response, `ours` is true
   * when the body looks like our own JSON (a "result" or a "problem") that
   * this page can't read, which usually means the page is older than the
   * server: reloading it helps.
   */
  | { state: "reply_cut"; status: number; requestId: string | null }
  | { state: "bad_response"; status: number; requestId: string | null; ours: boolean }
  | { state: "cancelled" }
  | { state: "page_bug" };

/** The API route this page talks to. */
export const PARSE_URL = "/api/parse";

/**
 * How long we wait for the server, in milliseconds, once the file is sent. The
 * server stops by itself after 60 seconds (its maxDuration), so 75 seconds
 * lets the server's own answer arrive first whenever it can.
 */
export const CLIENT_TIMEOUT_MS = 75_000;

/**
 * The slowest upload speed we allow for, in bytes per millisecond (50 KB a
 * second). The time limit starts before the file is sent, so it gets extra
 * time for sending: a 4 MB file gets about 84 seconds more.
 */
export const MIN_UPLOAD_BYTES_PER_MS = 50;

/**
 * The whole time limit for one upload of `bytes` bytes, in milliseconds: the
 * time allowed for the server (`serverMs`), plus the time to send the file at
 * MIN_UPLOAD_BYTES_PER_MS.
 */
export function timeLimitMs(bytes: number, serverMs: number): number {
  return serverMs + Math.ceil(bytes / MIN_UPLOAD_BYTES_PER_MS);
}

/** What parseFile needs from the outside world. Tests replace them. */
export interface ClientDeps {
  fetch: typeof fetch;
  /** The time allowed for the server, before the extra time for sending the file. */
  timeoutMs: number;
}

const DEFAULT_DEPS: ClientDeps = {
  // Wrapped, so `fetch` is called with the right `this` in every browser.
  fetch: (input, init) => fetch(input, init),
  timeoutMs: CLIENT_TIMEOUT_MS,
};

/**
 * A signal that aborts after `ms` milliseconds. AbortSignal.timeout does
 * exactly this in current browsers; the fallback covers older ones.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The time limit was reached.", "TimeoutError")), ms);
  return controller.signal;
}

/**
 * A signal that aborts when any of `signals` does. AbortSignal.any does
 * exactly this in current browsers; the fallback covers older ones.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Waits for `work`, but gives up as soon as `signal` aborts (Cancel or the
 * time limit), even when `work` never ends: it then rejects with the signal's
 * reason, and the caller names the outcome from the signals.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/**
 * Which outcome a request that stopped early is: the person cancelled, we
 * stopped waiting, or `otherwise` (the file couldn't be read, the network
 * failed, or the reply was cut).
 */
function stoppedOutcome(userSignal: AbortSignal, timeout: AbortSignal, seconds: number, otherwise: UploadOutcome): UploadOutcome {
  if (userSignal.aborted) return { state: "cancelled" };
  if (timeout.aborted) return { state: "timeout", source: "client", seconds };
  return otherwise;
}

/** A reply that fits the contract, as its outcome. */
function outcomeOfBody(body: unknown, status: number): UploadOutcome | null {
  const result = ParseResult.safeParse(body);
  if (result.success) return { state: "result", data: result.data };
  const problem = Problem.safeParse(body);
  if (!problem.success) return null;
  // Our own failure is never shown as a refusal of the person's file.
  if (problem.data.code === "INTERNAL") {
    return { state: "server_bug", requestId: problem.data.requestId, detail: problem.data.detail };
  }
  return status === problem.data.status ? { state: "document_refused", problem: problem.data } : null;
}

/** True when `body` has the shape of our own JSON: an object whose `kind` is "result" or "problem". */
function looksLikeOurs(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const kind = (body as { kind?: unknown }).kind;
  return kind === "result" || kind === "problem";
}

/** A reply that doesn't fit the contract, by its status. */
function outcomeOfStatus(status: number, bytes: number, requestId: string | null, ours: boolean): UploadOutcome {
  if (status === 413) return { state: "too_large_platform", bytes };
  if (status === 504) return { state: "timeout", source: "server" };
  return { state: "bad_response", status, requestId, ours };
}

/**
 * Sends one PDF to the API and returns how it ended. Never throws, and never
 * returns anything that isn't one of the UploadOutcome states.
 *
 * `userSignal` is the Cancel button's signal (an AbortController's signal).
 */
export async function parseFile(file: File, userSignal: AbortSignal, deps: ClientDeps = DEFAULT_DEPS): Promise<UploadOutcome> {
  try {
    return await send(file, userSignal, deps);
  } catch {
    // Every failure we expect is caught inside `send` and named. So only a
    // mistake in this page's own code can reach here: our bug, not the file's.
    return { state: "page_bug" };
  }
}

/** The steps of parseFile, in the order of the header above. */
async function send(file: File, userSignal: AbortSignal, deps: ClientDeps): Promise<UploadOutcome> {
  // 1. Too large: never sent.
  if (file.size > MAX_UPLOAD_BYTES) return { state: "too_large_local", bytes: file.size };
  if (userSignal.aborted) return { state: "cancelled" };

  // 2. The time limit, which includes the time to read and send the file.
  const waitMs = timeLimitMs(file.size, deps.timeoutMs);
  const seconds = Math.round(waitMs / 1000);
  const timeout = timeoutSignal(waitMs);
  const signal = anySignal([userSignal, timeout]);

  // 3. The file's bytes, read now, so a file the browser can't read is named
  //    as such. (Handing the File straight to fetch would read it while
  //    sending, and a failure would look like the network's.) A slow read,
  //    such as a cloud file still downloading, still stops on Cancel or at
  //    the time limit.
  let bytes: ArrayBuffer;
  try {
    bytes = await untilAborted(file.arrayBuffer(), signal);
  } catch {
    return stoppedOutcome(userSignal, timeout, seconds, { state: "file_unreadable" });
  }

  // 4. The request.
  let response: Response;
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: file.type }), file.name);
    response = await deps.fetch(PARSE_URL, { method: "POST", body: form, signal });
  } catch {
    return stoppedOutcome(userSignal, timeout, seconds, { state: "network" });
  }
  const status = response.status;
  const requestId = response.headers.get("x-request-id");

  // 5. The reply's text. The server has answered by now, so a failure that
  //    isn't a cancel or our time limit means the reply was cut off.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return stoppedOutcome(userSignal, timeout, seconds, { state: "reply_cut", status, requestId });
  }

  // 6. A reply in our own contract.
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: an HTML or plain-text page from the platform or a proxy.
  }
  const fromBody = body === undefined ? null : outcomeOfBody(body, status);
  if (fromBody) return fromBody;

  // 7. Anything else, by its status. The size given is the size of the bytes
  //    really sent.
  return outcomeOfStatus(status, bytes.byteLength, requestId, looksLikeOurs(body));
}
