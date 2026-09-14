/**
 * R3.8: both engines over the shared fixtures, held equivalent. Soufflé runs
 * when a binary is present (CI installs it; locally set SOUFFLE); without
 * one the evaluator is still held to every fixture's expectation, and the
 * test that needs Soufflé says so rather than passing vacuously.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCatalog, loadRecords } from "../src/catalog/catalog.ts";
import { compileProgram, type RuleProgram } from "../src/compile/compile.ts";
import { emitSouffleProgram } from "../src/compile/emit-souffle.ts";
import { loadVocabulary } from "../src/compile/vocabulary.ts";
import { defaultManifestPath, type Manifest } from "../src/extract/extract.ts";
import { differentialCheck, findSouffle } from "../src/verify/differential.ts";

const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
const program = compileProgram(loadVocabulary(), loadCatalog(manifest, loadRecords().records).entries, manifest.corpus);
const dl = emitSouffleProgram(program);
const fixtures = resolve(import.meta.dir, "conformance", "fixtures");
const souffle = findSouffle();

describe("differentialCheck -- the evaluator against the fixtures' expectations", () => {
  const report = differentialCheck(program, dl, fixtures, null);

  it("agrees with expected.tsv on every fixture", () => {
    expect(report.fixtures.map((f) => [f.fixture, f.ok, f.evaluator.length])).toEqual([
      ["conformant", true, 0],
      ["violating", true, 33],
    ]);
  });

  it("the violating fixture breaches every V5 compiled provision and the V7 ones its README names, and nothing that did not compile", () => {
    const violating = report.fixtures.find((f) => f.fixture === "violating");
    const provisions = new Set((violating?.evaluator ?? []).map((v) => v.split("\t")[0] ?? ""));
    const compiled = new Set(program.provisions.filter((p) => p.status === "compiled").map((p) => p.id));
    for (const id of provisions) expect(compiled.has(id)).toBe(true);
    const v5 = ["ACS-REQ-0001", "ACS-REQ-0002", "ACS-REQ-0003", "ACS-REQ-0004", "ACS-REQ-0005", "ACS-REQ-0006", "ACS-REQ-0007", "ACS-REQ-0008", "ACS-REQ-0009", "ACS-REQ-0010", "ACS-REQ-0011", "ACS-REQ-0012", "ACS-REQ-0013", "ACS-REQ-0014", "ACS-REQ-0015", "ACS-REQ-0016", "ACS-REQ-0017", "ACS-REQ-0018", "ACS-REQ-0020", "ACS-REQ-0022", "ACS-REQ-0023"];
    const v7 = ["ACS-REQ-0027", "ACS-REQ-0060", "ACS-REQ-0062", "ACS-REQ-0092", "ACS-REQ-0134", "ACS-REQ-0138"];
    expect([...provisions].sort()).toEqual([...v5, ...v7]);
  });

  it("names a wrong expectation as divergence rather than trusting the engines", () => {
    const tampered: RuleProgram = JSON.parse(JSON.stringify(program));
    const p = tampered.provisions.find((x) => x.id === "ACS-REQ-0007");
    if (!p) throw new Error("missing");
    p.rules = p.rules.filter((r) => r.head.relation !== "acs_req_0007__violation");
    const r = differentialCheck(tampered, dl, fixtures, null).fixtures.find((f) => f.fixture === "violating");
    expect(r?.ok).toBe(false);
    expect(r?.evaluator_vs_expected.only_expected).toEqual(["ACS-REQ-0007\t2\ts1|steps/toolCallRequest"]);
  });
});

describe("differentialCheck -- Soufflé as the oracle (R3.8, X4)", () => {
  it("has a Soufflé binary to run (CI installs 2.5; locally set SOUFFLE=/path/to/souffle)", () => {
    if (!souffle) {
      console.warn("differential: no souffle binary; the oracle half of R3.8 is not exercised in this run");
    }
    expect(process.env.CI ? souffle !== null : true).toBe(true);
  });

  it("derives identical violation sets on both fixtures", () => {
    if (!souffle) return;
    const report = differentialCheck(program, dl, fixtures, souffle);
    for (const f of report.fixtures) {
      expect(f.evaluator_vs_souffle).toEqual({ only_evaluator: [], only_souffle: [] });
      expect(f.souffle).toEqual(f.evaluator);
    }
    expect(report.ok).toBe(true);
  });

  it("turns red on a deliberate divergence and prints the tuples only one engine derived (U31)", () => {
    if (!souffle) return;
    // Weaken the evaluator's copy of one rule; the published .dl keeps the real one.
    const tampered: RuleProgram = JSON.parse(JSON.stringify(program));
    const p = tampered.provisions.find((x) => x.id === "ACS-REQ-0004");
    if (!p) throw new Error("missing");
    p.rules = p.rules.map((r) => ({ ...r, body: r.body.filter((l) => !(l.kind === "atom" && l.negated)) }));
    const r = differentialCheck(tampered, dl, fixtures, souffle).fixtures.find((f) => f.fixture === "violating");
    expect(r?.ok).toBe(false);
    expect(r?.evaluator_vs_souffle?.only_evaluator).toEqual(["ACS-REQ-0004\t40\tresolution_method", "ACS-REQ-0004\t50\tresolution_method", "ACS-REQ-0004\t50\tresolution_timeout_ms", "ACS-REQ-0004\t50\ttimeout_decision"]);
    expect(r?.evaluator_vs_souffle?.only_souffle).toEqual([]);
  });
});

describe("the published program", () => {
  it("is the committed ir/dist/rules.dl", () => {
    expect(readFileSync(join(import.meta.dir, "..", "dist", "rules.dl"), "utf8")).toBe(dl);
  });
});
