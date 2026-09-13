import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calloutScan } from "../src/census/callout-scan.ts";

const rules = readFileSync(join(import.meta.dir, "fixtures", "mini", "docs", "spec", "rules.md"), "utf8");

describe("calloutScan -- candidates for the editor, typed by tag shape only", () => {
  const tags = calloutScan("spec/rules.md", rules);

  it("finds each of the four tag shapes at its line", () => {
    expect(tags.map((t) => [t.line, t.kind, t.title])).toEqual([
      [21, "callout", "Chain hashing"],
      [23, "lead_in", "Enforcement"],
      [25, "heading", "1.1 Failure (normative)"],
      [27, "citation", ""],
    ]);
  });

  it("strips the quote marker from a callout's text and keeps the sentence", () => {
    expect(tags[0]?.text).toBe("**Chain hashing (normative).** Entries MUST chain.");
  });

  it("finds nothing in a page without the tag", () => {
    expect(calloutScan("x.md", "Plain MUST prose.\n\n> quoted, untagged")).toEqual([]);
  });
});
