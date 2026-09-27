/**
 * The response contract: the exact shape of every JSON reply from Part A.
 *
 * Why this file exists
 * --------------------
 * The engine (Part A) and the web page (Part B) must agree on one shape. If
 * they drift apart, the page can no longer read a refusal and falls back to a
 * vague error, which is the failure the brief warns about. So the shape is
 * written once, here, with zod:
 *
 *   - The server builds its reply to match these schemas.
 *   - The page checks every reply with `safeParse` before showing it.
 *   - The TypeScript types come from the schemas (`z.infer`), so the types and
 *     the runtime checks can never disagree.
 *
 * Every object is a `z.strictObject`, so a key that is not listed here fails
 * validation. This way a new or misspelled field from the server is caught at
 * once instead of being ignored.
 *
 * Some rules involve more than one field (for example "a quantity must have a
 * value"). zod's shape alone can't express them, so they are written as
 * `superRefine` functions next to the object they check. `superRefine` can
 * report several problems at once, each at its own path, such as
 * `fields.quantity.value`. That makes a broken reply easy to debug.
 *
 * Reading guide
 * -------------
 * A reply is either a `ParseResult` (the file opened, whatever was found) or a
 * `Problem` (the whole file was refused, or our own code failed). Inside a
 * `ParseResult`:
 *
 *   pages     one report per page: its status, its columns and its notes
 *   items     the line items we could read, each with evidence
 *   refusals  everything we refused to read, each with a reason
 *   totals    the totals printed on the document, and our checks against them
 *
 * The hard rule from the brief: every number must point to its source. That is
 * why each number is a `Field` that keeps its raw text and its position in the
 * row it came from, and why each `LineItem` keeps that row's text.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Column roles
// ---------------------------------------------------------------------------

/**
 * What a column means. The engine decides this from the numbers first
 * (quantity x unit price = line total), with the header words as a second
 * opinion. A column that neither can place gets role `null`.
 */
export const Role = z.enum([
  "itemNo", // the line number, like 1, 2, 3. Kept as text, never used in maths.
  "code", // a product code or SKU, like "ADH-400"
  "description", // what the line is, like "Framing timber lot 1-1"
  "quantity", // how many
  "unit", // the unit of the quantity, like "sheet" or "ea"
  "unitPrice", // the price of one unit
  "lineTotal", // quantity x unit price, as printed on the document
]);
export type Role = z.infer<typeof Role>;

/** The three roles whose cells are read as numbers. Every other role stays text. */
export const NUMERIC_ROLES = ["quantity", "unitPrice", "lineTotal"] as const satisfies readonly Role[];

/** The roles that hold money. Only these may have a currency. */
export const MONEY_ROLES = ["unitPrice", "lineTotal"] as const satisfies readonly Role[];

/**
 * Where a column's role came from:
 *   - "numbers": the values decided it (for example, the product check)
 *   - "header":  only the header words decided it; the numbers didn't confirm it
 *   - "both":    the values and the header words agree
 * It is `null` exactly when the role is `null`.
 */
export const RoleSource = z.enum(["numbers", "header", "both"]).nullable();
export type RoleSource = z.infer<typeof RoleSource>;

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/**
 * An ISO 4217 currency code such as "NZD", "EUR" or "VND", or `null`.
 *
 * It is set only when the document writes the code itself, or uses a symbol
 * that means exactly one currency ("NZ$" means NZD, "€" means EUR). A bare "$"
 * could be NZD, AUD or USD, so it gives `null`. The engine never guesses.
 * The raw text of the cell always keeps the symbol as printed.
 *
 * The schema checks only the shape (three capital letters), not that the code
 * is a real currency.
 */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "a three-letter ISO 4217 code").nullable();

/**
 * Where a piece of text sits inside its row's `sourceText` (a line item's row,
 * or a printed total's row). Written as [start, end): start is included, end
 * is not. `sourceText.slice(start, end)` must give back `raw` exactly, and the
 * schema checks this. It lets the page highlight the right "10" when the row
 * also contains "lot 1-10".
 */
export const Span = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([start, end]) => start <= end, "a span must not end before it starts");
export type Span = z.infer<typeof Span>;

/**
 * One cell that we did read.
 *
 * Every cell keeps `raw`, the exact characters printed on the page. Only the
 * three numeric roles also get a `value`, the number we read from `raw`.
 * (`z.number()` already rejects NaN and Infinity, so a broken calculation can't
 * slip through as a value.)
 */
export const Field = z.strictObject({
  /** The column header exactly as printed ("Unit Price"), or null when the column has no heading. */
  header: z.string().nullable(),
  /** The exact characters of the cell, currency symbol included: "$68.00 /bag". */
  raw: z.string().min(1),
  /** The number read from `raw`. Only for quantity, unitPrice and lineTotal. */
  value: z.number().optional(),
  /** The price unit from a "/bag" style ending. Only for unitPrice. */
  per: z.string().min(1).optional(),
  /** The currency, when the document states it. Only for unitPrice and lineTotal. */
  currency: Currency.optional(),
  /**
   * Where `raw` sits inside the row's `sourceText`. The rules engine always
   * sets it. It is optional only so that a later extractor (the optional AI
   * step in the plan) could return a field without one; the server's evidence
   * check then falls back to a weaker whole-word match, and the page shows the
   * row without a highlight.
   */
  span: Span.optional(),
});
export type Field = z.infer<typeof Field>;

/**
 * Checks that a field's span points at exactly its raw text in the row.
 * Used for line items and for printed totals, which follow the same rule.
 */
function checkSpan(
  field: Field,
  sourceText: string,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!field.span) return;
  const [start, end] = field.span;
  if (sourceText.slice(start, end) !== field.raw) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "span"],
      message: `the span [${start}, ${end}) doesn't point at the raw text "${field.raw}"`,
    });
  }
}

/**
 * One column of a table, as the engine understood it.
 *
 * `header` is kept exactly as printed, in whatever language the document uses.
 * `key` is a mechanical, lowercase camelCase version of it ("Unit Price" gives
 * "unitPrice", "Prix unitaire" gives "prixUnitaire"), or `col{n}` when there is
 * no heading. `role` is what the column means, if we could tell.
 */
export const Column = z
  .strictObject({
    header: z.string().nullable(),
    key: z.string().min(1),
    role: Role.nullable(),
    roleSource: RoleSource,
    /** Decided from the cell shapes only: "numeric" when half or more of the body cells look like numbers. */
    kind: z.enum(["numeric", "text"]),
  })
  .refine((column) => (column.role === null) === (column.roleSource === null), {
    message: "roleSource must be null exactly when role is null",
    path: ["roleSource"],
  });
export type Column = z.infer<typeof Column>;

/**
 * A cell from a column whose role is null (for example a "Weight" column).
 * It is shown exactly as printed. It is never read as a number, never summed
 * and never used in a check.
 */
export const OtherCell = z.strictObject({
  header: z.string().nullable(),
  key: z.string().min(1),
  raw: z.string(),
});
export type OtherCell = z.infer<typeof OtherCell>;

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/** The line item shape before the rules across fields (below) are applied. */
const LineItemShape = z.strictObject({
  /**
   * `p{page}-r{rowIndex}`, for example "p1-r5". Built from the page and row,
   * never from a counter, so the same file always gives the same ids.
   */
  id: z.string().regex(/^p\d+-r\d+$/, "an id like p1-r5"),
  page: z.number().int().min(1),
  /**
   * The row's position on the page, starting at 0 at the top. Rows above the
   * table (name, title, header) are counted. Separator lines like "-----" are not.
   */
  rowIndex: z.number().int().min(0),
  /**
   * The whole row as rebuilt from the page. When a description wraps onto a
   * second line, that line is added after a "\n".
   */
  sourceText: z.string().min(1),
  /** The cells we read, keyed by role. Only roles that the table has and this row fills are present. */
  fields: z.partialRecord(Role, Field),
  /** Cells from columns with no role, shown as printed. */
  otherCells: z.array(OtherCell),
  /** Roles whose column exists on the page but whose cell is empty in this row. We never guess a value for them. */
  missing: z.array(Role),
});
type LineItemShape = z.infer<typeof LineItemShape>;

/**
 * The rules across fields of one line item. They make a broken item fail
 * validation instead of reaching the screen:
 *
 *   1. The id matches the page and row ("p1-r5" for page 1, row 5).
 *   2. Only quantity, unitPrice and lineTotal may have a `value`, and they must
 *      have one. A number we couldn't read makes the whole row a refusal, so a
 *      numeric field without a value would be a bug.
 *   3. Only unitPrice may have `per`.
 *   4. Only unitPrice and lineTotal may have `currency`.
 *   5. Every span points at exactly its raw text in `sourceText`.
 *   6. A role can't be both present in `fields` and listed in `missing`.
 */
function lineItemRules(item: LineItemShape, ctx: z.RefinementCtx): void {
  const numeric: readonly Role[] = NUMERIC_ROLES;
  const money: readonly Role[] = MONEY_ROLES;

  if (item.id !== `p${item.page}-r${item.rowIndex}`) {
    ctx.addIssue({ code: "custom", path: ["id"], message: `the id must be p${item.page}-r${item.rowIndex}` });
  }

  for (const [roleName, field] of Object.entries(item.fields)) {
    if (!field) continue;
    const role = roleName as Role;
    const path = ["fields", role];

    if (numeric.includes(role) && field.value === undefined) {
      ctx.addIssue({ code: "custom", path: [...path, "value"], message: `${role} must have a value` });
    }
    if (!numeric.includes(role) && field.value !== undefined) {
      ctx.addIssue({ code: "custom", path: [...path, "value"], message: `${role} is text and must not have a value` });
    }
    if (field.per !== undefined && role !== "unitPrice") {
      ctx.addIssue({ code: "custom", path: [...path, "per"], message: "only unitPrice may have a price unit" });
    }
    if (field.currency !== undefined && !money.includes(role)) {
      ctx.addIssue({ code: "custom", path: [...path, "currency"], message: "only money roles may have a currency" });
    }
    checkSpan(field, item.sourceText, path, ctx);
  }

  for (const role of item.missing) {
    if (item.fields[role]) {
      ctx.addIssue({ code: "custom", path: ["missing"], message: `${role} is both present and listed as missing` });
    }
  }
}

/** One line we could read, with evidence for every cell. */
export const LineItem = LineItemShape.superRefine(lineItemRules);
export type LineItem = z.infer<typeof LineItem>;

// ---------------------------------------------------------------------------
// Refusal codes, and the rules attached to each one
// ---------------------------------------------------------------------------

/** A quote from the document that backs up a refusal: the page and the text as printed. */
export const Evidence = z.strictObject({
  page: z.number().int().min(1),
  sourceText: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * Refusals that stop us reading the file at all. These come back as a 4xx
 * `Problem`, not as a `ParseResult`, because there is nothing else to show.
 */
export const DocumentCode = z.enum([
  "NO_FILE",
  "EMPTY_FILE",
  "FILE_TOO_LARGE",
  "NOT_A_PDF",
  "ENCRYPTED",
  "CORRUPT_FILE",
]);
export type DocumentCode = z.infer<typeof DocumentCode>;

/**
 * Every reason the engine can give for not reading something. The wording the
 * user sees for each one lives in `codes.ts`, never here.
 */
export const RefusalCode = z.enum([
  ...DocumentCode.options,
  // Page problems: the whole page is skipped. The other pages are not affected.
  "NO_TEXT_LAYER",
  "GARBLED_TEXT",
  "ROTATED_TEXT",
  "PAGE_LOAD_FAILED",
  "NO_TABLE_FOUND",
  "AMBIGUOUS_COLUMNS",
  "COLUMN_MEANING_UNKNOWN",
  "CREDIT_OR_RETURN_PAGE",
  // Row problems: one line (or, for the last two, one printed total) is skipped.
  // The rest of the page is still read.
  "UNPARSEABLE_NUMBER",
  "NO_DESCRIPTION",
  "ARITHMETIC_MISMATCH",
  "AMBIGUOUS_NUMBER_FORMAT",
  "EVIDENCE_CHECK_FAILED",
  // Findings about the whole document or its totals, reported next to the items.
  "CONFLICTING_FIGURES",
  "TOTALS_DISAGREE",
  "TOTALS_UNVERIFIABLE",
  "NO_LINE_ITEMS_FOUND",
]);
export type RefusalCode = z.infer<typeof RefusalCode>;

/**
 * How much of the document a refusal covers:
 *   - "document": the whole file. This includes the whole-file refusals sent as
 *                 a Problem, and findings like CONFLICTING_FIGURES inside a result.
 *   - "page":     one page
 *   - "row":      one line
 *   - "totals":   a printed total, or a check of the lines against it
 */
export const RefusalScope = z.enum(["document", "page", "row", "totals"]);
export type RefusalScope = z.infer<typeof RefusalScope>;

/**
 * Where each refusal code may appear. Most codes have one scope. Two can also
 * apply to a printed total: a total whose number has two readings, and a total
 * that fails the final evidence check.
 */
export const REFUSAL_SCOPES: { [Code in RefusalCode]: readonly RefusalScope[] } = {
  NO_FILE: ["document"],
  EMPTY_FILE: ["document"],
  FILE_TOO_LARGE: ["document"],
  NOT_A_PDF: ["document"],
  ENCRYPTED: ["document"],
  CORRUPT_FILE: ["document"],
  NO_TEXT_LAYER: ["page"],
  GARBLED_TEXT: ["page"],
  ROTATED_TEXT: ["page"],
  PAGE_LOAD_FAILED: ["page"],
  NO_TABLE_FOUND: ["page"],
  AMBIGUOUS_COLUMNS: ["page"],
  COLUMN_MEANING_UNKNOWN: ["page"],
  CREDIT_OR_RETURN_PAGE: ["page"],
  UNPARSEABLE_NUMBER: ["row"],
  NO_DESCRIPTION: ["row"],
  ARITHMETIC_MISMATCH: ["row"],
  AMBIGUOUS_NUMBER_FORMAT: ["row", "totals"],
  EVIDENCE_CHECK_FAILED: ["row", "totals"],
  CONFLICTING_FIGURES: ["document"],
  TOTALS_DISAGREE: ["totals"],
  TOTALS_UNVERIFIABLE: ["totals"],
  NO_LINE_ITEMS_FOUND: ["document"],
};

/**
 * What a page refusal does to the page's status. Every page refusal makes the
 * page "refused", except COLUMN_MEANING_UNKNOWN: its rows are still shown as
 * printed, so the page is "partial".
 */
export const PAGE_REFUSAL_STATUS = {
  NO_TEXT_LAYER: "refused",
  GARBLED_TEXT: "refused",
  ROTATED_TEXT: "refused",
  PAGE_LOAD_FAILED: "refused",
  NO_TABLE_FOUND: "refused",
  AMBIGUOUS_COLUMNS: "refused",
  COLUMN_MEANING_UNKNOWN: "partial",
  CREDIT_OR_RETURN_PAGE: "refused",
} as const satisfies Partial<Record<RefusalCode, "refused" | "partial">>;

/**
 * The HTTP status for each whole-file refusal:
 *   400  the request itself is wrong (no file in it)
 *   413  the file is too large
 *   415  the file is not the type we read
 *   422  the file is the right type, but we can't read its contents
 */
export const DOCUMENT_HTTP_STATUS: Record<DocumentCode, number> = {
  NO_FILE: 400,
  EMPTY_FILE: 422,
  FILE_TOO_LARGE: 413,
  NOT_A_PDF: 415,
  ENCRYPTED: 422,
  CORRUPT_FILE: 422,
};

/** The HTTP status when our own code fails. It is never used for a problem with the user's file. */
export const INTERNAL_HTTP_STATUS = 500;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const RefusalShape = z.strictObject({
  /**
   * Built from fixed parts, never from a counter, so the same file always
   * gives the same ids. The forms are:
   *   doc-{code}                 a finding about the whole document
   *   doc-{code}-{word}          CONFLICTING_FIGURES, one per repeated word ("doc-CONFLICTING_FIGURES-pallet")
   *   p{page}-{code}             a page refusal ("p4-NO_TEXT_LAYER")
   *   p{page}-r{row}-{code}      a row refusal ("p1-r7-ARITHMETIC_MISMATCH")
   *   totals-{...}               a totals refusal ("totals-lines_vs_total")
   */
  id: z.string().min(1),
  code: RefusalCode,
  scope: RefusalScope,
  page: z.number().int().min(1).optional(),
  rowIndex: z.number().int().min(0).optional(),
  /** The plain-English sentence the page shows, exactly as sent. */
  message: z.string().min(1),
  /** Quotes of what was on the page, so nothing is hidden from the user even when we refuse to read it. */
  evidence: z.array(Evidence),
});
type RefusalShape = z.infer<typeof RefusalShape>;

/**
 * The rules that tie a refusal's code, scope, location and id together, so the
 * page can always place a refusal next to the page or row it is about:
 *
 *   - the scope is one the code allows (REFUSAL_SCOPES)
 *   - a "document" refusal has no page and no row
 *   - a "page" refusal has a page and no row
 *   - a "row" refusal has a page and a row
 *   - the id follows the form for its scope
 */
function refusalRules(refusal: RefusalShape, ctx: z.RefinementCtx): void {
  const { code, scope, page, rowIndex, id } = refusal;
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

  if (!REFUSAL_SCOPES[code].includes(scope)) {
    issue("scope", `${code} can't have scope "${scope}"`);
  }

  if (scope === "document") {
    if (page !== undefined) issue("page", "a document refusal has no page");
    if (rowIndex !== undefined) issue("rowIndex", "a document refusal has no row");
    if (id !== `doc-${code}` && !id.startsWith(`doc-${code}-`)) issue("id", `the id must start with doc-${code}`);
  } else if (scope === "page") {
    if (page === undefined) issue("page", "a page refusal needs its page");
    if (rowIndex !== undefined) issue("rowIndex", "a page refusal has no row");
    if (page !== undefined && id !== `p${page}-${code}`) issue("id", `the id must be p${page}-${code}`);
  } else if (scope === "row") {
    if (page === undefined) issue("page", "a row refusal needs its page");
    if (rowIndex === undefined) issue("rowIndex", "a row refusal needs its row");
    if (page !== undefined && rowIndex !== undefined && id !== `p${page}-r${rowIndex}-${code}`) {
      issue("id", `the id must be p${page}-r${rowIndex}-${code}`);
    }
  } else if (!id.startsWith("totals-")) {
    issue("id", "the id of a totals refusal must start with totals-");
  }
}

/** One thing we refused to read, and why. */
export const Refusal = RefusalShape.superRefine(refusalRules);
export type Refusal = z.infer<typeof Refusal>;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Something the user should know that is not a refusal. "info" is background
 * ("the 'Weight' column is shown as printed"). "warning" asks for care ("this
 * page is titled 'Summary', so its lines may repeat other pages").
 */
export const Note = z.strictObject({
  level: z.enum(["info", "warning"]),
  text: z.string().min(1),
});
export type Note = z.infer<typeof Note>;

/**
 * What happened to one page:
 *   - "extracted": read, with no page or row refusals (it may still have warnings)
 *   - "partial":   some lines read and some refused; or a table whose columns
 *                  we couldn't understand, with its rows shown as printed
 *   - "refused":   no line from this page is listed. Either the page itself
 *                  was refused (a scan, no table, a credit note), or every row
 *                  on it was refused.
 *   - "blank":     no text and no images
 */
export const PageStatus = z.enum(["extracted", "partial", "refused", "blank"]);
export type PageStatus = z.infer<typeof PageStatus>;

/** What happened to one page, and the columns the engine found on it. */
export const PageReport = z.strictObject({
  page: z.number().int().min(1),
  status: PageStatus,
  /** The title lines above the table, as printed. Used to spot credit-note and returns pages (CREDIT_OR_RETURN_PAGE). */
  titleLines: z.array(z.string()),
  itemCount: z.number().int().min(0),
  columns: z.array(Column),
  notes: z.array(Note),
});
export type PageReport = z.infer<typeof PageReport>;

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** A total printed on the document. It follows the same evidence rules as a line item. */
export const StatedTotal = z
  .strictObject({
    label: z.enum(["subtotal", "gst", "total", "amount_due"]),
    /**
     * false when we didn't know the label word. We still used the figure as
     * the total, because it matched the sum of the lines, and a note tells the
     * user. In that case `label` is "total".
     */
    labelKnown: z.boolean(),
    page: z.number().int().min(1),
    /** The totals row as rebuilt from the page, for example "Total: $5,122.40". */
    sourceText: z.string().min(1),
    /** The amount. Its header is the label as printed; its span points into this total's `sourceText`. */
    amount: Field,
  })
  .superRefine((total, ctx) => {
    // A printed total is a number read from the page, so it needs a value and
    // evidence, exactly like a line total. A price unit makes no sense on it.
    if (total.amount.value === undefined) {
      ctx.addIssue({ code: "custom", path: ["amount", "value"], message: "a printed total must have a value" });
    }
    if (total.amount.per !== undefined) {
      ctx.addIssue({ code: "custom", path: ["amount", "per"], message: "a printed total has no price unit" });
    }
    checkSpan(total.amount, total.sourceText, ["amount"], ctx);
  });
export type StatedTotal = z.infer<typeof StatedTotal>;

/**
 * One check of the lines against a printed total.
 *
 * `derived` is the only numeric field in the reply that we calculated
 * ourselves. (Refusal messages can also contain calculated numbers, as text
 * marked "(calculated by us)".) Its label must be exactly "calculated by us",
 * because `z.literal` rejects any other text, so it can never be mistaken for a
 * number read from the page.
 *
 * A check that ran ("pass" or "fail") must show the sum it used. A check that
 * didn't run ("not_checked") must say why.
 */
export const TotalsCheck = z
  .strictObject({
    name: z.enum(["lines_vs_total", "lines_vs_subtotal"]),
    outcome: z.enum(["pass", "fail", "not_checked"]),
    /** The pages whose lines were added up for this check. */
    pagesCovered: z.array(z.number().int().min(1)),
    /** Why the check was not done, in plain English. Only for "not_checked". */
    reason: z.string().min(1).optional(),
    /** The sum of the line totals, and the items it came from. Only for "pass" and "fail". */
    derived: z
      .strictObject({
        label: z.literal("calculated by us"),
        value: z.number(),
        fromItemIds: z.array(z.string()),
      })
      .optional(),
  })
  .superRefine((check, ctx) => {
    if (check.outcome === "not_checked") {
      if (!check.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "a check that didn't run must say why" });
      if (check.derived) ctx.addIssue({ code: "custom", path: ["derived"], message: "a check that didn't run has no sum" });
    } else {
      if (!check.derived) ctx.addIssue({ code: "custom", path: ["derived"], message: "a check that ran must show its sum" });
      if (check.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "a check that ran has no reason" });
    }
  });
export type TotalsCheck = z.infer<typeof TotalsCheck>;

// ---------------------------------------------------------------------------
// Number format
// ---------------------------------------------------------------------------

/**
 * How the document writes its numbers, found from the numbers themselves.
 *
 * "1,195.20" (NZ and AU), "1.195,20" (German), "1 195,20" (French) and
 * "1'195.20" (Swiss) are all possible. The engine keeps every format that
 * could have produced all the numbers in the tables, and reads a number only
 * if every one of them gives the same value.
 *
 *   decimal   the decimal mark, or null when the document does not prove it
 *   grouping  the thousands mark, "none", or null when it is not proven.
 *             " " stands for every space-like mark (space, no-break space,
 *             narrow no-break space, thin space).
 *   settled   false when some number could be read two ways and was refused,
 *             or when no format fits all the numbers
 */
export const NumberFormat = z
  .strictObject({
    decimal: z.enum([".", ","]).nullable(),
    grouping: z.enum([",", ".", " ", "'", "none"]).nullable(),
    settled: z.boolean(),
  })
  .refine((format) => format.decimal === null || format.decimal !== format.grouping, {
    message: "the decimal mark and the thousands mark can't be the same character",
    path: ["grouping"],
  });
export type NumberFormat = z.infer<typeof NumberFormat>;

// ---------------------------------------------------------------------------
// The two kinds of reply
// ---------------------------------------------------------------------------

const ParseResultShape = z.strictObject({
  kind: z.literal("result"),
  /** Also sent in the `x-request-id` header, so a user's bug report can be matched to our logs. */
  requestId: z.string().min(1),
  fileName: z.string(),
  pageCount: z.number().int().min(1),
  numberFormat: NumberFormat,
  /** One report per page, in page order. */
  pages: z.array(PageReport),
  /** Ordered by page, then by row from the top. */
  items: z.array(LineItem),
  refusals: z.array(Refusal),
  totals: z.strictObject({
    stated: z.array(StatedTotal),
    /**
     * Whether the line totals include GST (the sales tax in New Zealand and
     * Australia). "inclusive" or "exclusive" only when the document says so in
     * words; otherwise "unstated".
     */
    gstBasis: z.enum(["inclusive", "exclusive", "unstated"]),
    checks: z.array(TotalsCheck),
  }),
});
type ParseResultShape = z.infer<typeof ParseResultShape>;

/**
 * The rules across a whole result. They make sure the page strip, the item
 * list and the refusals can't contradict each other:
 *
 *   - there is one page report per page, numbered 1 to pageCount, in order
 *   - each page's itemCount matches the items listed for that page
 *   - a "refused" or "blank" page lists no items
 *   - items are in order (page, then row) and their ids are unique
 *   - refusal ids are unique, and every page a refusal mentions exists
 */
function parseResultRules(result: ParseResultShape, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const pageExists = (page: number) => page >= 1 && page <= result.pageCount;

  if (result.pages.length !== result.pageCount) {
    issue(["pages"], `expected ${result.pageCount} page reports, got ${result.pages.length}`);
  }
  result.pages.forEach((report, index) => {
    if (report.page !== index + 1) issue(["pages", index, "page"], `page reports must be numbered 1, 2, 3... in order`);
    const listed = result.items.filter((item) => item.page === report.page).length;
    if (report.itemCount !== listed) {
      issue(["pages", index, "itemCount"], `page ${report.page} says ${report.itemCount} items, but ${listed} are listed`);
    }
    if ((report.status === "refused" || report.status === "blank") && listed > 0) {
      issue(["pages", index, "status"], `a ${report.status} page can't list items`);
    }
  });

  const itemIds = new Set<string>();
  result.items.forEach((item, index) => {
    if (!pageExists(item.page)) issue(["items", index, "page"], `page ${item.page} doesn't exist`);
    if (itemIds.has(item.id)) issue(["items", index, "id"], `the item id ${item.id} is repeated`);
    itemIds.add(item.id);
    const previous = result.items[index - 1];
    if (previous && (previous.page > item.page || (previous.page === item.page && previous.rowIndex >= item.rowIndex))) {
      issue(["items", index], "items must be ordered by page, then by row");
    }
  });

  const refusalIds = new Set<string>();
  result.refusals.forEach((refusal, index) => {
    if (refusalIds.has(refusal.id)) issue(["refusals", index, "id"], `the refusal id ${refusal.id} is repeated`);
    refusalIds.add(refusal.id);
    if (refusal.page !== undefined && !pageExists(refusal.page)) {
      issue(["refusals", index, "page"], `page ${refusal.page} doesn't exist`);
    }
    refusal.evidence.forEach((quote, quoteIndex) => {
      if (!pageExists(quote.page)) issue(["refusals", index, "evidence", quoteIndex, "page"], `page ${quote.page} doesn't exist`);
    });
  });
}

/**
 * The reply whenever the file opens, even if every page is refused. HTTP 200.
 * Problems in part of the file are listed in `refusals`, next to the items that
 * were read, so one bad row or page never hides the rest.
 */
export const ParseResult = ParseResultShape.superRefine(parseResultRules);
export type ParseResult = z.infer<typeof ParseResult>;

/**
 * The reply when the whole file is refused (HTTP 4xx) or our own code failed
 * (HTTP 500). It follows RFC 9457 ("problem details") and is sent as
 * `application/problem+json`.
 *
 * `detail` is always a full plain-English sentence, so the page can show the
 * real reason instead of a generic error.
 */
export const Problem = z
  .strictObject({
    kind: z.literal("problem"),
    /** A stable identifier for the kind of problem, for example "/problems/encrypted". */
    type: z.string().min(1),
    /** A short title, for example "Password-protected PDF". */
    title: z.string().min(1),
    /** The HTTP status, repeated in the body as RFC 9457 suggests. */
    status: z.number().int().min(400).max(599),
    /** The sentence shown to the user. */
    detail: z.string().min(1),
    /** INTERNAL means our own code failed, never a problem with the user's file. */
    code: z.union([DocumentCode, z.literal("INTERNAL")]),
    requestId: z.string().min(1),
    /** The same refusal in the usual shape. Present for whole-file refusals, absent for INTERNAL. */
    refusal: Refusal.optional(),
  })
  .superRefine((problem, ctx) => {
    // The web page sorts a Problem by its status first (500 means our bug).
    // So the status, the code and the refusal must all tell the same story.
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (problem.code === "INTERNAL") {
      if (problem.status !== INTERNAL_HTTP_STATUS) issue("status", "INTERNAL must use status 500");
      if (problem.refusal) issue("refusal", "INTERNAL is our failure, not a refusal of the file");
      return;
    }
    const expected = DOCUMENT_HTTP_STATUS[problem.code];
    if (problem.status !== expected) issue("status", `${problem.code} must use status ${expected}`);
    if (!problem.refusal) issue("refusal", "a whole-file refusal must include the refusal");
    else if (problem.refusal.code !== problem.code) issue("refusal", "the refusal's code must match the problem's code");
  });
export type Problem = z.infer<typeof Problem>;

/** Any reply from Part A. The `kind` field tells the two apart. */
export const ParseResponse = z.discriminatedUnion("kind", [ParseResult, Problem]);
export type ParseResponse = z.infer<typeof ParseResponse>;
