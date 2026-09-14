/**
 * E5.2: staleness propagation. N16 `checkStaleness()`, N17 `walkDependsOn()`,
 * N18 `checkRestatement()`.
 *
 * One computation, three edge types. A record pins `reviewed_against`, the
 * `text_hash` it was last reviewed against; a mismatch means the prose moved
 * under the record (R2.4). From every such root the walk follows the
 * catalog's edges in reverse: a Requirement that `depends_on` a changed
 * Definition or Invariant is stale even though no keyword sentence changed
 * (R2.6), and a pillar copy that `restates` a changed concept-page provision
 * is stale because the concept page is canonical (R2.9, `concepts/README.md:33`).
 * Conformance tests that cite a stale provision are listed with it.
 *
 * Nothing here is ever marked invalid. The output is `needs-review`; a person
 * classifies the change as editorial, semantic, or split, and clears the
 * flag by updating `reviewed_against` (or issuing new IDs).
 *
 * The migration worklist (R6.6) falls out of the same pass: every live
 * `restates` edge is an inline pillar copy still awaiting replacement by a
 * reference to the concept page.
 */
import type { Catalog } from "./catalog.ts";

export type StaleReason =
  | { kind: "text_changed"; reviewed_against: string; text_hash: string }
  | { kind: "dependency_stale"; via: string }
  | { kind: "restatement_diverged"; canonical: string };

export interface StaleEntry {
  id: string;
  source_file: string;
  line: number;
  reasons: StaleReason[];
  /** Provisions this one's staleness propagated to, directly. */
  invalidates: string[];
  /** Conformance tests citing this provision (S14). Empty until V5 brings the fixtures. */
  tests: string[];
}

export interface WorklistEntry {
  /** The inline pillar copy. */
  pillar: string;
  pillar_source: string;
  pillar_line: number;
  /** The canonical concept-page provision it restates. */
  canonical: string;
  canonical_source: string;
}

export interface StalenessReport {
  stale: StaleEntry[];
  worklist: WorklistEntry[];
}

/** Test citations: provision ID -> the test files that cite it. */
export type TestCitations = Map<string, string[]>;

export function checkStaleness(catalog: Catalog, citations: TestCitations = new Map()): StalenessReport {
  const byId = new Map(catalog.entries.map((e) => [e.manifest.id, e]));
  const stale = new Map<string, StaleEntry>();
  const entryFor = (id: string): StaleEntry => {
    const existing = stale.get(id);
    if (existing) return existing;
    const e = byId.get(id);
    if (!e) throw new Error(`${id}: not in the catalog`);
    const created: StaleEntry = {
      id,
      source_file: e.manifest.source_file,
      line: e.manifest.line,
      reasons: [],
      invalidates: [],
      tests: citations.get(id) ?? [],
    };
    stale.set(id, created);
    return created;
  };

  // N16: roots -- records whose prose moved under them.
  const roots: string[] = [];
  for (const { manifest, record } of catalog.entries) {
    if (record.reviewed_against !== manifest.text_hash) {
      entryFor(manifest.id).reasons.push({ kind: "text_changed", reviewed_against: record.reviewed_against, text_hash: manifest.text_hash });
      roots.push(manifest.id);
    }
  }

  // N17 and N18: reverse edges, walked from every root.
  const dependents = new Map<string, string[]>();
  const restaters = new Map<string, string[]>();
  for (const { manifest, record } of catalog.entries) {
    for (const dep of record.depends_on) dependents.set(dep, [...(dependents.get(dep) ?? []), manifest.id]);
    if (record.restates) restaters.set(record.restates, [...(restaters.get(record.restates) ?? []), manifest.id]);
  }
  const queue = [...roots];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const from = entryFor(id);
    for (const dependent of walkDependsOn(id, dependents)) {
      const target = entryFor(dependent);
      if (!target.reasons.some((r) => r.kind === "dependency_stale" && r.via === id)) target.reasons.push({ kind: "dependency_stale", via: id });
      if (!from.invalidates.includes(dependent)) from.invalidates.push(dependent);
      queue.push(dependent);
    }
    for (const copy of checkRestatement(id, restaters)) {
      const target = entryFor(copy);
      if (!target.reasons.some((r) => r.kind === "restatement_diverged")) target.reasons.push({ kind: "restatement_diverged", canonical: id });
      if (!from.invalidates.includes(copy)) from.invalidates.push(copy);
      queue.push(copy);
    }
  }

  const worklist: WorklistEntry[] = catalog.entries
    .filter((e) => e.record.restates !== null && e.record.status === "active")
    .map((e) => {
      const canonical = byId.get(e.record.restates as string);
      return {
        pillar: e.manifest.id,
        pillar_source: e.manifest.source_file,
        pillar_line: e.manifest.line,
        canonical: e.record.restates as string,
        canonical_source: canonical?.manifest.source_file ?? "?",
      };
    });

  return { stale: [...stale.values()].sort((a, b) => a.id.localeCompare(b.id)), worklist };
}

/** N17: the provisions that declare `depends_on` the given one. */
export function walkDependsOn(id: string, dependents: Map<string, string[]>): string[] {
  return dependents.get(id) ?? [];
}

/** N18: the pillar copies that `restates` the given provision; a changed canonical makes each of them diverge. */
export function checkRestatement(id: string, restaters: Map<string, string[]>): string[] {
  return restaters.get(id) ?? [];
}
