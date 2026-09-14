/**
 * The V3 demo, as a test: change one word inside the Intent immutability
 * callout, re-extract, and the lint names the Invariant, the §8.4
 * Requirement that depends on it, and that Requirement's own dependent --
 * none of which contain the edited word -- while the census keyword count
 * is unchanged. Run against the marked corpus, which is what the extractor
 * reads once markers live upstream; with the overlay still in place, the
 * same edit also needs its quote updated, and the answer is the same.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, loadRecords } from "../src/catalog/catalog.ts";
import { checkStaleness } from "../src/catalog/staleness.ts";
import { collectTestCitations } from "../src/catalog/test-citations.ts";
import { loadCorpus, readSource } from "../src/corpus.ts";
import { extractProvisions } from "../src/extract/extract.ts";
import { keywordScan } from "../src/census/keyword-scan.ts";
import { applyOverlay, defaultMarkersDir, parseOverlay, resolveOverlay } from "../src/markers/overlay.ts";

describe("V3 demo -- a one-word edit to a concept page", () => {
  const corpus = loadCorpus();
  const entries = parseOverlay(readFileSync(join(defaultMarkersDir(), "overlay.yaml"), "utf8"));
  const { spans } = resolveOverlay(entries, (f) => (corpus.files.includes(f) ? readSource(corpus, f) : null));
  const marked = mkdtempSync(join(tmpdir(), "acs-ir-demo-"));
  applyOverlay(corpus, spans, (f) => readSource(corpus, f), marked);
  const records = loadRecords().records;

  it("starts clean", () => {
    const before = extractProvisions(marked, corpus.files, { version: null, commit: null });
    expect(checkStaleness(loadCatalog(before.manifest, records), collectTestCitations()).stale).toEqual([]);
  });

  it("names the Invariant, the Requirement that depends on it, and the Requirement downstream of that", () => {
    const page = join(marked, "concepts/intent.md");
    const original = readFileSync(page, "utf8");
    const edited = original.replace("It may grow only through approver action via the ASK flow.", "It may widen only through approver action via the ASK flow.");
    expect(edited).not.toBe(original);
    writeFileSync(page, edited);

    const after = extractProvisions(marked, corpus.files, { version: null, commit: null });
    expect(after.problems).toEqual([]);
    const report = checkStaleness(loadCatalog(after.manifest, records), collectTestCitations());
    expect(report.stale.map((s) => [s.id, s.reasons.map((r) => r.kind), s.invalidates])).toEqual([
      ["ACS-INV-0001", ["text_changed"], ["ACS-REQ-0011"]],
      ["ACS-REQ-0011", ["dependency_stale"], ["ACS-REQ-0012"]],
      ["ACS-REQ-0012", ["dependency_stale"], []],
    ]);
    expect(report.stale.every((s) => s.tests.length === 0)).toBe(true);
    // No RFC 2119 keyword moved.
    expect(keywordScan("concepts/intent.md", edited).occurrences.length).toBe(keywordScan("concepts/intent.md", original).occurrences.length);
  });
});
