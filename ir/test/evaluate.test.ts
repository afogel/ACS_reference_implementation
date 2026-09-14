import { describe, expect, it } from "bun:test";
import { compileProvision, type RuleProgram } from "../src/compile/compile.ts";
import { parseVocabulary } from "../src/compile/vocabulary.ts";
import { evaluate, unified } from "../src/verify/evaluate.ts";
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
`);

function program(id: string, subject: string[], witness: string[], ...rules: string[]): RuleProgram {
  const manifest: ManifestEntry = { id, type: "Requirement", source_file: "x", line: 1, block_type: "paragraph", section_slug: null, level: "MUST", keywords: [], text: "", text_hash: "" };
  const record: ProvisionRecord = {
    id, title: "T", actor: "guardian", reported_against: "guardian", profile: ["acs-core"], activation: null, modality_kind: "obligation", evidence_class: "wire",
    schema_refs: [], depends_on: [], restates: null, status: "active", since: "0.1.0", superseded_by: [], reviewed_against: "", note: null,
    predicate: { kind: "rules", subject, witness, rules },
  };
  return { generated_by: "t", corpus: { version: null, commit: null }, relations: [...vocabulary.relations.values()], domains: [...vocabulary.domains.entries()].map(([name, type]) => ({ name, type })), provisions: [compileProvision(vocabulary, manifest, record, new Set([id]))], problems: [] };
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
