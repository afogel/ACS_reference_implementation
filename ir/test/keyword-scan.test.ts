import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keywordScan, maskSpans } from "../src/census/keyword-scan.ts";

const rules = readFileSync(join(import.meta.dir, "fixtures", "mini", "docs", "spec", "rules.md"), "utf8");

describe("keywordScan -- every RFC 2119 occurrence, with where it is", () => {
  const scan = keywordScan("spec/rules.md", rules);
  const rows = scan.occurrences.map((o) => `${o.line}:${o.column} ${o.keyword} ${o.block_type}`);

  it("finds the uses and none of the mentions", () => {
    expect(rows).toEqual([
      "1:14 MUST heading",
      "3:27 MUST paragraph",
      "4:1 MUST NOT paragraph",
      "6:12 SHOULD list_item",
      "7:6 MAY list_item",
      "9:13 MAY list_item",
      "14:9 REQUIRED table_cell",
      "15:9 OPTIONAL table_cell",
      "15:19 MAY table_cell",
      "21:42 MUST blockquote",
      "23:44 MUST paragraph",
      "31:25 RECOMMENDED paragraph",
      "31:49 NOT RECOMMENDED paragraph",
    ]);
  });

  it("counts MUST NOT once, as MUST NOT", () => {
    expect(scan.occurrences.filter((o) => o.line === 4).map((o) => o.keyword)).toEqual(["MUST NOT"]);
  });

  it("reports the inline-code span and the HTML comment as masked, not as occurrences", () => {
    expect(scan.masked.map((o) => `${o.line}:${o.column}`)).toEqual(["4:42", "4:67"]);
  });

  it("never looks inside a code fence", () => {
    expect(scan.occurrences.some((o) => o.block_type === "code_fence")).toBe(false);
  });

  it("counts a block once however many keywords it carries", () => {
    // heading, paragraph (3-4), item one (6-7), nested item, two cells, quote, lead-in, trailing paragraph
    expect(scan.blocks_with_keywords).toBe(9);
    const paragraph = scan.occurrences.filter((o) => o.line === 3 || o.line === 4);
    expect(new Set(paragraph.map((o) => o.block)).size).toBe(1);
  });

  it("gives an editor a one-line context window around the keyword", () => {
    const first = scan.occurrences.find((o) => o.line === 3);
    expect(first?.context).toContain("A client MUST send a handshake first");
    expect(first?.context).not.toContain("\n");
  });
});

describe("maskSpans", () => {
  it("blanks code spans and comments to spaces of equal length, keeping newlines", () => {
    const input = "a `MUST` b <!-- x\ny --> c ``d`e`` f";
    const masked = maskSpans(input);
    expect(masked.length).toBe(input.length);
    expect(masked).toBe("a " + " ".repeat(6) + " b " + " ".repeat(6) + "\n" + " ".repeat(5) + " c " + " ".repeat(7) + " f");
  });
});
