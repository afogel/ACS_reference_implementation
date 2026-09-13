/**
 * The census against the pinned corpus, held to the numbers the shaping
 * survey measured. `normative-ir-slices.md` §V1: "If V1's scan disagrees
 * with those, V1's scan is wrong." The survey's numbers were taken at
 * c259f57 (v0.1.0); the submodule now pins v0.1.2, which added two
 * identity pages carrying five occurrences in table cells and left every
 * other count unchanged. Both sets are recorded so a future submodule bump
 * that moves a number moves it here, on purpose.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCensusDir, runCensus } from "../src/census/run-census.ts";
import { defaultCorpusRoot } from "../src/corpus.ts";

const pinned = defaultCorpusRoot();
const present = existsSync(join(pinned, "docs"));
const run = present ? runCensus() : null;
const census = run?.provisions ?? null;

describe("the pinned corpus (spec/acs) -- reference numbers", () => {
  it("is checked out", () => {
    // A missing submodule is a hard failure here for the same reason it is in packages/guardian:
    // the answer would otherwise be a self-skip that looks like a pass.
    expect(present).toBe(true);
  });

  it("is fully declared in sources.yaml", () => {
    expect(run?.sources.problems).toEqual([]);
  });

  it("is ACS v0.1.2 at 6fce2a0", () => {
    expect(census?.corpus).toEqual({ version: "0.1.2", commit: "6fce2a0a71ed6372ed575ce19934dd32220b38d9", documents: 38 });
  });

  it("carries 208 keyword occurrences in the four block types X3 found, and none anywhere else", () => {
    expect(census?.totals.by_block_type).toEqual({
      paragraph: 145,
      list_item: 33,
      table_cell: 22,
      blockquote: 8,
      heading: 0,
      code_fence: 0,
      thematic_break: 0,
    });
    expect(census?.totals).toMatchObject({ occurrences: 208, blocks_with_keywords: 134, masked: 0 });
  });

  it("counts by keyword as the survey did, plus v0.1.2's five", () => {
    expect(census?.totals.by_keyword).toEqual({
      "MUST NOT": 23,
      MUST: 73,
      "SHALL NOT": 0,
      SHALL: 0,
      "SHOULD NOT": 0,
      SHOULD: 34,
      "NOT RECOMMENDED": 0,
      RECOMMENDED: 8,
      MAY: 44,
      OPTIONAL: 21,
      REQUIRED: 5,
    });
  });

  it("leaves every occurrence in a normative source unbound, and excludes the eleven in informative or editorial sources", () => {
    expect(census?.totals).toMatchObject({ bound: 0, excluded: 11, unbound: 197 });
    const excluded = (census?.occurrences ?? []).filter((o) => o.binding.kind === "excluded").map((o) => o.source);
    expect(new Set(excluded)).toEqual(
      new Set(["acs.md", "concepts/README.md", "identity/overview.md", "identity/standards.md", "topics/ACS_in_action_example.md"]),
    );
  });

  it("finds the ten (normative) callouts across six concept pages", () => {
    const callouts = (census?.normative_tags ?? []).filter((t) => t.kind === "callout");
    expect(callouts.map((t) => `${t.source}:${t.line}`)).toEqual([
      "concepts/agents.md:15",
      "concepts/agents.md:21",
      "concepts/identity.md:21",
      "concepts/intent.md:13",
      "concepts/intent.md:21",
      "concepts/provenance.md:19",
      "concepts/provenance.md:27",
      "concepts/session-lifecycle.md:23",
      "concepts/trust.md:25",
      "concepts/trust.md:27",
    ]);
  });

  it("seeds dependency edges from all eight Referenced-by footers, none dangling", () => {
    const pages = new Set((census?.dependency_edges ?? []).map((e) => e.from));
    expect(pages.size).toBe(8);
    expect(census?.dependency_audit).toEqual({
      entries_without_depending_provision: 22,
      pages_without_footer: [],
      dangling_targets: [],
    });
  });

  it("matches the committed ir/census/provisions.yaml byte for byte", () => {
    const committed = readFileSync(join(defaultCensusDir(), "provisions.yaml"), "utf8");
    expect(run?.yaml).toBe(committed);
  });
});
