import { describe, expect, it } from "bun:test";
import { compileProgram, type RuleProgram } from "../src/compile/compile.ts";
import { parseVocabulary } from "../src/compile/vocabulary.ts";
import { evaluate, evaluateProgram, unified } from "../src/verify/evaluate.ts";
import { verdictRows } from "../src/verify/differential.ts";
import type { FactSet } from "../src/verify/facts.ts";
import type { ProvisionRecord } from "../src/catalog/catalog.ts";
import type { ManifestEntry } from "../src/extract/extract.ts";

const vocabulary = parseVocabulary(`
relations:
  - name: edge
    source: wire
    columns: [{ name: from, type: symbol, domain: node }, { name: to, type: symbol, domain: node }]
  - name: item
    source: wire
    columns: [{ name: node, type: symbol }, { name: seq, type: number }]
  - name: bound
    source: deployment
    columns: [{ name: node, type: symbol }, { name: max, type: number }]
  - name: blocked
    source: wire
    columns: [{ name: node, type: symbol }]
  - name: envelope
    source: wire
    columns: [{ name: seq, type: number }, { name: session, type: symbol }, { name: direction, type: symbol }, { name: method, type: symbol }, { name: rpc_id, type: symbol }]
  - name: negotiated
    source: wire
    columns: [{ name: session, type: symbol }, { name: profile, type: symbol }]
  - name: available
    source: external
    columns: [{ name: relation, type: symbol }]
`);

type Spec = { id: string; subject: string[]; witness: string[]; rules: string[]; level?: ManifestEntry["level"]; modality?: ProvisionRecord["modality_kind"] };

function programOf(...specs: Spec[]): RuleProgram {
  const entries = specs.map((s) => {
    const manifest: ManifestEntry = { id: s.id, type: "Requirement", source_file: "x", line: 1, block_type: "paragraph", section_slug: null, level: s.level ?? "MUST", keywords: [], text: "", text_hash: "" };
    const record: ProvisionRecord = {
      id: s.id, title: "T", actor: "guardian", reported_against: "guardian", profile: ["acs-core"], activation: null, modality_kind: s.modality ?? "obligation", keyword: null, keyword_basis: null, evidence_class: "wire",
      schema_refs: [], depends_on: [], restates: null, status: "active", since: "0.1.0", superseded_by: [], reviewed_against: "", note: null,
      predicate: { kind: "rules", subject: s.subject, witness: s.witness, rules: s.rules },
    };
    return { manifest, record };
  });
  const p = compileProgram(vocabulary, entries, { version: null, commit: null });
  // A provision whose subject is a node cannot be attributed to a session; these tests are about the violations, so that is not a failure here.
  const attributable = new Set(p.verdicts.catalog.find((r) => r.name === "compiled")?.facts.map((t) => String(t[0])));
  for (const problem of p.problems) if (attributable.has(problem.id) || !/attributed to a session/.test(problem.message)) throw new Error(problem.message);
  return p;
}

function program(id: string, subject: string[], witness: string[], ...rules: string[]): RuleProgram {
  return programOf({ id, subject, witness, rules });
}

const facts = (init: Record<string, (string | number)[][]>): FactSet => new Map(Object.entries(init));

describe("evaluate -- the in-process engine's constructs", () => {
  it("negation", () => {
    const p = program("ACS-REQ-0001", ["N"], ["S"], "violation(N, S) :- item(S, N), not blocked(S).");
    const v = evaluate(p, facts({ item: [["a", 1], ["b", 2]], blocked: [["b"]] }));
    expect(v.map(unified)).toEqual(["ACS-REQ-0001\t1\ta"]);
  });

  it("count aggregation against a bound", () => {
    const p = program("ACS-REQ-0001", ["S"], ["N", "B"], "violation(S, N, B) :- bound(S, B), N = count : { item(S, _) }, N > B.");
    const v = evaluate(p, facts({ item: [["a", 1], ["a", 2], ["a", 3], ["b", 1]], bound: [["a", 2], ["b", 2]] }));
    expect(v.map(unified)).toEqual(["ACS-REQ-0001\ta\t3|2"]);
  });

  it("recursion (a transitive closure), semi-naively, and it terminates on a cycle", () => {
    const p = program("ACS-REQ-0001", ["X"], ["Y"], "violation(X, Y) :- reach(X, Y), blocked(Y).", "reach(X, Y) :- edge(X, Y).", "reach(X, Z) :- edge(X, Y), reach(Y, Z).");
    const v = evaluate(p, facts({ edge: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "b"]], blocked: [["d"]] }));
    expect(v.map(unified)).toEqual(["ACS-REQ-0001\ta\td", "ACS-REQ-0001\tb\td", "ACS-REQ-0001\tc\td", "ACS-REQ-0001\td\td"]);
  });

  it("a constant in the head is emitted as the column's value", () => {
    const p = program("ACS-REQ-0001", ["S"], ["Label"], 'violation(S, "missing") :- item(S, _), not blocked(S).');
    const v = evaluate(p, facts({ item: [["a", 1], ["b", 2]], blocked: [["b"]] }));
    expect(v.map(unified)).toEqual(["ACS-REQ-0001\ta\tmissing"]);
  });

  it("assignment binds a variable from an expression and to_string renders numbers", () => {
    const p = program("ACS-REQ-0001", ["S"], ["Label"], 'violation(S, Label) :- item(S, N), N > 1, Label = cat(S, "#", to_string(N)).');
    const v = evaluate(p, facts({ item: [["a", 1], ["a", 2]] }));
    expect(v.map(unified)).toEqual(["ACS-REQ-0001\ta\ta#2"]);
  });

  it("derives nothing from empty relations and keeps provisions independent", () => {
    const p = program("ACS-REQ-0001", ["N"], ["S"], "violation(N, S) :- item(S, N), not blocked(S).");
    expect(evaluate(p, facts({}))).toEqual([]);
  });
});

describe("evaluateProgram -- the verdict layer over the provisions' violations", () => {
  const p = programOf(
    { id: "ACS-REQ-0001", subject: ["S"], witness: ["N"], rules: ["violation(S, N) :- item(N, S), not blocked(N)."] },
    { id: "ACS-REQ-0002", subject: ["S"], witness: ["N"], rules: ["violation(S, N) :- item(N, S), not blocked(N)."], level: "SHOULD" },
    { id: "ACS-REQ-0003", subject: ["S"], witness: ["N"], rules: ["violation(S, N) :- item(N, S), bound(N, 0)."] },
    { id: "ACS-REQ-0004", subject: ["S"], witness: ["N"], rules: ["violation(S, N) :- item(N, S), blocked(N), bound(N, 0)."], modality: "conditional-on-exercise" },
  );
  const base = {
    envelope: [[1, "s1", "request", "m", "r"], [2, "s2", "request", "m", "r"]],
    item: [["a", 1], ["b", 2]],
    blocked: [["b"]],
    bound: [["a", 3]],
    negotiated: [["s1", "acs-core"], ["s2", "acs-trace"]],
    available: [["bound"]],
  };

  it("a MUST breached fails, a SHOULD breached deviates, a session that did not negotiate the profile is not activated", () => {
    const rows = verdictRows(evaluateProgram(p, facts(base)).verdicts);
    expect(rows.filter((r) => r.startsWith("fail"))).toEqual(["fail\tACS-REQ-0001\ts1"]);
    expect(rows.filter((r) => r.startsWith("deviates"))).toEqual(["deviates\tACS-REQ-0002\ts1"]);
    expect(rows.filter((r) => r.startsWith("not_activated"))).toEqual(["not_activated\tACS-REQ-0001\ts2", "not_activated\tACS-REQ-0002\ts2", "not_activated\tACS-REQ-0003\ts2", "not_activated\tACS-REQ-0004\ts2"]);
    // ACS-REQ-0003 reads bound (a deployment relation), which was supplied, and derives nothing for s1's item, whose bound is 3: it passes there.
    expect(rows.filter((r) => r.startsWith("pass"))).toEqual(["pass\tACS-REQ-0003\ts1"]);
    // ACS-REQ-0004 is conditional; its condition (a blocked item with a bound of 0) never arose in s1.
    expect(rows.filter((r) => r.startsWith("not_exercised"))).toEqual(["not_exercised\tACS-REQ-0004\ts1"]);
    expect(rows.filter((r) => r.startsWith("unevaluated"))).toEqual([]);
  });

  it("a relation not listed as available makes the provisions that need it unevaluated, never passed", () => {
    const rows = verdictRows(evaluateProgram(p, facts({ ...base, available: [] })).verdicts);
    expect(rows.filter((r) => r.startsWith("unevaluated"))).toEqual(["unevaluated\tACS-REQ-0003", "unevaluated\tACS-REQ-0004"]);
    expect(rows.filter((r) => /^(pass|not_exercised)\t/.test(r))).toEqual([]);
    expect(rows.filter((r) => r.startsWith("fail"))).toEqual(["fail\tACS-REQ-0001\ts1"]);
  });

  it("a conditional provision whose condition arose is judged like any other, and stays not exercised where it did not", () => {
    const rows = verdictRows(evaluateProgram(p, facts({ ...base, bound: [["a", 3], ["b", 0]], negotiated: [["s1", "acs-core"], ["s2", "acs-core"]] })).verdicts);
    expect(rows.filter((r) => r.includes("ACS-REQ-0004"))).toEqual(["fail\tACS-REQ-0004\ts2", "not_exercised\tACS-REQ-0004\ts1"]);
  });
});

