/**
 * The verdict layer: RFC 2119 strength as facts, verdicts as rules.
 *
 * A provision's rules derive its violations. What a violation means is a
 * question of the provision's keyword and of the session: a MUST breached
 * in a session that activated the provision's profile is a failure, a
 * SHOULD breached there is a deviation, a provision whose relations were
 * not supplied is unevaluated, and a conditional obligation whose
 * condition never arose is not exercised. Until this layer those decisions
 * were TypeScript. Here they are facts generated from the catalog
 * (`strength`, `polarity`, `requires_profile`, `needs`, `conditional`,
 * `compiled`), two relations the run supplies (`negotiated`, `available`),
 * and nine rules, so the published Soufflé program produces verdicts and
 * the differential oracle checks them.
 *
 * Each compiled provision also gets a projection rule, `violated(P, S)`,
 * attributing its violations to a session through a subject column that
 * holds a session or a seq; a provision with neither does not compile. A
 * conditional provision gets `exercised(P, S)`: the positive, non-static
 * atoms of its violation rules, which is the situation the rule guards on.
 */
import { PROFILES, effectiveKeyword, polarityOf, strengthOf, type CatalogEntry } from "../catalog/catalog.ts";
import type { CompiledProvision } from "./compile.ts";
import { formatTerm, parseRule, type Atom, type Rule, type Term } from "./predicate.ts";
import { stratify, toTy, typeRule, type Ty } from "./typing.ts";
import type { Column, ColumnType, Relation, Vocabulary } from "./vocabulary.ts";

export interface VerdictLayer {
  /** Facts from the catalog, one relation per thing the rules read about a provision, tuples inline. */
  catalog: Relation[];
  /** The relations the rules derive, declared with typed columns. */
  derived: Relation[];
  /** The derived relations that are verdicts, each an output of the published program. */
  outputs: string[];
  rules: Rule[];
  /** Strata over the derived relations, lowest first. */
  strata: string[][];
  /** The domains this layer's columns declare beyond the vocabulary's. */
  domains: { name: string; type: ColumnType }[];
}

export const VERDICT_OUTPUTS = ["fail", "deviates", "pass", "unevaluated", "not_activated", "not_exercised"] as const;
export type VerdictRelation = (typeof VERDICT_OUTPUTS)[number];

const col = (name: string, type: ColumnType = "symbol", domain: string = name): Column => ({ name, type, domain });
const PROVISION = col("provision");
const SESSION = col("session");

/** The rules, written once; the projection and exercise rules per provision are generated beside them. */
const RULES = [
  "active(P, S) :- requires_profile(P, Pr), negotiated(S, Pr).",
  "not_activated(P, S) :- provision(P), negotiated(S, _), not active(P, S).",
  "unevaluated(P) :- needs(P, R), not available(R).",
  "not_exercised(P, S) :- conditional(P), active(P, S), not unevaluated(P), not exercised(P, S).",
  'fail(P, S) :- violated(P, S), active(P, S), strength(P, "must"), not unevaluated(P).',
  'deviates(P, S) :- violated(P, S), active(P, S), strength(P, "should"), not unevaluated(P).',
  "pass(P, S) :- compiled(P), active(P, S), not conditional(P), not unevaluated(P), not violated(P, S).",
  "pass(P, S) :- conditional(P), active(P, S), exercised(P, S), not unevaluated(P), not violated(P, S).",
];

export function buildVerdictLayer(vocabulary: Vocabulary, entries: CatalogEntry[], provisions: CompiledProvision[]): { layer: VerdictLayer; problems: { id: string; message: string }[] } {
  for (const name of ["envelope", "negotiated", "available"]) {
    if (!vocabulary.relations.has(name)) throw new Error(`verdicts: the vocabulary has no ${name} relation; the verdict layer reads envelope, negotiated and available`);
  }
  const problems: { id: string; message: string }[] = [];
  const records = new Map(entries.map((e) => [e.manifest.id, e]));
  const compiled = provisions.filter((p) => p.status === "compiled" && p.violation);

  const facts = {
    provision: [] as (string | number)[][],
    compiled: [] as (string | number)[][],
    strength: [] as (string | number)[][],
    polarity: [] as (string | number)[][],
    requires_profile: [] as (string | number)[][],
    needs: [] as (string | number)[][],
    conditional: [] as (string | number)[][],
  };
  // Every Requirement is scoped to the profiles that activate it, compiled or not, so a permission or a non-testable provision in a profile the session never negotiated is reported as not activated.
  for (const entry of entries) {
    if (entry.manifest.type !== "Requirement") continue;
    facts.provision.push([entry.manifest.id]);
    for (const profile of entry.record.profile === "all" ? PROFILES : entry.record.profile) facts.requires_profile.push([entry.manifest.id, profile]);
  }
  const generated: string[] = [];
  for (const p of compiled) {
    const entry = records.get(p.id);
    if (!entry) throw new Error(`${p.id}: compiled but not in the catalog`);
    const keyword = effectiveKeyword(entry.manifest, entry.record);
    if (!keyword) {
      problems.push({ id: p.id, message: `${p.id}: no RFC 2119 keyword to judge it by` });
      continue;
    }
    try {
      generated.push(projection(vocabulary, p));
      if (entry.record.modality_kind === "conditional-on-exercise") generated.push(...exercise(vocabulary, p));
    } catch (error) {
      problems.push({ id: p.id, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    facts.compiled.push([p.id]);
    facts.strength.push([p.id, strengthOf(keyword)]);
    facts.polarity.push([p.id, polarityOf(keyword)]);
    for (const e of p.external_facts) facts.needs.push([p.id, e.relation]);
    if (entry.record.modality_kind === "conditional-on-exercise") facts.conditional.push([p.id]);
  }

  const catalog: Relation[] = [
    { name: "provision", source: "catalog", columns: [PROVISION], doc: "Every Requirement in the catalog, compiled or not.", facts: facts.provision },
    { name: "compiled", source: "catalog", columns: [PROVISION], doc: "A provision with compiled rules.", facts: facts.compiled },
    { name: "strength", source: "catalog", columns: [PROVISION, col("strength")], doc: "The provision's RFC 2119 strength: must, should, or may.", facts: facts.strength },
    { name: "polarity", source: "catalog", columns: [PROVISION, col("polarity")], doc: "Whether the sentence obliges (MUST, SHOULD) or prohibits (MUST NOT, SHOULD NOT).", facts: facts.polarity },
    { name: "requires_profile", source: "catalog", columns: [PROVISION, col("profile")], doc: "A profile that activates the provision; `all` is expanded to every profile.", facts: facts.requires_profile.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))) },
    { name: "needs", source: "catalog", columns: [PROVISION, col("relation")], doc: "A relation the provision's rules read whose tuples are not derived from the wire.", facts: facts.needs },
    { name: "conditional", source: "catalog", columns: [PROVISION], doc: "An obligation conditional on a permission being exercised.", facts: facts.conditional },
  ];
  const derived: Relation[] = [
    { name: "violated", source: "derived", columns: [PROVISION, SESSION], doc: "The provision's violation relation, attributed to a session.", facts: [] },
    { name: "exercised", source: "derived", columns: [PROVISION, SESSION], doc: "The situation a conditional provision's rules guard on arose in the session.", facts: [] },
    { name: "active", source: "derived", columns: [PROVISION, SESSION], doc: "The session negotiated a profile that activates the provision.", facts: [] },
    { name: "unevaluated", source: "derived", columns: [PROVISION], doc: "A relation the provision needs was not supplied; no verdict.", facts: [] },
    { name: "not_activated", source: "derived", columns: [PROVISION, SESSION], doc: "No negotiated profile activates the provision in the session.", facts: [] },
    { name: "not_exercised", source: "derived", columns: [PROVISION, SESSION], doc: "The condition never arose in the session; the obligation had nothing to bind.", facts: [] },
    { name: "fail", source: "derived", columns: [PROVISION, SESSION], doc: "A MUST or MUST NOT violated in a session that activated it.", facts: [] },
    { name: "deviates", source: "derived", columns: [PROVISION, SESSION], doc: "A SHOULD or SHOULD NOT violated in a session that activated it.", facts: [] },
    { name: "pass", source: "derived", columns: [PROVISION, SESSION], doc: "Active, evaluated, exercised where conditional, and not violated.", facts: [] },
  ];

  const rules = [...new Set([...generated, ...RULES])].map((text) => parseRule(text));
  const declared = new Map<string, Column[]>();
  for (const r of [...catalog, ...derived]) declared.set(r.name, r.columns);
  for (const p of compiled) if (p.violation) declared.set(p.violation.name, p.violation.columns);
  const relationTypes = (name: string): (Ty | null)[] | null => vocabulary.relations.get(name)?.columns.map(toTy) ?? declared.get(name)?.map(toTy) ?? null;
  for (const rule of rules) {
    const env = typeRule("verdicts", rule, relationTypes, true);
    const columns = declared.get(rule.head.relation);
    if (!columns) throw new Error(`verdicts: ${rule.head.relation} is not a verdict-layer relation in: ${rule.source}`);
    if (columns.length !== rule.head.args.length) throw new Error(`verdicts: ${rule.head.relation} has ${columns.length} column(s), the head ${rule.head.args.length} in: ${rule.source}`);
    rule.head.args.forEach((arg, i) => {
      const want = columns[i] as Column;
      const got: Ty | null = arg.kind === "var" ? (env.get(arg.name) ?? null) : arg.kind === "str" ? { base: "symbol", domain: null } : arg.kind === "num" ? { base: "number", domain: null } : null;
      if (!got) throw new Error(`verdicts: head argument ${i + 1} of ${rule.head.relation} is untyped in: ${rule.source}`);
      if (got.base !== want.type || (got.domain && want.domain && got.domain !== want.domain)) {
        throw new Error(`verdicts: ${rule.head.relation} column ${want.name} is ${want.domain ?? want.type}, got ${got.domain ?? got.base} in: ${rule.source}`);
      }
    });
  }

  const local = new Set(derived.map((r) => r.name));
  const positive = new Map<string, Set<string>>();
  const negative = new Map<string, Set<string>>();
  for (const rel of local) {
    positive.set(rel, new Set());
    negative.set(rel, new Set());
  }
  for (const rule of rules) {
    for (const lit of rule.body) {
      if (lit.kind === "atom" && local.has(lit.atom.relation)) (lit.negated ? negative : positive).get(rule.head.relation)?.add(lit.atom.relation);
    }
  }
  const strata = stratify("verdicts", [...local], positive, negative);
  const domains = new Map<string, ColumnType>();
  for (const r of [...catalog, ...derived]) for (const c of r.columns) if (c.domain && !vocabulary.domains.has(c.domain)) domains.set(c.domain, c.type);
  return {
    layer: { catalog, derived, outputs: [...VERDICT_OUTPUTS], rules, strata, domains: [...domains.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name, type })) },
    problems,
  };
}

/** `violated(P, S)` from the provision's violation relation, through a subject column holding a session or a seq. */
function projection(vocabulary: Vocabulary, p: CompiledProvision): string {
  const v = p.violation as NonNullable<CompiledProvision["violation"]>;
  const seqRelation = vocabulary.relations.get("envelope");
  if (!seqRelation) throw new Error(`${p.id}: the vocabulary has no envelope relation to attribute a seq to a session`);
  const subject = v.columns.slice(0, p.subject.length);
  const witness = v.columns.slice(p.subject.length);
  const pick = (domain: string): number => {
    const i = subject.findIndex((c) => c.domain === domain);
    return i !== -1 ? i : witness.findIndex((c) => c.domain === domain) + (witness.some((c) => c.domain === domain) ? subject.length : -1 - subject.length);
  };
  const session = pick("session");
  const seq = pick("seq");
  if (session >= 0) return `violated("${p.id}", S) :- ${v.name}(${v.columns.map((_, i) => (i === session ? "S" : "_")).join(", ")}).`;
  if (seq >= 0) return `violated("${p.id}", S) :- ${v.name}(${v.columns.map((_, i) => (i === seq ? "Q" : "_")).join(", ")}), envelope(Q, S, _, _, _).`;
  throw new Error(`${p.id}: no subject or witness column holds a session or a seq, so a violation cannot be attributed to a session`);
}

/** `exercised(P, S)` per violation rule: its positive, non-static vocabulary atoms, attributed to a session. */
function exercise(vocabulary: Vocabulary, p: CompiledProvision): string[] {
  const v = p.violation as NonNullable<CompiledProvision["violation"]>;
  const out: string[] = [];
  for (const rule of p.rules) {
    if (rule.head.relation !== v.name) continue;
    const atoms: Atom[] = [];
    for (const lit of rule.body) {
      if (lit.kind !== "atom" || lit.negated) continue;
      const rel = vocabulary.relations.get(lit.atom.relation);
      if (rel && rel.source !== "static") atoms.push(lit.atom);
    }
    if (atoms.length === 0) throw new Error(`${p.id}: conditional on exercise, but a violation rule has no positive vocabulary atom to read the condition from: ${rule.source}`);
    let session: string | null = null;
    let seq: string | null = null;
    const used = new Set<string>();
    for (const atom of atoms) {
      const columns = vocabulary.relations.get(atom.relation)?.columns ?? [];
      atom.args.forEach((arg: Term, i) => {
        if (arg.kind !== "var") return;
        used.add(arg.name);
        if (columns[i]?.domain === "session") session = session ?? arg.name;
        if (columns[i]?.domain === "seq") seq = seq ?? arg.name;
      });
    }
    // The session variable joined in through envelope must not collide with the rule's own.
    let fresh = "Session";
    for (let n = 2; used.has(fresh); n++) fresh = `Session${n}`;
    const body = atoms.map((a) => `${a.relation}(${a.args.map(formatTerm).join(", ")})`);
    if (session) out.push(`exercised("${p.id}", ${session}) :- ${body.join(", ")}.`);
    else if (seq) out.push(`exercised("${p.id}", ${fresh}) :- ${body.join(", ")}, envelope(${seq}, ${fresh}, _, _, _).`);
    else throw new Error(`${p.id}: conditional on exercise, but no positive atom binds a session or a seq in: ${rule.source}`);
  }
  return out;
}
