/**
 * Limits for uploads and documents.
 *
 * They live in the contract folder because both sides must use the same
 * numbers: the web page checks the file size before sending it (src/app/page.tsx
 * imports MAX_UPLOAD_BYTES from here), and the server checks it again when the
 * file arrives.
 */

/**
 * The largest upload we accept: 4 MB (1 MB = 1024 x 1024 bytes).
 *
 * Why 4 MB: Vercel rejects any request body over 4.5 MB before our code even
 * runs, and its rejection is a plain-text page, not our JSON. Stopping at 4 MB
 * leaves room for the rest of the upload request, so a file that is too large
 * gets our own clear message instead of the platform's.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Extra bytes an upload request carries on top of the file itself (the
 * multipart boundaries and headers). The route uses it to reject a request
 * that is clearly too large from its Content-Length header alone, before
 * reading the body.
 */
export const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;

/**
 * The most pages we read in one file.
 *
 * A PDF's page list can point at the same page again and again, so a 2 KB file
 * can claim 100,000 pages. Reading that would produce a reply far larger than
 * Vercel allows (4.5 MB), and the user would get the platform's error instead
 * of ours. 200 pages is far more than any quote, invoice or delivery docket
 * needs.
 */
export const MAX_PAGES = 200;

/**
 * How far into the file we look for the "%PDF-" marker that every PDF starts
 * with. The PDF standard allows some bytes before it, and readers accept the
 * marker anywhere in the first 1024 bytes, so we do the same.
 */
export const PDF_MARKER_WINDOW = 1024;
