/**
 * E12 and N45 to N47: from violation tuples to verdicts a report can carry.
 *
 * `scopeByProfile()` drops provisions the session never activated (R4.3):
 * a provision's profile list must meet the profiles the trace negotiated,
 * `all` always does. `applyModality()` gives permissions no verdict (R4.6)
 * and marks a conditional-on-exercise obligation `not-exercised` when the
 * Guardian-state relations it reads are empty. Exclusions never yield a
 * violation and are reported as such (R4.8); non-testable and inexpressible
 * provisions are listed, never dropped (R4.4, R3.6). A provision whose
 * predicate needs a relation nobody supplied is `unevaluated`, never
 * `pass`. `attachEvidence()` names each violation's subject and witness
 * columns and gathers the facts that mention the subject (R3.4).
 *
 * Activation conditions written in prose (R4.5) are carried into the
 * report as text; the ones this catalog needed mechanically are already
 * inside the predicates (`decision(Seq, "defer")`, `archived(Session)`).
 */
import type { Catalog } from "../catalog/catalog.ts";
import type { CompiledProvision, RuleProgram } from "../compile/compile.ts";
import type { Relation } from "../compile/vocabulary.ts";
import type { Violation } from "./evaluate.ts";
import type { FactSet, Value } from "./facts.ts";

export type Verdict =
  | "pass"
  | "fail"
  | "not-activated"
  | "not-exercised"
  | "permission"
  | "non-testable"
  | "inexpressible"
  | "unevaluated"
  | "exclusion"
  | "definition"
  | "invariant";

export interface Evidence {
  subject: { name: string; value: Value }[];
  witness: { name: string; value: Value }[];
  /** Facts from the relations the predicate reads that mention a subject value. */
  facts: { relation: string; tuple: Value[] }[];
}

export interface ProvisionVerdict {
  id: string;
  title: string;
  type: string;
  level: string | null;
  actor: string;
  profile: string[] | "all";
  activation: string | null;
  verdict: Verdict;
  /** The record is stale (V3): the verdict is based on a text the reviewer has not re-read. */
  needs_review: boolean;
  reason: string | null;
  /** Relations the predicate needed and nobody supplied. */
  missing: string[];
  evidence: Evidence[];
}

export function judge(
  program: RuleProgram,
  catalog: Catalog,
  violations: Violation[],
  facts: FactSet,
  negotiated: string[],
  available: Set<string>,
  stale: Set<string>,
): ProvisionVerdict[] {
  const compiled = new Map(program.provisions.map((p) => [p.id, p]));
  const relations = new Map(program.relations.map((r) => [r.name, r]));
  const byProvision = new Map<string, Violation[]>();
  for (const v of violations) byProvision.set(v.provision, [...(byProvision.get(v.provision) ?? []), v]);
  const verdicts = new Map<string, ProvisionVerdict>();

  for (const { manifest, record } of catalog.entries) {
    const base: ProvisionVerdict = {
      id: manifest.id,
      title: record.title,
      type: manifest.type,
      level: manifest.level,
      actor: record.actor,
      profile: record.profile,
      activation: record.activation,
      verdict: "pass",
      needs_review: stale.has(manifest.id),
      reason: null,
      missing: [],
      evidence: [],
    };
    const c = compiled.get(manifest.id);
    if (manifest.type === "Exclusion") verdicts.set(manifest.id, { ...base, verdict: "exclusion", reason: "ACS deliberately requires nothing here" });
    else if (manifest.type === "Definition") verdicts.set(manifest.id, { ...base, verdict: "definition", reason: "a definition; verified through the Requirements that depend on it" });
    else if (manifest.type === "Invariant") verdicts.set(manifest.id, { ...base, verdict: "invariant", reason: "an invariant; verified through the Requirements that enforce it" });
    else if (!c) verdicts.set(manifest.id, { ...base, verdict: "unevaluated", reason: "not compiled" });
    else if (!scopeByProfile(record.profile, negotiated)) verdicts.set(manifest.id, { ...base, verdict: "not-activated", reason: `needs ${(record.profile as string[]).join(" or ")}; the session negotiated ${negotiated.join(", ")}` });
    else if (c.status === "permission") verdicts.set(manifest.id, { ...base, verdict: "permission", reason: c.reason });
    else if (c.status === "non-testable") verdicts.set(manifest.id, { ...base, verdict: "non-testable", reason: c.reason });
    else if (c.status === "inexpressible") verdicts.set(manifest.id, { ...base, verdict: "inexpressible", reason: c.reason });
    else if (c.status === "alias") verdicts.set(manifest.id, base); // filled below once the target is known
    else verdicts.set(manifest.id, applyModality(base, c, record.modality_kind, facts, relations, available, byProvision.get(manifest.id) ?? []));
  }
  for (const c of program.provisions) {
    if (c.status !== "alias" || !c.alias_of) continue;
    const target = verdicts.get(c.alias_of);
    const own = verdicts.get(c.id);
    if (target && own) verdicts.set(c.id, { ...own, verdict: target.verdict, reason: `${c.reason}: ${target.reason ?? target.verdict}`, missing: target.missing, evidence: target.evidence });
  }
  return [...verdicts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** N45 */
export function scopeByProfile(profile: string[] | "all", negotiated: string[]): boolean {
  if (profile === "all") return true;
  return profile.some((p) => negotiated.includes(p));
}

/** N46, then N47 for a failing obligation. */
function applyModality(
  base: ProvisionVerdict,
  c: CompiledProvision,
  modality: string,
  facts: FactSet,
  relations: Map<string, Relation>,
  available: Set<string>,
  violations: Violation[],
): ProvisionVerdict {
  const missing = c.relations_used.filter((r) => {
    const source = relations.get(r)?.source;
    return source !== "wire" && source !== "static" && !available.has(r);
  });
  if (missing.length) return { ...base, verdict: "unevaluated", missing, reason: `needs ${missing.join(", ")}, which the verifier was not given` };
  if (modality === "conditional-on-exercise") {
    const stateRelations = c.relations_used.filter((r) => relations.get(r)?.source === "guardian-state");
    if (stateRelations.every((r) => (facts.get(r) ?? []).length === 0)) {
      return { ...base, verdict: "not-exercised", reason: "the permission it is conditional on was not exercised in this trace" };
    }
  }
  if (violations.length === 0) return base;
  return { ...base, verdict: "fail", evidence: violations.map((v) => attachEvidence(c, v, facts)) };
}

/** N47 */
export function attachEvidence(c: CompiledProvision, v: Violation, facts: FactSet): Evidence {
  const subject = c.subject.map((name, i) => ({ name, value: v.subject[i] as Value }));
  const witness = c.witness.map((name, i) => ({ name, value: v.witness[i] as Value }));
  const subjectValues = new Set(v.subject.map(String));
  const witnessing: Evidence["facts"] = [];
  const seen = new Set<string>();
  for (const relation of c.relations_used) {
    for (const tuple of facts.get(relation) ?? []) {
      if (!tuple.some((x) => subjectValues.has(String(x)))) continue;
      const key = `${relation}(${JSON.stringify(tuple)})`;
      if (seen.has(key)) continue;
      seen.add(key);
      witnessing.push({ relation, tuple });
    }
  }
  return { subject, witness, facts: witnessing.slice(0, 24) };
}
