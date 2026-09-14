/**
 * The rule checker both the provision compiler and the verdict layer use:
 * a variable's type is the meet of every column it fills (base type and
 * domain), a head column's type comes from every rule that produces it,
 * every variable in a head, a negated atom, or a comparison is bound by a
 * positive atom, and the relations a rule set defines are stratified so no
 * relation depends negatively on itself.
 */
import { atomVars, termVars, type Atom, type Literal, type Rule, type Term } from "./predicate.ts";
import type { Column, ColumnType } from "./vocabulary.ts";

/** A column type as the checker sees it: the base type, and the domain when the value is known to come from one. */
export interface Ty {
  base: ColumnType;
  domain: string | null;
}

export function describe(t: Ty): string {
  return t.domain ?? t.base;
}

export function sameTy(a: Ty | null, b: Ty | null): boolean {
  return a === null || b === null ? a === b : a.base === b.base && a.domain === b.domain;
}

export function toTy(c: Column): Ty {
  return { base: c.type, domain: c.domain };
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
export function headColumnType(id: string, relation: string, i: number, producers: Rule[], envs: Env[]): Ty | null {
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

export type Env = Map<string, Ty>;

/** Type every variable in a rule from its positive atoms, then check the rest. Returns the environment. */
export function typeRule(id: string, rule: Rule, relationTypes: (name: string) => (Ty | null)[] | null, strict = false): Env {
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

export function termType(term: Term, env: Env): Ty | null {
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

export function literalAtoms(lit: Literal): Atom[] {
  if (lit.kind === "atom") return [lit.atom];
  if (lit.kind === "count") return lit.atoms;
  return [];
}

export function renameLiteral(lit: Literal, rename: (name: string) => string): Literal {
  if (lit.kind === "atom") return { ...lit, atom: { relation: rename(lit.atom.relation), args: lit.atom.args } };
  if (lit.kind === "count") return { ...lit, atoms: lit.atoms.map((a) => ({ relation: rename(a.relation), args: a.args })) };
  return lit;
}

/** Strata by Tarjan SCC over positive+negative edges, refusing a negative edge inside a component. */
export function stratify(id: string, nodes: string[], positive: Map<string, Set<string>>, negative: Map<string, Set<string>>): string[][] {
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
