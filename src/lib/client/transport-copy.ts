/**
 * The words the page shows for every upload outcome.
 *
 * Two kinds of outcome:
 *   - The server answered in our contract (a result, a refused file, or our
 *     own bug). The server's sentence and title are shown exactly as sent;
 *     they are written in src/lib/contract/codes.ts, and nothing here
 *     rewords them.
 *   - The server's answer never reached us as ours: the file was too large to
 *     send, something on the way turned it away, the browser couldn't read
 *     it, it took too long, the network failed, the reply was cut off or
 *     wasn't ours, the person cancelled, or this page's own code failed.
 *     Those sentences are here.
 *
 * `too_large_local` reuses the server's own FILE_TOO_LARGE sentence, filled in
 * with the file's size, so the page and the server always say the same thing.
 * No sentence here names a limit the page can't know: a 413 from something
 * between us and the server gives the file's size, not a guessed limit.
 */
import { INTERNAL_PROBLEM, megabytes, refusalMessage } from "@/lib/contract/codes";
import { MAX_UPLOAD_BYTES } from "@/lib/contract/limits";

import type { UploadOutcome } from "./parse-client";

/** A short title and one sentence, for a panel on the page. */
export interface OutcomeCopy {
  title: string;
  message: string;
}

/** The title and the sentence for every outcome that is not a result. */
export function outcomeCopy(outcome: Exclude<UploadOutcome, { state: "result" }>): OutcomeCopy {
  switch (outcome.state) {
    case "document_refused":
      return { title: outcome.problem.title, message: outcome.problem.detail };
    case "server_bug":
      return { title: INTERNAL_PROBLEM.title, message: outcome.detail };
    case "too_large_local":
      return {
        title: "File too large",
        message: refusalMessage({ code: "FILE_TOO_LARGE", sizeBytes: outcome.bytes, limitBytes: MAX_UPLOAD_BYTES }),
      };
    case "too_large_platform":
      return {
        title: "File too large",
        message:
          `This file (${megabytes(outcome.bytes)}) was turned away as too large before the server could read it. ` +
          "Try a smaller copy, for example with smaller images, or split it into several files.",
      };
    case "file_unreadable":
      return {
        title: "Couldn't read the file",
        message:
          "Your browser couldn't read this file from your device. It may have been moved, renamed or changed " +
          "after you chose it. Choose it again.",
      };
    case "timeout":
      return {
        title: "Took too long",
        message:
          outcome.source === "server"
            ? "Reading this file took too long, so the server stopped. Try again, or try a smaller file."
            : `We didn't get an answer within ${outcome.seconds} seconds, so we stopped waiting. On a slow connection, ` +
              "sending the file takes part of that time. Try again, or try a smaller file.",
      };
    case "network":
      return { title: "No connection", message: "We couldn't reach the server. Check your connection and try again." };
    case "reply_cut":
      return {
        title: "Reply cut off",
        message: `The server answered (status ${outcome.status}), but its reply was cut off before it all arrived. Your file may be fine. Try again.`,
      };
    case "bad_response":
      return {
        title: "Unexpected reply",
        message: outcome.ours
          ? `The server's reply doesn't match this version of the page (status ${outcome.status}). Reload the page and try again.`
          : `The server replied in a way we didn't expect (status ${outcome.status}), so we can't show a result. Your file may be fine. Try again.`,
      };
    case "cancelled":
      return { title: "Cancelled", message: "Upload cancelled. Choose a file to try again." };
    case "page_bug":
      return {
        title: "This page failed",
        message:
          "This page's own code failed while sending your file. This is our bug, not a problem with your file. " +
          "Reload the page and try again.",
      };
    default:
      return assertNever(outcome);
  }
}

/**
 * Makes TypeScript check that every case above is handled. If a new outcome
 * is added to UploadOutcome without a case here, `outcome` is not `never`
 * any more, and the build fails.
 */
export function assertNever(value: never): never {
  throw new Error(`an outcome with no words: ${JSON.stringify(value)}`);
}
