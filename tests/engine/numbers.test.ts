/**
 * Tests for src/lib/engine/numbers.ts: reading numbers in the page's own format.
 *
 * The tests follow the pipeline: split one cell (analyseNumber), find the
 * conventions a page allows (conventionsFor), read a cell under them
 * (readNumber), report the format the pages share (sharedConventions and
 * numberFormatOf), and write a number we calculated (formatNumber). Every rule has a case that triggers it and a
 * close case that must not. All text is invented.
 */
import { describe, expect, it } from "vitest";

import {
  CONVENTIONS,
  analyseNumber,
  conventionsFor,
  currencyCode,
  formatNumber,
  hasValidCore,
  isNumericColumn,
  numberFormatOf,
  readNumber,
  sharedConventions,
  validConventions,
  type Convention,
} from "@/lib/engine/numbers";

/** Reads one cell under the conventions of a page made of the given numeric cells. */
function readIn(cell: string, pageCells: string[], joinSpaces: number[] = []) {
  const conventions = conventionsFor([pageCells.map((text) => analyseNumber(text))]);
  return readNumber(analyseNumber(cell, joinSpaces), conventions);
}

/** Reads one cell on its own: the page is just that cell. */
function readAlone(cell: string, joinSpaces: number[] = []) {
  const parts = analyseNumber(cell, joinSpaces);
  return readNumber(parts, conventionsFor([[parts]]));
}

const EN: Convention[] = [{ decimal: ".", grouping: "," }];
const FR: Convention[] = [{ decimal: ",", grouping: " " }];

describe("analyseNumber", () => {
  it("splits a dollar amount into marker and core", () => {
    const parts = analyseNumber("$1,234.50");
    expect(parts).toMatchObject({ core: "1,234.50", currencyMarker: "$", negative: false, percent: false, per: null });
  });

  it("accepts letters plus a symbol before the number", () => {
    expect(analyseNumber("NZ$ 45.00")).toMatchObject({ core: "45.00", currencyMarker: "NZ$" });
    expect(analyseNumber("A$12.50")).toMatchObject({ core: "12.50", currencyMarker: "A$" });
  });

  it("accepts a real three-letter currency code before or after, but not any three letters", () => {
    expect(analyseNumber("NZD 45.00")).toMatchObject({ core: "45.00", currencyMarker: "NZD" });
    expect(analyseNumber("45.00 EUR")).toMatchObject({ core: "45.00", currencyMarker: "EUR" });
    expect(analyseNumber("QZX 45.00").core).toBeNull();
    expect(analyseNumber("45.00 QZX").core).toBeNull();
  });

  it("accepts a symbol after the number", () => {
    expect(analyseNumber("1.195,20 €")).toMatchObject({ core: "1.195,20", currencyMarker: "€" });
  });

  it.each([
    ["-12.00", "a leading minus"],
    ["−12.00", "a leading minus sign character"],
    ["(12.00)", "parentheses"],
    ["12.00 CR", "a trailing CR"],
    ["$12.00 CR", "a currency and a trailing CR"],
    ["12.00 € CR", "a currency after the number and then CR"],
    ["$-12.00", "a minus after the currency"],
  ])("marks %s as negative (%s)", (text) => {
    const parts = analyseNumber(text);
    expect(parts.negative).toBe(true);
    expect(parts.core).toBe("12.00");
  });

  it("does not mark a plain amount as negative", () => {
    expect(analyseNumber("12.00").negative).toBe(false);
    expect(analyseNumber("$12.00").negative).toBe(false);
  });

  it("refuses two negative marks, because the meaning is unclear", () => {
    expect(analyseNumber("(-12.00)").core).toBeNull();
    expect(analyseNumber("-12.00 CR").core).toBeNull();
  });

  it("reads a percent sign", () => {
    expect(analyseNumber("15%")).toMatchObject({ core: "15", percent: true });
    expect(analyseNumber("15").percent).toBe(false);
  });

  it("keeps a /unit suffix as `per`", () => {
    expect(analyseNumber("$12.50 /box")).toMatchObject({ core: "12.50", currencyMarker: "$", per: "box" });
    expect(analyseNumber("$0.15 /ea")).toMatchObject({ core: "0.15", per: "ea" });
    expect(analyseNumber("$0.15/ea")).toMatchObject({ core: "0.15", per: "ea" });
  });

  it.each([
    ["1,2.50"],
    ["12.5.0"],
    ["12a"],
    ["10 widgets"],
    ["$12.50 box"],
    ["1�2"],
    [""],
    ["   "],
    ["1,,000"],
    ["Plank"],
  ])("gives %j no usable core (null or valid under no convention)", (text) => {
    const parts = analyseNumber(text);
    const usable = parts.core !== null && validConventions(parts.core, parts.spaceAtJoin).length > 0;
    expect(usable).toBe(false);
  });

  it("keeps the core exactly as printed, special spaces included", () => {
    expect(analyseNumber("1 195,20 €").core).toBe("1 195,20");
  });

  it("sets spaceAtJoin only when a join space sits between the digits", () => {
    // "1" and "195,20" were two pieces; we put the space at offset 1.
    expect(analyseNumber("1 195,20", [1]).spaceAtJoin).toBe(true);
    // One piece: no join spaces.
    expect(analyseNumber("1 195,20").spaceAtJoin).toBe(false);
    // The join is between the marker and the number, outside the digits.
    expect(analyseNumber("$ 12.50", [1]).spaceAtJoin).toBe(false);
    // The join is before the unit, after the last digit.
    expect(analyseNumber("12.50 /box", [5]).spaceAtJoin).toBe(false);
  });
});

describe("validConventions", () => {
  it("allows only the '.' decimal conventions for a core like 16.00", () => {
    expect(validConventions("16.00").map((c) => c.decimal)).toEqual([".", ".", ".", "."]);
  });

  it("allows both readings for 1.200", () => {
    const valid = validConventions("1.200");
    expect(valid).toContainEqual({ decimal: ".", grouping: "," });
    expect(valid).toContainEqual({ decimal: ",", grouping: "." });
  });

  it("needs groups of exactly three digits and no leading zero", () => {
    expect(validConventions("1,195")).toContainEqual({ decimal: ".", grouping: "," });
    expect(validConventions("1,95")).not.toContainEqual({ decimal: ".", grouping: "," });
    expect(validConventions("01,195")).not.toContainEqual({ decimal: ".", grouping: "," });
  });

  it("treats U+00A0, U+202F and U+2009 as the space grouping", () => {
    for (const space of [" ", " ", " ", " "]) {
      expect(validConventions(`1${space}195,20`)).toEqual([{ decimal: ",", grouping: " " }]);
    }
  });

  it("drops the space conventions when the space is at a join", () => {
    expect(validConventions("1 195,20", true)).toEqual([]);
    expect(validConventions("1 195.20", true)).toEqual([]);
  });
});

describe("readNumber", () => {
  it.each([
    ["$1,234.50", 1234.5, 2, true],
    ["NZ$ 45.00", 45, 2, false],
    ["$5", 5, 0, false],
    ["-12.00", -12, 2, false],
    ["(12.00)", -12, 2, false],
    ["12.00 CR", -12, 2, false],
  ])("reads %s as %d", (text, value, dp, grouped) => {
    expect(readAlone(text)).toEqual({ status: "ok", value, dp, grouped });
  });

  it("reads a unit price with a /unit suffix", () => {
    expect(readAlone("$12.50 /box")).toMatchObject({ status: "ok", value: 12.5 });
    expect(readAlone("$0.15 /ea")).toMatchObject({ status: "ok", value: 0.15 });
  });

  it("gives text for a cell with no core", () => {
    expect(readAlone("")).toEqual({ status: "text" });
    expect(readAlone("10 widgets")).toEqual({ status: "text" });
    expect(readAlone("$12.50 box")).toEqual({ status: "text" });
    expect(readAlone("1�2")).toEqual({ status: "text" });
  });

  it("gives unreadable for a core that no convention reads", () => {
    expect(readAlone("1,2.50")).toEqual({ status: "unreadable" });
    expect(readAlone("12.5.0")).toEqual({ status: "unreadable" });
  });

  it("gives ambiguous for 1.200 alone, with both values", () => {
    const reading = readAlone("1.200");
    expect(reading.status).toBe("ambiguous");
    if (reading.status === "ambiguous") expect([...reading.values].sort((a, b) => a - b)).toEqual([1.2, 1200]);
  });

  it("reads 1.200 as 1200 when the document has 1.195,20 (',' decimals)", () => {
    expect(readIn("1.200", ["1.195,20", "1.200"])).toMatchObject({ status: "ok", value: 1200 });
  });

  it("reads 1.200 as 1.2 when the document has $16.00 ('.' decimals)", () => {
    expect(readIn("1.200", ["$16.00", "1.200"])).toMatchObject({ status: "ok", value: 1.2 });
  });

  it("reads 1.195,20 € in a document that proves ',' decimals, with currency EUR", () => {
    const parts = analyseNumber("1.195,20 €");
    expect(readIn("1.195,20 €", ["1.195,20 €", "12,50 €"])).toMatchObject({ status: "ok", value: 1195.2 });
    expect(currencyCode(parts.currencyMarker)).toBe("EUR");
  });

  it("reads Vietnamese-style 1.195.200 as 1195200", () => {
    expect(readAlone("1.195.200")).toMatchObject({ status: "ok", value: 1195200, grouped: true });
  });

  it("reads space grouping inside one piece, but not across two pieces", () => {
    expect(readAlone("1 195,20")).toMatchObject({ status: "ok", value: 1195.2 });
    expect(readAlone("1 195,20 €")).toMatchObject({ status: "ok", value: 1195.2 });
    // The same characters, drawn as "1" and "195,20".
    expect(readAlone("1 195,20", [1])).toEqual({ status: "unreadable" });
    expect(readNumber(analyseNumber("1 195,20", [1]), CONVENTIONS)).toEqual({ status: "unreadable" });
  });

  it("never gives -0", () => {
    const reading = readAlone("(0.00)");
    expect(reading).toMatchObject({ status: "ok" });
    if (reading.status === "ok") expect(Object.is(reading.value, -0)).toBe(false);
  });
});

describe("isNumericColumn", () => {
  const column = (...texts: string[]) => texts.map((text) => analyseNumber(text));

  it("is numeric when at least 60% of the non-empty cells are numbers", () => {
    // 3 of 5 = 60%; the empty cell is not counted.
    expect(isNumericColumn(column("12", "4.50", "$8", "tba", "n/a", ""))).toBe(true);
  });

  it("is not numeric just under 60%", () => {
    // 2 of 4 = 50%.
    expect(isNumericColumn(column("12", "4.50", "tba", "n/a"))).toBe(false);
  });

  it("is not numeric when every cell is empty", () => {
    expect(isNumericColumn(column("", " "))).toBe(false);
  });

  it("does not count a core that no convention reads", () => {
    expect(isNumericColumn(column("1,2.50", "12.5.0", "7"))).toBe(false);
  });
});

/** The cells of one column, split. */
function cells(...texts: string[]) {
  return texts.map((text) => analyseNumber(text));
}

describe("conventionsFor", () => {
  it("keeps every convention when there are no numeric cells", () => {
    expect(conventionsFor([])).toEqual([...CONVENTIONS]);
    expect(conventionsFor([cells("tba")])).toEqual([...CONVENTIONS]);
  });

  it("is not shrunk by a cell that fits no convention", () => {
    expect(conventionsFor([cells("$16.00", "1,2.50")])).toEqual(conventionsFor([cells("$16.00")]));
  });

  it("keeps the conventions every cell allows, across columns", () => {
    const set = conventionsFor([cells("1.200"), cells("3,50")]);
    expect(set).toEqual([{ decimal: ",", grouping: "." }]);
  });

  it("lets the most cells win when one cell is written differently, in any order", () => {
    const usual = ["1,250.00", "$186.00", "$2,049.50", "15.50"];
    const expected: Convention[] = [{ decimal: ".", grouping: "," }];
    expect(conventionsFor([cells("1,5", ...usual)])).toEqual(expected);
    expect(conventionsFor([cells(...usual, "1,5")])).toEqual(expected);
    // The odd cell is then unreadable, and it is still a number in some format.
    const odd = analyseNumber("1,5");
    expect(readNumber(odd, expected)).toEqual({ status: "unreadable" });
    expect(hasValidCore(odd)).toBe(true);
  });

  it("keeps both formats on a tie, which reads the unmistakable cells and refuses the rest", () => {
    const set = conventionsFor([cells("1,234.50", "1.234,50")]);
    expect(set).toEqual([
      { decimal: ".", grouping: "," },
      { decimal: ",", grouping: "." },
    ]);
    expect(readNumber(analyseNumber("1,234.50"), set)).toMatchObject({ status: "ok", value: 1234.5 });
    expect(readNumber(analyseNumber("1.234,50"), set)).toMatchObject({ status: "ok", value: 1234.5 });
    expect(readNumber(analyseNumber("1.200"), set)).toEqual({ status: "ambiguous", values: [1.2, 1200] });
  });
});

describe("sharedConventions", () => {
  it("keeps what every page allows", () => {
    const newZealand = conventionsFor([cells("$1,250.00")]);
    const integersOnly = conventionsFor([cells("12", "8")]);
    expect(sharedConventions([newZealand, integersOnly])).toEqual(newZealand);
  });

  it("is empty when two pages use different formats", () => {
    const newZealand = conventionsFor([cells("$1,250.00")]);
    const german = conventionsFor([cells("1.250,00 €")]);
    expect(sharedConventions([newZealand, german])).toEqual([]);
    expect(numberFormatOf([], false)).toEqual({ decimal: null, grouping: null, settled: false });
  });
});

describe("numberFormatOf", () => {
  const formatOf = (...cells: string[]) =>
    numberFormatOf(conventionsFor([cells.map((text) => analyseNumber(text))]), false);

  it("reports '.' decimals and ',' grouping for NZ money with thousands", () => {
    expect(formatOf("$1,234.50", "$16.00")).toEqual({ decimal: ".", grouping: ",", settled: true });
  });

  it("reports '.' decimals and no known grouping when no value reaches 1000", () => {
    expect(formatOf("$16.00", "$160.00")).toEqual({ decimal: ".", grouping: null, settled: true });
  });

  it("reports ',' decimals and grouping null when values stay under 1000", () => {
    expect(formatOf("12,50", "3,00")).toEqual({ decimal: ",", grouping: null, settled: true });
  });

  it("reports the French format", () => {
    expect(formatOf("1 195,20 €", "12,50 €")).toEqual({ decimal: ",", grouping: " ", settled: true });
  });

  it("reports grouping 'none' when that is the only one left", () => {
    expect(numberFormatOf([{ decimal: ".", grouping: "" }], false)).toEqual({
      decimal: ".",
      grouping: "none",
      settled: true,
    });
  });

  it("is not settled when a cell had two readings", () => {
    expect(numberFormatOf([...CONVENTIONS], true)).toEqual({ decimal: null, grouping: null, settled: false });
  });

  it("is settled but unknown when nothing proves the format", () => {
    expect(numberFormatOf([...CONVENTIONS], false)).toEqual({ decimal: null, grouping: null, settled: true });
  });

  it("is not settled when the pages share no convention", () => {
    const pages = [conventionsFor([cells("1,234.50")]), conventionsFor([cells("1.234,50")])];
    expect(numberFormatOf(sharedConventions(pages), false)).toEqual({ decimal: null, grouping: null, settled: false });
  });

  it("names no marks for a page that mixes two formats equally, since neither mark is shared", () => {
    expect(formatOf("1,234.50", "1.234,50")).toEqual({ decimal: null, grouping: null, settled: true });
  });
});

describe("currencyCode", () => {
  it.each([
    ["NZD", "NZD"],
    ["EUR", "EUR"],
    ["NZ$", "NZD"],
    ["A$", "AUD"],
    ["AU$", "AUD"],
    ["US$", "USD"],
    ["€", "EUR"],
    ["£", "GBP"],
    ["₫", "VND"],
  ])("maps %s to %s", (marker, code) => {
    expect(currencyCode(marker)).toBe(code);
  });

  it.each([["$"], ["¥"], ["C$"], ["QZX"], ["XY$"]])("gives no code for %s, which is shared or unknown", (marker) => {
    expect(currencyCode(marker)).toBeNull();
  });

  it("gives no code for no marker", () => {
    expect(currencyCode(null)).toBeNull();
    expect(currencyCode(analyseNumber("$5").currencyMarker)).toBeNull();
    expect(currencyCode(analyseNumber("NZ$ 45.00").currencyMarker)).toBe("NZD");
  });
});

describe("formatNumber", () => {
  it("writes NZ style with the marker first", () => {
    expect(formatNumber(1538.2, 2, EN, "$")).toBe("$1,538.20");
  });

  it("writes French style with the marker after", () => {
    expect(formatNumber(1538.2, 2, FR, "€", true)).toBe("1 538,20 €");
  });

  it("uses '.' and no grouping when the format is unknown", () => {
    expect(formatNumber(1538.2, 2, CONVENTIONS, null)).toBe("1538.20");
  });

  it("rounds to dp, including values stored just below the half", () => {
    expect(formatNumber(1.005, 2, EN, null)).toBe("1.01");
    expect(formatNumber(2.5, 0, EN, null)).toBe("3");
    // A value JavaScript writes with an exponent (1e-7) still works.
    expect(formatNumber(0.0000001, 2, EN, null)).toBe("0.00");
  });

  it("puts a space after a letters-only marker, but not after a symbol", () => {
    expect(formatNumber(45, 2, EN, "NZD")).toBe("NZD 45.00");
    expect(formatNumber(45, 2, EN, "NZ$")).toBe("NZ$45.00");
  });

  it("writes large numbers with every group", () => {
    expect(formatNumber(1234567.891, 2, EN, null)).toBe("1,234,567.89");
    expect(formatNumber(999, 0, EN, null)).toBe("999");
  });

  it("writes a minus for a negative value, but not for one that rounds to zero", () => {
    expect(formatNumber(-12, 2, EN, "$")).toBe("-$12.00");
    expect(formatNumber(-0.001, 2, EN, null)).toBe("0.00");
  });
});
