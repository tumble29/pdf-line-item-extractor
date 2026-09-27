/**
 * Step 1 of the pipeline: check the upload before any PDF code runs.
 *
 * These checks are cheap and need no PDF reader, so they run first. Each
 * problem gets its own refusal with its own sentence, instead of letting the
 * PDF reader fail later with a confusing error:
 *
 *   NO_FILE         the request has no file in it
 *   EMPTY_FILE      the file has 0 bytes
 *   FILE_TOO_LARGE  over the 4 MB limit (checked before the bytes are copied)
 *   NOT_A_PDF       no "%PDF-" marker in the first 1024 bytes
 *
 * The web page runs the size check too, but the server never trusts the page:
 * someone can call the API directly, for example with curl.
 */
import { MAX_UPLOAD_BYTES, PDF_MARKER_WINDOW } from "@/lib/contract/limits";

import { documentRefusal, type DocumentRefusal } from "./refusals";

/** The result of checking an upload: the file's bytes, or the reason it was refused. */
export type UploadCheck =
  | { ok: true; bytes: Uint8Array; fileName: string }
  | { ok: false; refusal: DocumentRefusal };

/** "%PDF-" as bytes. */
const PDF_MARKER = new TextEncoder().encode("%PDF-");

/** True when `marker` appears anywhere in the first `window` bytes of `bytes`. */
function hasMarker(bytes: Uint8Array, marker: Uint8Array, window: number): boolean {
  const end = Math.min(bytes.length, window) - marker.length;
  for (let start = 0; start <= end; start++) {
    let match = true;
    for (let i = 0; i < marker.length; i++) {
      if (bytes[start + i] !== marker[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Checks the `file` field of an upload.
 *
 * `entry` is what `formData.get("file")` returns: a File, a plain string (if a
 * client sent text instead of a file), or null (no field at all).
 *
 * `limitBytes` is MAX_UPLOAD_BYTES in the app; tests pass a smaller one so
 * they don't need a 4 MB file.
 */
export async function validateUpload(
  entry: FormDataEntryValue | null,
  limitBytes: number = MAX_UPLOAD_BYTES,
): Promise<UploadCheck> {
  // A string or null means no file was attached.
  if (!(entry instanceof File)) {
    return { ok: false, refusal: documentRefusal({ code: "NO_FILE" }) };
  }
  if (entry.size === 0) {
    return { ok: false, refusal: documentRefusal({ code: "EMPTY_FILE" }) };
  }
  // Check the size before copying the bytes. By now formData() has already
  // read the body; the route turns away a clearly oversized request earlier,
  // from its Content-Length header, and on Vercel the platform itself stops
  // bodies over 4.5 MB.
  if (entry.size > limitBytes) {
    return {
      ok: false,
      refusal: documentRefusal({ code: "FILE_TOO_LARGE", sizeBytes: entry.size, limitBytes }),
    };
  }

  const bytes = new Uint8Array(await entry.arrayBuffer());
  if (!hasMarker(bytes, PDF_MARKER, PDF_MARKER_WINDOW)) {
    return { ok: false, refusal: documentRefusal({ code: "NOT_A_PDF", fileName: entry.name }) };
  }
  return { ok: true, bytes, fileName: entry.name };
}
