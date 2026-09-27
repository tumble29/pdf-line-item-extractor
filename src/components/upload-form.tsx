/**
 * The file picker.
 *
 * Choosing a file starts the upload at once; the size check runs first, in
 * parse-client.ts, so a file over the limit is never sent. The input is a
 * normal file input (keyboard and screen readers work with it), styled with a
 * visible label. The input is cleared after each choice, so choosing the same
 * file again starts a new upload. `inputRef` lets the page focus it, or open
 * the picker, when the person starts over.
 */
"use client";

import { useId, type Ref } from "react";

import { megabytes } from "@/lib/contract/codes";
import { MAX_UPLOAD_BYTES } from "@/lib/contract/limits";

export function UploadForm({ onFile, busy, inputRef }: { onFile: (file: File) => void; busy: boolean; inputRef: Ref<HTMLInputElement> }) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="rounded-lg border border-dashed border-neutral-400 p-5 dark:border-neutral-600">
      <label htmlFor={inputId} className="block text-base font-medium">
        Choose a PDF to read
      </label>
      <p id={hintId} className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        A quote, docket or invoice. PDF, up to {megabytes(MAX_UPLOAD_BYTES, false)}.
      </p>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        aria-describedby={hintId}
        disabled={busy}
        className="mt-3 block w-full text-sm file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:file:bg-neutral-100 dark:file:text-neutral-900 dark:hover:file:bg-neutral-300"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
