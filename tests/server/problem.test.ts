/**
 * Tests for src/lib/server/problem.ts: the HTTP replies of Part A.
 *
 * Every reply must fit the contract, carry the request id in the body and in
 * the `x-request-id` header, and use the right status and content type, so
 * the web page can always tell a refusal from our own bug.
 */
import { describe, expect, it } from "vitest";

import { Problem } from "@/lib/contract/schema";
import { documentRefusal } from "@/lib/engine/refusals";
import { documentProblem, internalProblem, problemResponse, resultResponse } from "@/lib/server/problem";

describe("problems", () => {
  it("turns a whole-file refusal into a Problem that fits the contract", () => {
    const problem = documentProblem(documentRefusal({ code: "ENCRYPTED" }), "req-123");
    expect(Problem.safeParse(problem).success).toBe(true);
    expect(problem).toMatchObject({ status: 422, code: "ENCRYPTED", type: "/problems/encrypted", requestId: "req-123" });
    expect(problem.detail).toBe(problem.refusal?.message);
  });

  it("gives our own failure status 500 and a short reference", () => {
    const problem = internalProblem("3f1c9a52-8d7e-4b1a-9c55-0e2f6b7d4a10");
    expect(Problem.safeParse(problem).success).toBe(true);
    expect(problem.status).toBe(500);
    expect(problem.detail).toContain("reference 3f1c9a52");
  });

  it("sends a Problem with its status, content type and request id header", async () => {
    const response = problemResponse(documentProblem(documentRefusal({ code: "NO_FILE" }), "req-9"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("x-request-id")).toBe("req-9");
    expect((await response.json()).detail).toContain("No file arrived");
  });

  it("sends a result with status 200 and the request id header", () => {
    const response = resultResponse({ requestId: "req-7" } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-7");
  });
});
