/**
 * The page's upload state, as a React hook.
 *
 * The state is one of three:
 *   idle       nothing chosen yet (or the person started over)
 *   uploading  a file is being sent and read; it can be cancelled
 *   done       the upload ended, with one UploadOutcome (parse-client.ts)
 *
 * The page renders `done` by switching on `outcome.state`, with assertNever
 * as the default, so an outcome with no screen fails the TypeScript build
 * instead of showing a blank or generic panel.
 *
 * The state changes go through `uploadReducer`, a plain function, so they are
 * easy to test and can't be done half-way.
 */
"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { parseFile, type UploadOutcome } from "./parse-client";

/** Every state the upload can be in. */
export type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; fileName: string; bytes: number; startedAt: number }
  | { phase: "done"; fileName: string; outcome: UploadOutcome };

/** Every change of state. */
export type UploadAction =
  | { type: "start"; fileName: string; bytes: number; startedAt: number }
  | { type: "finish"; outcome: UploadOutcome }
  | { type: "reset" };

/**
 * The next state. A "finish" only counts while uploading (a late answer
 * after "reset" is ignored), and it keeps the file's name for the screen.
 */
export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case "start":
      return { phase: "uploading", fileName: action.fileName, bytes: action.bytes, startedAt: action.startedAt };
    case "finish":
      return state.phase === "uploading" ? { phase: "done", fileName: state.fileName, outcome: action.outcome } : state;
    case "reset":
      return { phase: "idle" };
  }
}

/** The upload state, and the three things the page can do with it. */
export function useUpload(): {
  state: UploadState;
  upload: (file: File) => void;
  cancel: () => void;
  reset: () => void;
} {
  const [state, dispatch] = useReducer(uploadReducer, { phase: "idle" });
  // The Cancel button's controller for the upload in progress.
  const controller = useRef<AbortController | null>(null);

  const upload = useCallback((file: File) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    dispatch({ type: "start", fileName: file.name, bytes: file.size, startedAt: Date.now() });
    // Only the latest upload may finish; an older one was replaced.
    const finish = (outcome: UploadOutcome) => {
      if (controller.current === current) dispatch({ type: "finish", outcome });
    };
    // parseFile never throws, but if a future change made it, the page would
    // stay on "Reading…" for ever. The catch makes sure it always finishes.
    void parseFile(file, current.signal).then(finish, () => finish({ state: "page_bug" }));
  }, []);

  const cancel = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    dispatch({ type: "reset" });
  }, []);

  // Leaving the page cancels an upload that is still running.
  useEffect(() => () => controller.current?.abort(), []);

  return { state, upload, cancel, reset };
}
