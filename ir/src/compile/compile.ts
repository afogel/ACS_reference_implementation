/**
 * X2's answer, part two: N31 `compilePredicate()`, N32 `flagInexpressible()`,
 * N36 `requireEvidenceColumns()`.
 *
 * Every predicate is checked against the vocabulary and turned into a typed
 * rule program that both emitters read (R3.3: the IR predicate is the
 * authority; the `.dl` and the evaluator's rules are generated from it,
 * never hand-written beside it). The checks:
 *
 *  - every relation is a vocabulary relation or a helper the predicate
 *    defines; arity matches; every variable has one type and one domain
 *    (a variable bound to a `seq` column cannot also fill a `bound`
 *    column, and two different domains cannot be compared)
 *  - safety: every variable in a head, a negated atom, or a comparison is
 *    bound by a positive atom (or is the target of `count`, or the left
 *    side of `Var = expr` with `expr` bound)
 *  - stratification: no relation depends negatively on itself, directly or
 *    through helpers, so both engines compute the same fixpoint
 *  - N36: the `violation` head's arguments are the declared `subject` then
 *    `witness` variables in that order, both lists non-empty, all bound. A
 *    position may hold a constant instead of its variable, which is how a
 *    rule names the field it found missing. A rule that derives a violation
 *    without naming its subject and witness does not compile
 *  - R3.6: a Requirement with neither a predicate nor a declared
 *    `inexpressible` reason is a compile failure, never an unreported skip
 *
 * The external-fact boundary (E7.1) is derived, not authored: the relations
 * a predicate touches whose source is not the wire are listed per provision.
 */
import type { ProvisionRecord, PredicateSpec } from "../catalog/catalog.ts";
import type { ManifestEntry } from "../extract/extract.ts";
import { parseRule, type Rule } from "./predicate.ts";
import { headColumnType, literalAtoms, renameLiteral, sameTy, stratify, toTy, typeRule, type Env, type Ty } from "./typing.ts";
import { buildVerdictLayer, type VerdictLayer } from "./verdict-layer.ts";
import type { Column, ColumnType, Relation, RelationSource, Vocabulary } from "./vocabulary.ts";

export type ProvisionStatus = "compiled" | "non-testable" | "permission" | "alias" | "no-predicate" | "inexpressible";

export interface HelperRelation {
  /** The name as written in the predicate. */
  local: string;
  /** The emitted name, unique across provisions. */
  name: string;
  columns: Column[];
}

export interface CompiledProvision {
  id: string;
  status: ProvisionStatus;
  reason: string | null;
  alias_of: string | null;
  subject: string[];
  witness: string[];
  /** The emitted violation relation: `<slug>__violation`, subject columns then witness columns. */
  violation: { name: string; columns: Column[] } | null;
  helpers: HelperRelation[];
  rules: Rule[];
  /** Rule strata, lowest first; each is the set of emitted relation names computed together. */
  strata: string[][];
  relations_used: string[];
  /** Relations used whose tuples are not derived from the wire (E7.1). */
  external_facts: { relation: string; source: RelationSource }[];
}

export interface RuleProgram {
  generated_by: string;
  corpus: { version: string | null; commit: string | null };
  relations: Relation[];
  /** Every column domain the relations declare, the verdict layer's included, with its base type; the Soufflé emitter declares each as a subtype. */
  domains: { name: string; type: ColumnType }[];
  provisions: CompiledProvision[];
  /** RFC 2119 strength as facts and the verdicts as rules, over the provisions' violation relations. */
  verdicts: VerdictLayer;
  problems: { id: string; message: string }[];
}

export function slug(id: string): string {
  return id.toLowerCase().replace(/-/g, "_");
}

export function compileProgram(
  vocabulary: Vocabulary,
  entries: { manifest: ManifestEntry; record: ProvisionRecord }[],
  corpus: { version: string | null; commit: string | null },
): RuleProgram {
  const provisions: CompiledProvision[] = [];
  const problems: { id: string; message: string }[] = [];
  const ids = new Set(entries.map((e) => e.manifest.id));
  for (const { manifest, record } of entries) {
    try {
      provisions.push(compileProvision(vocabulary, manifest, record, ids));
    } catch (error) {
      problems.push({ id: manifest.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const verdicts = buildVerdictLayer(vocabulary, entries, provisions);
  problems.push(...verdicts.problems);
  return {
    generated_by: "acs-ir compile",
    corpus,
    relations: [...vocabulary.relations.values()],
    domains: [...[...vocabulary.domains.entries()].map(([name, type]) => ({ name, type })), ...verdicts.layer.domains].sort((a, b) => a.name.localeCompare(b.name)),
    provisions,
    verdicts: verdicts.layer,
    problems,
  };
}

function skipped(id: string, status: ProvisionStatus, reason: string | null, alias_of: string | null = null): CompiledProvision {
  return { id, status, reason, alias_of, subject: [], witness: [], violation: null, helpers: [], rules: [], strata: [], relations_used: [], external_facts: [] };
}

export function compileProvision(vocabulary: Vocabulary, manifest: ManifestEntry, record: ProvisionRecord, ids: Set<string>): CompiledProvision {
  const id = manifest.id;
  const spec = record.predicate;
  if (manifest.type !== "Requirement") {
    if (spec) throw new Error(`${id}: a ${manifest.type} carries no predicate; only Requirements are verified`);
    return skipped(id, "no-predicate", `${manifest.type}s are not obligations`);
  }
  if (record.modality_kind === "permission") {
    if (spec) throw new Error(`${id}: a permission generates no obligation and so no predicate`);
    return skipped(id, "permission", "a MAY that was not exercised yields no verdict");
  }
  if (record.evidence_class === "non-testable") {
    if (spec) throw new Error(`${id}: non-testable provisions carry no predicate`);
    return skipped(id, "non-testable", "no trace can falsify it; listed on the non-testable roster");
  }
  if (!spec) throw new Error(`${id}: a testable Requirement needs a predicate, or a declared inexpressible reason`);
  if (spec.kind === "inexpressible") return flagInexpressible(id, spec.reason);
  if (spec.kind === "alias") {
    if (!ids.has(spec.alias_of)) throw new Error(`${id}: predicate aliases ${spec.alias_of}, which is not in the catalog`);
    if (record.restates !== spec.alias_of) throw new Error(`${id}: a predicate alias must point at the provision this one restates`);
    return skipped(id, "alias", `verified through ${spec.alias_of}, which it restates`, spec.alias_of);
  }
  return compilePredicate(vocabulary, id, spec);
}

/** N32: the vocabulary cannot express it, and the record says so. Flagged, counted, never approximated. */
export function flagInexpressible(id: string, reason: string): CompiledProvision {
  if (reason.trim().length === 0) throw new Error(`${id}: inexpressible needs a reason`);
  return skipped(id, "inexpressible", reason);
}

/** N31: parse, type, check safety and stratification, and rename helpers so provisions never collide. */
export function compilePredicate(vocabulary: Vocabulary, id: string, spec: Extract<PredicateSpec, { kind: "rules" }>): CompiledProvision {
  const prefix = slug(id);
  const rules = spec.rules.map((text) => {
    try {
      return parseRule(text);
    } catch (error) {
      throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (rules.length === 0) throw new Error(`${id}: predicate has no rules`);

  // Helper relations: every head that is not `violation`.
  const helperNames = new Set(rules.map((r) => r.head.relation).filter((n) => n !== "violation"));
  for (const h of helperNames) {
    if (vocabulary.relations.has(h)) throw new Error(`${id}: helper ${h} shadows a vocabulary relation`);
    const arities = new Set(rules.filter((r) => r.head.relation === h).map((r) => r.head.args.length));
    if (arities.size > 1) throw new Error(`${id}: helper ${h} has ${[...arities].join(" and ")} columns in different rules`);
  }
  for (const rule of rules) {
    for (const lit of rule.body) {
      for (const atom of literalAtoms(lit)) {
        if (!vocabulary.relations.has(atom.relation) && !helperNames.has(atom.relation)) {
          throw new Error(`${id}: ${atom.relation} is neither a vocabulary relation nor a helper defined by this predicate`);
        }
      }
    }
  }
  if (!rules.some((r) => r.head.relation === "violation")) throw new Error(`${id}: no rule derives violation`);

  // N36: the violation head is subject then witness, both non-empty; each position is its variable or a constant.
  if (spec.subject.length === 0 || spec.witness.length === 0) throw new Error(`${id}: violation needs at least one subject and one witness column`);
  const expectedHead = [...spec.subject, ...spec.witness];
  if (new Set(expectedHead).size !== expectedHead.length) throw new Error(`${id}: subject and witness variables must be distinct`);
  for (const rule of rules.filter((r) => r.head.relation === "violation")) {
    const ok =
      rule.head.args.length === expectedHead.length &&
      rule.head.args.every((a, i) => (a.kind === "var" && a.name === expectedHead[i]) || a.kind === "str" || a.kind === "num");
    if (!ok) {
      const got = rule.head.args.map((a) => (a.kind === "var" ? a.name : a.kind === "str" || a.kind === "num" ? "<constant>" : "?"));
      throw new Error(`${id}: violation(${expectedHead.join(", ")}) is the only allowed head, each position its variable or a constant; got violation(${got.join(", ")})`);
    }
  }

  // Types: iterate until every helper column has a type. Each pass types every
  // rule with what is known and recomputes each derived relation's columns
  // from the heads that produce it.
  const derived = new Map<string, (Ty | null)[]>();
  for (const name of [...helperNames, "violation"]) {
    const arity = rules.find((r) => r.head.relation === name)?.head.args.length ?? 0;
    derived.set(name, Array.from({ length: arity }, () => null));
  }
  const relationTypes = (name: string): (Ty | null)[] | null => vocabulary.relations.get(name)?.columns.map(toTy) ?? derived.get(name) ?? null;
  for (let pass = 0; pass < 8; pass++) {
    let progressed = false;
    for (const [name, current] of derived) {
      const producers = rules.filter((r) => r.head.relation === name);
      const envs = producers.map((rule) => typeRule(id, rule, relationTypes));
      const next = current.map((_, i) => headColumnType(id, name, i, producers, envs));
      if (!next.every((t, i) => sameTy(t, current[i] ?? null))) {
        derived.set(name, next);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  for (const [name, types] of derived) {
    const i = types.findIndex((t) => t === null);
    if (i === -1) continue;
    if (name === "violation") throw new Error(`${id}: violation variable ${expectedHead[i]} is not bound by a positive atom (unsafe)`);
    const arg = rules.find((r) => r.head.relation === name)?.head.args[i];
    throw new Error(`${id}: helper ${name} column ${i + 1}${arg?.kind === "var" ? ` (${arg.name})` : ""} is not bound by a positive atom (unsafe)`);
  }
  // A final pass with every type known checks each rule's body fully.
  for (const rule of rules) typeRule(id, rule, relationTypes, true);

  // Stratification over this predicate's relations.
  const local = new Set(["violation", ...helperNames]);
  const positive = new Map<string, Set<string>>();
  const negative = new Map<string, Set<string>>();
  for (const rel of local) {
    positive.set(rel, new Set());
    negative.set(rel, new Set());
  }
  for (const rule of rules) {
    for (const lit of rule.body) {
      if (lit.kind === "atom" && local.has(lit.atom.relation)) (lit.negated ? negative : positive).get(rule.head.relation)?.add(lit.atom.relation);
      if (lit.kind === "count") for (const a of lit.atoms) if (local.has(a.relation)) negative.get(rule.head.relation)?.add(a.relation);
    }
  }
  const strata = stratify(id, [...local], positive, negative);

  // Emitted names and the assembled result.
  const rename = (name: string): string => (name === "violation" ? `${prefix}__violation` : helperNames.has(name) ? `${prefix}__${name}` : name);
  const renamedRules: Rule[] = rules.map((r) => ({
    head: { relation: rename(r.head.relation), args: r.head.args },
    body: r.body.map((lit) => renameLiteral(lit, rename)),
    source: r.source,
  }));
  const column = (name: string, t: Ty | null): Column => ({ name, type: (t as Ty).base, domain: (t as Ty).domain });
  const helpers: HelperRelation[] = [...helperNames].map((h) => ({
    local: h,
    name: rename(h),
    columns: (derived.get(h) ?? []).map((t, i) => column(`c${i + 1}`, t)),
  }));
  const violation = {
    name: rename("violation"),
    columns: expectedHead.map((name, i) => column(`${i < spec.subject.length ? "subject" : "witness"}_${name.toLowerCase()}`, derived.get("violation")?.[i] ?? null)),
  };
  const used = new Set<string>();
  for (const rule of rules) for (const lit of rule.body) for (const a of literalAtoms(lit)) if (vocabulary.relations.has(a.relation)) used.add(a.relation);
  const relations_used = [...used].sort();
  const external_facts = relations_used
    .map((r) => vocabulary.relations.get(r) as Relation)
    .filter((r) => r.source !== "wire" && r.source !== "static")
    .map((r) => ({ relation: r.name, source: r.source }));
  return {
    id,
    status: "compiled",
    reason: null,
    alias_of: null,
    subject: spec.subject,
    witness: spec.witness,
    violation,
    helpers,
    rules: renamedRules,
    strata: strata.map((s) => s.map(rename)),
    relations_used,
    external_facts,
  };
}
