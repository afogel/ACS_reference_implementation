import { describe, expect, it } from "bun:test";
import { loadCatalog, type ProvisionRecord } from "../src/catalog/catalog.ts";
import { checkStaleness } from "../src/catalog/staleness.ts";
import type { Manifest, ManifestEntry } from "../src/extract/extract.ts";
import { renderStale } from "../src/render/stale.ts";

const entry = (id: string, source_file: string, text_hash: string): ManifestEntry => ({
  id,
  type: id.includes("INV") ? "Invariant" : id.includes("DEF") ? "Definition" : "Requirement",
  source_file,
  line: 1,
  block_type: "paragraph",
  section_slug: null,
  level: null,
  keywords: [],
  text: "t",
  text_hash,
});
const record = (id: string, reviewed_against: string, extra: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  id,
  title: "T",
  actor: "guardian",
  reported_against: "guardian",
  profile: ["acs-core"],
  activation: null,
  modality_kind: "obligation",
  evidence_class: "wire",
  schema_refs: [],
  depends_on: [],
  restates: null,
  status: "active",
  since: "0.1.0",
  superseded_by: [],
  reviewed_against,
  note: null,
  ...extra,
});

// INV-0001 (concept) <- REQ-0011 depends_on <- REQ-0012 depends_on; REQ-0023 (concept) <- REQ-0024 restates; DEF-0002 <- REQ-0009 <- REQ-0010
const manifest = (invHash = "inv", reqHash = "r23"): Manifest => ({
  generated_by: "test",
  corpus: { version: null, commit: null },
  provisions: [
    entry("ACS-INV-0001", "concepts/intent.md", invHash),
    entry("ACS-REQ-0011", "spec/s.md", "r11"),
    entry("ACS-REQ-0012", "spec/s.md", "r12"),
    entry("ACS-REQ-0023", "concepts/agents.md", reqHash),
    entry("ACS-REQ-0024", "spec/s.md", "r24"),
    entry("ACS-DEF-0002", "concepts/provenance.md", "d2"),
    entry("ACS-REQ-0009", "spec/s.md", "r9"),
  ],
});
const records = [
  record("ACS-INV-0001", "inv"),
  record("ACS-REQ-0011", "r11", { depends_on: ["ACS-INV-0001"] }),
  record("ACS-REQ-0012", "r12", { depends_on: ["ACS-REQ-0011"] }),
  record("ACS-REQ-0023", "r23"),
  record("ACS-REQ-0024", "r24", { restates: "ACS-REQ-0023" }),
  record("ACS-DEF-0002", "d2"),
  record("ACS-REQ-0009", "r9", { depends_on: ["ACS-DEF-0002"] }),
];

describe("checkStaleness -- one computation, three edge types", () => {
  it("reports nothing stale when every record matches its text, and still lists the worklist", () => {
    const report = checkStaleness(loadCatalog(manifest(), records));
    expect(report.stale).toEqual([]);
    expect(report.worklist).toEqual([
      { pillar: "ACS-REQ-0024", pillar_source: "spec/s.md", pillar_line: 1, canonical: "ACS-REQ-0023", canonical_source: "concepts/agents.md" },
    ]);
  });

  it("propagates a changed Invariant to the Requirement that depends on it, and onward, with no keyword sentence changed (R2.6)", () => {
    const report = checkStaleness(loadCatalog(manifest("inv-reworded"), records), new Map([["ACS-REQ-0011", ["intent.test.ts"]]]));
    expect(report.stale).toEqual([
      {
        id: "ACS-INV-0001",
        source_file: "concepts/intent.md",
        line: 1,
        reasons: [{ kind: "text_changed", reviewed_against: "inv", text_hash: "inv-reworded" }],
        invalidates: ["ACS-REQ-0011"],
        tests: [],
      },
      { id: "ACS-REQ-0011", source_file: "spec/s.md", line: 1, reasons: [{ kind: "dependency_stale", via: "ACS-INV-0001" }], invalidates: ["ACS-REQ-0012"], tests: ["intent.test.ts"] },
      { id: "ACS-REQ-0012", source_file: "spec/s.md", line: 1, reasons: [{ kind: "dependency_stale", via: "ACS-REQ-0011" }], invalidates: [], tests: [] },
    ]);
  });

  it("marks the pillar copy diverged when the canonical concept provision changes, never the reverse (R2.9)", () => {
    const forward = checkStaleness(loadCatalog(manifest("inv", "r23-reworded"), records));
    expect(forward.stale.map((s) => [s.id, s.reasons.map((r) => r.kind)])).toEqual([
      ["ACS-REQ-0023", ["text_changed"]],
      ["ACS-REQ-0024", ["restatement_diverged"]],
    ]);
    const pillarOnly = manifest();
    (pillarOnly.provisions.find((p) => p.id === "ACS-REQ-0024") as ManifestEntry).text_hash = "r24-reworded";
    const backward = checkStaleness(loadCatalog(pillarOnly, records));
    expect(backward.stale.map((s) => s.id)).toEqual(["ACS-REQ-0024"]);
  });

  it("does not report a provision twice when two roots reach it, and records each reason", () => {
    const both = manifest("inv-reworded");
    (both.provisions.find((p) => p.id === "ACS-REQ-0011") as ManifestEntry).text_hash = "r11-reworded";
    const report = checkStaleness(loadCatalog(both, records));
    const r11 = report.stale.find((s) => s.id === "ACS-REQ-0011");
    expect(r11?.reasons.map((r) => r.kind)).toEqual(["text_changed", "dependency_stale"]);
    expect(report.stale.filter((s) => s.id === "ACS-REQ-0012")).toHaveLength(1);
  });
});

describe("renderStale -- U10 and U32", () => {
  it("names each stale provision, why, what it invalidated, and its tests", () => {
    const text = renderStale(checkStaleness(loadCatalog(manifest("inv-reworded"), records), new Map([["ACS-REQ-0011", ["intent.test.ts"]]])));
    expect(text).toContain("3 provision(s) need review");
    expect(text).toContain("- **ACS-INV-0001** (`concepts/intent.md:1`)\n  - its text changed: reviewed against `inv`, now `inv-reworded` (R2.4)\n  - invalidates: ACS-REQ-0011");
    expect(text).toContain("- it depends on ACS-INV-0001, which needs review (R2.6)\n  - invalidates: ACS-REQ-0012\n  - tests citing it: intent.test.ts");
    expect(text).toContain("| ACS-REQ-0024 | spec/s.md:1 | ACS-REQ-0023 | concepts/agents.md |");
  });

  it("says plainly when nothing needs review", () => {
    expect(renderStale(checkStaleness(loadCatalog(manifest(), records)))).toContain("None. Every record is reviewed against");
  });
});
