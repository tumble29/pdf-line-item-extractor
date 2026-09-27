/**
 * Tests for src/lib/engine/shapes.ts: does a piece of text look like a number?
 *
 * The shape test must work for every way of writing numbers (it doesn't decide
 * the value, only the shape), and it must NOT mistake product codes or
 * descriptions for numbers.
 */
import { describe, expect, it } from "vitest";

import { cellShape, isSeparatorText, looksLikeNumber } from "@/lib/engine/shapes";

describe("cellShape", () => {
  it.each([
    ["48", "plain integer"],
    ["$1,195.20", "NZ/AU money"],
    ["1.195,20 €", "German money"],
    ["1 195,20 €", "French money with narrow and no-break spaces"],
    ["1'195.20", "Swiss grouping"],
    ["1.195.200", "Vietnamese grouping with no decimals"],
    ["NZ$ 45.00", "letters plus a currency symbol"],
    ["A$12.50", "short letters plus a currency symbol"],
    ["NZD 45.00", "a three-letter currency code"],
    ["-12.00", "negative"],
    ["(12.00)", "negative in parentheses"],
    ["15%", "percent"],
  ])("reads %s as a number (%s)", (text) => {
    expect(cellShape(text)).toBe("NUM");
  });

  it.each([
    ["25kg", "weight"],
    ["$68.00 /bag", "price per bag"],
    ["480g total", "weight with a word"],
    ["12.00 CR", "credit marker"],
  ])("reads %s as a number with a short unit (%s)", (text) => {
    expect(cellShape(text)).toBe("NUMX");
  });

  it.each([
    ["ADH-400", "product code with a dash"],
    ["ADH 400", "product code with a space (ADH is not a currency code)"],
    ["10mm GIB Standard board 2400x1200", "description starting with a number"],
    ["Stud adhesive 400ml cartridge", "description containing a number"],
    ["Total:", "label"],
    ["", "empty"],
    ["Qty", "header word"],
  ])("reads %s as text (%s)", (text) => {
    expect(cellShape(text)).toBe("TEXT");
  });

  it("accepts a real currency code but not any three capital letters", () => {
    expect(cellShape("EUR 400")).toBe("NUM");
    expect(cellShape("400 NZD")).toBe("NUM");
    expect(cellShape("ABC 400")).toBe("TEXT");
  });

  it("ignores surrounding spaces", () => {
    expect(cellShape("  $16.00  ")).toBe("NUM");
  });

  it("treats a number with a long tail as text, so a description is never read as a number", () => {
    expect(cellShape("400ml cartridge refill pack")).toBe("TEXT");
    expect(looksLikeNumber("400ml cartridge refill pack")).toBe(false);
    expect(looksLikeNumber("25kg")).toBe(true);
  });
});

describe("isSeparatorText", () => {
  it("recognises dashed and double lines", () => {
    expect(isSeparatorText("-".repeat(40))).toBe(true);
    expect(isSeparatorText("=====")).toBe(true);
  });

  it("does not treat currency symbols or short marks as separators", () => {
    expect(isSeparatorText("$$$")).toBe(false);
    expect(isSeparatorText("--")).toBe(false);
    expect(isSeparatorText("- note -")).toBe(false);
  });
});
