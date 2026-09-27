/**
 * The panel that says what is happening with the upload, for every state but
 * a result:
 *
 *   uploading   "Reading invoice.pdf (1.2 MB)… 7 s", with a Cancel button
 *   any other   the outcome's title and sentence (transport-copy.ts), the
 *               button that can help ("Try again" for the same file, or
 *               "Reload the page"), a "Choose another file" button, and the
 *               reference to quote to us, when there is one
 *
 * Screen readers: these panels are not live regions themselves. The page has
 * one live region that is always there (in extractor.tsx), which says when
 * reading starts and how it ended. The seconds counter is hidden from screen
 * readers, so it isn't read out every second. Focus moves on purpose: to
 * Cancel when reading starts, and to the outcome's title when it ends, so a
 * keyboard user never lands on a button that has disappeared.
 */
"use client";

import { useEffect, useRef, useState, type Ref } from "react";

import type { UploadOutcome } from "@/lib/client/parse-client";
import { outcomeCopy } from "@/lib/client/transport-copy";

import { fileSize } from "./format";

/** The styles of a secondary button (Cancel, Choose another file). */
const SECONDARY_BUTTON =
  "rounded-md border border-neutral-400 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:bg-neutral-800";

/** The styles of the main button (Try again, Reload the page). */
const PRIMARY_BUTTON =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300";

/** The seconds since `startedAt`, counted up once a second. */
function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The uploading state: the file, how long it has taken, and Cancel (which gets the focus). */
export function UploadingPanel({ fileName, bytes, startedAt, onCancel }: { fileName: string; bytes: number; startedAt: number; onCancel: () => void }) {
  const seconds = useElapsedSeconds(startedAt);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The file input is disabled while reading, so the focus would be lost:
  // it moves to Cancel, the one thing a keyboard user can do now.
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
      <p className="min-w-0 grow">
        Reading <span className="font-medium wrap-anywhere">{fileName}</span> ({fileSize(bytes)})…{" "}
        <span aria-hidden="true">{seconds} s</span>
      </p>
      <button ref={cancelRef} type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
        Cancel
      </button>
    </div>
  );
}

/** Every outcome that is not a result. */
type NotResult = Exclude<UploadOutcome, { state: "result" }>;

/**
 * The reference a person can quote to us: the start of the request id, as in
 * our own error message. A reply we couldn't read, or that was cut off, still
 * has one when it came from our route (its x-request-id header).
 */
function referenceOf(outcome: NotResult): string | null {
  if (outcome.state === "server_bug") return outcome.requestId.slice(0, 8);
  if (outcome.state === "document_refused") return outcome.problem.requestId.slice(0, 8);
  if ((outcome.state === "bad_response" || outcome.state === "reply_cut") && outcome.requestId) return outcome.requestId.slice(0, 8);
  return null;
}

/**
 * True when the problem is the file itself: the server refused it, it is too
 * large, or the browser couldn't read it. Sending the same file again can't
 * help then, so there is no "Try again".
 */
function isFileProblem(outcome: NotResult): boolean {
  return (
    outcome.state === "document_refused" ||
    outcome.state === "too_large_local" ||
    outcome.state === "too_large_platform" ||
    outcome.state === "file_unreadable"
  );
}

/**
 * True when reloading the page is what helps: this page's own code failed, or
 * the server's JSON doesn't match this version of the page.
 */
function needsReload(outcome: NotResult): boolean {
  return outcome.state === "page_bug" || (outcome.state === "bad_response" && outcome.ours);
}

/**
 * Every outcome that is not a result. A problem with the file is shown in
 * amber; everything else (our bug, the platform, the network) is shown in
 * grey with its own words, never as the file's fault. The title and an icon
 * carry the meaning too, so colour is never the only signal.
 *
 * `titleRef` is the title's heading, which the page focuses when the outcome
 * appears.
 */
export function OutcomePanel({
  fileName,
  outcome,
  onRetry,
  onReset,
  titleRef,
}: {
  fileName: string;
  outcome: NotResult;
  onRetry: () => void;
  onReset: () => void;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const { title, message } = outcomeCopy(outcome);
  const reference = referenceOf(outcome);
  const fileProblem = isFileProblem(outcome);
  const reload = needsReload(outcome);
  return (
    <div
      className={`rounded-lg border p-4 ${fileProblem ? "border-amber-500 bg-amber-50 dark:bg-amber-950/40" : "border-neutral-400 bg-neutral-50 dark:bg-neutral-900"}`}
    >
      <h2 ref={titleRef} tabIndex={-1} className="flex items-center gap-2 font-semibold focus:outline-none">
        <span aria-hidden="true">{fileProblem ? "⚠" : "ⓘ"}</span>
        {title}
      </h2>
      <p className="mt-1 text-sm text-neutral-600 wrap-anywhere dark:text-neutral-400">{fileName}</p>
      <p className="mt-2">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {reload ? (
          <button type="button" onClick={() => window.location.reload()} className={PRIMARY_BUTTON}>
            Reload the page
          </button>
        ) : (
          !fileProblem && (
            <button type="button" onClick={onRetry} className={PRIMARY_BUTTON}>
              Try again
            </button>
          )
        )}
        <button type="button" onClick={onReset} className={SECONDARY_BUTTON}>
          Choose another file
        </button>
        {reference && <span className="text-xs text-neutral-600 dark:text-neutral-400">Reference {reference}</span>}
      </div>
    </div>
  );
}
