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
  keyword: null,
  keyword_basis: null,
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
    expect(c.violation).toEqual({ name: "acs_req_0007__violation", columns: [{ name: "subject_seq", type: "number", domain: "seq" }, { name: "witness_session", type: "symbol", domain: "session" }] });
    expect(c.helpers).toEqual([{ local: "before", name: "acs_req_0007__before", columns: [{ name: "c1", type: "symbol", domain: "session" }, { name: "c2", type: "number", domain: "seq" }] }]);
    expect(c.strata).toEqual([["acs_req_0007__before"], ["acs_req_0007__violation"]]);
    expect(c.external_facts).toEqual([]);
    expect(slug("ACS-REQ-0007")).toBe("acs_req_0007");
  });

  it("refuses an unknown relation, a wrong arity, and a type clash (R3.2)", () => {
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- nope(S, X).") }))).toThrow("neither a vocabulary relation nor a helper");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X).") }))).toThrow("hook takes 3 argument(s), got 2");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), decision(X, _).") }))).toThrow("used as both session and seq");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], 'violation(S, X) :- hook(S, X, _), S < "a".') }))).toThrow("comparing number with symbol");
  });

  it("refuses a join or a comparison across two domains of the same base type (a seq is not a bound)", () => {
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), defer_bound(X, S).") }))).toThrow("variable S is used as both seq and bound");
    expect(() => compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _), defer_bound(X, B), S > B.") }))).toThrow("comparing a seq with a bound");
    // The same value under another column name is one domain: response_to's request_seq is a seq.
    const c = compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], 'violation(S, X) :- hook(S, X, _), response_to(S, R), decision(R, "deny").') }));
    expect(c.status).toBe("compiled");
  });

  it("accepts a constant in a head position, typed by the base type, and a base-typed value alongside a domain in another rule", () => {
    const c = compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["Field"], 'violation(S, "reasoning") :- hook(S, _, _), not result_field(S, "reasoning").') }));
    expect(c.violation?.columns[1]).toEqual({ name: "witness_field", type: "symbol", domain: null });
    const mixed = compileOne(
      record("ACS-REQ-0001", {
        predicate: rules(["S"], ["Detail"], "violation(S, Detail) :- hook(S, _, _), result_field(S, Detail).", 'violation(S, Detail) :- hook(S, _, _), decision(S, D), Detail = cat("decision=", D).'),
      }),
    );
    expect(mixed.violation?.columns[1]).toEqual({ name: "witness_detail", type: "symbol", domain: null });
    expect(() =>
      compileOne(record("ACS-REQ-0001", { predicate: rules(["S"], ["X"], "violation(S, X) :- hook(S, X, _).", "violation(S, X) :- hook(S, _, X).") })),
    ).toThrow("violation column 2 is session in one rule and method in another");
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

  it("with no problems: 69 compiled, 3 aliases, 39 permissions, 25 non-testable, 12 inexpressible, 7 with no predicate (V7)", () => {
    expect(program.problems).toEqual([]);
    const counts: Record<string, number> = {};
    for (const p of program.provisions) counts[p.status] = (counts[p.status] ?? 0) + 1;
    expect(counts).toEqual({ compiled: 69, alias: 3, permission: 39, "non-testable": 25, inexpressible: 12, "no-predicate": 7 });
  });

  it("declares the external-fact boundary per provision (E7.1)", () => {
    const byId = Object.fromEntries(program.provisions.map((p) => [p.id, p]));
    expect(byId["ACS-REQ-0013"]?.external_facts).toEqual([
      { relation: "context_entry", source: "guardian-state" },
      { relation: "entry_hash_recomputed", source: "external" },
    ]);
    expect(byId["ACS-REQ-0007"]?.external_facts).toEqual([]);
  });

  it("puts the recursive lineage closure in its own stratum below the violation", () => {
    const p = program.provisions.find((x) => x.id === "ACS-REQ-0010");
    expect(p?.strata).toEqual([["acs_req_0010__ancestor"], ["acs_req_0010__violation"]]);
  });

  it("emits a Soufflé program with domain subtypes, typed inputs, inline static facts, and one typed output per provision", () => {
    const dl = emitSouffleProgram(program);
    expect(dl).toContain(".type Seq <: number\n");
    expect(dl).toContain(".type EntryId <: symbol\n");
    expect(dl).toContain(".decl hook(seq:Seq, session:Session, method:Method)\n.input hook(IO=file, filename=\"hook.facts\", delimiter=\"\\t\")");
    expect(dl).toContain(".decl response_to(request_seq:Seq, response_seq:Seq)");
    expect(dl).toContain('required_field("deny", "reasoning").');
    expect(dl).toContain('default_trust("user_input", "trusted").');
    expect(dl).toContain(".decl acs_req_0007__violation(subject_seq:Seq, witness_session:Session, witness_method:Method)\n.output acs_req_0007__violation\n");
    expect(dl).not.toContain("cat(cat(");
    expect(dl).not.toContain(".decl violation(");
    expect(dl).toContain("acs_req_0010__ancestor(Pid, Ancestor) :- derived_from(_, Pid, Parent), acs_req_0010__ancestor(Parent, Ancestor).");
    expect(dl).toContain('acs_req_0062__violation(Session, EntryId, "request_hash") :- context_entry(Session, EntryId, _, _), !context_entry_field(Session, EntryId, "request_hash").');
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

  it("gives every column a domain, defaulting to its name, and refuses one domain with two base types", () => {
    const v = parseVocabulary("relations:\n  - name: a\n    source: wire\n    columns: [{ name: seq, type: number }, { name: parent_seq, type: number, domain: seq }]\n");
    expect(v.relations.get("a")?.columns.map((c) => c.domain)).toEqual(["seq", "seq"]);
    expect([...v.domains.entries()]).toEqual([["seq", "number"]]);
    expect(() => parseVocabulary("relations:\n  - name: a\n    source: wire\n    columns: [{ name: seq, type: number }, { name: x, type: symbol, domain: seq }]\n")).toThrow("domain seq is number elsewhere, symbol here");
  });
});

describe("the verdict layer -- RFC 2119 strength as facts, verdicts as rules", () => {
  const manifestEntry = (id: string, level: ManifestEntry["level"]): ManifestEntry => ({ ...entry(id), level, keywords: level ? [level] : [] });
  const program = compileProgram(
    vocabulary,
    [
      { manifest: manifestEntry("ACS-REQ-0007", "MUST"), record: record("ACS-REQ-0007", { predicate: rules(["Seq"], ["Session"], "violation(Seq, Session) :- hook(Seq, Session, _), not handshake(_, Session).") }) },
      { manifest: manifestEntry("ACS-REQ-0012", "SHOULD"), record: record("ACS-REQ-0012", { profile: ["acs-audit"], predicate: rules(["Session"], ["Seq"], 'violation(Session, Seq) :- intent_modification_rejected(Session, Seq), not audit_event(Session, Seq, "intent_modification_rejected").') }) },
      { manifest: manifestEntry("ACS-REQ-0022", "MUST"), record: record("ACS-REQ-0022", { modality_kind: "conditional-on-exercise", predicate: rules(["Session"], ["Field"], "violation(Session, Field) :- archived(Session), archive_required_field(Field), not archive_preserved(Session, Field).") }) },
      { manifest: manifestEntry("ACS-REQ-0021", "MAY"), record: record("ACS-REQ-0021", { modality_kind: "permission" }) },
      { manifest: manifestEntry("ACS-REQ-0003", "MUST"), record: record("ACS-REQ-0003", { predicate: rules(["Seq"], ["Field"], 'violation(Seq, "reasoning") :- decision(Seq, "deny"), not result_field(Seq, "reasoning").') }) },
    ],
    { version: null, commit: null },
  );

  it("states each compiled provision's strength, polarity, profiles and needs as facts, and every Requirement's profiles", () => {
    const fact = (name: string) => program.verdicts.catalog.find((r) => r.name === name)?.facts;
    expect(fact("strength")).toEqual([["ACS-REQ-0007", "must"], ["ACS-REQ-0012", "should"], ["ACS-REQ-0022", "must"], ["ACS-REQ-0003", "must"]]);
    expect(fact("polarity")?.every((t) => t[1] === "obligation")).toBe(true);
    expect(fact("provision")).toEqual([["ACS-REQ-0007"], ["ACS-REQ-0012"], ["ACS-REQ-0022"], ["ACS-REQ-0021"], ["ACS-REQ-0003"]]);
    expect(fact("requires_profile")).toEqual([["ACS-REQ-0003", "acs-core"], ["ACS-REQ-0007", "acs-core"], ["ACS-REQ-0012", "acs-audit"], ["ACS-REQ-0021", "acs-core"], ["ACS-REQ-0022", "acs-core"]]);
    expect(fact("needs")).toEqual([["ACS-REQ-0012", "audit_event"], ["ACS-REQ-0012", "intent_modification_rejected"], ["ACS-REQ-0022", "archive_preserved"], ["ACS-REQ-0022", "archived"]]);
    expect(fact("conditional")).toEqual([["ACS-REQ-0022"]]);
  });

  it("attributes a violation to a session through a session column, or a seq column joined to envelope, and reads a conditional provision's exercise off its positive atoms", () => {
    const sources = program.verdicts.rules.map((r) => r.source);
    // A session column anywhere in the violation is used directly; a violation keyed by seq alone joins envelope.
    expect(sources).toContain('violated("ACS-REQ-0007", S) :- acs_req_0007__violation(_, S).');
    expect(sources).toContain('violated("ACS-REQ-0012", S) :- acs_req_0012__violation(S, _).');
    expect(sources).toContain('violated("ACS-REQ-0003", S) :- acs_req_0003__violation(Q, _), envelope(Q, S, _, _, _).');
    expect(sources).toContain('exercised("ACS-REQ-0022", Session) :- archived(Session).');
    expect(program.verdicts.outputs).toEqual(["fail", "deviates", "pass", "unevaluated", "not_activated", "not_exercised"]);
    expect(program.verdicts.strata.flat()).toEqual(["violated", "exercised", "active", "unevaluated", "not_activated", "not_exercised", "fail", "deviates", "pass"]);
    expect(program.domains.map((d) => d.name)).toContain("provision");
  });

  it("refuses a provision whose violation names neither a session nor a seq, since no session could be judged by it", () => {
    const p = compileProgram(vocabulary, [{ manifest: manifestEntry("ACS-REQ-0014", "MUST"), record: record("ACS-REQ-0014", { predicate: rules(["Pid"], ["Other"], "violation(Pid, Other) :- provenance(_, _, Pid, _), provenance(_, _, Other, _), Pid != Other.") }) }], { version: null, commit: null });
    expect(p.problems.map((x) => x.message)).toEqual(["ACS-REQ-0014: no subject or witness column holds a session or a seq, so a violation cannot be attributed to a session"]);
  });

  it("emits the layer into the published program: catalog facts inline, the verdicts as outputs, the rules last", () => {
    const dl = emitSouffleProgram(program);
    expect(dl).toContain('.decl strength(provision:Provision, strength:Strength)\nstrength("ACS-REQ-0007", "must").');
    expect(dl).toContain(".decl deviates(provision:Provision, session:Session)\n.output deviates");
    expect(dl).toContain('deviates(P, S) :- violated(P, S), active(P, S), strength(P, "should"), !unevaluated(P).');
    expect(dl).toContain(".type Provision <: symbol");
  });
});

