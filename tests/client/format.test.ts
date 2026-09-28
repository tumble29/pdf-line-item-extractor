/**
 * Tests for src/components/format.ts: the few words the page makes up
 * itself, from data in the result (everything else is shown as the engine
 * sent it).
 */
import { describe, expect, it } from "vitest";

import { columnName, fileSize, numberFormatSentence, pageStatusLabel, plural, prettyJson } from "@/components/format";
import type { PageReport } from "@/lib/contract/schema";

/** A page report with the given status and notes. */
function page(status: PageReport["status"], notes: PageReport["notes"] = []): PageReport {
  return { page: 1, status, titleLines: [], itemCount: 0, columns: [], notes };
}

/** A warning note. */
const WARNING = { level: "warning", text: "Page 1 is titled 'Summary'." } as const;

/** Nothing refused, on one page of table. */
const PLAIN = { twoReadings: false, tablePages: 1 };

describe("numberFormatSentence", () => {
  it("says nothing for the usual '.' decimals", () => {
    expect(numberFormatSentence({ decimal: ".", grouping: ",", settled: true }, PLAIN)).toBeNull();
    expect(numberFormatSentence({ decimal: ".", grouping: null, settled: true }, PLAIN)).toBeNull();
  });

  it("names the marks of a ',' decimal format, and only a thousands mark the document proves", () => {
    expect(numberFormatSentence({ decimal: ",", grouping: ".", settled: true }, PLAIN)).toBe(
      "Numbers on this document use '.' between thousands and ',' as the decimal mark, like 1.195,20.",
    );
    expect(numberFormatSentence({ decimal: ",", grouping: " ", settled: true }, PLAIN)).toContain("a space between thousands");
    expect(numberFormatSentence({ decimal: ",", grouping: null, settled: true }, PLAIN)).toBe(
      "Numbers on this document use ',' as the decimal mark, like 15,50.",
    );
  });

  it("says the pages write numbers differently only with two or more pages of tables", () => {
    const unknown = { decimal: null, grouping: null, settled: false } as const;
    expect(numberFormatSentence(unknown, { twoReadings: false, tablePages: 2 })).toContain("don't all write numbers the same way");
    expect(numberFormatSentence(unknown, { twoReadings: false, tablePages: 1 })).toBeNull();
  });

  it("says a number had two readings only when such a refusal was sent, and never that the pages differ then", () => {
    const unknown = { decimal: null, grouping: null, settled: false } as const;
    const sentence = numberFormatSentence(unknown, { twoReadings: true, tablePages: 1 });
    expect(sentence).toContain("could be read two ways");
    expect(sentence).not.toContain("don't all write numbers the same way");
    expect(numberFormatSentence(unknown, { twoReadings: true, tablePages: 3 })).not.toContain("don't all write");
  });

  it("gives both sentences for a ',' decimal document with a number that had two readings", () => {
    const sentence = numberFormatSentence({ decimal: ",", grouping: ".", settled: false }, { twoReadings: true, tablePages: 1 });
    expect(sentence).toContain("as the decimal mark");
    expect(sentence).toContain("could be read two ways");
  });
});

describe("pageStatusLabel", () => {
  const none = { pageRefused: false, linesLeftOut: 0 };

  it.each([
    ["extracted", "Read"],
    ["partial", "Partly read"],
    ["blank", "Nothing found to read"],
  ] as const)("names %s as '%s'", (status, label) => {
    expect(pageStatusLabel(page(status), none)).toBe(label);
  });

  it("says 'Not read' only for a page refused as a whole", () => {
    expect(pageStatusLabel(page("refused"), { pageRefused: true, linesLeftOut: 0 })).toBe("Not read");
  });

  it("says a page that was read had every line left out, instead of 'Not read'", () => {
    expect(pageStatusLabel(page("refused"), { pageRefused: false, linesLeftOut: 3 })).toBe("No lines listed: all 3 lines were left out");
    expect(pageStatusLabel(page("refused"), { pageRefused: false, linesLeftOut: 1 })).toBe("No lines listed: its one line was left out");
  });

  it("counts the lines left out of a partly read page", () => {
    expect(pageStatusLabel(page("partial"), { pageRefused: false, linesLeftOut: 2 })).toBe("Partly read: 2 lines left out");
  });

  it("says how many warnings a read page has", () => {
    expect(pageStatusLabel(page("extracted", [WARNING]), none)).toBe("Read, with a warning");
    expect(pageStatusLabel(page("extracted", [WARNING, WARNING]), none)).toBe("Read, with 2 warnings");
  });
});

describe("small words", () => {
  it("names a column with no heading by its place", () => {
    expect(columnName(null, 2)).toBe("Column 3 (no heading)");
    expect(columnName("Qty", 2)).toBe("Qty");
  });

  it("writes sizes and counts the way people read them", () => {
    expect(fileSize(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(fileSize(2400)).toBe("2 KB");
    expect(fileSize(0)).toBe("0 bytes");
    expect(fileSize(1)).toBe("1 byte");
    expect(fileSize(900)).toBe("900 bytes");
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(3, "page")).toBe("3 pages");
  });
});

describe("prettyJson", () => {
  it("lays JSON out with two spaces per level, keeping the server's key order and every value", () => {
    const text = '{"requestId":"r-1","kind":"result","items":[{"value":1.5,"raw":"1,50 €"}]}';
    const pretty = prettyJson(text);
    expect(pretty).toBe(
      ['{', '  "requestId": "r-1",', '  "kind": "result",', '  "items": [', "    {", '      "value": 1.5,', '      "raw": "1,50 €"', "    }", "  ]", "}"].join("\n"),
    );
    expect(JSON.parse(pretty)).toEqual(JSON.parse(text));
  });

  it("gives back a text that isn't JSON as it is", () => {
    expect(prettyJson("<html>Gateway</html>")).toBe("<html>Gateway</html>");
  });
});
