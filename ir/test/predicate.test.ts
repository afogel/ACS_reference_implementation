import { describe, expect, it } from "bun:test";
import { formatTerm, parseRule, PredicateSyntaxError } from "../src/compile/predicate.ts";

describe("parseRule -- the predicate language's whole surface", () => {
  it("parses atoms, negation, comparisons, strings, numbers, wildcards, and functions", () => {
    const rule = parseRule('violation(Seq, Session) :- request(Seq, Session, _, "x", -32600), not rejected(Seq), Seq > 3, Path = cat(Seq, "<-", to_string(Seq)).');
    expect(rule.head).toEqual({ relation: "violation", args: [{ kind: "var", name: "Seq" }, { kind: "var", name: "Session" }] });
    expect(rule.body.map((l) => l.kind)).toEqual(["atom", "atom", "cmp", "cmp"]);
    expect(rule.body[0]).toMatchObject({ negated: false, atom: { relation: "request", args: [{ kind: "var", name: "Seq" }, { kind: "var", name: "Session" }, { kind: "wild" }, { kind: "str", value: "x" }, { kind: "num", value: -32600 }] } });
    expect(rule.body[1]).toMatchObject({ negated: true, atom: { relation: "rejected" } });
    expect(rule.body[2]).toMatchObject({ op: ">", left: { kind: "var", name: "Seq" }, right: { kind: "num", value: 3 } });
    expect(rule.body[3]).toMatchObject({ op: "=", left: { kind: "var", name: "Path" }, right: { kind: "func", name: "cat" } });
    expect(rule.source).toBe('violation(Seq, Session) :- request(Seq, Session, _, "x", -32600), not rejected(Seq), Seq > 3, Path = cat(Seq, "<-", to_string(Seq)).');
  });

  it("parses the count aggregate", () => {
    const rule = parseRule("violation(S, N, B) :- defer_bound(S, B), N = count : { defer_in(S, _) }, N > B.");
    expect(rule.body[1]).toEqual({ kind: "count", target: "N", atoms: [{ relation: "defer_in", args: [{ kind: "var", name: "S" }, { kind: "wild" }] }] });
  });

  it("rejects what the language does not have", () => {
    expect(() => parseRule("violation(X) :- a(X)")).not.toThrow();
    expect(() => parseRule("violation(X) :- a(x).")).toThrow(PredicateSyntaxError);
    expect(() => parseRule("violation(X) :- a(X), b.")).toThrow(PredicateSyntaxError);
    expect(() => parseRule("violation(X) :- a(X); b(X).")).toThrow("unexpected trailing input");
    expect(() => parseRule("violation(X) :- N = max : { a(X) }.")).toThrow(PredicateSyntaxError);
    expect(() => parseRule("violation(X).")).toThrow('expected ":-"');
  });

  it("formats terms back to the surface syntax", () => {
    const rule = parseRule('h(P) :- d(P, "a"), P = cat(P, "/", to_string(3)).');
    expect(rule.body.map((l) => (l.kind === "cmp" ? formatTerm(l.right) : ""))).toEqual(["", 'cat(P, "/", to_string(3))']);
  });
});
