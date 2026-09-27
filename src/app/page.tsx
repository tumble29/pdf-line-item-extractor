/**
 * The web page: one page where a person can upload a PDF and see what was
 * read, where each number came from, what was refused and why, and what needs
 * a second look.
 *
 * This file is a Server Component with the page's fixed text. The interactive
 * part (the upload and the result) is the Extractor client component.
 */
import { Extractor } from "@/components/extractor";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">PDF line-item extractor</h1>
      <p className="mt-2 max-w-3xl text-neutral-700 dark:text-neutral-300">
        Upload a quote, docket or invoice. We list each line item we can read, with the page and the exact text it came
        from. When we can&apos;t read something safely, we say so in plain words instead of guessing.
      </p>
      <Extractor />
    </main>
  );
}
