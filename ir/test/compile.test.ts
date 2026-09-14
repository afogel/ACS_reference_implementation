import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { loadCatalog, loadRecords, type ProvisionRecord } from "../src/catalog/catalog.ts";
import { compileProgram, compileProvision, slug } from "../src/compile/compile.ts";
import { emitSouffleProgram } from "../src/compile/emit-souffle.ts";
import { loadVocabulary, parseVocabulary } from "../src/compile/vocabulary.ts";
import { defaultManifestPath, type Manifest, type ManifestEntry } from "../src/extract/extract.ts";

const vocabulary = loadVocabulary();
const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
const ids = new Set(manifest.provisions.map((p) => p.id));

const entry = (id: string, type: ManifestEntry["type"] = "Requirement"): ManifestEntry => ({
  id,
  type,
  source_file: "spec/x.md",
  line: 1,
  block_type: "paragraph",
  section_slug: null,
  level: "MUST",
  keywords: ["MUST"],
  text: "t",
  text_hash: "h",
});
const record = (id: string, extra: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  id,
  title: "T",
  actor: "guardian",
  reported_against: "guardian",
  profile: ["acs-core"],
  activation: null,
  modality_kind: "obligation",
  evidence_class: "wire",
  schema_refs: [],
  depends_on: [],
  restates: null,
  status: "active",
  since: "0.1.0",
  superseded_by: [],
  reviewed_against: "h",
  note: null,
  predicate: null,
  ...extra,
});
const rules = (subject: string[], witness: string[], ...rules: string[]): ProvisionRecord["predicate"] => ({ kind: "rules", subject, witness, rules });
const compileOne = (r: ProvisionRecord, type: ManifestEntry["type"] = "Requirement") => compileProvision(vocabulary, entry(r.id, type), r, ids);

describe("compileProvision -- what the type checker refuses", () => {
  it("compiles a well-typed, safe, stratified predicate and renames its helpers", () => {
    const c = compileOne(record("ACS-REQ-0007", { predicate: rules(["Seq"], ["Session"], "violation(Seq, Session) :- hook(Seq, Session, _), not before(Session, Seq).", "before(Session, Seq) :- handshake(H, Session), hook(Seq, Session, _), H < Seq.") }));
    expect(c.status).toBe("compiled");
    expect(c.violation).toEqual({ name: "acs_req_0007__violation", columns: [{ name: "subject_seq", type: "number" }, { name: "witness_session", type: "symbol" }] });
    expect(c.helpers).toEqual([{ local: "before", name: "acs_req_0007__before", columns: [{ name: "c1", type: "symbol" }, { name: "c2", type: "number" }] }]);
    expect(c.strata).toEqual([["acs_req_0007__before"], ["acs_req_0007__violation"]]);
    expect(c.external_facts).toEqual([]);
    expect(slug("ACS-REQ-0007")).toBe("acs_req_0007");
  });

  it("refuses an unknown relation, a wrong arity, and a type clash (R3.2)", () => {
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- nope(S, X).") }))).toThrow("neither a vocabulary relation nor a helper");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X).") }))).toThrow("hook takes 3 argument(s), got 2");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), decision(X, _).") }))).toThrow("used as both symbol and number");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], 'violation(S, X) :- hook(S, X, _), S < "a".') }))).toThrow("comparing number with symbol");
  });

  it("refuses unsafe rules: a negated or compared variable nothing binds, a head variable nothing binds", () => {
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), not decision(R, _).") }))).toThrow("variable R in a negated atom is not bound");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), R > 1.") }))).toThrow("variable R in a comparison is not bound");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, _, _).") }))).toThrow("violation variable X is not bound by a positive atom");
  });

  it("refuses a predicate that is not stratifiable", () => {
    expect(() =>
      compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), not bad(S).", "bad(S) :- hook(S, _, _), not good(S).", "good(S) :- hook(S, _, _), not bad(S).") })),
    ).toThrow("depends negatively on");
  });

  it("enforces the evidence columns (N36): violation is exactly subject then witness, both non-empty", () => {
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], [], "violation(S) :- hook(S, _, _).") }))).toThrow("at least one subject and one witness column");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(X, S) :- hook(S, X, _).") }))).toThrow("violation(S, X) is the only allowed head");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["S"], "violation(S, S) :- hook(S, _, _).") }))).toThrow("must be distinct");
  });

  it("refuses a testable Requirement with no predicate and no inexpressible reason (R3.1, R3.6)", () => {
    expect(() => compileOne(record("ACS-REQ-0001"))).toThrow("needs a predicate, or a declared inexpressible reason");
    expect(compileOne(record("ACS-REQ-0001", { predicate: { kind: "inexpressible", reason: "no relation observes it" } })).status).toBe("inexpressible");
  });

  it("skips permissions, non-testables and non-Requirements, and refuses a predicate on them", () => {
    expect(compileOne(record("ACS-REQ-0021", { modality_kind: "permission" })).status).toBe("permission");
    expect(compileOne(record("ACS-REQ-0019", { evidence_class: "non-testable" })).status).toBe("non-testable");
    expect(compileOne(record("ACS-DEF-0001"), "Definition").status).toBe("no-predicate");
    expect(() => compileOne(record("ACS-DEF-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _).") }), "Definition")).toThrow("carries no predicate");
  });

  it("accepts an alias only of the provision this one restates", () => {
    expect(compileOne(record("ACS-REQ-0024", { restates: "ACS-REQ-0023", predicate: { kind: "alias", alias_of: "ACS-REQ-0023" } })).status).toBe("alias");
    expect(() => compileOne(record("ACS-REQ-0024", { restates: "ACS-REQ-0023", predicate: { kind: "alias", alias_of: "ACS-REQ-0007" } }))).toThrow("must point at the provision this one restates");
  });
});

describe("the real catalog compiles", () => {
  const catalog = loadCatalog(manifest, loadRecords().records);
  const program = compileProgram(vocabulary, catalog.entries, manifest.corpus);

  it("with no problems: 21 compiled, one alias, one permission, one non-testable, four with no predicate", () => {
    expect(program.problems).toEqual([]);
    const counts: Record<string, number> = {};
    for (const p of program.provisions) counts[p.status] = (counts[p.status] ?? 0) + 1;
    expect(counts).toEqual({ compiled: 21, alias: 1, permission: 1, "non-testable": 1, "no-predicate": 4 });
  });

  it("declares the external-fact boundary per provision (E7.1)", () => {
    const byId = Object.fromEntries(program.provisions.map((p) => [p.id, p]));
    expect(byId["ACS-REQ-0013"]?.external_facts).toEqual([
      { relation: "context_entry", source: "guardian-state" },
      { relation: "entry_hash_recomputed", source: "external" },
    ]);
    expect(byId["ACS-REQ-0007"]?.external_facts).toEqual([]);
  });

  it("puts the recursive, path-carrying closure in its own stratum below the violation", () => {
    const p = program.provisions.find((x) => x.id === "ACS-REQ-0010");
    expect(p?.strata).toEqual([["acs_req_0010__ancestor"], ["acs_req_0010__violation"]]);
  });

  it("emits a Soufflé program with inputs, inline static facts, and the unified output", () => {
    const dl = emitSouffleProgram(program);
    expect(dl).toContain(".decl hook(seq:number, session:symbol, method:symbol)\n.input hook(IO=file, filename=\"hook.facts\", delimiter=\"\\t\")");
    expect(dl).toContain('required_field("deny", "reasoning").');
    expect(dl).toContain(".decl violation(provision:symbol, subject:symbol, witness:symbol)");
    expect(dl).toContain('violation("ACS-REQ-0007", to_string(V0), cat(cat(V1, "|"), V2)) :- acs_req_0007__violation(V0, V1, V2).');
    expect(dl).toContain("acs_req_0010__ancestor(Pid, Ancestor, Path) :- derived_from(_, Pid, Parent), acs_req_0010__ancestor(Parent, Ancestor, Rest), Path = cat(cat(Pid, \"<-\"), Rest).");
    expect(dl).toContain("Deferrals = count : { acs_req_0006__defer_in(Session, _) }");
  });
});

describe("parseVocabulary -- the vocabulary's own shape", () => {
  it("rejects a static relation without facts, facts on a non-static one, and a wrong-arity fact", () => {
    expect(() => parseVocabulary("relations:\n  - name: a\n    source: static\n    columns: [{ name: x, type: symbol }]\n")).toThrow("must list its facts");
    expect(() => parseVocabulary("relations:\n  - name: a\n    source: wire\n    columns: [{ name: x, type: symbol }]\n    facts: [[y]]\n")).toThrow("only static relations carry facts");
    expect(() => parseVocabulary("relations:\n  - name: a\n    source: static\n    columns: [{ name: x, type: symbol }]\n    facts: [[y, z]]\n")).toThrow("wrong arity");
    expect(() => parseVocabulary("relations:\n  - name: a\n    source: static\n    columns: [{ name: x, type: number }]\n    facts: [[y]]\n")).toThrow("must be a number");
  });
});
