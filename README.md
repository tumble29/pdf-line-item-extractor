# PDF line-item extractor

[![CI](https://github.com/tumble29/pdf-line-item-extractor/actions/workflows/ci.yml/badge.svg)](https://github.com/tumble29/pdf-line-item-extractor/actions/workflows/ci.yml)

**Demo: https://pdf-line-item-extractor.vercel.app**

A small web service and page that read the line items of a quote, invoice, packing list or delivery docket from a PDF. Every number it reads from the PDF points to the page and the exact text it came from. Anything it can't read safely is refused, with a plain-English reason, instead of being guessed.

## What it does

- **Part A, the API.** `POST /api/parse` takes a PDF and returns JSON with:
  - the line items, where every number carries its evidence: the page, the characters exactly as printed, where they sit in the row, and the full row they came from;
  - a separate list of refusals, each with a code and a sentence that says why;
  - a status for every page (read, partly read, refused, or blank), and the printed totals with the check of the lines against them. The one number it works out itself, the sum of the lines, is marked "calculated by us".
- **Part B, the page.** Upload a PDF and see:
  - **JSON result**: the API's reply, hidden until you press "Show JSON", with a "Copy JSON" button;
  - a summary, then everything we couldn't read or check (shown above the items, so it is never missed), the totals, a card for each page, and the line items with their source line.

A refused file or a failed request is never shown as a generic error. Each one has its own sentence, for example "This PDF is protected with a password or other security, so we can't open it."

### Try it

Download a sample from [`samples/`](samples) and upload it on the demo:

- `KBS-DR118.pdf`: 8 pages of different kinds (a scanned page, a returns page, a credit page, a summary page).
- `KBS-10270.pdf`: the lines don't add up to the printed total, and both numbers are shown.
- `KBS-10262.pdf`: the notes above and below the table give two different pallet counts.

### Call the API directly

```bash
curl -F file=@invoice.pdf https://pdf-line-item-extractor.vercel.app/api/parse
```

Part of a real reply for one of the test PDFs, with some fields left out: a line item, and a row that was refused because its maths doesn't add up.

```json
{
  "items": [
    {
      "id": "p1-r3",
      "page": 1,
      "sourceText": "1 Pine batten 45x19 12 length $15.50 $186.00",
      "fields": {
        "quantity": { "header": "Qty", "raw": "12", "value": 12, "span": [20, 22] },
        "unitPrice": { "header": "Unit Price", "raw": "$15.50", "value": 15.5, "currency": null, "span": [30, 36] },
        "lineTotal": { "header": "Line Total", "raw": "$186.00", "value": 186, "currency": null, "span": [37, 44] }
      }
    }
  ],
  "refusals": [
    {
      "code": "ARITHMETIC_MISMATCH",
      "scope": "row",
      "page": 1,
      "message": "On page 1, 8 × $22.25 is $178.00 (calculated by us), but the document says $187.00. We can't tell which is right, so we left this line out.",
      "evidence": [{ "page": 1, "sourceText": "2 Deck screws 10g box 8 box $22.25 $187.00" }]
    }
  ]
}
```

`span` is the position of the number's characters in `sourceText`, so `sourceText.slice(30, 36)` is exactly `$15.50`. A whole file that can't be read (not a PDF, protected, damaged, over 4 MB) comes back as an HTTP 4xx with a JSON reason instead. The one exception is a file over about 4.5 MB: Vercel stops it before it reaches the code, and the reply is Vercel's own plain-text 413.

## Build and run

You need Node 24 and pnpm 9 (`corepack enable` sets up pnpm).

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000. The page is `src/app/page.tsx` and the API is `src/app/api/parse/route.ts`; the page updates as you edit.

Other commands:

| Command | What it does |
|---|---|
| `pnpm test` | Runs every test (Vitest) |
| `pnpm typecheck` | Generates the route types, then checks the types |
| `pnpm lint` | ESLint |
| `pnpm build` then `pnpm start` | A production build, served locally |
| `pnpm fixtures` | Writes the test PDFs to `out/demo/`, to upload by hand |
| `pnpm samples` | Reads the six samples in `samples/` and compares each with its expected outcome |

It is deployed on Vercel from this repo: every push to `main` deploys. CI runs the typecheck, lint and tests, and fails if the words "something went wrong" or "an error occurred" appear anywhere in `src/`.

## How it works

The engine is in `src/lib/engine/`. For each PDF:

1. Check the upload (a file, not empty, at most 4 MB, really a PDF), then open it with pdf.js.
2. Read every page on its own, with a time limit, so a page that throws or hangs doesn't change the other pages. Two gaps remain: a very heavy page can't be stopped in the middle of its work, and a broken entry in the file's page list loses the pages after it.
3. Decide what each page is: text, a scan, sideways text, or garbled text. Only text pages go on.
4. Group the text pieces into rows and cells by their positions, and find the table by its layout.
5. Work out what each column means from its numbers (quantity × unit price = line total, a currency sign, a "/bag" price unit), with the heading words as a second opinion (they decide alone only when the numbers can't tell, and the page says so).
6. Build one line item per row. A row with a problem is refused as a whole, with its reason.
7. Check every number once more against the page it came from (the evidence check), and refuse any that fails.
8. Check the lines against the printed total, and look for counts that contradict each other in the notes.

### Results on the six samples

On production, the same as locally:

| Sample | Pages | Items | What it reported |
|---|---|---|---|
| KBS-10234 | 1 | 5 | Clean. The lines add up to the printed total ($2,630.00). |
| KBS-10241 | 1 | 0 | A scanned page with no text, refused (`NO_TEXT_LAYER`). |
| KBS-10255 | 1 | 4 | A warning that the Weight column mixes per-item figures and totals. The Qty column's meaning comes from its heading only (labelled). It has no line-total column and no printed money total, so there is no totals check. |
| KBS-10262 | 1 | 3 | The lines add up to the total ($5,122.40). The notes say 14 pallets and 16 pallets, so the document gets `CONFLICTING_FIGURES`, quoting both lines. |
| KBS-10270 | 1 | 4 | The lines add up to $1,538.20 (calculated by us), but the total says $1,612.90 (`TOTALS_DISAGREE`, with the $74.70 difference). |
| KBS-DR118 | 8 | 15 | Page 4 is a scan (`NO_TEXT_LAYER`), page 6 is a returns page and page 7 a credit page ("Returns Note", "Credit Adjustment", both `CREDIT_OR_RETURN_PAGE`), and pages 5 and 8 get a warning that they may repeat lines ("Summary", "Signed Acceptance"). |

No number in any of them failed the evidence check.

## The three hardest decisions

### 1. No AI to read the PDF, but a proper PDF text extractor with rules

AI models are good at reading documents, but they can still make mistakes, and they can write a number that looks right but isn't on the page. In a quoting product, a confidently wrong number is worse than no number. So the service reads the text that is really inside the PDF, with its position on the page, and uses rules to find the table and read each number. Every number read from the document is the exact characters from the file, and a final check in the code proves it before anything is sent. The only numbers we calculate ourselves (the sum of the lines, and the maths in a refusal) are marked "calculated by us".

The cost is that an unusual layout gets more refusals than an AI would give. That is the safe direction, because a refusal is a correct result. An AI could be added later as a second reader, behind the same check.

### 2. Which PDF library: unpdf (Mozilla's pdf.js inside)

I needed a library that gives each piece of text with its position and font size, not just the plain text. Without positions, I can't find the table's columns or point to the exact characters of a number. I compared:

| Library | Result |
|---|---|
| **unpdf** (chosen) | Mozilla's pdf.js (the PDF reader in Firefox) packaged for servers. Gives positions, has no native parts, runs on Vercel without extra setup, MIT licence. |
| pdfjs-dist (the same pdf.js, used directly) | Second choice. Needs extra setup on Next.js and Vercel, and its default import crashed on Node 24. |
| pdf-parse | No way to get positions, and it needs a native canvas library. |
| pdf2json | Weaker positions (no height, no rotation), and a known bug when reading from memory. |
| mupdf | The best positions, but its AGPL licence rules it out for a closed product. |
| pdfium ports | Either too much low-level work, or no positions at all. |

The costs I accepted: pdf.js sometimes joins text drawn close together ("2" and "150.00" arrive as "2 150.00"). When the joined number reaches into the next column, the engine sees it and refuses the row instead of reading 2150. When every row is joined that way, there is no clean column to compare with, so it can't see it. And a very heavy page can't be interrupted, because the timer can't stop pdf.js in the middle of its work.

### 3. How to turn the library's output into the JSON

pdf.js doesn't give a table. It gives a flat list of text pieces, each with a position and a font size. The hard part was deciding how to turn that into line items without ever guessing.

- **The shape of the JSON came first.** Before writing the parser, I fixed what every answer must hold: every number with its evidence (the page, the exact characters, where they sit in the row, the full row); a separate list of refusals, each with a code and a plain sentence; a status for every page. A number is never calculated to fill a gap: a missing value stays missing.
- **The table is found by its layout, and columns get their meaning from the numbers.** Pieces are grouped into rows by their height on the page, and into cells by the gaps between them; the table is the run of rows whose cells line up. A column's meaning comes from its numbers first (quantity × unit price = line total, a currency sign, a "/bag" price unit), and the heading words are a second opinion: they confirm it, and when the numbers can't tell, the heading alone decides and the page says so. So the code isn't tied to one supplier's template or to English: in the tests it finds the tables in French, German and Vietnamese. The words it knows are English only, so on other languages some checks may not work, and the page gets a warning. When the maths and the headings disagree about a quantity, price or total column, or a number could be read two ways ("1.200" is 1.2 or 1200), that part is refused instead of guessed.

## Where I'm not confident

- **Only one supplier's template.** All six samples share one layout, and my own test PDFs are generated by my own code, so they are neat. I don't know yet how well it reads other suppliers' real documents. The best evidence I have for other layouts is a test that replaces every letter with letters from other alphabets (the tables are still found the same way) and tests with changed layouts (one piece per word, centred or two-line headings, no heading, a single item).
- **The table finding has measured limits.** When the column edges wobble, for example in a table lined up with spaces, the detector struggles: with edges moved by ±2 points only 11 of 18 test pages were still read correctly, and with ±3 points only 1 of 18 (measured on the prototype of the detector). A table with only two columns is skipped on purpose, and with several tables on one page only the one with the most number columns is read.
- **Scans with a hidden OCR text layer.** Many office scanners add invisible OCR text to a scanned page. The service reads that text as if it were real text, so if the scanner's OCR misread a number, it is quoted as the exact source text. Nothing detects this today.

## With three more days

1. **OCR for scanned pages**, so a photo or scan saved as a PDF can be read too. AWS Textract (AnalyzeExpense, about $10 per 1,000 pages) returns each word with its position and a confidence score, so the same table finding could run on it. OCR text is the OCR's reading, not characters from the file, so those numbers would be marked "read by OCR" with their confidence, and a low-confidence number would be refused.
2. **Test on many more real documents** from different suppliers, to see where the table finding breaks.
3. **Handle crooked columns** by grouping the column edges over the whole page before matching rows, instead of row by row.
4. **Read the pages in AWS Lambda, one Lambda per page**, each with its own time limit. A heavy page is then really stopped when its time is up, and only that page is lost. Lambda allows up to 15 minutes and 10 GB of memory. A normal Lambda call can only send and receive about 6 MB, so the PDF and the results would go through storage and Lambda would only get their addresses.
5. **Upload straight to Supabase Storage.** The browser would send the file to a one-time signed upload link, so large files no longer go through the 4 MB limit of the function. The result would be saved there too, so a very large result can be loaded by the page instead of being refused.

## Tests

1,042 tests (Vitest). The refusal rules are tested in `tests/engine/`, one file per part of the engine: for example `items.test.ts` for refused rows, `roles.test.ts` for column meanings, `numbers.test.ts` for number formats and numbers with two readings, `languages.test.ts` for the French, German and Vietnamese tables, `totals.test.ts` for the totals check and `contradictions.test.ts` for conflicting counts. A few tests matter most:

- `tests/engine/hard-rule.test.ts` runs 30 named test PDFs and all six samples through the engine, and checks that every number points back to the exact characters of its source.
- `tests/engine/containment.test.ts` breaks one page (it throws, or never finishes) and checks that the other pages give exactly the same items.
- `tests/api/route.test.ts` checks that every whole-file refusal and every bug of ours comes back with its own code and sentence, and `tests/client/parse-client.test.ts` that every way an upload can fail gets its own words on the page, never a generic message. `tests/copy.test.ts` checks that every refusal sentence is specific.

The test PDFs are built in memory with pdfkit, mostly by `tests/fixtures/build.ts` and `tests/fixtures/languages.ts`, with invented text. Only the six samples are PDF files in the repo.

## How I used AI

I built this with Claude Code, as the brief expects. We researched the PDF libraries and planned the design together before writing code. Claude Code wrote most of the code and tests, and from the contract onwards, before each part was committed, it ran reviews that attacked the code, often with made-up PDFs; each finding was checked, and the real ones were fixed. The decisions above were made together, and I chose between the options. `AGENTS.md` and `CLAUDE.md` are notes for coding agents, written by Next.js itself.
