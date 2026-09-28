/**
 * The JSON result: the server's reply, for anyone who wants the data itself
 * (Part A of the task is this JSON).
 *
 * It sits right below the upload form, above the plain-language view. The
 * JSON is hidden at first, because it is long; "Show JSON" opens it and
 * "Hide JSON" closes it again. "Copy JSON" copies the whole reply as shown,
 * whether it is open or not.
 *
 * What is shown: the reply's text laid out for reading, two spaces per level
 * (format.ts, prettyJson). The server sends it compact, on one line; only the
 * spacing changes. It is never rebuilt from the parsed data, so every key and
 * value is the server's own, in the server's order. For a refused file the
 * reply is a Problem (the refusal's code and sentence); for a result it is
 * the full ParseResult, with every value's span and evidence.
 *
 * A result can be several megabytes, so the reply is only laid out the first
 * time someone presses "Show JSON" or "Copy JSON", never just because it
 * arrived.
 *
 * After a copy, the button says "Copied" instead of "Copy JSON" for two
 * seconds. Copying can fail (a browser can block the clipboard): the button
 * then keeps its name, and a sentence next to it says so and says what to do
 * instead, never a vague message. That sentence is also a small live region,
 * hidden from sight while it only says "Copied.", and every press gives it
 * new text, so a screen reader hears the outcome of each press.
 */
"use client";

import { useEffect, useId, useMemo, useState } from "react";

import type { ServerReply } from "@/lib/client/parse-client";

import { fileSize, prettyJson } from "./format";

/** How long the button says "Copied", in milliseconds. */
const COPIED_MS = 2000;

/** The styles of the section's two buttons. */
const BUTTON =
  "rounded-md border border-neutral-400 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:bg-neutral-800";

/**
 * What the last press of "Copy JSON" did, and how many presses there were.
 * The count makes each press a new state, even when it gives the same result
 * as the one before, so the timer starts again and the status is read out.
 */
type CopyState = { result: "none" | "copied" | "failed"; presses: number };

/** What the live region says for each copy result (nothing before the first press, or once "Copied" is over). */
const COPY_WORDS: Record<CopyState["result"], string> = {
  none: "",
  copied: "Copied.",
  failed: "Your browser didn't let us copy. Show the JSON, select it and copy it yourself.",
};

/** Copies `text` to the clipboard. Resolves to false when the browser has no clipboard or refuses. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function JsonResult({ reply }: { reply: ServerReply }) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<CopyState>({ result: "none", presses: 0 });
  // The laid-out text, made the first time it is needed (see the header).
  const [pretty, setPretty] = useState<string | null>(null);
  const jsonId = useId();
  // The size as sent: measured once per reply.
  const size = useMemo(() => fileSize(new TextEncoder().encode(reply.text).byteLength), [reply.text]);

  /** The laid-out text, made now if it wasn't yet. */
  const laidOut = (): string => {
    if (pretty !== null) return pretty;
    const text = prettyJson(reply.text);
    setPretty(text);
    return text;
  };

  // "Copied" goes away by itself; a failure stays until the next press.
  useEffect(() => {
    if (copy.result !== "copied") return;
    const timer = setTimeout(() => setCopy((last) => ({ ...last, result: "none" })), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  return (
    <section aria-labelledby={`${jsonId}-heading`} className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <h2 id={`${jsonId}-heading`} className="text-lg font-semibold">
        JSON result
      </h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The reply from the API (HTTP {reply.status}, {size} as sent), laid out for reading. Every key and value is the
        server&apos;s own, in its order.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={jsonId}
          onClick={() => {
            if (!open) laidOut();
            setOpen(!open);
          }}
          className={BUTTON}
        >
          {open ? "Hide JSON" : "Show JSON"}
        </button>
        {/* A minimum width, so the button doesn't shrink while it says "Copied". */}
        <button
          type="button"
          onClick={async () => {
            const copied = await copyText(laidOut());
            setCopy((last) => ({ result: copied ? "copied" : "failed", presses: last.presses + 1 }));
          }}
          className={`${BUTTON} min-w-28`}
        >
          {copy.result === "copied" ? "Copied" : "Copy JSON"}
        </button>
        {/* Seen only when copying failed; a screen reader hears it every time. */}
        <span
          role="status"
          aria-live="polite"
          className={copy.result === "failed" ? "text-sm text-neutral-600 dark:text-neutral-400" : "sr-only"}
        >
          {/* A new key per press puts new text in the live region, even when
              the words are the same as last time. */}
          <span key={copy.presses}>{COPY_WORDS[copy.result]}</span>
        </span>
      </div>
      {/* Always on the page, so the Show button's aria-controls points at it.
          The text is only put in while it is shown, so a very large reply is
          never drawn on the page until someone opens it. */}
      <pre
        id={jsonId}
        hidden={!open}
        tabIndex={open ? 0 : -1}
        className="mt-3 max-h-[32rem] overflow-auto rounded bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900"
      >
        {open ? pretty : ""}
      </pre>
    </section>
  );
}
