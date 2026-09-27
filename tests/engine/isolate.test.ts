/**
 * Tests for src/lib/engine/isolate.ts: settlePage never throws and never
 * waits forever.
 *
 * Vitest fails the run on any unhandled promise rejection, so the "fails
 * later" test also proves that a late failure is handled.
 */
import { describe, expect, it } from "vitest";

import { settlePage } from "@/lib/engine/isolate";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("settlePage", () => {
  it("returns the value when the work finishes in time", async () => {
    await expect(settlePage(async () => 42, 100)).resolves.toEqual({ ok: true, value: 42 });
  });

  it("accepts work that returns a plain value", async () => {
    await expect(settlePage(() => "done", 100)).resolves.toEqual({ ok: true, value: "done" });
  });

  it("turns a rejected promise into an 'error' outcome", async () => {
    const boom = new Error("page is broken");
    await expect(settlePage(async () => Promise.reject(boom), 100)).resolves.toEqual({ ok: false, cause: "error", error: boom });
  });

  it("turns an error thrown straight away into an 'error' outcome", async () => {
    const outcome = await settlePage(() => {
      throw new RangeError("thrown before any promise");
    }, 100);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toBe("error");
  });

  it("stops waiting after the time limit", async () => {
    const started = performance.now();
    const outcome = await settlePage(() => new Promise(() => {}), 30); // never finishes
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("handles work that fails after the time limit, with no unhandled rejection", async () => {
    const outcome = await settlePage(async () => {
      await wait(40);
      throw new Error("failed after we stopped waiting");
    }, 10);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
    // Let the late failure happen while this test is still running.
    await wait(60);
  });
});
