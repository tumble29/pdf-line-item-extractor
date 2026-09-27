/**
 * Tests for the fixtures themselves (build.ts and languages.ts).
 *
 * Engine tests trust that a fixture draws what its name says. These tests
 * check that: each new builder is opened with openDocument and read with
 * readPage, the same way the engine reads an upload, and the intended text
 * (headers, some cells, titles) must be there, on the right number of pages.
 * They also check the fixture data itself: every row multiplies correctly
 * unless the fixture is about a mismatch.
 *
 * They don't test any engine rule: rows, tables and roles have their own tests.
 */
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { openDocument } from "@/lib/engine/open";
import { readPage, type RawPage } from "@/lib/engine/read-page";

import {
  DEFAULT_COLUMNS,
  DOCKET_COLUMNS,
  DOCKET_ROWS,
  MISMATCH_ROW_INDEX,
  MULTI_PAGE,
  NUMBERS_ONLY_ROW,
  SHIFTED_AFTER_LINE,
  SHIFTED_COLUMNS,
  SHIFTED_ROWS,
  STAMP_ANGLE,
  TITLED_PAGE_TITLES,
  TITLED_PAGES_LABEL_LINE,
  UNPARSEABLE_PRICE,
  docket,
  mismatchRow,
  multiPage,
  numbersOnlyRow,
  rotatedStamp,
  shiftedColumns,
  titledPages,
  unparseableCell,
} from "./build";
import { FORMATS, LANGUAGE_FIXTURES, NO_TABLE_KEY_VALUES, asReadBack, french, type FormatName } from "./languages";

/** Opens a fixture and reads every page, as the engine does. */
async function readAll(bytes: Uint8Array): Promise<RawPage[]> {
  const opened = await openDocument(bytes);
  if (!opened.ok) throw new Error(`fixture did not open: ${opened.refusal.code}`);
  try {
    const pages: RawPage[] = [];
    for (let n = 1; n <= opened.doc.numPages; n++) pages.push(await readPage(opened.doc, opened.pdfjs, n));
    return pages;
  } finally {
    await opened.doc.loadingTask.destroy();
  }
}

/** The texts of a page's pieces, in stream order. */
function texts(page: RawPage): string[] {
  return page.pieces.map((piece) => piece.str);
}

/** Asserts that each text appears on the page as one whole piece. */
function expectPieces(page: RawPage, wanted: readonly string[]): void {
  const found = texts(page);
  for (const text of wanted) if (text !== "") expect(found, `"${text}" on page ${page.page}`).toContain(text);
}

/** Reads an amount written in one of the fixture formats back into integer minor units. */
function minorUnits(text: string, format: FormatName): number {
  const cleaned = {
    en: () => text.replace(/[$,]/g, ""),
    fr: () => text.replace(/[\s  €]/gu, "").replace(",", "."),
    de: () => text.replace(/[.\s €]/gu, "").replace(",", "."),
    vi: () => text.replace(/\./g, ""),
  }[format]();
  // Dong has no minor unit, so its amounts are counted in whole dong.
  return Math.round(Number(cleaned) * (format === "vi" ? 1 : 100));
}

describe("the Unicode font", () => {
  it("draws Vietnamese letters that pdf.js reads back exactly", async () => {
    const [page] = await readAll(await LANGUAGE_FIXTURES.vietnamese.build());
    expectPieces(page, ["Mô tả", "ĐVT", "Đơn giá", "Thành tiền", "Gạch ốp tường 30x60, loại A", "Vữa dán gạch, bao 25 kg"]);
  });

  it("writes U+202F and U+00A0 into the PDF, which pdf.js reads back as normal spaces", async () => {
    const bytes = await french();
    // The font's character map (ToUnicode) is in a compressed stream. Unpack
    // every stream and look for the two code points in hexadecimal.
    const raw = Buffer.from(bytes).toString("latin1");
    const streams = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => {
      try {
        return inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
      } catch {
        return ""; // not a compressed stream
      }
    });
    const maps = streams.filter((stream) => stream.includes("begincmap")).join("\n");
    expect(maps).toContain("<202f>");
    expect(maps).toContain("<00a0>");

    // pdf.js gives both back as U+0020, and the value stays one piece.
    const [page] = await readAll(bytes);
    const drawn = LANGUAGE_FIXTURES.french.rows[1][5];
    expect(drawn).toMatch(/ .* €$/u);
    expect(texts(page)).toContain(asReadBack(drawn));
    expect(texts(page).join("")).not.toMatch(/[  ]/u);
  });
});

describe("language and layout fixtures", () => {
  for (const [name, fixture] of Object.entries(LANGUAGE_FIXTURES)) {
    it(`${name}: headers, cells and lines below the table are on the page`, async () => {
      const pages = await readAll(await fixture.build());
      expect(pages).toHaveLength(fixture.pageCount);
      const [page] = pages;
      const found = texts(page);
      const perWord = name === "onePiecePerWord";
      const twoLine = name === "twoLineHeader";

      if (perWord) {
        // Every word is its own piece, and no piece holds a space.
        expect(found.filter((text) => text.includes(" "))).toEqual([]);
        const words = [...fixture.headers, ...fixture.rows.flat(), ...fixture.after].flatMap((text) => text.split(" "));
        for (const word of words) if (word !== "") expect(found).toContain(word);
        return;
      }
      if (twoLine) {
        // Each header word is its own piece, on two lines.
        expectPieces(page, fixture.headers.flatMap((header) => header.split(" ")));
        const unit = page.pieces.filter((piece) => piece.str === "Unit").map((piece) => piece.y);
        expect(new Set(unit.map((y) => Math.round(y))).size).toBe(2);
      } else {
        expectPieces(page, fixture.headers);
      }
      expectPieces(page, fixture.rows.flat().map(asReadBack));
      expectPieces(page, fixture.wrapped.flatMap((wrapped) => wrapped.lines));
      expect(fixture.rows).toHaveLength(fixture.rowCount);
      for (const line of fixture.after) {
        // The total is two pieces (label and amount); a note is one piece.
        expect(found.join(" ")).toContain(asReadBack(line));
      }
    });
  }

  it("every row multiplies correctly in the fixtures that claim it", () => {
    for (const fixture of Object.values(LANGUAGE_FIXTURES)) {
      if (!fixture.maths) continue;
      const { qty, price, total } = fixture.maths;
      for (const row of fixture.rows) {
        expect(Number(row[qty]) * minorUnits(row[price], fixture.format)).toBe(minorUnits(row[total], fixture.format));
      }
    }
  });

  it("the discount fixture has rows with qty 1 and exactly one discounted row", () => {
    const { rows, headers } = LANGUAGE_FIXTURES.qtyOneDisc;
    const disc = headers.indexOf("Disc %");
    expect(disc).toBe(headers.indexOf("Unit Price") + 1);
    expect(disc).toBe(headers.indexOf("Line Total") - 1);
    expect(rows.filter((row) => row[2] === "1").length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row[disc] !== "")).toHaveLength(1);
  });

  it("the wrapped fixture wraps the first row and a later row", () => {
    expect(LANGUAGE_FIXTURES.wrappedDescription.wrapped.map((wrapped) => wrapped.row)).toEqual([0, 2]);
  });

  it("the no-table page holds its text and key/value block", async () => {
    const [page] = await readAll(await LANGUAGE_FIXTURES.noTable.build());
    expectPieces(page, ["Tax Invoice", "Invoice No: KHR-6620", "Bill to:", ...NO_TABLE_KEY_VALUES.flat()]);
  });

  it("the right-aligned fixture lines numbers up on their right edge", async () => {
    const [page] = await readAll(await LANGUAGE_FIXTURES.reorderedRightAligned.build());
    const column = LANGUAGE_FIXTURES.reorderedRightAligned.rows.map((row) => row[5]);
    const rights = column.map((text) => {
      const piece = page.pieces.find((candidate) => candidate.str === text);
      if (!piece) throw new Error(`no piece "${text}"`);
      return piece.x + piece.width;
    });
    for (const right of rights) expect(right).toBeCloseTo(rights[0], 1);
  });

  it("the formatters print each language's number style", () => {
    expect(FORMATS.en(119520)).toBe("$1,195.20");
    expect(FORMATS.de(119520)).toBe("1.195,20 €");
    expect(FORMATS.fr(119520)).toBe("1 195,20 €");
    expect(FORMATS.vi(1195200)).toBe("1.195.200");
  });
});

describe("rule fixtures in build.ts", () => {
  it("docket: three columns and no prices", async () => {
    const pages = await readAll(await docket());
    expect(pages).toHaveLength(1);
    expectPieces(pages[0], [...DOCKET_COLUMNS.map((column) => column.header), ...DOCKET_ROWS.flat()]);
    expect(texts(pages[0]).some((text) => text.includes("$"))).toBe(false);
  });

  it("multiPage: three pages, headers everywhere, carried forward on page 2, subtotal on page 3", async () => {
    const pages = await readAll(await multiPage());
    expect(pages).toHaveLength(3);
    for (const page of pages) expectPieces(page, DEFAULT_COLUMNS.map((column) => column.header));
    pages.forEach((page, index) => expectPieces(page, MULTI_PAGE.pages[index].flat()));
    expectPieces(pages[1], ["Carried forward", MULTI_PAGE.carriedForward]);
    expect(texts(pages[0])).not.toContain("Carried forward");
    expectPieces(pages[2], [MULTI_PAGE.subtotalLine]);
    expect(texts(pages[1])).not.toContain(MULTI_PAGE.subtotalLine);
  });

  it("multiPage: the carried-forward amount is page 1's lines total, and the subtotal covers every line", () => {
    const cents = (text: string) => minorUnits(text, "en");
    const lineTotals = MULTI_PAGE.pages.map((rows) => rows.filter((row) => row[0] !== "").map((row) => cents(row[5])));
    expect(lineTotals[0].reduce((a, b) => a + b, 0)).toBe(cents(MULTI_PAGE.carriedForward));
    expect(lineTotals.flat().reduce((a, b) => a + b, 0)).toBe(cents(MULTI_PAGE.subtotalLine.replace("Subtotal: ", "")));
    expect(lineTotals.flat()).toHaveLength(MULTI_PAGE.itemCount);
    for (const row of MULTI_PAGE.pages.flat().filter((cells) => cells[0] !== "")) {
      expect(Number(row[2]) * cents(row[4])).toBe(cents(row[5]));
    }
  });

  it("rotatedStamp: a normal table plus one piece turned 45 degrees", async () => {
    const [page] = await readAll(await rotatedStamp());
    expectPieces(page, DEFAULT_COLUMNS.map((column) => column.header));
    const stamp = page.pieces.find((piece) => piece.str === "PAID");
    expect(stamp).toBeDefined();
    expect(Math.abs(stamp!.angle)).toBeCloseTo(STAMP_ANGLE, 0);
    expect(page.pieces.filter((piece) => Math.abs(piece.angle) > 1)).toHaveLength(1);
  });

  it("shiftedColumns: headers at their own positions, unit prices, one 'total' weight", async () => {
    const [page] = await readAll(await shiftedColumns());
    for (const column of SHIFTED_COLUMNS) {
      const piece = page.pieces.find((candidate) => candidate.str === column.header);
      expect(piece?.x).toBeCloseTo(column.x, 0);
    }
    expectPieces(page, [...SHIFTED_ROWS.flat(), SHIFTED_AFTER_LINE]);
    expect(SHIFTED_ROWS.filter((row) => row[3].includes("total"))).toHaveLength(1);
    expect(SHIFTED_ROWS.every((row) => /\/[a-z]+$/.test(row[4]))).toBe(true);
    expect(SHIFTED_COLUMNS.map((column) => column.x)).not.toEqual(DEFAULT_COLUMNS.slice(0, 5).map((column) => column.x));
  });

  it("titledPages: five pages with their titles, and the label line only on page 5", async () => {
    const pages = await readAll(await titledPages());
    expect(pages).toHaveLength(5);
    pages.forEach((page, index) => {
      expectPieces(page, [TITLED_PAGE_TITLES[index], ...DEFAULT_COLUMNS.map((column) => column.header)]);
      expect(texts(page).includes(TITLED_PAGES_LABEL_LINE)).toBe(index === 4);
    });
    const label = pages[4].pieces.find((piece) => piece.str === TITLED_PAGES_LABEL_LINE)!;
    const header = pages[4].pieces.find((piece) => piece.str === "Qty")!;
    expect(label.y).toBeLessThan(header.y);
  });

  it("mismatchRow: exactly one row does not multiply", async () => {
    const [page] = await readAll(await mismatchRow());
    expectPieces(page, ["$22.25", "$187.00"]);
    expect(texts(page)).not.toContain("$178.00");
    expect(MISMATCH_ROW_INDEX).toBe(1);
  });

  it("unparseableCell: the price with a unit word is one piece", async () => {
    const [page] = await readAll(await unparseableCell());
    expectPieces(page, [UNPARSEABLE_PRICE, "Tile spacers 3mm"]);
  });

  it("numbersOnlyRow: a fourth row with numbers and no description", async () => {
    const [page] = await readAll(await numbersOnlyRow());
    expectPieces(page, NUMBERS_ONLY_ROW);
    const fourth = page.pieces.filter((piece) => piece.str === NUMBERS_ONLY_ROW[5]);
    expect(fourth).toHaveLength(1);
    const onRow = page.pieces.filter((piece) => Math.abs(piece.y - fourth[0].y) < 1);
    expect(onRow).toHaveLength(NUMBERS_ONLY_ROW.filter((cell) => cell !== "").length);
  });
});
