/**
 * The interactive part of the page: the file picker, the upload's progress,
 * and its outcome.
 *
 * It renders the upload state from use-upload.ts, top to bottom:
 *   1. the file picker
 *   2. while reading: the progress panel with Cancel
 *   3. when the reply fits our contract (a result, a refused file, or our
 *      own bug): the JSON result, the server's reply laid out for reading,
 *      hidden until shown (json-result.tsx). The JSON is the task's main
 *      output, so it comes right after the picker.
 *   4. the outcome in plain words. It is rendered by switching on
 *      `outcome.state`: a result gets the full ResultView, and every other
 *      state gets the OutcomePanel with its own sentence. The switch ends with
 *      assertNever, so an outcome without a screen fails the TypeScript build
 *      instead of showing a blank panel.
 *
 * For keyboard and screen-reader users:
 *   - One live region is always on the page (a live region that appears
 *     together with its text is often not read out). It says when reading
 *     starts, and how it ended: the summary of a result, or the outcome's
 *     title and sentence.
 *   - When the upload ends, the focus moves to the title of what appeared
 *     (the result's summary, or the outcome's title), because the Cancel
 *     button that had the focus is gone.
 *   - "Choose another file" starts over and opens the file picker; starting
 *     over always puts the focus back on the file input.
 */
"use client";

import { useEffect, useRef, type Ref } from "react";

import type { ServerReply, UploadOutcome } from "@/lib/client/parse-client";
import { assertNever, outcomeCopy } from "@/lib/client/transport-copy";
import { useUpload, type UploadState } from "@/lib/client/use-upload";

import { summarySentence } from "./format";
import { JsonResult } from "./json-result";
import { ResultView } from "./result-view";
import { OutcomePanel, UploadingPanel } from "./status-panel";
import { UploadForm } from "./upload-form";

/**
 * The server's reply and its request id, for the outcomes whose reply fits
 * our contract. The other outcomes have no reply this page could read: the
 * file wasn't sent, the network failed, the reply was cut off, or it didn't
 * fit the contract (even when it came from our server).
 */
function serverReplyOf(outcome: UploadOutcome): { reply: ServerReply; requestId: string } | null {
  switch (outcome.state) {
    case "result":
      return { reply: outcome.reply, requestId: outcome.data.requestId };
    case "document_refused":
      return { reply: outcome.reply, requestId: outcome.problem.requestId };
    case "server_bug":
      return { reply: outcome.reply, requestId: outcome.requestId };
    default:
      return null;
  }
}

/** What the live region says in each state. */
function announcementOf(state: UploadState): string {
  if (state.phase === "uploading") return `Reading ${state.fileName}.`;
  if (state.phase === "idle") return "";
  if (state.outcome.state === "result") return summarySentence(state.outcome.data);
  const { title, message } = outcomeCopy(state.outcome);
  return `${title}. ${message}`;
}

export function Extractor() {
  const { state, upload, cancel, reset } = useUpload();
  // The last file chosen, so "Try again" can send it once more.
  const lastFile = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The title of the finished upload's screen, focused when it appears.
  const titleRef = useRef<HTMLHeadingElement>(null);

  const outcome = state.phase === "done" ? state.outcome : null;
  const server = outcome ? serverReplyOf(outcome) : null;
  useEffect(() => {
    if (outcome) titleRef.current?.focus();
  }, [outcome]);

  const start = (file: File) => {
    lastFile.current = file;
    upload(file);
  };
  const retry = () => {
    if (lastFile.current) upload(lastFile.current);
  };
  // Starts over and opens the file picker. The input is never disabled
  // outside an upload, so it can be opened at once, in the same click.
  const chooseAnother = () => {
    reset();
    inputRef.current?.focus();
    inputRef.current?.click();
  };

  return (
    <div className="mt-6 space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announcementOf(state)}
      </p>
      <UploadForm onFile={start} busy={state.phase === "uploading"} inputRef={inputRef} />
      {state.phase === "uploading" && (
        <UploadingPanel fileName={state.fileName} bytes={state.bytes} startedAt={state.startedAt} onCancel={cancel} />
      )}
      {/* Keyed by the request, so each new reply starts hidden. */}
      {server && <JsonResult key={server.requestId} reply={server.reply} />}
      {state.phase === "done" && (
        <Outcome fileName={state.fileName} outcome={state.outcome} onRetry={retry} onReset={chooseAnother} titleRef={titleRef} />
      )}
    </div>
  );
}

/** A finished upload's outcome, one screen per state. */
function Outcome({
  fileName,
  outcome,
  onRetry,
  onReset,
  titleRef,
}: {
  fileName: string;
  outcome: UploadOutcome;
  onRetry: () => void;
  onReset: () => void;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  switch (outcome.state) {
    case "result":
      return <ResultView result={outcome.data} titleRef={titleRef} />;
    case "document_refused":
    case "server_bug":
    case "too_large_local":
    case "too_large_platform":
    case "file_unreadable":
    case "timeout":
    case "network":
    case "reply_cut":
    case "bad_response":
    case "cancelled":
    case "page_bug":
      return <OutcomePanel fileName={fileName} outcome={outcome} onRetry={onRetry} onReset={onReset} titleRef={titleRef} />;
    default:
      return assertNever(outcome);
  }
}
