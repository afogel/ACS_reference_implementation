/**
 * X2's answer, part one: the predicate language's concrete syntax.
 *
 * A predicate is a list of Datalog rules written as strings, one relation
 * `violation` as the head that matters, helper relations for the rest:
 *
 *   violation(Seq, Session) :- hook(Seq, Session, _), not handshake_before(Session, Seq).
 *   handshake_before(Session, Seq) :- handshake(H, Session), hook(Seq, Session, _), H < Seq.
 *
 * Terms are variables (Uppercase), the wildcard `_`, double-quoted strings,
 * integers, and the two functions the backends share: `cat(a, b, ...)` and
 * `to_string(n)`. Literals are atoms, negated atoms (`not a(...)`),
 * comparisons (`= != < <= > >=`), and one aggregate, `N = count : { atoms }`.
 * That is the whole language: what twenty-one provisions needed, and no
 * more, because every construct has to be emitted twice and held
 * equivalent (R3.8).
 */

export type Term =
  | { kind: "var"; name: string }
  | { kind: "wild" }
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "func"; name: "cat" | "to_string"; args: Term[] };

export interface Atom {
  relation: string;
  args: Term[];
}

export type Comparator = "=" | "!=" | "<" | "<=" | ">" | ">=";

export type Literal =
  | { kind: "atom"; atom: Atom; negated: boolean }
  | { kind: "cmp"; op: Comparator; left: Term; right: Term }
  | { kind: "count"; target: string; atoms: Atom[] };

export interface Rule {
  head: Atom;
  body: Literal[];
  /** The rule as written, for error messages and for the published .dl's comments. */
  source: string;
}

export class PredicateSyntaxError extends Error {}

export function parseRule(text: string): Rule {
  const p = new Parser(text);
  const head = p.atom();
  p.expect(":-");
  const body: Literal[] = [];
  do {
    body.push(p.literal());
  } while (p.accept(","));
  p.accept(".");
  p.end();
  return { head, body, source: text.trim() };
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  atom(): Atom {
    const relation = this.name();
    this.expect("(");
    const args: Term[] = [];
    if (!this.peek(")")) {
      do {
        args.push(this.term());
      } while (this.accept(","));
    }
    this.expect(")");
    return { relation, args };
  }

  literal(): Literal {
    this.ws();
    if (this.acceptWord("not")) return { kind: "atom", atom: this.atom(), negated: true };
    // `N = count : { ... }`
    const save = this.i;
    if (/^[A-Z]/.test(this.rest())) {
      const name = this.name();
      this.ws();
      if (this.accept("=") && this.acceptWord("count")) {
        this.expect(":");
        this.expect("{");
        const atoms: Atom[] = [];
        do {
          atoms.push(this.atom());
        } while (this.accept(","));
        this.expect("}");
        return { kind: "count", target: name, atoms };
      }
      this.i = save;
    }
    // A relation name followed by `(` is an atom; anything else starts a comparison.
    if (/^[a-z_][A-Za-z0-9_]*\s*\(/.test(this.rest()) && !/^(cat|to_string)\s*\(/.test(this.rest())) {
      return { kind: "atom", atom: this.atom(), negated: false };
    }
    const left = this.term();
    this.ws();
    const op = this.comparator();
    if (!op) this.fail("expected a comparison operator");
    return { kind: "cmp", op, left, right: this.term() };
  }

  term(): Term {
    this.ws();
    const c = this.s[this.i];
    if (c === '"') {
      this.i++;
      let value = "";
      while (this.i < this.s.length && this.s[this.i] !== '"') {
        if (this.s[this.i] === "\\") this.i++;
        value += this.s[this.i];
        this.i++;
      }
      this.expect('"');
      return { kind: "str", value };
    }
    if (c !== undefined && /[-0-9]/.test(c)) {
      const m = /^-?\d+/.exec(this.rest());
      if (!m) this.fail("bad number");
      this.i += m[0].length;
      return { kind: "num", value: Number(m[0]) };
    }
    if (c === "_" && !/[A-Za-z0-9_]/.test(this.s[this.i + 1] ?? "")) {
      this.i++;
      return { kind: "wild" };
    }
    const name = this.name();
    if (name === "cat" || name === "to_string") {
      this.expect("(");
      const args: Term[] = [];
      do {
        args.push(this.term());
      } while (this.accept(","));
      this.expect(")");
      return { kind: "func", name, args };
    }
    if (/^[A-Z]/.test(name)) return { kind: "var", name };
    this.fail(`"${name}" is not a variable (variables start with an uppercase letter), a string, a number, cat(), or to_string()`);
  }

  private comparator(): Comparator | null {
    for (const op of ["!=", "<=", ">=", "=", "<", ">"] as const) {
      if (this.accept(op)) return op;
    }
    return null;
  }

  name(): string {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.rest());
    if (!m) this.fail("expected a name");
    this.i += m[0].length;
    return m[0];
  }

  expect(token: string): void {
    if (!this.accept(token)) this.fail(`expected "${token}"`);
  }

  accept(token: string): boolean {
    this.ws();
    if (this.s.startsWith(token, this.i)) {
      this.i += token.length;
      return true;
    }
    return false;
  }

  acceptWord(word: string): boolean {
    this.ws();
    if (this.s.startsWith(word, this.i) && !/[A-Za-z0-9_]/.test(this.s[this.i + word.length] ?? "")) {
      this.i += word.length;
      return true;
    }
    return false;
  }

  peek(token: string): boolean {
    this.ws();
    return this.s.startsWith(token, this.i);
  }

  end(): void {
    this.ws();
    if (this.i !== this.s.length) this.fail("unexpected trailing input");
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? "")) this.i++;
  }

  private rest(): string {
    return this.s.slice(this.i);
  }

  private fail(message: string): never {
    throw new PredicateSyntaxError(`${message} at offset ${this.i} in: ${this.s.trim()}`);
  }
}

export function termVars(term: Term): string[] {
  switch (term.kind) {
    case "var":
      return [term.name];
    case "func":
      return term.args.flatMap(termVars);
    default:
      return [];
  }
}

export function atomVars(atom: Atom): string[] {
  return atom.args.flatMap(termVars);
}

export function formatTerm(term: Term): string {
  switch (term.kind) {
    case "var":
      return term.name;
    case "wild":
      return "_";
    case "str":
      return JSON.stringify(term.value);
    case "num":
      return String(term.value);
    case "func":
      return `${term.name}(${term.args.map(formatTerm).join(", ")})`;
  }
}
