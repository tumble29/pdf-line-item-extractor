// Temporary smoke-test route: proves unpdf loads and opens PDFs inside a
// Next.js Route Handler. Part 4 of the plan replaces this with the real engine.
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;

function problem(status: number, code: string, detail: string) {
  return Response.json(
    { kind: "problem", code, detail },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return problem(400, "NO_FILE", "No file arrived with the upload. Choose a PDF and try again.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return problem(400, "NO_FILE", "No file arrived with the upload. Choose a PDF and try again.");
  }
  if (file.size > MAX_BYTES) {
    return problem(413, "FILE_TOO_LARGE", "This file is larger than the 4 MB limit.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) {
    return problem(415, "NOT_A_PDF", "This file isn't a PDF, even though its name may end in .pdf.");
  }

  const pdfjs = await getResolvedPDFJS();
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const pageCount = doc.numPages;
    await doc.loadingTask.destroy();
    return Response.json({ kind: "result", fileName: file.name, pageCount, pdfjsVersion: pdfjs.version });
  } catch (err) {
    if (err instanceof pdfjs.PasswordException) {
      return problem(422, "ENCRYPTED", "This PDF is password-protected. Remove the password and upload it again.");
    }
    if (err instanceof pdfjs.InvalidPDFException) {
      return problem(422, "CORRUPT_FILE", "This file is damaged and couldn't be opened.");
    }
    throw err;
  }
}
