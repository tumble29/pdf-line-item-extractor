/**
 * Tests for src/lib/engine/evidence.ts: the evidence gate, the last check
 * before an item is sent.
 *
 * The items here are built by hand, with spans computed by indexOf (so they
 * stay correct if the text changes). Each page's streamText is built the way
 * read-page.ts builds it: the pdf.js pieces in stream order, with every
 * whitespace character removed, joined with nothing between them.
 *
 * First checkField alone, one rule at a time, each with a case that triggers
 * it and a close case that must not. Then evidenceGate over several items.
 * All text is invented.
 */
import { describe, expect, it } from "vitest";

import { Field, LineItem, Refusal, type Role, type Span } from "@/lib/contract/schema";
import { checkField, evidenceGate } from "@/lib/engine/evidence";
import type { Convention } from "@/lib/engine/numbers";

/** Finds `part` inside `text` and returns its [start, end) span. Pass `from` to skip an earlier match. */
function spanOf(text: string, part: string, from = 0): Span {
  const start = text.indexOf(part, from);
  if (start < 0) throw new Error(`"${part}" is not in "${text}"`);
  return [start, start + part.length];
}

/** Builds a page's streamText the way read-page.ts does: pieces in stream order, whitespace removed. */
function streamOf(pieces: string[]): string {
  return pieces.map((piece) => piece.replace(/\s+/gu, "")).join("");
}

/** English numbers: "." decimals, "," thousands. */
const EN: Convention[] = [{ decimal: ".", grouping: "," }];
/** French numbers: "," decimals, space thousands. */
const FR: Convention[] = [{ decimal: ",", grouping: " " }];
/** "." decimals with space thousands: the French values must not read under this. */
const DOT_SPACE: Convention[] = [{ decimal: ".", grouping: " " }];

/** One English row, joined the way rows.ts joins cells: single spaces. */
const ROW = "3 Cedar plank 1.8m 12 ea $4.50 /ea $54.00";

/** The pdf.js pieces of ROW. "Cedar plank" comes as two pieces, and the unit price as two. */
const ROW_PIECES = ["3", "Cedar ", "plank 1.8m", "12", "ea", "$4.50", " /ea", "$54.00"];

/** A correct item for ROW on the given page and row. */
function englishItem(page = 1, rowIndex = 4, sourceText = ROW): LineItem {
  return {
    id: `p${page}-r${rowIndex}`,
    page,
    rowIndex,
    sourceText,
    fields: {
      itemNo: { header: "No", raw: "3", span: spanOf(sourceText, "3") },
      description: { header: "Description", raw: "Cedar plank 1.8m", span: spanOf(sourceText, "Cedar plank 1.8m") },
      quantity: { header: "Qty", raw: "12", value: 12, span: spanOf(sourceText, "12") },
      unit: { header: "Unit", raw: "ea", span: spanOf(sourceText, "ea") },
      unitPrice: {
        header: "Unit Price",
        raw: "$4.50 /ea",
        value: 4.5,
        per: "ea",
        currency: null,
        span: spanOf(sourceText, "$4.50 /ea"),
      },
      lineTotal: { header: "Total", raw: "$54.00", value: 54, currency: null, span: spanOf(sourceText, "$54.00") },
    },
    otherCells: [],
    missing: [],
  };
}

/** A French row. pdf.js reads U+202F and U+00A0 back as normal spaces, so the row has normal spaces. */
const FR_ROW = "Planche de hêtre 2 u 1 195,20 € 2 390,40 €";
const FR_PIECES = ["Planche de hêtre", "2", "u", "1 195,20 €", "2 390,40 €"];

/** A correct French item for FR_ROW. */
function frenchItem(): LineItem {
  return {
    id: "p1-r6",
    page: 1,
    rowIndex: 6,
    sourceText: FR_ROW,
    fields: {
      description: { header: "Désignation", raw: "Planche de hêtre", span: spanOf(FR_ROW, "Planche de hêtre") },
      quantity: { header: "Qté", raw: "2", value: 2, span: spanOf(FR_ROW, "2") },
      unit: { header: "Unité", raw: "u", span: spanOf(FR_ROW, "u", FR_ROW.indexOf(" u ")) },
      unitPrice: {
        header: "Prix unitaire",
        raw: "1 195,20 €",
        value: 1195.2,
        currency: "EUR",
        span: spanOf(FR_ROW, "1 195,20 €"),
      },
      lineTotal: { header: "Montant", raw: "2 390,40 €", value: 2390.4, currency: "EUR", span: spanOf(FR_ROW, "2 390,40 €") },
    },
    otherCells: [],
    missing: [],
  };
}

/** Returns a copy of `field` with some keys changed. */
function changed(field: Field | undefined, change: Partial<Field>): Field {
  if (!field) throw new Error("the fixture item lacks this field");
  return { ...field, ...change };
}

const STREAM = streamOf(ROW_PIECES);
const FR_STREAM = streamOf(FR_PIECES);

describe("the hand-made fixtures", () => {
  it("are valid line items, so every failure below comes from the gate, not from a broken fixture", () => {
    expect(LineItem.safeParse(englishItem()).success).toBe(true);
    expect(LineItem.safeParse(frenchItem()).success).toBe(true);
  });
});

describe("checkField", () => {
  const item = englishItem();
  const { quantity, unitPrice, lineTotal, description } = item.fields;

  it("passes every field of a correct item", () => {
    for (const [role, field] of Object.entries(item.fields)) {
      expect(checkField(role as Role, field!, ROW, STREAM, EN)).toBeNull();
    }
  });

  describe("the span", () => {
    it("fails a field with a value but no span", () => {
      expect(checkField("quantity", changed(quantity, { span: undefined }), ROW, STREAM, EN)).toBe("no-span");
    });

    it("fails a span shifted by one character", () => {
      const [start, end] = quantity!.span!;
      expect(checkField("quantity", changed(quantity, { span: [start + 1, end + 1] }), ROW, STREAM, EN)).toBe(
        "span-mismatch",
      );
      expect(checkField("quantity", changed(quantity, { span: [start - 1, end - 1] }), ROW, STREAM, EN)).toBe(
        "span-mismatch",
      );
    });

    it("fails a span one character too long or too short", () => {
      const [start, end] = lineTotal!.span!;
      expect(checkField("lineTotal", changed(lineTotal, { span: [start - 1, end] }), ROW, STREAM, EN)).toBe(
        "span-mismatch",
      );
      expect(checkField("lineTotal", changed(lineTotal, { span: [start, end - 1] }), ROW, STREAM, EN)).toBe(
        "span-mismatch",
      );
    });

    it("does not check a text field without a value, even with no span", () => {
      expect(checkField("description", changed(description, { span: undefined }), ROW, STREAM, EN)).toBeNull();
      expect(checkField("description", changed(description, { span: [0, 1] }), ROW, STREAM, EN)).toBeNull();
    });
  });

  describe("the words on the page", () => {
    it("fails when a word of the row is missing from the page's streamText", () => {
      const withoutPlank = streamOf(ROW_PIECES.filter((piece) => piece !== "plank 1.8m"));
      expect(checkField("quantity", quantity!, ROW, withoutPlank, EN)).toBe("not-on-page");
    });

    it("fails a field on an empty page text", () => {
      expect(checkField("lineTotal", lineTotal!, ROW, "", EN)).toBe("not-on-page");
    });

    it("passes when pdf.js cut a word into two pieces", () => {
      // "Ced" + "ar plank" joins to "Cedarplank" in streamText, which still holds "Cedar" and "plank".
      const cut = streamOf(["3", "Ced", "ar plank", "1.8m", "12", "ea", "$4.50 /ea", "$54.00"]);
      expect(checkField("quantity", quantity!, ROW, cut, EN)).toBeNull();
    });

    it("passes when the stream order differs from the reading order", () => {
      expect(checkField("quantity", quantity!, ROW, streamOf([...ROW_PIECES].reverse()), EN)).toBeNull();
    });

    it("splits the row on the special spaces and on a line break too", () => {
      const row = "3 Cedar plank\nsanded both sides 12 $4.50 $54.00";
      const field: Field = { header: "Qty", raw: "12", value: 12, span: spanOf(row, "12") };
      expect(checkField("quantity", field, row, streamOf(["3", "Cedar plank", "sanded both sides", "12", "$4.50", "$54.00"]), EN)).toBeNull();

      // A narrow no-break space (U+202F) inside the number and a no-break space (U+00A0) before "€".
      const value = "1 195,20 €";
      const narrow = `Lot ${value}`;
      const price: Field = { header: "Prix", raw: value, value: 1195.2, currency: "EUR", span: spanOf(narrow, value) };
      expect(checkField("unitPrice", price, narrow, streamOf(["Lot", value]), FR)).toBeNull();
    });
  });

  describe("reading the value again", () => {
    it("fails a value changed to 99", () => {
      expect(checkField("quantity", changed(quantity, { value: 99 }), ROW, STREAM, EN)).toBe("value-mismatch");
      expect(checkField("lineTotal", changed(lineTotal, { value: 99 }), ROW, STREAM, EN)).toBe("value-mismatch");
    });

    it("fails a value off by one cent, and passes the exact value", () => {
      expect(checkField("lineTotal", changed(lineTotal, { value: 54.01 }), ROW, STREAM, EN)).toBe("value-mismatch");
      expect(checkField("lineTotal", changed(lineTotal, { value: 54 }), ROW, STREAM, EN)).toBeNull();
    });

    it("fails a value whose raw text has two readings under the conventions", () => {
      const row = "Wire 1.200 kg";
      const field: Field = { header: "Qty", raw: "1.200", value: 1200, span: spanOf(row, "1.200") };
      const both: Convention[] = [
        { decimal: ".", grouping: "," },
        { decimal: ",", grouping: "." },
      ];
      expect(checkField("quantity", field, row, streamOf([row]), both)).toBe("value-mismatch");
      expect(checkField("quantity", field, row, streamOf([row]), [{ decimal: ",", grouping: "." }])).toBeNull();
    });

    it("fails a negative that was read as positive", () => {
      const row = "Refund (12.00)";
      const field: Field = { header: "Total", raw: "(12.00)", value: 12, currency: null, span: spanOf(row, "(12.00)") };
      expect(checkField("lineTotal", field, row, streamOf([row]), EN)).toBe("value-mismatch");
      expect(checkField("lineTotal", { ...field, value: -12 }, row, streamOf([row]), EN)).toBeNull();
    });

    it("fails a per that was changed or left out", () => {
      expect(checkField("unitPrice", changed(unitPrice, { per: "box" }), ROW, STREAM, EN)).toBe("value-mismatch");
      expect(checkField("unitPrice", changed(unitPrice, { per: undefined }), ROW, STREAM, EN)).toBe("value-mismatch");
    });

    it("fails a per added to a unit price that has none", () => {
      const row = "Nails $4.50";
      const field: Field = { header: "Price", raw: "$4.50", value: 4.5, currency: null, span: spanOf(row, "$4.50") };
      expect(checkField("unitPrice", field, row, streamOf([row]), EN)).toBeNull();
      expect(checkField("unitPrice", { ...field, per: "ea" }, row, streamOf([row]), EN)).toBe("value-mismatch");
    });

    it("fails a currency that was changed", () => {
      expect(checkField("lineTotal", changed(lineTotal, { currency: "USD" }), ROW, STREAM, EN)).toBe("value-mismatch");

      const row = "Fence post NZ$ 45.00";
      const field: Field = { header: "Total", raw: "NZ$ 45.00", value: 45, currency: "NZD", span: spanOf(row, "NZ$ 45.00") };
      expect(checkField("lineTotal", field, row, streamOf([row]), EN)).toBeNull();
      expect(checkField("lineTotal", { ...field, currency: "AUD" }, row, streamOf([row]), EN)).toBe("value-mismatch");
      expect(checkField("lineTotal", { ...field, currency: null }, row, streamOf([row]), EN)).toBe("value-mismatch");
    });

    it("treats a left-out currency as none", () => {
      // "$" means no single currency, so leaving currency out is the same as null.
      expect(checkField("lineTotal", changed(lineTotal, { currency: undefined }), ROW, STREAM, EN)).toBeNull();
      // "€" means EUR, so leaving it out is a mismatch.
      const { lineTotal: euros } = frenchItem().fields;
      expect(checkField("lineTotal", changed(euros, { currency: undefined }), FR_ROW, FR_STREAM, FR)).toBe(
        "value-mismatch",
      );
    });

    it("checks the currency of a printed total, but not of a quantity", () => {
      const row = "Total NZ$ 45.00";
      const amount: Field = { header: "Total", raw: "NZ$ 45.00", value: 45, currency: "NZD", span: spanOf(row, "NZ$ 45.00") };
      expect(checkField("statedTotal", amount, row, streamOf([row]), EN)).toBeNull();
      expect(checkField("statedTotal", { ...amount, currency: "AUD" }, row, streamOf([row]), EN)).toBe("value-mismatch");
      // A quantity may not carry a currency (the contract forbids it), so the gate does not compare it.
      expect(checkField("quantity", { ...amount, currency: undefined }, row, streamOf([row]), EN)).toBeNull();
    });

    it('reads "1 195,20 €" under "," decimals and fails it under "." decimals', () => {
      const { unitPrice: price, lineTotal: total } = frenchItem().fields;
      expect(checkField("unitPrice", price!, FR_ROW, FR_STREAM, FR)).toBeNull();
      expect(checkField("lineTotal", total!, FR_ROW, FR_STREAM, FR)).toBeNull();
      expect(checkField("unitPrice", price!, FR_ROW, FR_STREAM, EN)).toBe("value-mismatch");
      expect(checkField("unitPrice", price!, FR_ROW, FR_STREAM, DOT_SPACE)).toBe("value-mismatch");
    });
  });
});

describe("evidenceGate", () => {
  const streams = new Map([
    [1, `${STREAM}${FR_STREAM}`],
    [2, STREAM],
  ]);

  it("keeps every correct item, in order, with no refusals", () => {
    const items = [englishItem(1, 4), englishItem(1, 5), englishItem(2, 3)];
    const gate = evidenceGate(items, streams, () => EN);
    expect(gate.items).toEqual(items);
    expect(gate.refusals).toEqual([]);
  });

  it("replaces a failing item with an EVIDENCE_CHECK_FAILED refusal and keeps the others in order", () => {
    const bad = englishItem(1, 5);
    bad.fields.lineTotal = changed(bad.fields.lineTotal, { value: 99 });
    const before = englishItem(1, 4);
    const after = englishItem(2, 3);

    const gate = evidenceGate([before, bad, after], streams, () => EN);
    expect(gate.items).toEqual([before, after]);
    expect(gate.refusals).toHaveLength(1);

    const [refusal] = gate.refusals;
    expect(Refusal.safeParse(refusal).success).toBe(true);
    expect(refusal).toMatchObject({
      id: "p1-r5-EVIDENCE_CHECK_FAILED",
      code: "EVIDENCE_CHECK_FAILED",
      scope: "row",
      page: 1,
      rowIndex: 5,
      evidence: [{ page: 1, sourceText: ROW }],
    });
    expect(refusal.message).toContain("'$54.00'");
    expect(refusal.message).toContain("page 1");
  });

  it("gives one refusal per failing item, in item order", () => {
    const first = englishItem(1, 4);
    first.fields.quantity = changed(first.fields.quantity, { span: undefined });
    const second = englishItem(2, 3);
    second.fields.unitPrice = changed(second.fields.unitPrice, { per: "box" });

    const gate = evidenceGate([first, englishItem(1, 5), second], streams, () => EN);
    expect(gate.items.map((item) => item.id)).toEqual(["p1-r5"]);
    expect(gate.refusals.map((refusal) => refusal.id)).toEqual([
      "p1-r4-EVIDENCE_CHECK_FAILED",
      "p2-r3-EVIDENCE_CHECK_FAILED",
    ]);
    for (const refusal of gate.refusals) expect(Refusal.safeParse(refusal).success).toBe(true);
  });

  it("fails an item whose page has no streamText", () => {
    const lost = englishItem(3, 2);
    const gate = evidenceGate([englishItem(1, 4), lost], streams, () => EN);
    expect(gate.items.map((item) => item.id)).toEqual(["p1-r4"]);
    expect(gate.refusals).toHaveLength(1);
    expect(Refusal.safeParse(gate.refusals[0]).success).toBe(true);
    expect(gate.refusals[0]).toMatchObject({ id: "p3-r2-EVIDENCE_CHECK_FAILED", page: 3, rowIndex: 2 });
    // No single cell is to blame, so the message says "a value".
    expect(gate.refusals[0].message).toContain("a value");
  });

  it("fails an item whose row is on a different page than cited", () => {
    // The French row is on page 1 only. Cited on page 2, its words are not there.
    const moved = { ...frenchItem(), id: "p2-r6", page: 2 };
    const gate = evidenceGate([moved], streams, () => FR);
    expect(gate.items).toEqual([]);
    expect(gate.refusals.map((refusal) => refusal.id)).toEqual(["p2-r6-EVIDENCE_CHECK_FAILED"]);
  });

  it("keeps a French item under ',' decimals and refuses it under '.' decimals", () => {
    expect(evidenceGate([frenchItem()], streams, () => FR).items).toHaveLength(1);
    const gate = evidenceGate([frenchItem()], streams, () => EN);
    expect(gate.items).toEqual([]);
    expect(gate.refusals[0].message).toContain("'1 195,20 €'");
  });

  it("keeps an item whose only unproved fields are text fields without a value", () => {
    const item = englishItem(1, 4);
    item.fields.description = changed(item.fields.description, { span: undefined });
    item.fields.unit = changed(item.fields.unit, { span: undefined });
    expect(evidenceGate([item], streams, () => EN).items).toEqual([item]);
  });

  it("does not change the items it is given", () => {
    const items = [englishItem(1, 4), englishItem(3, 1)];
    const copy = structuredClone(items);
    evidenceGate(items, streams, () => EN);
    expect(items).toEqual(copy);
  });
});
