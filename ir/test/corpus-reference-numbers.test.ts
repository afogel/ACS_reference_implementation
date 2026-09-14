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
import { loadCatalog, loadRecords } from "../src/catalog/catalog.ts";
import { defaultCensusDir, runCensus } from "../src/census/run-census.ts";
import { defaultCorpusRoot } from "../src/corpus.ts";
import { defaultManifestPath, type Manifest } from "../src/extract/extract.ts";
import { checkAllocated, readCounter, readTombstones } from "../src/ids.ts";

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

  it("binds the V2 specimens' 23 occurrences, excludes the eleven in informative or editorial sources, and leaves 174 unbound", () => {
    expect(census?.totals).toMatchObject({ bound: 23, excluded: 11, unbound: 174 });
    const bound = (census?.occurrences ?? []).filter((o) => o.binding.kind === "bound");
    expect(new Set(bound.map((o) => (o.binding as { provision_id: string }).provision_id)).size).toBe(18);
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

describe("the V2 catalog -- twenty-eight provisions, both halves present", () => {
  const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
  const records = loadRecords();
  const catalog = loadCatalog(manifest, records.records);

  it("is generated from the same corpus pin the census reports", () => {
    expect(manifest.corpus).toEqual({ version: "0.1.2", commit: "6fce2a0a71ed6372ed575ce19934dd32220b38d9" });
  });

  it("joins every marked provision to an authored record, with no problems either way", () => {
    expect(records.problems).toEqual([]);
    expect(catalog.problems).toEqual([]);
    expect(catalog.entries).toHaveLength(28);
  });

  it("spans all five node types and the four block types", () => {
    const types = new Set(catalog.entries.map((e) => e.manifest.type));
    expect(types).toEqual(new Set(["Requirement", "Definition", "Invariant", "Exclusion"]));
    const blocks = new Set(catalog.entries.map((e) => e.manifest.block_type));
    expect(blocks).toEqual(new Set(["paragraph", "list_item", "table_cell", "blockquote"]));
  });

  it("has every record reviewed against the text it currently carries", () => {
    const stale = catalog.entries.filter((e) => e.record.reviewed_against !== e.manifest.text_hash).map((e) => e.manifest.id);
    expect(stale).toEqual([]);
  });

  it("uses only allocated, live IDs", () => {
    expect(checkAllocated(manifest.provisions.map((p) => p.id), readCounter(), readTombstones())).toEqual([]);
  });

  it("carries the modalities and the restatement pair the specimen table asked for", () => {
    const byId = Object.fromEntries(catalog.entries.map((e) => [e.manifest.id, e.record]));
    expect(byId["ACS-REQ-0021"]?.modality_kind).toBe("permission");
    expect(byId["ACS-REQ-0022"]).toMatchObject({ modality_kind: "conditional-on-exercise", depends_on: ["ACS-REQ-0021"] });
    expect(byId["ACS-REQ-0024"]?.restates).toBe("ACS-REQ-0023");
    expect(byId["ACS-REQ-0019"]?.evidence_class).toBe("non-testable");
    expect(byId["ACS-REQ-0010"]?.depends_on).toContain("ACS-DEF-0002");
  });
});
