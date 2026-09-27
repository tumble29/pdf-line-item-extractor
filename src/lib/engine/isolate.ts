/**
 * Keeps one bad page from affecting the others.
 *
 * The brief asks "whether problems in part of a file are contained, or take
 * down the rest of it". Every page is processed through `settlePage`, which
 * NEVER throws and NEVER waits forever:
 *
 *   - if the work finishes, you get its value
 *   - if the work throws, you get { cause: "error" }
 *   - if the work takes longer than the time limit, you get { cause: "timeout" }
 *
 * The caller turns a failure into a PAGE_LOAD_FAILED refusal for that page
 * only, and continues with the next page.
 *
 * Two limits to know:
 *   - A timeout stops *waiting* for the work, but it can't stop the work
 *     itself. JavaScript has no way to cancel a promise.
 *   - The timer can only fire while the work is waiting (for example for the
 *     next chunk of a file). pdf.js does heavy pages as one long calculation
 *     without pausing, so the timer can't fire until that calculation ends,
 *     and then the finished work wins. Such a page is slow but not refused;
 *     index.ts logs it. The document time budget (index.ts) and the route's
 *     own time limit cover the rest.
 */

/** The outcome of one page's work. */
export type Settled<Value> =
  | { ok: true; value: Value }
  | { ok: false; cause: "error" | "timeout"; error?: unknown };

/**
 * Runs `work` with a time limit, and always resolves.
 *
 * Example:
 *   const outcome = await settlePage(() => readPage(doc, pdfjs, 2), 8000);
 *   if (!outcome.ok) { ...refuse page 2 with outcome.cause... }
 */
export async function settlePage<Value>(work: () => Promise<Value> | Value, timeoutMs: number): Promise<Settled<Value>> {
  // `Promise.resolve().then(work)` also catches an error that `work` throws
  // straight away, before it returns a promise.
  const running = Promise.resolve().then(work);

  // If the time limit wins and the work fails LATER (for example when the
  // document is closed while a page is still being read), that late failure
  // must not become an "unhandled rejection". Node can stop the server on one,
  // and Vitest fails the run. Attaching an empty handler marks it as handled.
  running.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const winner = await Promise.race([running.then((value) => ({ value })), timeout]);
    if (winner === "timeout") return { ok: false, cause: "timeout" };
    return { ok: true, value: winner.value };
  } catch (error) {
    return { ok: false, cause: "error", error };
  } finally {
    // Always stop the timer, so a finished page doesn't keep the process busy.
    clearTimeout(timer);
  }
}
