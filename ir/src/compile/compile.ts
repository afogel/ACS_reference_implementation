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
 *    defines; arity matches; every variable has one type
 *  - safety: every variable in a head, a negated atom, or a comparison is
 *    bound by a positive atom (or is the target of `count`, or the left
 *    side of `Var = expr` with `expr` bound)
 *  - stratification: no relation depends negatively on itself, directly or
 *    through helpers, so both engines compute the same fixpoint
 *  - N36: the `violation` head's arguments are exactly the declared
 *    `subject` then `witness` variables, both non-empty, all bound. A rule
 *    that derives a violation without saying who and why does not compile
 *  - R3.6: a Requirement with neither a predicate nor a declared
 *    `inexpressible` reason is a compile failure, never a silent skip
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
  return { generated_by: "acs-ir compile", corpus, relations: [...vocabulary.relations.values()], provisions, problems };
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

  // N36: the violation head is subject then witness, all variables, both non-empty.
  if (spec.subject.length === 0 || spec.witness.length === 0) throw new Error(`${id}: violation needs at least one subject and one witness column (R3.4)`);
  const expectedHead = [...spec.subject, ...spec.witness];
  if (new Set(expectedHead).size !== expectedHead.length) throw new Error(`${id}: subject and witness variables must be distinct`);
  for (const rule of rules.filter((r) => r.head.relation === "violation")) {
    const names = rule.head.args.map((a) => (a.kind === "var" ? a.name : null));
    if (names.some((n) => n === null) || names.join(",") !== expectedHead.join(",")) {
      throw new Error(`${id}: violation(${expectedHead.join(", ")}) is the only allowed head; got violation(${rule.head.args.map((a) => (a.kind === "var" ? a.name : "?")).join(", ")}) (N36)`);
    }
  }

  // Types: iterate until every helper column has a type.
  const helperTypes = new Map<string, (ColumnType | null)[]>();
  for (const rule of rules) if (rule.head.relation !== "violation") helperTypes.set(rule.head.relation, rule.head.args.map(() => null));
  let violationTypes: (ColumnType | null)[] = expectedHead.map(() => null);
  const relationTypes = (name: string): (ColumnType | null)[] | null =>
    vocabulary.relations.get(name)?.columns.map((c) => c.type) ?? helperTypes.get(name) ?? null;
  for (let pass = 0; pass < 8; pass++) {
    let progressed = false;
    for (const rule of rules) {
      const env = typeRule(id, rule, relationTypes);
      const target = rule.head.relation === "violation" ? violationTypes : helperTypes.get(rule.head.relation);
      if (!target) continue;
      rule.head.args.forEach((arg, i) => {
        const t = termType(arg, env);
        if (t && target[i] === null) {
          target[i] = t;
          progressed = true;
        } else if (t && target[i] !== t) {
          throw new Error(`${id}: ${rule.head.relation} column ${i + 1} is ${target[i]} in one rule and ${t} in another`);
        }
      });
      if (rule.head.relation === "violation") violationTypes = target;
    }
    if (!progressed) break;
  }
  for (const [name, types] of helperTypes) {
    const i = types.findIndex((t) => t === null);
    if (i !== -1) {
      const rule = rules.find((r) => r.head.relation === name);
      const arg = rule?.head.args[i];
      throw new Error(`${id}: helper ${name} column ${i + 1}${arg?.kind === "var" ? ` (${arg.name})` : ""} is not bound by a positive atom (unsafe)`);
    }
  }
  const missing = violationTypes.findIndex((t) => t === null);
  if (missing !== -1) throw new Error(`${id}: violation variable ${expectedHead[missing]} is not bound by a positive atom (unsafe)`);
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
  const helpers: HelperRelation[] = [...helperNames].map((h) => ({
    local: h,
    name: rename(h),
    columns: (helperTypes.get(h) ?? []).map((t, i) => ({ name: `c${i + 1}`, type: t as ColumnType })),
  }));
  const violation = {
    name: rename("violation"),
    columns: expectedHead.map((name, i) => ({ name: `${i < spec.subject.length ? "subject" : "witness"}_${name.toLowerCase()}`, type: violationTypes[i] as ColumnType })),
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

type Env = Map<string, ColumnType>;

/** Type every variable in a rule from its positive atoms, then check the rest. Returns the environment. */
function typeRule(id: string, rule: Rule, relationTypes: (name: string) => (ColumnType | null)[] | null, strict = false): Env {
  const env: Env = new Map();
  const bind = (name: string, type: ColumnType | null): void => {
    if (!type) return;
    const known = env.get(name);
    if (known && known !== type) throw new Error(`${id}: variable ${name} is used as both ${known} and ${type} in: ${rule.source}`);
    env.set(name, type);
  };
  const bindAtom = (atom: Atom): void => {
    const types = relationTypes(atom.relation);
    if (!types) return;
    if (types.length !== atom.args.length) throw new Error(`${id}: ${atom.relation} takes ${types.length} argument(s), got ${atom.args.length} in: ${rule.source}`);
    atom.args.forEach((arg, i) => {
      const t = types[i] ?? null;
      if (arg.kind === "var") bind(arg.name, t);
      else if (arg.kind === "str" && t === "number") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a number, got a string in: ${rule.source}`);
      else if (arg.kind === "num" && t === "symbol") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a symbol, got a number in: ${rule.source}`);
      else if (arg.kind === "func" && t === "number") throw new Error(`${id}: ${atom.relation} argument ${i + 1} is a number, got ${arg.name}() in: ${rule.source}`);
    });
  };
  // Positive atoms bind; then assignments; then everything is checked.
  for (const lit of rule.body) if (lit.kind === "atom" && !lit.negated) bindAtom(lit.atom);
  for (const lit of rule.body) if (lit.kind === "count") bind(lit.target, "number");
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
      bindAtom(lit.atom); // arity and constant types, now that every variable is known to be bound
    }
    if (lit.kind === "cmp") {
      if (!bound(lit.left) || !bound(lit.right)) {
        const missing = [...termVars(lit.left), ...termVars(lit.right)].filter((v) => !env.has(v));
        throw new Error(`${id}: variable ${missing[0]} in a comparison is not bound (unsafe) in: ${rule.source}`);
      }
      const l = termType(lit.left, env);
      const r = termType(lit.right, env);
      if (l !== r) throw new Error(`${id}: comparing ${l} with ${r} in: ${rule.source}`);
      if (lit.op !== "=" && lit.op !== "!=" && l !== "number") throw new Error(`${id}: ordering comparisons need numbers, got ${l} in: ${rule.source}`);
    }
    if (lit.kind === "count") {
      for (const atom of lit.atoms) {
        const types = relationTypes(atom.relation);
        if (types && types.length !== atom.args.length) throw new Error(`${id}: ${atom.relation} takes ${types.length} argument(s) in: ${rule.source}`);
      }
    }
  }
  for (const v of atomVars(rule.head)) if (!env.has(v)) throw new Error(`${id}: head variable ${v} is not bound in the body (unsafe) in: ${rule.source}`);
  for (const arg of rule.head.args) if (arg.kind === "wild") throw new Error(`${id}: a head cannot carry a wildcard in: ${rule.source}`);
  return env;
}

function termType(term: Term, env: Env): ColumnType | null {
  switch (term.kind) {
    case "var":
      return env.get(term.name) ?? null;
    case "str":
      return "symbol";
    case "num":
      return "number";
    case "func":
      return "symbol";
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
