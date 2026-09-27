"use client";

// Temporary upload page for the platform smoke test. It shows the server's
// own reason for every outcome. The real UI (Part B) replaces this page.
import { useState } from "react";

const MAX_BYTES = 4 * 1024 * 1024;

type Outcome =
  | { state: "idle" }
  | { state: "uploading"; fileName: string }
  | { state: "done"; status: number; body: unknown; detail?: string }
  | { state: "message"; text: string };

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setOutcome({
        state: "message",
        text: `This file is ${formatSize(file.size)}. The limit is 4 MB, so it wasn't sent.`,
      });
      return;
    }

    setOutcome({ state: "uploading", fileName: file.name });
    const form = new FormData();
    form.append("file", file);

    let res: Response;
    try {
      res = await fetch("/api/parse", { method: "POST", body: form });
    } catch {
      setOutcome({
        state: "message",
        text: "We couldn't reach the server. Check your connection and try again.",
      });
      return;
    }

    const text = await res.text();
    try {
      const body = JSON.parse(text) as { detail?: unknown };
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      setOutcome({ state: "done", status: res.status, body, detail });
    } catch {
      setOutcome({
        state: "message",
        text:
          res.status === 413
            ? "The file was too large for the server to accept."
            : `The server replied with status ${res.status}, but not in the format we expected. Your file may be fine.`,
      });
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">PDF line-item extractor</h1>
      <p className="mt-2 text-sm opacity-70">
        Temporary test page. Upload a PDF (up to 4 MB) to check that the server can open it.
      </p>

      <input
        type="file"
        accept="application/pdf"
        className="mt-6 block w-full text-sm file:mr-4 file:rounded file:border-0 file:bg-foreground file:px-4 file:py-2 file:text-background"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <section className="mt-6" aria-live="polite">
        {outcome.state === "uploading" && <p>Reading {outcome.fileName}…</p>}
        {outcome.state === "message" && (
          <p className="rounded border border-amber-500 p-3">{outcome.text}</p>
        )}
        {outcome.state === "done" && (
          <div className="space-y-3">
            {outcome.detail && (
              <p className="rounded border border-amber-500 p-3">{outcome.detail}</p>
            )}
            <pre className="overflow-x-auto rounded bg-black/5 p-3 text-xs dark:bg-white/10">
              HTTP {outcome.status}
              {"\n"}
              {JSON.stringify(outcome.body, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </main>
  );
}
