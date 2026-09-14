/**
 * N44: `evaluate()` -- the in-process engine (E7.2).
 *
 * Semi-naive fixpoint per stratum over the rule subset the compiler emits:
 * positive and negated atoms, comparisons, `Var = expr` assignment, `cat`
 * and `to_string`, and `count`. Nothing more, because every construct is
 * also emitted as Soufflé and the two are held equivalent by the
 * differential oracle (N63); a construct only one engine had would be a
 * construct nobody had checked.
 *
 * Running on a laptop needs only `bun install` and this file (R3.9).
 */
import type { CompiledProvision, RuleProgram } from "../compile/compile.ts";
import type { Atom, Literal, Rule, Term } from "../compile/predicate.ts";
import type { FactSet, Tuple, Value } from "./facts.ts";

export interface Violation {
  provision: string;
  subject: Value[];
  witness: Value[];
}

/** The unified form the fixtures pin and both engines are compared in: provision, then subject and witness values each joined with "|". */
export function unified(v: Violation): string {
  return `${v.provision}\t${v.subject.map(String).join("|")}\t${v.witness.map(String).join("|")}`;
}

type Store = Map<string, Map<string, Tuple>>;
type Bindings = Map<string, Value>;

export function evaluate(program: RuleProgram, facts: FactSet): Violation[] {
  const store: Store = new Map();
  for (const rel of program.relations) {
    const table = new Map<string, Tuple>();
    for (const t of facts.get(rel.name) ?? []) table.set(key(t), t);
    store.set(rel.name, table);
  }
  const violations: Violation[] = [];
  for (const p of program.provisions) {
    if (p.status !== "compiled" || !p.violation) continue;
    evaluateProvision(p, store);
    for (const t of store.get(p.violation.name)?.values() ?? []) {
      violations.push({ provision: p.id, subject: t.slice(0, p.subject.length), witness: t.slice(p.subject.length) });
    }
  }
  return violations.sort((a, b) => unified(a).localeCompare(unified(b)));
}

function evaluateProvision(p: CompiledProvision, store: Store): void {
  for (const h of p.helpers) store.set(h.name, new Map());
  store.set((p.violation as NonNullable<typeof p.violation>).name, new Map());
  for (const stratum of p.strata) {
    const members = new Set(stratum);
    const rules = p.rules.filter((r) => members.has(r.head.relation));
    // Semi-naive: after the first full round, only bindings that touch a delta tuple of a member relation can be new.
    let delta = new Map<string, Map<string, Tuple>>();
    for (const m of members) delta.set(m, new Map(store.get(m)));
    let first = true;
    for (;;) {
      const next = new Map<string, Map<string, Tuple>>();
      for (const m of members) next.set(m, new Map());
      for (const rule of rules) {
        const memberAtoms = rule.body.flatMap((lit, i) => (lit.kind === "atom" && !lit.negated && members.has(lit.atom.relation) ? [i] : []));
        const plans = first || memberAtoms.length === 0 ? [null] : memberAtoms;
        for (const deltaAt of plans) {
          if (!first && deltaAt === null) continue;
          for (const b of solve(rule.body, 0, new Map(), store, delta, deltaAt)) {
            const head = rule.head.args.map((a) => valueOf(a, b));
            const k = key(head);
            const table = store.get(rule.head.relation) as Map<string, Tuple>;
            if (!table.has(k)) {
              table.set(k, head);
              next.get(rule.head.relation)?.set(k, head);
            }
          }
        }
      }
      first = false;
      delta = next;
      if ([...next.values()].every((m) => m.size === 0)) break;
    }
  }
}

/** All bindings satisfying body[from..], positive atoms first in order, then the rest once bound. */
function* solve(body: Literal[], from: number, b: Bindings, store: Store, delta: Map<string, Map<string, Tuple>>, deltaAt: number | null): Generator<Bindings> {
  if (from === body.length) {
    // Everything positive is bound: check negations, comparisons, and aggregates.
    if (checkRest(body, b, store)) yield b;
    return;
  }
  const lit = body[from] as Literal;
  if (lit.kind !== "atom" || lit.negated) {
    yield* solve(body, from + 1, b, store, delta, deltaAt);
    return;
  }
  const source = deltaAt === from ? delta.get(lit.atom.relation) : store.get(lit.atom.relation);
  for (const tuple of source?.values() ?? []) {
    const extended = unify(lit.atom, tuple, b);
    if (extended) yield* solve(body, from + 1, extended, store, delta, deltaAt);
  }
}

function checkRest(body: Literal[], b: Bindings, store: Store): boolean {
  // Assignments first, in order, since later comparisons may read them.
  for (const lit of body) {
    if (lit.kind === "cmp" && lit.op === "=" && lit.left.kind === "var" && !b.has(lit.left.name)) b.set(lit.left.name, valueOf(lit.right, b));
  }
  for (const lit of body) {
    if (lit.kind === "count") b.set(lit.target, countMatches(lit.atoms, b, store));
  }
  for (const lit of body) {
    if (lit.kind === "atom" && lit.negated) {
      if (matches(lit.atom, b, store)) return false;
    } else if (lit.kind === "cmp") {
      if (!compare(lit.op, valueOf(lit.left, b), valueOf(lit.right, b))) return false;
    }
  }
  return true;
}

function matches(atom: Atom, b: Bindings, store: Store): boolean {
  for (const tuple of store.get(atom.relation)?.values() ?? []) if (unify(atom, tuple, b)) return true;
  return false;
}

/** Distinct bindings of the aggregate's atoms given the outer bindings, as Soufflé counts them. */
function countMatches(atoms: Atom[], outer: Bindings, store: Store): number {
  const seen = new Set<string>();
  const walk = (i: number, b: Bindings): void => {
    if (i === atoms.length) {
      const locals = [...b.entries()].filter(([k]) => !outer.has(k)).map(([k, v]) => `${k}=${v}`).sort();
      seen.add(locals.join("") || "");
      return;
    }
    const atom = atoms[i] as Atom;
    for (const tuple of store.get(atom.relation)?.values() ?? []) {
      const extended = unify(atom, tuple, b);
      if (extended) walk(i + 1, extended);
    }
  };
  walk(0, outer);
  // With no local variables the count is the number of matching tuples, not 1: count each tuple combination.
  if (atoms.every((a) => a.args.every((t) => t.kind !== "var" || outer.has(t.name)))) {
    let n = 0;
    const walkAll = (i: number, b: Bindings): void => {
      if (i === atoms.length) {
        n++;
        return;
      }
      const atom = atoms[i] as Atom;
      for (const tuple of store.get(atom.relation)?.values() ?? []) if (unify(atom, tuple, b)) walkAll(i + 1, b);
    };
    walkAll(0, outer);
    return n;
  }
  return seen.size;
}

function unify(atom: Atom, tuple: Tuple, b: Bindings): Bindings | null {
  let out: Bindings | null = null;
  for (let i = 0; i < atom.args.length; i++) {
    const arg = atom.args[i] as Term;
    const value = tuple[i] as Value;
    if (arg.kind === "wild") continue;
    if (arg.kind === "var") {
      const bound = (out ?? b).get(arg.name);
      if (bound === undefined) {
        out = out ?? new Map(b);
        out.set(arg.name, value);
      } else if (bound !== value) return null;
      continue;
    }
    if (valueOf(arg, out ?? b) !== value) return null;
  }
  return out ?? b;
}

function valueOf(term: Term, b: Bindings): Value {
  switch (term.kind) {
    case "var": {
      const v = b.get(term.name);
      if (v === undefined) throw new Error(`unbound variable ${term.name}`);
      return v;
    }
    case "str":
      return term.value;
    case "num":
      return term.value;
    case "wild":
      throw new Error("wildcard has no value");
    case "func":
      return term.name === "cat" ? term.args.map((a) => String(valueOf(a, b))).join("") : String(valueOf(term.args[0] as Term, b));
  }
}

function compare(op: string, l: Value, r: Value): boolean {
  switch (op) {
    case "=":
      return l === r;
    case "!=":
      return l !== r;
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
  return false;
}

function key(t: Tuple): string {
  return JSON.stringify(t);
}

export type { Rule };
