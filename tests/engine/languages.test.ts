/**
 * The engine on pages in other languages: French, German and Vietnamese.
 *
 * The engine finds tables by layout and column meanings by their numbers, so
 * a page is never refused for its language. What these tests prove, on the
 * language fixtures (tests/fixtures/languages.ts):
 *   - every row is read as an item, with its values in its own number format
 *   - the currency is known only when the page writes it ("€" is EUR)
 *   - the columns get their roles from the numbers (roleSource "numbers"),
 *     because the English vocabulary doesn't know these headings, and each page
 *     gets the warning that the English-only word checks may not work on it
 *   - the printed total is checked: French "Total" is a known label; German
 *     "Summe" and Vietnamese "Tổng cộng" are not, so they are used only
 *     because they equal the lines, with a note
 * All fixture text is invented.
 */
import { describe, expect, it } from "vitest";

import { NOTES } from "@/lib/contract/notes";
import { ParseResult, type Role } from "@/lib/contract/schema";
import { parsePdf } from "@/lib/engine";

import { LANGUAGE_FIXTURES, asReadBack } from "../fixtures/languages";

/** Reads a fixture through the whole engine, and checks the result against the contract. */
async function readFixture(name: "french" | "german" | "vietnamese") {
  const outcome = await parsePdf(await LANGUAGE_FIXTURES[name].build());
  if (outcome.kind !== "read") throw new Error(`the ${name} fixture was refused: ${outcome.refusal.code}`);
  const parsed = ParseResult.safeParse({ kind: "result", requestId: "test", fileName: "test.pdf", ...outcome.result });
  expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues[0])).toBe("ok");
  return outcome.result;
}

/**
 * A printed amount read the simplest way, knowing the fixture's format: drop
 * every character that is not a digit or the decimal mark, then use "." as
 * the decimal mark. It shares no code with numbers.ts.
 */
function plainValue(text: string, decimal: "." | ","): number {
  const kept = [...text].filter((character) => /\d/.test(character) || character === decimal).join("");
  return Number(kept.replace(",", "."));
}

describe.each([
  { name: "french" as const, decimal: "," as const, currency: "EUR", totalKnown: true },
  { name: "german" as const, decimal: "," as const, currency: "EUR", totalKnown: false },
  { name: "vietnamese" as const, decimal: "," as const, currency: null, totalKnown: false },
])("the $name fixture", ({ name, decimal, currency, totalKnown }) => {
  const fixture = LANGUAGE_FIXTURES[name];

  it("reads every row as an item, with its values in its own format, and refuses nothing", async () => {
    const result = await readFixture(name);
    expect(result.refusals).toEqual([]);
    expect(result.pages.map((page) => page.status)).toEqual(["extracted"]);
    expect(result.items).toHaveLength(fixture.rowCount);
    result.items.forEach((item, row) => {
      const printed = fixture.rows[row].map(asReadBack);
      expect(item.fields.lineTotal?.raw).toBe(printed[5]);
      expect(item.fields.lineTotal?.value).toBe(plainValue(printed[5], decimal));
      expect(item.fields.lineTotal?.currency).toBe(currency);
    });
  });

  it("gets its roles from the numbers, and warns that the English word checks may not work", async () => {
    const result = await readFixture(name);
    const [page] = result.pages;
    for (const column of page.columns) {
      if (column.role !== null) expect(column.roleSource).toBe("numbers");
    }
    expect(page.notes).toContainEqual(NOTES.unknownHeadings(1));
  });

  it("checks its printed total", async () => {
    const result = await readFixture(name);
    expect(result.totals.checks).toMatchObject([{ name: "lines_vs_total", outcome: "pass" }]);
    expect(result.totals.stated).toMatchObject([{ label: "total", labelKnown: totalKnown }]);
    const noted = result.pages[0].notes.some((note) => note.text.includes("we don't recognise its label"));
    expect(noted).toBe(!totalKnown);
  });
});

describe("the columns each language fixture reads", () => {
  const rolesOf = async (name: "french" | "german" | "vietnamese"): Promise<(Role | null)[]> =>
    (await readFixture(name)).pages[0].columns.map((column) => column.role);

  it("French and German: every column, because the prices and totals carry the same currency", async () => {
    const all: Role[] = ["itemNo", "description", "quantity", "unit", "unitPrice", "lineTotal"];
    expect(await rolesOf("french")).toEqual(all);
    expect(await rolesOf("german")).toEqual(all);
  });

  it("Vietnamese: no quantity or unit price, because nothing shows which factor is the price", async () => {
    // STT, Mô tả, SL, ĐVT, Đơn giá, Thành tiền. The amounts have no currency
    // marker and no thousands grouping tells the factors apart, so SL and
    // Đơn giá are shown as printed.
    expect(await rolesOf("vietnamese")).toEqual(["itemNo", "description", null, "unit", null, "lineTotal"]);
    const result = await readFixture("vietnamese");
    expect(result.items[0].otherCells.map((cell) => cell.header)).toEqual(["SL", "Đơn giá"]);
  });
});
