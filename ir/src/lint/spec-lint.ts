/**
 * E9 and N20: `specLint()` -- the spec PR polices itself.
 *
 * One pass over the marked corpus, the records, the allocation files, the
 * conformance tests and the pinned schemas, against a baseline: the
 * committed generated files (the manifest and the census), or with
 * `--baseline`, the base branch's copies of them, so a PR is judged by what
 * it changed rather than by what its author regenerated.
 *
 *  - N22 marker pairing: unpaired, mismatched or nested markers      -> fail
 *  - N21 unmarked keyword: an RFC 2119 occurrence not in the baseline
 *        census that is neither bound nor excluded                    -> fail (U25)
 *  - N23 tombstone: an ID in the baseline manifest and not in the
 *        fresh one, or a withdrawn record, with no tombstone; or a
 *        tombstoned ID back in use                                   -> fail (U24)
 *  - N24 duplicate / unallocated ID                                  -> fail
 *  - N25 unknown citation: a test citing an ID that is neither live
 *        nor tombstoned                                              -> fail
 *  - N26 schema refs: an unresolvable pointer or an unpinned ref      -> fail;
 *        a moved subschema                                           -> needs-review
 *  - N16 staleness (V3), extended with the schema reason             -> needs-review (U22)
 *  - added provisions with no conformance test                        -> reported (U23)
 *
 * Failures and needs-review both exit 1; the difference is what the
 * reviewer does about them. A failure is fixed in the tree; needs-review is
 * cleared by classifying the change and updating the record.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, loadRecords } from "../catalog/catalog.ts";
import { checkStaleness, type StaleEntry, type StalenessReport, type TestCitations } from "../catalog/staleness.ts";
import { provisionCensus, type ProvisionCensus } from "../census/provision-census.ts";
import { parseSourceDeclarations, sourceCensus } from "../census/source-census.ts";
import { parseExclusions, resolveExclusions } from "../census/exclusions.ts";
import type { Corpus } from "../corpus.ts";
import { extractProvisions, type Manifest } from "../extract/extract.ts";
import { checkAllocated, ID_PATTERN, readCounter, readTombstones } from "../ids.ts";
import type { ResolvedSpan } from "../markers/overlay.ts";
import { lintSchemaRefs } from "./schema-refs.ts";
import { unmark } from "./unmark.ts";

export type Rule = "marker-pairing" | "unmarked-keyword" | "tombstone" | "duplicate-id" | "unknown-citation" | "schema-refs" | "catalog";

export interface Finding {
  rule: Rule;
  /** `file:line` when the finding has a place in the corpus. */
  where: string | null;
  message: string;
}

export interface UnmarkedOccurrence {
  source: string;
  line: number;
  column: number;
  keyword: string;
  context: string;
}

export interface LintReport {
  corpus: { version: string | null; commit: string | null };
  findings: Finding[];
  /** U25: keyword occurrences new since the baseline and bound to nothing. */
  unmarked: UnmarkedOccurrence[];
  /** U24: IDs gone from the corpus with no tombstone. */
  removed_without_tombstone: string[];
  /** U23: IDs new since the baseline with no conformance test citing them. */
  added_without_test: string[];
  /** U22: needs-review, with what each invalidated and the tests citing it. */
  stale: StaleEntry[];
  worklist: StalenessReport["worklist"];
  /** Provisions whose text_hash differs from the baseline manifest's: what this change touched. */
  changed: { id: string; source_file: string; line: number }[];
  ok: boolean;
}

export interface Baseline {
  manifest: Manifest | null;
  census: ProvisionCensus | null;
}

export interface LintInputs {
  corpus: Corpus;
  markedDir: string;
  sourcesFile: string;
  /** Authored census exclusions; absent means none. */
  exclusionsFile?: string | null;
  provisionsDir: string;
  idsDir: string;
  schemaDir: string;
  citations: TestCitations;
  baseline: Baseline;
}

/** The committed generated files under `dir` (`manifest/provisions.json`, `census/provisions.yaml`), each absent-tolerant. */
export function loadBaseline(dir: string): Baseline {
  const manifestPath = join(dir, "manifest", "provisions.json");
  const censusPath = join(dir, "census", "provisions.yaml");
  return {
    manifest: existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : null,
    census: existsSync(censusPath) ? (Bun.YAML.parse(readFileSync(censusPath, "utf8")) as ProvisionCensus) : null,
  };
}

export function specLint(inputs: LintInputs): LintReport {
  const { corpus, markedDir } = inputs;
  const findings: Finding[] = [];
  const at = (rule: Rule, where: string | null, message: string): void => {
    findings.push({ rule, where, message });
  };

  // 1. The marked corpus, read back: pairing (N22) and the prose the census sees.
  const texts = new Map<string, string>();
  const spans: ResolvedSpan[] = [];
  const reportedPairing = new Set<string>();
  for (const file of corpus.files) {
    const path = join(markedDir, file);
    if (!existsSync(path)) {
      at("marker-pairing", file, "missing from the marked corpus; run `acs-ir markers apply`");
      continue;
    }
    const result = unmark(file, readFileSync(path, "utf8"));
    for (const p of result.pairing.problems) {
      reportedPairing.add(p);
      const colon = p.indexOf(": ");
      at("marker-pairing", colon === -1 ? file : p.slice(0, colon), colon === -1 ? p : p.slice(colon + 2));
    }
    texts.set(file, result.text);
    spans.push(...result.spans);
  }

  // 2. The manifest (N4) and the census over the same prose.
  const extraction = extractProvisions(markedDir, corpus.files, { version: corpus.version, commit: corpus.commit });
  for (const p of extraction.problems) {
    if (!p.includes("missing from the marked corpus") && !reportedPairing.has(p)) at("marker-pairing", null, p);
  }
  const declared = parseSourceDeclarations(readFileSync(inputs.sourcesFile, "utf8"));
  const sources = sourceCensus(declared, corpus.files);
  for (const p of sources.problems) at("catalog", null, `sources.yaml: ${p}`);
  let exclusions: ReturnType<typeof resolveExclusions>["exclusions"] = [];
  if (inputs.exclusionsFile && existsSync(inputs.exclusionsFile)) {
    const resolved = resolveExclusions(parseExclusions(readFileSync(inputs.exclusionsFile, "utf8")), (file) => texts.get(file) ?? null);
    for (const p of resolved.problems) at("catalog", null, `exclusions.yaml: ${p}`);
    exclusions = resolved.exclusions;
  }
  const census = provisionCensus(corpus, declared, (file) => texts.get(file) ?? "", spans, exclusions);
  for (const p of census.exclusion_problems) at("catalog", null, `exclusions.yaml: ${p}`);

  // 3. Records and the join (N15), then IDs (N24) against the allocation files.
  const records = loadRecords(inputs.provisionsDir);
  for (const p of records.problems) at("catalog", null, p);
  const catalog = loadCatalog(extraction.manifest, records.records);
  for (const p of catalog.problems) at("catalog", null, p);
  const counter = readCounter(inputs.idsDir);
  const tombstones = readTombstones(inputs.idsDir);
  const liveIds = extraction.manifest.provisions.map((p) => p.id);
  for (const p of checkAllocated(liveIds, counter, tombstones)) at("duplicate-id", null, p);
  for (const p of checkAllocated(records.records.map((r) => r.id), counter, tombstones)) {
    // A withdrawn record of a tombstoned ID is the expected state, so only allocation and duplication are faults here.
    if (/never allocated|used more than once/.test(p)) at("duplicate-id", null, `record ${p}`);
  }

  // 4. Tombstones (N23): gone from the corpus, or withdrawn, means retired on record.
  const retired = new Set(tombstones.map((t) => t.id));
  const live = new Set(liveIds);
  const removedWithoutTombstone: string[] = [];
  for (const id of (inputs.baseline.manifest?.provisions ?? []).map((p) => p.id)) {
    if (!live.has(id) && !retired.has(id)) removedWithoutTombstone.push(id);
  }
  for (const id of removedWithoutTombstone) at("tombstone", null, `${id}: marked in the baseline, gone from the corpus, and not tombstoned (R2.2)`);
  for (const r of records.records) {
    if (r.status === "withdrawn" && !retired.has(r.id)) at("tombstone", null, `${r.id}: record is withdrawn but ids/tombstones.yaml has no entry for it`);
    if (r.status === "active" && retired.has(r.id)) at("tombstone", null, `${r.id}: tombstoned, yet its record is still active`);
  }
  for (const id of liveIds) if (retired.has(id)) at("tombstone", null, `${id}: tombstoned, yet still marked in the corpus`);

  // 5. Citations (N25): tests may cite only live or retired IDs.
  for (const [id, files] of inputs.citations) {
    if (!ID_PATTERN.test(id) || (!live.has(id) && !retired.has(id))) {
      at("unknown-citation", files[0] ?? null, `${id}: cited by ${files.join(", ")} but is neither a marked provision nor a tombstone`);
    }
  }

  // 6. Schema refs (N26).
  const schemaCheck = lintSchemaRefs(
    records.records.map((r) => ({ id: r.id, refs: r.schema_refs })),
    inputs.schemaDir,
  );
  for (const p of schemaCheck.problems) at("schema-refs", null, p);

  // 7. Staleness (N16-N18), extended with moved subschemas.
  const staleness = checkStaleness(catalog, inputs.citations);
  const stale = staleness.stale;
  for (const c of schemaCheck.changed) {
    const reason = {
      kind: "text_changed" as const,
      reviewed_against: `${c.ref.file}#${c.ref.pointer} ${c.pinned.slice(0, 12)}`,
      text_hash: c.current.slice(0, 12),
    };
    const entry = stale.find((s) => s.id === c.id);
    if (entry) entry.reasons.push(reason);
    else {
      const m = extraction.manifest.provisions.find((p) => p.id === c.id);
      stale.push({ id: c.id, source_file: m?.source_file ?? "?", line: m?.line ?? 0, reasons: [reason], invalidates: [], tests: inputs.citations.get(c.id) ?? [] });
    }
  }
  stale.sort((a, b) => a.id.localeCompare(b.id));

  // 8. Unmarked keywords (N21): unbound now and not unbound in the baseline.
  const baselineUnbound = new Set((inputs.baseline.census?.occurrences ?? []).filter((o) => o.binding.kind === "unbound").map(identity));
  const unmarked: UnmarkedOccurrence[] = census.occurrences
    .filter((o) => o.binding.kind === "unbound" && !baselineUnbound.has(identity(o)))
    .map((o) => ({ source: o.source, line: o.line, column: o.column, keyword: o.keyword, context: o.context }));
  for (const u of unmarked) at("unmarked-keyword", `${u.source}:${u.line}`, `${u.keyword} with no marker and no census exclusion: ${u.context}`);

  // 9. What this change touched, for the comment: changed, and added without a test.
  const baselineHashes = new Map((inputs.baseline.manifest?.provisions ?? []).map((p) => [p.id, p.text_hash]));
  const changed = extraction.manifest.provisions
    .filter((p) => baselineHashes.has(p.id) && baselineHashes.get(p.id) !== p.text_hash)
    .map((p) => ({ id: p.id, source_file: p.source_file, line: p.line }));
  const addedWithoutTest = inputs.baseline.manifest
    ? extraction.manifest.provisions.filter((p) => !baselineHashes.has(p.id) && !inputs.citations.get(p.id)?.length).map((p) => p.id)
    : [];

  return {
    corpus: extraction.manifest.corpus,
    findings,
    unmarked,
    removed_without_tombstone: removedWithoutTombstone,
    added_without_test: addedWithoutTest,
    stale,
    worklist: staleness.worklist,
    changed,
    ok: findings.length === 0 && stale.length === 0,
  };
}

/** An occurrence's identity across edits: where it is by prose, not by line number. */
function identity(o: { source: string; keyword: string; context: string }): string {
  return `${o.source} ${o.keyword} ${o.context}`;
}
