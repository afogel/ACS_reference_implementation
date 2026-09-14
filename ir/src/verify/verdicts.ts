/**
 * E12 and N45 to N47: from the verdict relations to verdicts a report can carry.
 *
 * The judgement itself is Datalog (`compile/verdict-layer.ts`): which
 * sessions activated a provision, whether the relations it needs were
 * supplied, whether a conditional obligation's condition arose, and
 * whether a violation is a failure (MUST) or a deviation (SHOULD). This
 * module reads those relations back and folds the per-session verdicts of
 * a provision into the one the report shows: any failure is a failure,
 * else any deviation, else any pass, else not exercised, else not
 * activated. Provisions that did not compile get their verdict from the
 * catalog as before: permissions yield none (R4.6), exclusions are listed
 * (R4.8), non-testable and inexpressible ones are listed, never dropped
 * (R4.4, R3.6). `attachEvidence()` names each violation's subject and
 * witness columns and gathers the facts that mention the subject (R3.4).
 *
 * Activation conditions written in prose (R4.5) are carried into the
 * report as text; the ones this catalog needed mechanically are already
 * inside the predicates (`decision(Seq, "defer")`, `archived(Session)`).
 */
import { effectiveKeyword, type CanonicalKeyword, type Catalog } from "../catalog/catalog.ts";
import type { CompiledProvision, RuleProgram } from "../compile/compile.ts";
import type { Evaluation, Violation } from "./evaluate.ts";
import type { FactSet, Value } from "./facts.ts";

export type Verdict =
  | "pass"
  | "fail"
  | "deviates"
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
  /** The RFC 2119 keyword the provision is judged by (the record's, else the marked span's). */
  keyword: CanonicalKeyword | null;
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
  /** For a compiled provision, the verdict in each session the trace holds; the report shows the fold. */
  sessions: { session: string; verdict: Verdict }[];
}

/** The fold over sessions: the first of these that any session reached. */
const FOLD: Verdict[] = ["fail", "deviates", "pass", "not-exercised", "not-activated"];

export function judge(program: RuleProgram, catalog: Catalog, evaluation: Evaluation, facts: FactSet, stale: Set<string>): ProvisionVerdict[] {
  const compiled = new Map(program.provisions.map((p) => [p.id, p]));
  const byProvision = new Map<string, Violation[]>();
  for (const v of evaluation.violations) byProvision.set(v.provision, [...(byProvision.get(v.provision) ?? []), v]);
  const sessions = [...new Set((facts.get("negotiated") ?? []).map((t) => String(t[0])))].sort();
  const available = new Set((facts.get("available") ?? []).map((t) => String(t[0])));
  const needs = new Map<string, string[]>();
  for (const t of program.verdicts.catalog.find((r) => r.name === "needs")?.facts ?? []) needs.set(String(t[0]), [...(needs.get(String(t[0])) ?? []), String(t[1])]);
  const held = (relation: string, id: string, session: string): boolean => (evaluation.verdicts.get(relation) ?? []).some((t) => t[0] === id && (t.length < 2 || t[1] === session));
  const verdicts = new Map<string, ProvisionVerdict>();

  for (const { manifest, record } of catalog.entries) {
    const base: ProvisionVerdict = {
      id: manifest.id,
      title: record.title,
      type: manifest.type,
      level: manifest.level,
      keyword: manifest.type === "Requirement" ? effectiveKeyword(manifest, record) : null,
      actor: record.actor,
      profile: record.profile,
      activation: record.activation,
      verdict: "pass",
      needs_review: stale.has(manifest.id),
      reason: null,
      missing: [],
      evidence: [],
      sessions: [],
    };
    const c = compiled.get(manifest.id);
    // Not activated in every session: the Datalog `not_activated` relation, over every Requirement (R4.3), checked before the catalog statuses as the report always has.
    const inactive = sessions.length > 0 && sessions.every((session) => held("not_activated", manifest.id, session));
    if (manifest.type === "Exclusion") verdicts.set(manifest.id, { ...base, verdict: "exclusion", reason: "ACS deliberately requires nothing here" });
    else if (manifest.type === "Definition") verdicts.set(manifest.id, { ...base, verdict: "definition", reason: "a definition; verified through the Requirements that depend on it" });
    else if (manifest.type === "Invariant") verdicts.set(manifest.id, { ...base, verdict: "invariant", reason: "an invariant; verified through the Requirements that enforce it" });
    else if (!c) verdicts.set(manifest.id, { ...base, verdict: "unevaluated", reason: "not compiled" });
    else if (inactive) {
      const negotiated = [...new Set((facts.get("negotiated") ?? []).map((t) => String(t[1])))].sort();
      verdicts.set(manifest.id, { ...base, verdict: "not-activated", reason: `needs ${(record.profile as string[]).join(" or ")}; the session negotiated ${negotiated.join(", ")}`, sessions: sessions.map((session) => ({ session, verdict: "not-activated" as const })) });
    } else if (c.status === "permission") verdicts.set(manifest.id, { ...base, verdict: "permission", reason: c.reason });
    else if (c.status === "non-testable") verdicts.set(manifest.id, { ...base, verdict: "non-testable", reason: c.reason });
    else if (c.status === "inexpressible") verdicts.set(manifest.id, { ...base, verdict: "inexpressible", reason: c.reason });
    else if (c.status === "alias") verdicts.set(manifest.id, base); // filled below once the target is known
    else if ((evaluation.verdicts.get("unevaluated") ?? []).some((t) => t[0] === manifest.id)) {
      const missing = (needs.get(manifest.id) ?? []).filter((r) => !available.has(r));
      verdicts.set(manifest.id, { ...base, verdict: "unevaluated", missing, reason: `needs ${missing.join(", ")}, which the verifier was not given` });
    } else {
      const perSession = sessions.map((session) => {
        const verdict: Verdict = held("fail", manifest.id, session)
          ? "fail"
          : held("deviates", manifest.id, session)
            ? "deviates"
            : held("pass", manifest.id, session)
              ? "pass"
              : held("not_exercised", manifest.id, session)
                ? "not-exercised"
                : "not-activated";
        return { session, verdict };
      });
      const verdict = FOLD.find((v) => perSession.some((s) => s.verdict === v)) ?? "not-activated";
      const reason =
        verdict === "not-activated"
          ? sessions.length
            ? `needs ${record.profile === "all" ? "any profile" : (record.profile as string[]).join(" or ")}; no session negotiated it`
            : "no session negotiated a profile"
          : verdict === "not-exercised"
            ? "the permission it is conditional on was not exercised in this trace"
            : verdict === "deviates"
              ? `a ${base.keyword ?? "SHOULD"}: a deviation, not a failure`
              : null;
      const evidence = verdict === "fail" || verdict === "deviates" ? (byProvision.get(manifest.id) ?? []).map((v) => attachEvidence(c, v, facts)) : [];
      verdicts.set(manifest.id, { ...base, verdict, reason, evidence, sessions: perSession });
    }
  }
  for (const c of program.provisions) {
    if (c.status !== "alias" || !c.alias_of) continue;
    const target = verdicts.get(c.alias_of);
    const own = verdicts.get(c.id);
    if (target && own) verdicts.set(c.id, { ...own, verdict: target.verdict, reason: `${c.reason}: ${target.reason ?? target.verdict}`, missing: target.missing, evidence: target.evidence, sessions: target.sessions });
  }
  return [...verdicts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** N45: a provision's profile list meets the negotiated profiles; `all` always does. The verdict rules do this per session; the report uses it per claimed profile. */
export function scopeByProfile(profile: string[] | "all", negotiated: string[]): boolean {
  if (profile === "all") return true;
  return profile.some((p) => negotiated.includes(p));
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
