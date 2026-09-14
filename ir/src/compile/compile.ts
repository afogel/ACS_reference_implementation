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
import { atomVars, parseRule, termVars, type Atom, type Literal, type Rule, type Term } from "./predicate.ts";
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
  /** Every column domain the relations declare, with its base type; the Soufflé emitter declares each as a subtype. */
  domains: { name: string; type: ColumnType }[];
  provisions: CompiledProvision[];
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
  return {
    generated_by: "acs-ir compile",
    corpus,
    relations: [...vocabulary.relations.values()],
    domains: [...vocabulary.domains.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name, type })),
    provisions,
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
    if (spec) throw new Error(`${id}: a permission generates no obligation and so no predicate (R4.6)`);
    return skipped(id, "permission", "a MAY that was not exercised yields no verdict (R4.6)");
  }
  if (record.evidence_class === "non-testable") {
    if (spec) throw new Error(`${id}: non-testable provisions carry no predicate (R4.4)`);
    return skipped(id, "non-testable", "no trace can falsify it; listed on the non-testable roster (R4.4)");
  }
  if (!spec) throw new Error(`${id}: a testable Requirement needs a predicate, or a declared inexpressible reason (R3.1, R3.6)`);
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

/** A column type as the checker sees it: the base type, and the domain when the value is known to come from one. */
interface Ty {
  base: ColumnType;
  domain: string | null;
}

function describe(t: Ty): string {
  return t.domain ?? t.base;
}

function sameTy(a: Ty | null, b: Ty | null): boolean {
  return a === null || b === null ? a === b : a.base === b.base && a.domain === b.domain;
}

function toTy(c: Column): Ty {
  return { base: c.type, domain: c.domain };
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
          throw new Error(`${id}: ${atom.relation} is neither a vocabulary relation nor a helper defined by this predicate (R3.2)`);
        }
      }
    }
  }
  if (!rules.some((r) => r.head.relation === "violation")) throw new Error(`${id}: no rule derives violation`);

  // N36: the violation head is subject then witness, both non-empty; each position is its variable or a constant.
  if (spec.subject.length === 0 || spec.witness.length === 0) throw new Error(`${id}: violation needs at least one subject and one witness column (R3.4)`);
  const expectedHead = [...spec.subject, ...spec.witness];
  if (new Set(expectedHead).size !== expectedHead.length) throw new Error(`${id}: subject and witness variables must be distinct`);
  for (const rule of rules.filter((r) => r.head.relation === "violation")) {
    const ok =
      rule.head.args.length === expectedHead.length &&
      rule.head.args.every((a, i) => (a.kind === "var" && a.name === expectedHead[i]) || a.kind === "str" || a.kind === "num");
    if (!ok) {
      const got = rule.head.args.map((a) => (a.kind === "var" ? a.name : a.kind === "str" || a.kind === "num" ? "<constant>" : "?"));
      throw new Error(`${id}: violation(${expectedHead.join(", ")}) is the only allowed head, each position its variable or a constant; got violation(${got.join(", ")}) (N36)`);
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

/**
 * The type of a derived relation's column from every rule that produces it.
 * Variables and functors decide it: two rules must agree on the base type,
 * and on the domain when both name one; a rule that supplies a base-typed
 * value (a `cat` result, say) makes the column base-typed, which every
 * domain fits. A constant fits any domain, so it only has to agree on the
 * base type, and decides the column alone only when no rule supplies a
 * variable.
 */
function headColumnType(id: string, relation: string, i: number, producers: Rule[], envs: Env[]): Ty | null {
  let acc: Ty | null = null;
  let constant: ColumnType | null = null;
  producers.forEach((rule, r) => {
    const arg = rule.head.args[i] as Term;
    if (arg.kind === "str" || arg.kind === "num") {
      const base: ColumnType = arg.kind === "str" ? "symbol" : "number";
      if (constant && constant !== base) throw new Error(`${id}: ${relation} column ${i + 1} is ${constant} in one rule and ${base} in another`);
      constant = base;
      return;
    }
    const t = termType(arg, envs[r] as Env);
    if (!t) return;
    if (!acc) {
      acc = t;
      return;
    }
    if (acc.base !== t.base) throw new Error(`${id}: ${relation} column ${i + 1} is ${acc.base} in one rule and ${t.base} in another`);
    if (acc.domain && t.domain && acc.domain !== t.domain) throw new Error(`${id}: ${relation} column ${i + 1} is ${acc.domain} in one rule and ${t.domain} in another`);
    acc = { base: acc.base, domain: acc.domain && t.domain ? acc.domain : null };
  });
  const result: Ty | null = acc ?? (constant ? { base: constant, domain: null } : null);
  if (result && constant && result.base !== constant) throw new Error(`${id}: ${relation} column ${i + 1} is ${result.base} in one rule and ${constant} in another`);
  return result;
}

type Env = Map<string, Ty>;

/** Type every variable in a rule from its positive atoms, then check the rest. Returns the environment. */
function typeRule(id: string, rule: Rule, relationTypes: (name: string) => (Ty | null)[] | null, strict = false): Env {
  const env: Env = new Map();
  // A variable's type is the meet of every column it fills: the base types
  // must agree, and so must the domains when both are known.
  const bindIn = (target: Env, name: string, type: Ty | null): void => {
    if (!type) return;
    const known = target.get(name);
    if (!known) {
      target.set(name, type);
      return;
    }
    if (known.base !== type.base || (known.domain && type.domain && known.domain !== type.domain)) {
      throw new Error(`${id}: variable ${name} is used as both ${describe(known)} and ${describe(type)} in: ${rule.source}`);
    }
    if (!known.domain && type.domain) target.set(name, type);
  };
  const bindAtomIn = (target: Env, atom: Atom): void => {
    const types = relationTypes(atom.relation);
    if (!types) return;
    if (types.length !== atom.args.length) throw new Error(`${id}: ${atom.relation} takes ${types.length} argument(s), got ${atom.args.length} in: ${rule.source}`);
    atom.args.forEach((arg, i) => {
      const t = types[i] ?? null;
      if (arg.kind === "var") bindIn(target, arg.name, t);
      else if (arg.kind === "str" && t?.base === "number") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a number, got a string in: ${rule.source}`);
      else if (arg.kind === "num" && t?.base === "symbol") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a symbol, got a number in: ${rule.source}`);
      else if (arg.kind === "func" && t?.base === "number") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a number, got ${arg.name}() in: ${rule.source}`);
    });
  };
  const bind = (name: string, type: Ty | null): void => bindIn(env, name, type);
  const bindAtom = (atom: Atom): void => bindAtomIn(env, atom);
  // Positive atoms bind; then assignments; then everything is checked.
  for (const lit of rule.body) if (lit.kind === "atom" && !lit.negated) bindAtom(lit.atom);
  for (const lit of rule.body) if (lit.kind === "count") bind(lit.target, { base: "number", domain: null });
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const lit of rule.body) {
      if (lit.kind === "cmp" && lit.op === "=" && lit.left.kind === "var" && !env.has(lit.left.name)) {
        const t = termType(lit.right, env);
        if (t) {
          bind(lit.left.name, t);
          progressed = true;
        }
      }
    }
  }
  if (!strict) return env;

  const bound = (t: Term): boolean => termVars(t).every((v) => env.has(v));
  for (const lit of rule.body) {
    if (lit.kind === "atom" && lit.negated) {
      for (const v of atomVars(lit.atom)) if (!env.has(v)) throw new Error(`${id}: variable ${v} in a negated atom is not bound by a positive atom (unsafe) in: ${rule.source}`);
      bindAtom(lit.atom); // arity, constant types, and domains, now that every variable is known to be bound
    }
    if (lit.kind === "cmp") {
      if (!bound(lit.left) || !bound(lit.right)) {
        const missing = [...termVars(lit.left), ...termVars(lit.right)].filter((v) => !env.has(v));
        throw new Error(`${id}: variable ${missing[0]} in a comparison is not bound (unsafe) in: ${rule.source}`);
      }
      const l = termType(lit.left, env) as Ty;
      const r = termType(lit.right, env) as Ty;
      if (l.base !== r.base) throw new Error(`${id}: comparing ${l.base} with ${r.base} in: ${rule.source}`);
      if (l.domain && r.domain && l.domain !== r.domain) throw new Error(`${id}: comparing a ${l.domain} with a ${r.domain} in: ${rule.source}`);
      if (lit.op !== "=" && lit.op !== "!=" && l.base !== "number") throw new Error(`${id}: ordering comparisons need numbers, got ${l.base} in: ${rule.source}`);
    }
    if (lit.kind === "count") {
      // The aggregate's own variables are local to it; they are typed in a copy so they never count as bound outside.
      const inner: Env = new Map(env);
      for (const atom of lit.atoms) bindAtomIn(inner, atom);
    }
  }
  for (const v of atomVars(rule.head)) if (!env.has(v)) throw new Error(`${id}: head variable ${v} is not bound in the body (unsafe) in: ${rule.source}`);
  for (const arg of rule.head.args) if (arg.kind === "wild") throw new Error(`${id}: a head cannot carry a wildcard in: ${rule.source}`);
  return env;
}

function termType(term: Term, env: Env): Ty | null {
  switch (term.kind) {
    case "var":
      return env.get(term.name) ?? null;
    case "str":
      return { base: "symbol", domain: null };
    case "num":
      return { base: "number", domain: null };
    case "func":
      return { base: "symbol", domain: null };
    case "wild":
      return null;
  }
}

function literalAtoms(lit: Literal): Atom[] {
  if (lit.kind === "atom") return [lit.atom];
  if (lit.kind === "count") return lit.atoms;
  return [];
}

function renameLiteral(lit: Literal, rename: (name: string) => string): Literal {
  if (lit.kind === "atom") return { ...lit, atom: { relation: rename(lit.atom.relation), args: lit.atom.args } };
  if (lit.kind === "count") return { ...lit, atoms: lit.atoms.map((a) => ({ relation: rename(a.relation), args: a.args })) };
  return lit;
}

/** Strata by Tarjan SCC over positive+negative edges, refusing a negative edge inside a component. */
function stratify(id: string, nodes: string[], positive: Map<string, Set<string>>, negative: Map<string, Set<string>>): string[][] {
  const edges = (n: string): string[] => [...(positive.get(n) ?? []), ...(negative.get(n) ?? [])];
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const components: string[][] = [];
  const visit = (n: string): void => {
    idx.set(n, index);
    low.set(n, index);
    index++;
    stack.push(n);
    onStack.add(n);
    for (const m of edges(n)) {
      if (!idx.has(m)) {
        visit(m);
        low.set(n, Math.min(low.get(n) as number, low.get(m) as number));
      } else if (onStack.has(m)) {
        low.set(n, Math.min(low.get(n) as number, idx.get(m) as number));
      }
    }
    if (low.get(n) === idx.get(n)) {
      const members: string[] = [];
      let m: string | undefined;
      do {
        m = stack.pop();
        if (m !== undefined) {
          onStack.delete(m);
          component.set(m, components.length);
          members.push(m);
        }
      } while (m !== n);
      components.push(members);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  for (const [from, tos] of negative) {
    for (const to of tos) {
      if (component.get(from) === component.get(to)) throw new Error(`${id}: ${from} depends negatively on ${to} inside a recursive cycle; the predicate is not stratifiable`);
    }
  }
  // Tarjan emits components in reverse topological order of dependencies: dependencies first.
  return components;
}
