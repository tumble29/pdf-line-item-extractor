/**
 * Tests for src/lib/engine/vocabulary.ts: the word lists and the two matching
 * helpers.
 *
 * `findWord` is used for page titles, totals labels and carried-forward
 * lines; `headerOpinion` gives the header words' opinion on a column's role.
 * The vocabulary is English only, so every case here is English. All text is
 * invented.
 */
import { describe, expect, it } from "vitest";

import {
  CARRIED_FORWARD,
  CREDIT_WORDS,
  findWord,
  hasDescriptionHeader,
  headerOpinion,
  normaliseForMatching,
  SUMMARY_WORDS,
  TOTAL_LABELS,
} from "@/lib/engine/vocabulary";

describe("normaliseForMatching", () => {
  it("lowercases, drops a trailing '.' or ':', and collapses spaces", () => {
    expect(normaliseForMatching("QTY.")).toBe("qty");
    expect(normaliseForMatching("Unit   Price:")).toBe("unit price");
    expect(normaliseForMatching("  Line Total  ")).toBe("line total");
  });

  it("keeps a '.' or ':' that is not at the end", () => {
    expect(normaliseForMatching("No. of Bags")).toBe("no. of bags");
  });
});

describe("findWord", () => {
  it("ignores case", () => {
    expect(findWord("CREDIT NOTE", CREDIT_WORDS)).toBe("credit");
    expect(findWord("credit note", CREDIT_WORDS)).toBe("credit");
  });

  it("lets an English word match with a trailing 's'", () => {
    expect(findWord("Stock Returns", [{ lang: "en", words: ["return"] }])).toBe("return");
    expect(findWord("Refunds Issued", CREDIT_WORDS)).toBe("refund");
  });

  it("does not add the plural 's' for other language tags", () => {
    expect(findWord("Stock Returns", [{ lang: "xx", words: ["return"] }])).toBeNull();
    expect(findWord("Stock Return", [{ lang: "xx", words: ["return"] }])).toBe("return");
  });

  it("matches whole words only", () => {
    expect(findWord("Creditor Supplies Ltd", CREDIT_WORDS)).toBeNull();
    expect(findWord("Accredited Installer", CREDIT_WORDS)).toBeNull();
    expect(findWord("Returnable Crates", CREDIT_WORDS)).toBeNull();
    expect(findWord("Summarylink Freight", SUMMARY_WORDS)).toBeNull();
  });

  it("treats letters from other scripts as part of a word", () => {
    expect(findWord("écredit", CREDIT_WORDS)).toBeNull();
    expect(findWord("credité", CREDIT_WORDS)).toBeNull();
  });

  it("treats punctuation as a word boundary", () => {
    expect(findWord("(Credit)", CREDIT_WORDS)).toBe("credit");
    expect(findWord("Credit-Note 44", CREDIT_WORDS)).toBe("credit");
  });

  it("matches a phrase with a slash", () => {
    expect(findWord("Balance b/f", CARRIED_FORWARD)).toBe("b/f");
    expect(findWord("Balance bf", CARRIED_FORWARD)).toBeNull();
  });

  it("tries the longest phrase first", () => {
    const subtotalOrTotal = [...TOTAL_LABELS.subtotal, ...TOTAL_LABELS.total];
    expect(findWord("Total ex GST", subtotalOrTotal)).toBe("total ex gst");
    expect(findWord("Total inc GST", subtotalOrTotal)).toBe("total inc gst");
    expect(findWord("Total", subtotalOrTotal)).toBe("total");
  });

  it("returns null when nothing matches", () => {
    expect(findWord("Delivery Docket", CREDIT_WORDS)).toBeNull();
    expect(findWord("", CREDIT_WORDS)).toBeNull();
  });
});

describe("headerOpinion", () => {
  it.each([
    ["Unit Price", "unitPrice", "a phrase beats 'unit' and 'price'"],
    ["Line Total", "lineTotal", "a phrase beats 'line' and 'total'"],
    ["Product Code", "code", "a phrase beats 'product'"],
    ["Part No.", "code", "a phrase beats 'no'"],
    ["QTY.", "quantity", "upper case with a trailing dot"],
    ["Quantity", "quantity", "the long form"],
    ["Each", "unitPrice", "'each' is a price each"],
    ["Unit Cost", "unitPrice", "a phrase beats 'unit'"],
    ["Price Each", "unitPrice", "both words are price words"],
    ["Amount", "lineTotal", "'amount' is a line total"],
    ["Rate", "unitPrice", "'rate' is a unit price"],
    ["Description", "description", "the plain word"],
    ["Product", "description", "'product' on its own"],
    ["#", "itemNo", "a symbol word"],
  ])("reads %s as %s (%s)", (header, role) => {
    expect(headerOpinion(header, false)).toEqual({ role });
  });

  it("reads 'Item' as the line number beside a description header", () => {
    expect(headerOpinion("Item", true)).toEqual({ role: "itemNo" });
  });

  it("reads 'Item' as the description when there is no description header", () => {
    expect(headerOpinion("Item", false)).toEqual({ role: "description" });
  });

  it("gives no opinion and a tie for two roles that are not part of each other", () => {
    expect(headerOpinion("Qty Unit", false)).toEqual({ role: null, tie: true });
  });

  it("gives no opinion and no tie for a header it doesn't know", () => {
    expect(headerOpinion("Weight", false)).toEqual({ role: null, tie: false });
    expect(headerOpinion("Disc %", false)).toEqual({ role: null, tie: false });
  });

  it("matches header words as whole words only", () => {
    // "units" is the plural of "unit"; "unitary" and "codex" are other words.
    expect(headerOpinion("Units", false)).toEqual({ role: "unit" });
    expect(headerOpinion("Unitary", false)).toEqual({ role: null, tie: false });
    expect(headerOpinion("Codex", false)).toEqual({ role: null, tie: false });
  });
});

describe("review fixes", () => {
  it("reads 'Items' alone as the description, like 'Item'", () => {
    expect(headerOpinion("Items", false)).toEqual({ role: "description" });
    expect(headerOpinion("Items", true)).toEqual({ role: "itemNo" });
  });

  it("drops a trailing ':' even when a space follows it", () => {
    expect(normaliseForMatching("Unit Price: ")).toBe("unit price");
    expect(headerOpinion("Item: ", false)).toEqual({ role: "description" });
  });
});

describe("hasDescriptionHeader", () => {
  it("is true when one header is description-like", () => {
    expect(hasDescriptionHeader(["Item", "Description", "Qty"])).toBe(true);
    expect(hasDescriptionHeader(["Line", "Details", "Qty"])).toBe(true);
    expect(hasDescriptionHeader([null, "Particulars", null])).toBe(true);
  });

  it("is false when no header is description-like", () => {
    expect(hasDescriptionHeader(["Item", "Qty", "Unit Price"])).toBe(false);
    expect(hasDescriptionHeader([null, null])).toBe(false);
    expect(hasDescriptionHeader([])).toBe(false);
  });

  it("does not count 'Product Code' as a description, so 'Item' beside it stays the description", () => {
    // Found in review: a plain word search saw 'product' inside 'Product Code'.
    expect(hasDescriptionHeader(["Item", "Product Code", "Qty"])).toBe(false);
    expect(headerOpinion("Item", hasDescriptionHeader(["Item", "Product Code", "Qty"]))).toEqual({ role: "description" });
  });

  it("never counts 'Item' itself as the description header", () => {
    expect(hasDescriptionHeader(["Item", "Qty"])).toBe(false);
  });
});
