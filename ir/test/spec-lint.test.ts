/**
 * V4's rules, on the real catalog and marked corpus, against the committed
 * generated files as the baseline. The demo from the slices doc runs here:
 * a PR that adds an unmarked MUST and deletes a marked provision without
 * tombstoning it fails, and the comment names both with `file:line`.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultProvisionsDir } from "../src/catalog/catalog.ts";
import { defaultCensusDir } from "../src/census/run-census.ts";
import { loadCorpus, readSource } from "../src/corpus.ts";
import { defaultIdsDir } from "../src/ids.ts";
import { defaultSchemaDir, hashSubschema, lintSchemaRefs, resolvePointer } from "../src/lint/schema-refs.ts";
import { loadBaseline, specLint, type LintInputs } from "../src/lint/spec-lint.ts";
import { unmark } from "../src/lint/unmark.ts";
import { renderImpactComment } from "../src/render/impact.ts";
import { applyOverlay, defaultMarkersDir, parseOverlay, resolveOverlay } from "../src/markers/overlay.ts";
import { renderLint } from "../src/render/lint.ts";

const corpus = loadCorpus();
const irDir = resolve(import.meta.dir, "..");

function freshMarked(): string {
  const entries = parseOverlay(readFileSync(join(defaultMarkersDir(), "overlay.yaml"), "utf8"));
  const { spans } = resolveOverlay(entries, (f) => (corpus.files.includes(f) ? readSource(corpus, f) : null));
  const dir = mkdtempSync(join(tmpdir(), "acs-ir-lint-"));
  applyOverlay(corpus, spans, (f) => readSource(corpus, f), dir);
  return dir;
}

function inputs(markedDir: string, overrides: Partial<LintInputs> = {}): LintInputs {
  return {
    corpus,
    markedDir,
    sourcesFile: join(defaultCensusDir(), "sources.yaml"),
    exclusionsFile: join(defaultCensusDir(), "exclusions.yaml"),
    provisionsDir: defaultProvisionsDir(),
    idsDir: defaultIdsDir(),
    schemaDir: defaultSchemaDir(),
    citations: new Map(),
    baseline: loadBaseline(irDir),
    ...overrides,
  };
}

describe("loadBaseline -- what counts as no baseline", () => {
  it("treats a missing file and an empty file alike, so a base branch without the IR yields an empty baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-baseline-"));
    expect(loadBaseline(dir)).toEqual({ manifest: null, census: null });
    mkdirSync(join(dir, "manifest"), { recursive: true });
    mkdirSync(join(dir, "census"), { recursive: true });
    writeFileSync(join(dir, "manifest", "provisions.json"), "");
    writeFileSync(join(dir, "census", "provisions.yaml"), "\n");
    expect(loadBaseline(dir)).toEqual({ manifest: null, census: null });
  });
});

describe("specLint -- the tree as committed", () => {
  it("passes clean against its own baseline", () => {
    const report = specLint(inputs(freshMarked()));
    expect(report.findings).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.unmarked).toEqual([]);
    expect(report.removed_without_tombstone).toEqual([]);
    expect(report.added_without_test).toEqual([]);
    expect(report.changed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("with an empty baseline reports every testable provision as added without a test, the rest by reason, and no removal", () => {
    const report = specLint(inputs(freshMarked(), { baseline: { manifest: { generated_by: "t", corpus: { version: null, commit: null }, provisions: [] }, census: null } }));
    // 69 Requirements carry a predicate of their own, and these inputs collect no test citations.
    expect(report.added_without_test).toHaveLength(69);
    expect(report.added_without_test).toContain("ACS-REQ-0028");
    const byStatus: Record<string, number> = {};
    for (const a of report.added_untestable) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    expect(byStatus).toEqual({ permission: 39, "non-testable": 25, inexpressible: 12, alias: 3, definition: 2, invariant: 4, exclusion: 1 });
    expect(renderImpactComment(report)).toContain("- permission (39): ACS-REQ-0021, ");
    expect(report.removed_without_tombstone).toEqual([]);
    // With no baseline census every unbound occurrence would be new; since V7 there are none.
    expect(report.unmarked).toHaveLength(0);
  });
});

describe("specLint -- the V4 demo: an unmarked MUST added, a marked provision deleted", () => {
  const marked = freshMarked();
  const page = join(marked, "spec/instrument/specification.md");
  const text = readFileSync(page, "utf8");
  const edited = text
    .replace(/<a id="acs-exc-0001"><\/a>[\s\S]*?<!--\/acs-exc-0001-->/, "Multi-tenancy is specified in v0.2. Guardians MUST isolate tenants.");
  expect(edited).not.toBe(text);
  writeFileSync(page, edited);
  const report = specLint(inputs(marked));

  it("fails, naming the unmarked statement with file:line and the ID that needs a tombstone", () => {
    expect(report.ok).toBe(false);
    expect(report.unmarked).toEqual([
      {
        source: "spec/instrument/specification.md",
        line: 380,
        column: 47,
        keyword: "MUST",
        context: expect.stringContaining("Guardians MUST isolate tenants."),
      },
    ]);
    expect(report.removed_without_tombstone).toEqual(["ACS-EXC-0001"]);
    expect(report.findings.map((f) => [f.rule, f.where])).toEqual([
      ["catalog", null],
      ["tombstone", null],
      ["unmarked-keyword", "spec/instrument/specification.md:380"],
    ]);
  });

  it("reports only the new occurrence, not the 45 excluded ones", () => {
    expect(report.unmarked).toHaveLength(1);
  });

  it("renders the comment with both, and the terminal report by rule", () => {
    const comment = renderImpactComment(report);
    expect(comment).toStartWith("<!-- acs-ir-impact -->\n## Normative impact (ACS 0.1.2 at `6fce2a0`)\n\n**3 failure(s), 0 provision(s) to review.**");
    expect(comment).toContain("### Removed provisions missing a tombstone\n\n- ACS-EXC-0001: add an entry to `ir/ids/tombstones.yaml`");
    expect(comment).toContain("| `spec/instrument/specification.md:380:47` | MUST |");
    const terminal = renderLint(report);
    expect(terminal).toContain("### unmarked-keyword\n\n- `spec/instrument/specification.md:380`: MUST with no marker and no census exclusion:");
  });

  it("passes once the removed ID is tombstoned and the record withdrawn, leaving only the unmarked MUST", () => {
    const ids = mkdtempSync(join(tmpdir(), "acs-ir-ids-"));
    cpSync(defaultIdsDir(), ids, { recursive: true });
    writeFileSync(join(ids, "tombstones.yaml"), "tombstones:\n  - id: ACS-EXC-0001\n    withdrawn_in: '0.2.0'\n    reason: multi-tenancy specified\n");
    const provisions = mkdtempSync(join(tmpdir(), "acs-ir-prov-"));
    cpSync(defaultProvisionsDir(), provisions, { recursive: true });
    const record = join(provisions, "ACS-EXC-0001.yaml");
    writeFileSync(record, readFileSync(record, "utf8").replace("status: active", "status: withdrawn"));
    const after = specLint(inputs(marked, { idsDir: ids, provisionsDir: provisions }));
    expect(after.removed_without_tombstone).toEqual([]);
    expect(after.findings.map((f) => f.rule)).toEqual(["unmarked-keyword"]);
  });
});

describe("specLint -- the other rules", () => {
  it("rejects a test that cites an ID which is neither marked nor tombstoned (N25)", () => {
    const report = specLint(inputs(freshMarked(), { citations: new Map([["ACS-REQ-0999", ["conformance/x.test.ts"]], ["ACS-REQ-0001", ["conformance/y.test.ts"]]]) }));
    expect(report.findings).toEqual([
      { rule: "unknown-citation", where: "conformance/x.test.ts", message: "ACS-REQ-0999: cited by conformance/x.test.ts but is neither a marked provision nor a tombstone" },
    ]);
  });

  it("rejects a withdrawn record with no tombstone, and a tombstoned ID still marked (N23)", () => {
    const ids = mkdtempSync(join(tmpdir(), "acs-ir-ids-"));
    cpSync(defaultIdsDir(), ids, { recursive: true });
    writeFileSync(join(ids, "tombstones.yaml"), "tombstones:\n  - id: ACS-REQ-0007\n    withdrawn_in: '0.2.0'\n    reason: test\n");
    const provisions = mkdtempSync(join(tmpdir(), "acs-ir-prov-"));
    cpSync(defaultProvisionsDir(), provisions, { recursive: true });
    const record = join(provisions, "ACS-REQ-0008.yaml");
    writeFileSync(record, readFileSync(record, "utf8").replace("status: active", "status: withdrawn"));
    const report = specLint(inputs(freshMarked(), { idsDir: ids, provisionsDir: provisions }));
    expect(report.findings.map((f) => f.message)).toEqual([
      "ACS-REQ-0007: is tombstoned and cannot be reused",
      "ACS-REQ-0007: tombstoned, yet its record is still active",
      "ACS-REQ-0008: record is withdrawn but ids/tombstones.yaml has no entry for it",
      "ACS-REQ-0007: tombstoned, yet still marked in the corpus",
    ]);
  });

  it("turns a moved subschema into needs-review on the provision that pinned it (N26, R2.8)", () => {
    const schemas = mkdtempSync(join(tmpdir(), "acs-ir-schemas-"));
    cpSync(defaultSchemaDir(), schemas, { recursive: true });
    const file = join(schemas, "defer-details.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { properties: { reason: { enum: string[] } } };
    doc.properties.reason.enum.push("needs_human");
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const report = specLint(inputs(freshMarked(), { schemaDir: schemas }));
    expect(report.findings).toEqual([]);
    expect(report.stale.map((s) => [s.id, s.reasons[0]?.kind])).toEqual([["ACS-REQ-0005", "text_changed"]]);
    const reason = report.stale[0]?.reasons[0];
    expect(reason?.kind === "text_changed" && reason.reviewed_against.startsWith("defer-details.json#/properties/reason/enum")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("fails on an unmarked corpus file and on a broken pair (N22)", () => {
    const marked = freshMarked();
    const page = join(marked, "concepts/capability.md");
    writeFileSync(page, readFileSync(page, "utf8") + '\n<a id="acs-req-0099"></a>dangling\n');
    const report = specLint(inputs(marked));
    expect(report.findings.map((f) => [f.rule, f.where, f.message])).toEqual([["marker-pairing", "concepts/capability.md:31", "ACS-REQ-0099 has no terminator"]]);
  });
});

describe("unmark -- the census sees prose, not markers", () => {
  it("strips markers and re-bases span offsets onto the stripped text", () => {
    const marked = 'a <a id="acs-req-0001"></a>MUST b<!--/acs-req-0001--> c <a id="acs-def-0002"></a>d<!--/acs-def-0002-->';
    const { text, spans, pairing } = unmark("x.md", marked);
    expect(pairing.problems).toEqual([]);
    expect(text).toBe("a MUST b c d");
    expect(spans.map((s) => [s.id, text.slice(s.start, s.end)])).toEqual([
      ["ACS-REQ-0001", "MUST b"],
      ["ACS-DEF-0002", "d"],
    ]);
  });
});

describe("lintSchemaRefs -- pointers, pins, and moved subschemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "acs-ir-sr-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.json"), JSON.stringify({ properties: { x: { enum: ["1", "2"] }, "s/l": { type: "string" } } }));
  const pinned = hashSubschema(["1", "2"]);

  it("resolves RFC 6901 pointers including escapes, and hashes with sorted keys", () => {
    const doc = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    expect(resolvePointer(doc, "/properties/x/enum/1")).toBe("2");
    expect(resolvePointer(doc, "/properties/s~1l/type")).toBe("string");
    expect(resolvePointer(doc, "/properties/nope")).toBeUndefined();
    expect(hashSubschema({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(hashSubschema({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it("reports a missing file, a dead pointer, an unpinned ref, and a moved pin", () => {
    const check = lintSchemaRefs(
      [
        { id: "ACS-REQ-0001", refs: [{ file: "b.json", pointer: "/x" }] },
        { id: "ACS-REQ-0002", refs: [{ file: "a.json", pointer: "/properties/y" }] },
        { id: "ACS-REQ-0003", refs: [{ file: "a.json", pointer: "/properties/x/enum" }] },
        { id: "ACS-REQ-0004", refs: [{ file: "a.json", pointer: "/properties/x/enum", pinned: "0".repeat(64) }] },
        { id: "ACS-REQ-0005", refs: [{ file: "a.json", pointer: "/properties/x/enum", pinned }] },
      ],
      dir,
    );
    expect(check.problems).toEqual([
      `ACS-REQ-0001: schema_refs cites b.json, which is not in ${dir}`,
      "ACS-REQ-0002: schema_refs pointer a.json#/properties/y does not resolve",
      `ACS-REQ-0003: schema_refs a.json#/properties/x/enum has no pinned hash; pin ${pinned.slice(0, 12)}…`,
    ]);
    expect(check.changed.map((c) => c.id)).toEqual(["ACS-REQ-0004"]);
  });
});
