/**
 * Part A: POST /api/parse
 *
 * Send a PDF as multipart form data in a field named "file":
 *
 *   curl -F file=@invoice.pdf https://pdf-line-item-extractor.vercel.app/api/parse
 *
 * Every reply from our code to a POST is JSON, even when something goes wrong,
 * so the web page (Part B) can always show the real reason:
 *
 *   200  the file was read. The body is a ParseResult; problems in part of the
 *        file are listed in its `refusals`.
 *   4xx  the whole file was refused. The body is a Problem whose `detail` is
 *        a plain-English sentence.
 *   500  our own code failed. The body is a Problem with code INTERNAL.
 *
 * Two replies don't come from this code: a body over 4.5 MB is stopped by
 * Vercel before our code runs, and a request that runs past `maxDuration` is
 * ended by Vercel. Both come back as Vercel's own plain-text pages, which the
 * web page will recognise by their status.
 *
 * The route writes one JSON log line when something goes wrong, with the
 * request id. It never logs document text.
 */
import { MAX_UPLOAD_BYTES, MULTIPART_ALLOWANCE_BYTES } from "@/lib/contract/limits";
import { ParseResult } from "@/lib/contract/schema";
import { parsePdf } from "@/lib/engine";
import { documentRefusal } from "@/lib/engine/refusals";
import { validateUpload } from "@/lib/engine/validate";
import { documentProblem, internalProblem, problemResponse, resultResponse } from "@/lib/server/problem";

/**
 * The longest Vercel may run this route, in seconds. The engine stops starting
 * new pages after 30 seconds, so it normally answers well before this, with a
 * clear reason for any page it didn't reach.
 */
export const maxDuration = 60;

/** At most this many page problems go into one log line, so a bad file can't flood the log. */
const MAX_LOGGED_PAGE_PROBLEMS = 20;

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    // Turn away a clearly oversized upload from its declared size, before
    // reading the body. (On Vercel the platform stops bodies over 4.5 MB
    // anyway; this matters when the app runs elsewhere.) The size in the
    // message is the request's size, which is a little more than the file's.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_ALLOWANCE_BYTES) {
      const refusal = documentRefusal({ code: "FILE_TOO_LARGE", sizeBytes: declared, limitBytes: MAX_UPLOAD_BYTES });
      return problemResponse(documentProblem(refusal, requestId));
    }

    // A body that isn't multipart form data can't hold a file.
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return problemResponse(documentProblem(documentRefusal({ code: "NO_FILE" }), requestId));
    }

    const upload = await validateUpload(form.get("file"));
    if (!upload.ok) return problemResponse(documentProblem(upload.refusal, requestId));

    const outcome = await parsePdf(upload.bytes);
    if (outcome.kind === "refused") return problemResponse(documentProblem(outcome.refusal, requestId));

    // Page problems are logged for us; the user sees them as page refusals.
    if (outcome.diagnostics.length > 0) {
      console.warn(
        JSON.stringify({
          requestId,
          pageProblems: outcome.diagnostics.slice(0, MAX_LOGGED_PAGE_PROBLEMS),
          pageProblemCount: outcome.diagnostics.length,
        }),
      );
    }

    // Check our own reply against the contract before sending it. If it
    // doesn't fit, that is our bug: the user gets INTERNAL, never a reply the
    // web page can't read.
    const checked = ParseResult.safeParse({
      kind: "result",
      requestId,
      fileName: upload.fileName,
      ...outcome.result,
    });
    if (!checked.success) {
      // Only where and what kind: some issue messages quote cell text, and the
      // log must never contain document text.
      const issues = checked.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
      console.error(JSON.stringify({ requestId, contractIssues: issues }));
      return problemResponse(internalProblem(requestId));
    }
    return resultResponse(checked.data);
  } catch (error) {
    // Anything unexpected is our bug, never the user's file.
    console.error(
      JSON.stringify({
        requestId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      }),
    );
    return problemResponse(internalProblem(requestId));
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
