/**
 * Builds the HTTP replies of Part A.
 *
 * There are three kinds of reply, and each one always carries a request id,
 * both in the body and in the `x-request-id` header, so a user's report can be
 * matched to the server log:
 *
 *   200  a ParseResult: the file opened (it may still contain refusals)
 *   4xx  a Problem: the whole file was refused (no file, an empty file, too
 *        large, not a PDF, protected, damaged, too many pages, or too many
 *        line items to send back)
 *   500  a Problem with code INTERNAL: our own code failed
 *
 * Problems follow RFC 9457 and use the content type `application/problem+json`.
 */
import { DOCUMENT_PROBLEM_TITLES, INTERNAL_PROBLEM, problemType } from "@/lib/contract/codes";
import { DOCUMENT_HTTP_STATUS, INTERNAL_HTTP_STATUS, type ParseResult, type Problem } from "@/lib/contract/schema";
import type { DocumentRefusal } from "@/lib/engine/refusals";

/** A whole-file refusal as a Problem. `detail` is the same sentence as the refusal's message. */
export function documentProblem(refusal: DocumentRefusal, requestId: string): Problem {
  return {
    kind: "problem",
    type: problemType(refusal.code),
    title: DOCUMENT_PROBLEM_TITLES[refusal.code],
    status: DOCUMENT_HTTP_STATUS[refusal.code],
    detail: refusal.message,
    code: refusal.code,
    requestId,
    refusal,
  };
}

/**
 * Our own failure as a Problem. The reference is the start of the request id:
 * short enough for a user to read out, and enough to find the log line.
 */
export function internalProblem(requestId: string): Problem {
  return {
    kind: "problem",
    type: problemType("INTERNAL"),
    title: INTERNAL_PROBLEM.title,
    status: INTERNAL_HTTP_STATUS,
    detail: INTERNAL_PROBLEM.message({ reference: requestId.slice(0, 8) }),
    code: "INTERNAL",
    requestId,
  };
}

/** Sends a Problem with its status, content type and request id header. */
export function problemResponse(problem: Problem): Response {
  return Response.json(problem, {
    status: problem.status,
    headers: { "content-type": "application/problem+json", "x-request-id": problem.requestId },
  });
}

/**
 * Sends a ParseResult with status 200 and the request id header. `body` is the
 * result already turned into JSON: the route measures its size before sending
 * it (MAX_REPLY_BYTES), so it is only turned into JSON once.
 */
export function resultResponse(result: ParseResult, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": result.requestId },
  });
}
