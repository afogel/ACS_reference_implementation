import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCensus } from "../src/census/run-census.ts";
import { main } from "../src/main.ts";
import { renderCensus } from "../src/render/census.ts";

const mini = join(import.meta.dir, "fixtures", "mini");
const sourcesFile = join(mini, "sources.yaml");
const overlayFile = join(mini, "overlay.yaml");

describe("runCensus -- the fixture corpus end to end", () => {
  const run = runCensus({ corpusRoot: mini, sourcesFile, overlayFile });
  const census = run.provisions;
  const rows = census?.occurrences ?? [];

  it("declares the corpus cleanly and reads its version", () => {
    expect(run.sources.problems).toEqual([]);
    expect(run.corpus.version).toBe("9.9.9");
    expect(run.corpus.commit).toBeNull();
    expect(census?.corpus.documents).toBe(4);
  });

  it("puts every occurrence in exactly one of bound, excluded, unbound", () => {
    expect(census?.totals).toMatchObject({ occurrences: 16, bound: 7, excluded: 3, unbound: 6, masked: 2 });
    const bound = rows.filter((r) => r.binding.kind === "bound").map((r) => `${r.line}:${r.keyword}=${(r.binding as { provision_id: string }).provision_id}`);
    expect(bound).toEqual([
      "5:MUST NOT=ACS-INV-0001",
      "3:MUST=ACS-REQ-0001",
      "4:MUST NOT=ACS-REQ-0001",
      "6:SHOULD=ACS-REQ-0002",
      "7:MAY=ACS-REQ-0002",
      "15:OPTIONAL=ACS-REQ-0003",
      "15:MAY=ACS-REQ-0003",
    ]);
    expect(rows.filter((r) => r.binding.kind === "excluded").map((r) => [r.source, (r.binding as { reason: string }).reason])).toEqual([
      ["concepts/README.md", "editorial_source"],
      ["notes.md", "informative_source"],
      ["spec/rules.md", "restatement_of"],
    ]);
    const restated = rows.find((r) => r.source === "spec/rules.md" && r.binding.kind === "excluded")?.binding as { reason: string; of?: string };
    expect(restated.of).toBe("ACS-REQ-0001");
  });

  it("reports per-source counts with the node-type columns present and zero", () => {
    const rules = census?.sources.find((s) => s.path === "spec/rules.md");
    expect(rules).toMatchObject({
      occurrences: 13,
      bound: 6,
      excluded: 1,
      unbound: 6,
      by_block_type: { heading: 1, paragraph: 5, list_item: 3, table_cell: 3, blockquote: 1 },
      by_node_type: { requirement: 0, definition: 0, invariant: 0, exclusion: 0 },
      normative_tags: 4,
    });
  });

  it("audits the footer edges: all unmatched, two dangling targets, no missing footers", () => {
    expect(census?.dependency_audit).toEqual({
      entries_without_depending_provision: 2,
      pages_without_footer: [],
      dangling_targets: [
        { from: "concepts/thing.md", line: 11, doc: "spec/hooks.md" },
        { from: "concepts/thing.md", line: 13, doc: "concepts/other.md" },
      ],
    });
  });

  it("names a concept page that lacks a footer", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-"));
    const sources = readFileSync(sourcesFile, "utf8").replace(
      "  - path: concepts/README.md\n    status: editorial\n",
      "  - path: concepts/README.md\n    status: normative\n    normative_by: self\n",
    );
    writeFileSync(join(dir, "sources.yaml"), sources);
    const audit = runCensus({ corpusRoot: mini, sourcesFile: join(dir, "sources.yaml"), overlayFile }).provisions?.dependency_audit;
    expect(audit?.pages_without_footer).toEqual(["concepts/README.md"]);
  });

  it("writes YAML that parses back to the same census and is byte-stable across runs", () => {
    expect(run.yaml).not.toBeNull();
    const parsed = Bun.YAML.parse(run.yaml ?? "") as { totals: { occurrences: number }; occurrences: unknown[] };
    expect(parsed.totals.occurrences).toBe(16);
    expect(parsed.occurrences).toHaveLength(16);
    expect(runCensus({ corpusRoot: mini, sourcesFile, overlayFile }).yaml).toBe(run.yaml);
  });

  it("withholds the provision census when the overlay does not resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-"));
    writeFileSync(join(dir, "overlay.yaml"), "markers:\n  - id: ACS-REQ-0009\n    source: notes.md\n    quote: nowhere\n");
    const broken = runCensus({ corpusRoot: mini, sourcesFile, overlayFile: join(dir, "overlay.yaml") });
    expect(broken.provisions).toBeNull();
    expect(broken.sources.problems).toEqual(["overlay: ACS-REQ-0009: start quote not found in notes.md: \"nowhere\""]);
  });

  it("binds nothing when no overlay is given", () => {
    expect(runCensus({ corpusRoot: mini, sourcesFile, overlayFile: null }).provisions?.totals.bound).toBe(0);
  });

  it("withholds the provision census when the source census has problems", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-"));
    writeFileSync(join(dir, "sources.yaml"), "sources:\n  - path: notes.md\n    status: informative\n");
    const partial = runCensus({ corpusRoot: mini, sourcesFile: join(dir, "sources.yaml"), overlayFile });
    expect(partial.provisions).toBeNull();
    expect(partial.sources.problems).toContain("spec/rules.md: in the corpus but not declared in sources.yaml");
    expect(renderCensus(partial.sources, null)).toContain("Fix `ir/census/sources.yaml`");
  });
});

describe("renderCensus -- the four V1 panels", () => {
  const run = runCensus({ corpusRoot: mini, sourcesFile, overlayFile });
  const report = renderCensus(run.sources, run.provisions);

  it("renders the source census, provision census, unbound table and edge audit", () => {
    for (const heading of ["## Source census (U19)", "## Provision census (U20)", "## Unbound and excluded occurrences (U21)", "## Dependency-edge audit (U33)"]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain("| spec/rules.md:1:14 | MUST | heading | unbound |");
    expect(report).not.toContain("| spec/rules.md:3:27 |");
    expect(report).toContain("| notes.md:3:9 | MAY | paragraph | excluded: informative_source |");
    expect(report).toContain("2 pillar entries in Referenced-by footers; 2 with no provision depending back");
    expect(report).toContain("- concepts/thing.md:11 -> spec/hooks.md");
  });

  it("does not render the panels later slices own", () => {
    expect(report).not.toContain("U32");
    expect(report).not.toContain("U34");
  });
});

describe("acs-ir census -- exit codes", () => {
  it("rejects an unknown command with usage", () => {
    expect(main(["nope"])).toBe(2);
  });

  it("with --check reports a missing or stale file as 1 and a current file as 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-"));
    const out = join(dir, "provisions.yaml");
    const args = ["census", "--corpus", mini, "--sources", sourcesFile, "--overlay", overlayFile, "--out", out, "--quiet"];
    expect(main([...args, "--check"])).toBe(1);
    expect(main(args)).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(main([...args, "--check"])).toBe(0);
    writeFileSync(out, readFileSync(out, "utf8") + "stale: true\n");
    expect(main([...args, "--check"])).toBe(1);
  });
});
