/**
 * The API: POST /api/parse
 *
 * Send a PDF as multipart form data in a field named "file":
 *
 *   curl -F file=@invoice.pdf https://pdf-line-item-extractor.vercel.app/api/parse
 *
 * Every reply from our code to a POST is JSON, whatever happens, so the web
 * page can always show the real reason:
 *
 *   200  the file was read. The body is a ParseResult; problems in part of the
 *        file are listed in its `refusals`.
 *   4xx  the whole file was refused. The body is a Problem whose `detail` is
 *        a plain-English sentence.
 *   500  our own code failed. The body is a Problem with code INTERNAL and a
 *        reference the user can quote to us.
 *
 * Every reply carries the request id, in the body and in the `x-request-id`
 * header, and every request writes exactly one JSON line to the log
 * (src/lib/server/log.ts), which never holds document text.
 *
 * Two replies don't come from this code: a body over 4.5 MB is stopped by
 * Vercel before our code runs, and a request that runs past `maxDuration` is
 * ended by Vercel. (Vercel also stops a reply over 4.5 MB, so step 6 below
 * never sends one.) Both come back as Vercel's own plain-text pages, which the
 * web page recognises by their status (src/lib/client/parse-client.ts).
 *
 * How to read it: POST checks the request in order (size, form, file, PDF),
 * then checks its own reply (the contract, then the size). Every Problem goes
 * through `sendProblem`, which writes the log line and builds the reply, and
 * the one successful exit at the end does the same, so no path can forget
 * either. The log line is written after the last decision, so it always holds
 * the status that was really sent.
 */
import { MAX_REPLY_BYTES, MAX_UPLOAD_BYTES, MULTIPART_ALLOWANCE_BYTES } from "@/lib/contract/limits";
import { ParseResult, type Problem } from "@/lib/contract/schema";
import { parsePdf } from "@/lib/engine";
import { documentRefusal } from "@/lib/engine/refusals";
import { validateUpload } from "@/lib/engine/validate";
import { errorSummary, resultSummary, writeRequestLog, type RequestLog } from "@/lib/server/log";
import { byteLength, pagesPerPart } from "@/lib/server/reply-size";
import { documentProblem, internalProblem, problemResponse, resultResponse } from "@/lib/server/problem";

/**
 * The longest Vercel may run this route, in seconds. The engine stops starting
 * new pages after 30 seconds, so it normally answers well before this, with a
 * clear reason for any page it didn't reach.
 */
export const maxDuration = 60;

/** How many contract problems go into the log line when our own reply doesn't fit the contract. */
const MAX_LOGGED_CONTRACT_ISSUES = 10;


export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = performance.now();

  /** Writes the request's one log line. */
  const log = (entry: Omit<RequestLog, "requestId" | "ms">) =>
    writeRequestLog({ requestId, ms: Math.round(performance.now() - started), ...entry });

  /** Sends a Problem, and logs its status and code. */
  const sendProblem = (problem: Problem, extra: Partial<RequestLog> = {}): Response => {
    log({ status: problem.status, code: problem.code, ...extra });
    return problemResponse(problem);
  };

  try {
    // 1. Turn away a clearly oversized upload from its declared size, before
    //    reading the body. (On Vercel the platform stops bodies over 4.5 MB
    //    anyway; this matters when the app runs elsewhere.) The size in the
    //    message is the request's size, which is a little more than the file's.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_ALLOWANCE_BYTES) {
      const refusal = documentRefusal({ code: "FILE_TOO_LARGE", sizeBytes: declared, limitBytes: MAX_UPLOAD_BYTES });
      return sendProblem(documentProblem(refusal, requestId));
    }

    // 2. A body that isn't multipart form data can't hold a file. It is
    //    answered as NO_FILE either way. The log keeps what can tell the
    //    cases apart without quoting the request: the error's name, the
    //    body's media type ("text/plain" is a curl mistake; "multipart/form-
    //    data" that fails is a form cut short, or a fault on our side), and
    //    whether the browser had already given up (a Cancel mid-upload).
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      const formError = {
        name: errorSummary(error).name,
        // Only the type, never its parameters (the boundary is noise).
        mediaType: (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || null,
        clientAborted: request.signal?.aborted === true,
      };
      return sendProblem(documentProblem(documentRefusal({ code: "NO_FILE" }), requestId), { formError });
    }

    // 3. The file itself: present, not empty, not too large, a PDF.
    const upload = await validateUpload(form.get("file"));
    if (!upload.ok) return sendProblem(documentProblem(upload.refusal, requestId));

    // 4. Read it. A file that can't be opened at all is refused as a whole.
    const outcome = await parsePdf(upload.bytes);
    if (outcome.kind === "refused") return sendProblem(documentProblem(outcome.refusal, requestId));

    // 5. Check our own reply against the contract before sending it. If it
    //    doesn't fit, that is our bug: the user gets INTERNAL, never a reply
    //    the web page can't read.
    const checked = ParseResult.safeParse({ kind: "result", requestId, fileName: upload.fileName, ...outcome.result });
    if (!checked.success) {
      // Only where and what kind: some issue messages quote cell text, and the
      // log must never contain document text.
      const contractIssues = checked.error.issues
        .slice(0, MAX_LOGGED_CONTRACT_ISSUES)
        .map((issue) => ({ path: issue.path.join("."), code: issue.code }));
      return sendProblem(internalProblem(requestId), { contractIssues });
    }

    // 6. Measure the reply before sending it. A reply over 4.5 MB would be
    //    replaced by Vercel's own plain-text page, so one over MAX_REPLY_BYTES
    //    is refused here instead, with a sentence that says how far to split
    //    the file (reply-size.ts).
    const body = JSON.stringify(checked.data);
    const replyBytes = byteLength(body);
    const summary = { ...resultSummary(checked.data, outcome.diagnostics), replyBytes };
    if (replyBytes > MAX_REPLY_BYTES) {
      const refusal = documentRefusal({
        code: "TOO_MANY_LINES",
        itemCount: checked.data.items.length,
        leftOutCount: checked.data.refusals.filter((one) => one.scope === "row").length,
        pagesPerFile: pagesPerPart(checked.data, replyBytes, MAX_REPLY_BYTES),
      });
      return sendProblem(documentProblem(refusal, requestId), summary);
    }
    log({ status: 200, ...summary });
    return resultResponse(checked.data, body);
  } catch (error) {
    // Anything unexpected is our bug, never the user's file. That includes an
    // unexpected error while opening, which open.ts throws again on purpose.
    return sendProblem(internalProblem(requestId), { error: errorSummary(error) });
  }
}

/**
 * Opening the address in a browser sends a GET. Instead of an empty
 * "405 Method Not Allowed" page, say how to use the route. This reply is only
 * a hint for people; it is not part of the ParseResult / Problem contract.
 */
export function GET(): Response {
  return Response.json(
    {
      detail: "Send a PDF to this address with POST, as multipart form data in a field named \"file\".",
      example: "curl -F file=@invoice.pdf https://pdf-line-item-extractor.vercel.app/api/parse",
    },
    { status: 405, headers: { allow: "POST" } },
  );
}
