/**
 * V6: `acs-ir verify <trace>` end to end over the generated envelope logs,
 * plus the ordinary-code pieces it rests on (JCS, chain hashes, HMAC).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, loadRecords } from "../src/catalog/catalog.ts";
import { compileProgram } from "../src/compile/compile.ts";
import { loadVocabulary } from "../src/compile/vocabulary.ts";
import { defaultManifestPath, type Manifest } from "../src/extract/extract.ts";
import { defaultSchemaDir } from "../src/lint/schema-refs.ts";
import { renderConformanceReport } from "../src/render/report.ts";
import { evaluateProgram } from "../src/verify/evaluate.ts";
import { computeExternalFacts } from "../src/verify/external-facts.ts";
import { canonicalize, chainEntryHash, signHmac, verifyHmac } from "../src/verify/jcs.ts";
import { findProvenance, normalizeTrace, parseTrace, readTrace } from "../src/verify/normalize-trace.ts";
import { hookSchemaFile, loadSchemas } from "../src/verify/schemas.ts";
import { judge, scopeByProfile } from "../src/verify/verdicts.ts";
import { SESSION, TEST_HMAC_KEY, writeFixture } from "./fixtures/trace/generate.ts";

const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
const catalog = loadCatalog(manifest, loadRecords().records);
const program = compileProgram(loadVocabulary(), catalog.entries, manifest.corpus);
const schemas = loadSchemas(defaultSchemaDir());

function run(kind: "clean" | "violating", options: { key?: boolean; guardian?: boolean; deployment?: boolean; negotiated?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `acs-ir-${kind}-`));
  const trace = writeFixture(dir, kind);
  const normalized = normalizeTrace(readTrace(trace));
  const external = computeExternalFacts(normalized, program.relations, schemas, {
    hmacKey: options.key === false ? null : TEST_HMAC_KEY,
    guardianDir: options.guardian === false ? null : join(dir, "guardian"),
    deploymentDir: options.deployment === false ? null : join(dir, "deployment"),
  });
  const facts = new Map(normalized.facts);
  for (const rel of program.relations) if (rel.source === "static") facts.set(rel.name, rel.facts.map((t) => [...t]));
  for (const [r, tuples] of external.facts) facts.set(r, [...(facts.get(r) ?? []), ...tuples]);
  const negotiated = options.negotiated ?? [...new Set(normalized.sessions.flatMap((s) => s.profiles))];
  // An override of the negotiated profiles is an override of the `negotiated` facts the verdict rules read.
  if (options.negotiated) facts.set("negotiated", normalized.sessions.flatMap((s) => (options.negotiated as string[]).map((p) => [s.session, p])));
  const verdicts = judge(program, catalog, evaluateProgram(program, facts), facts, new Set());
  return { dir, trace, normalized, external, facts, verdicts, negotiated };
}

const byVerdict = (verdicts: ReturnType<typeof run>["verdicts"], verdict: string): string[] => verdicts.filter((v) => v.verdict === verdict).map((v) => v.id);

describe("acs-ir verify -- the clean trace", () => {
  const r = run("clean");

  it("negotiates its profiles from the ServerHello and derives the wire relations", () => {
    expect(r.normalized.sessions).toEqual([{ session: SESSION, profiles: ["acs-core", "acs-provenance"], negotiated_version: "0.1.0" }]);
    expect(r.facts.get("handshake")).toEqual([[1, SESSION]]);
    expect(r.facts.get("hook")?.map((t) => t[2])).toEqual(["steps/sessionStart", "steps/toolCallRequest", "steps/toolCallResult", "steps/agentResponse"]);
    expect(r.facts.get("decision")).toEqual([[4, "allow"], [6, "deny"], [8, "defer"], [10, "allow"]]);
    expect(r.facts.get("derived_from")).toEqual([[7, "p2", "p1"], [9, "p3", "p2"]]);
    expect(r.facts.get("schema_violation") ?? []).toEqual([]);
  });

  it("violates nothing, and reports the rest by kind rather than dropping it", () => {
    expect(byVerdict(r.verdicts, "fail")).toEqual([]);
    // V7 sizes: 63 + 2 + 33 + 17 + 10 + 1 + 4 + 2 + 23 not-activated = 155, every provision with one verdict.
    expect(byVerdict(r.verdicts, "pass")).toHaveLength(63);
    expect(byVerdict(r.verdicts, "not-exercised")).toEqual(["ACS-REQ-0022", "ACS-REQ-0102"]);
    expect(byVerdict(r.verdicts, "permission")).toHaveLength(33);
    expect(byVerdict(r.verdicts, "permission")).toContain("ACS-REQ-0021");
    expect(byVerdict(r.verdicts, "non-testable")).toHaveLength(17);
    expect(byVerdict(r.verdicts, "non-testable")).toContain("ACS-REQ-0019");
    expect(byVerdict(r.verdicts, "inexpressible")).toHaveLength(10);
    expect(byVerdict(r.verdicts, "exclusion")).toEqual(["ACS-EXC-0001"]);
    expect(byVerdict(r.verdicts, "invariant")).toEqual(["ACS-INV-0001", "ACS-INV-0002", "ACS-INV-0003", "ACS-INV-0004"]);
    expect(byVerdict(r.verdicts, "definition")).toEqual(["ACS-DEF-0001", "ACS-DEF-0002"]);
    // The clean session negotiates acs-core and acs-provenance; ACS-Audit, ACS-Inspect and ACS-Crypto provisions are not activated (R4.3).
    expect(byVerdict(r.verdicts, "not-activated")).toHaveLength(23);
    expect(byVerdict(r.verdicts, "not-activated")).toContain("ACS-REQ-0134");
    expect(byVerdict(r.verdicts, "unevaluated")).toEqual([]);
    expect(r.verdicts).toHaveLength(155);
  });

  it("marks what it was not given the facts for as unevaluated, never as a pass", () => {
    const blind = run("clean", { key: false, guardian: false, deployment: false });
    const unevaluated = blind.verdicts.filter((v) => v.verdict === "unevaluated");
    const v2 = ["ACS-REQ-0002", "ACS-REQ-0006", "ACS-REQ-0008", "ACS-REQ-0011", "ACS-REQ-0012", "ACS-REQ-0013", "ACS-REQ-0015", "ACS-REQ-0017", "ACS-REQ-0018", "ACS-REQ-0020", "ACS-REQ-0022", "ACS-REQ-0023", "ACS-REQ-0024"];
    expect(unevaluated.map((v) => v.id).slice(0, v2.length)).toEqual(v2);
    // 35: the 34 V7 counted, plus ACS-REQ-0111, whose step_provenance relation only the Guardian can supply.
    expect(unevaluated).toHaveLength(35);
    for (const v of unevaluated) expect(v.missing.length).toBeGreaterThan(0);
    expect(unevaluated.find((v) => v.id === "ACS-REQ-0017")?.missing).toEqual(["signature_covers"]);
    expect(byVerdict(blind.verdicts, "fail")).toEqual([]);
  });

  it("scopes to the negotiated profiles: an acs-core-only session is never judged against ACS-Provenance", () => {
    const core = run("clean", { negotiated: ["acs-core"] });
    const notActivated = byVerdict(core.verdicts, "not-activated");
    expect(notActivated.slice(0, 4)).toEqual(["ACS-REQ-0009", "ACS-REQ-0010", "ACS-REQ-0014", "ACS-REQ-0019"]);
    expect(notActivated).toHaveLength(36);
    expect(notActivated).toContain("ACS-REQ-0027");
    expect(scopeByProfile("all", ["acs-core"])).toBe(true);
    expect(scopeByProfile(["acs-crypto"], ["acs-core"])).toBe(false);
  });
});

describe("acs-ir verify -- the violating trace", () => {
  const r = run("violating");

  it("fails exactly the provisions the fixture breaches", () => {
    expect(byVerdict(r.verdicts, "fail")).toEqual([
      "ACS-REQ-0001",
      "ACS-REQ-0003",
      "ACS-REQ-0004",
      "ACS-REQ-0005",
      "ACS-REQ-0007",
      "ACS-REQ-0010",
      "ACS-REQ-0013",
      "ACS-REQ-0016",
      "ACS-REQ-0018",
    ]);
  });

  it("judges per session, and the report's verdict is the fold: this trace has one session, so it is that session's", () => {
    const early = r.verdicts.find((v) => v.id === "ACS-REQ-0007");
    expect(early?.sessions).toEqual([{ session: SESSION, verdict: "fail" }]);
    expect(early?.keyword).toBe("MUST");
    const archival = r.verdicts.find((v) => v.id === "ACS-REQ-0102");
    expect(archival?.sessions).toEqual([{ session: SESSION, verdict: "not-exercised" }]);
    // No SHOULD is breached in this trace, so nothing deviates; the verdict exists for the trace that does.
    expect(byVerdict(r.verdicts, "deviates")).toEqual([]);
  });

  it("attaches evidence that names the subject, the witness, and the facts (R3.4)", () => {
    const trust = r.verdicts.find((v) => v.id === "ACS-REQ-0010");
    expect(trust?.evidence).toHaveLength(1);
    expect(trust?.evidence[0]?.subject).toEqual([{ name: "Seq", value: 11 }, { name: "Pid", value: "p3" }]);
    expect(trust?.evidence[0]?.witness.map((w) => `${w.name}=${w.value}`)).toEqual(["Ancestor=p2", "Level=trusted", "AncestorLevel=untrusted"]);
    expect(trust?.evidence[0]?.facts).toContainEqual({ relation: "derived_from", tuple: [11, "p3", "p2"] });
    const chain = r.verdicts.find((v) => v.id === "ACS-REQ-0013");
    expect(chain?.evidence[0]?.subject.map((s) => s.name)).toEqual(["Session", "EntryId"]);
    const early = r.verdicts.find((v) => v.id === "ACS-REQ-0007");
    expect(early?.evidence[0]?.witness).toEqual([{ name: "Session", value: SESSION }, { name: "Method", value: "steps/userMessage" }]);
  });

  it("renders the report with every roster present", () => {
    const report = renderConformanceReport({ corpus: program.corpus, trace: r.trace, sessions: r.normalized.sessions, negotiated: r.negotiated, available: [...r.external.available].sort(), verdicts: r.verdicts });
    for (const h of ["## Summary", "## Obligations per claimed profile", "## Verdicts", "## Evidence", "## Non-testable roster", "## Exclusion roster", "## Not evaluated", "## Permissions"]) {
      expect(report).toContain(h);
    }
    expect(report).toContain("fail 9, pass 54,");
    expect(report).toContain("| profile | active obligations | met | unmet | deviating | unevaluated |");
    expect(report).toContain("| acs-core | 58 | 50 | 8 | 0 | 0 |");
    // The verdict table shows the keyword each provision is judged by, the record's override included (ACS-REQ-0003's span starts with a RECOMMENDED).
    expect(report).toContain("| ACS-REQ-0003 Required fields per disposition | fail | MUST | guardian | acs-core |");
    expect(report).toContain("| ACS-REQ-0113 A Guardian does not deny postCompact | pass | MUST NOT |");
    expect(report).toContain("- ACS-EXC-0001 Multi-tenant isolation is unspecified in v0.1: ACS deliberately requires nothing here");
  });
});

describe("the ordinary-code facts (E7.1)", () => {
  it("canonicalizes per JCS: sorted keys, no whitespace, undefined dropped", () => {
    expect(canonicalize({ b: 1, a: [true, null, { z: "x", y: 2 }], u: undefined })).toBe('{"a":[true,null,{"y":2,"z":"x"}],"b":1}');
  });

  it("computes §8.2's entry_hash over content || raw previous_hash, and detects tampering", () => {
    const first = { entry_id: "e1", step_id: "s1", step_type: "sessionStart", previous_hash: null } as Record<string, unknown>;
    const h1 = chainEntryHash(first);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const second = { entry_id: "e2", step_id: "s2", step_type: "toolCallRequest", previous_hash: h1 };
    const h2 = chainEntryHash(second);
    expect(chainEntryHash({ ...second, entry_hash: h2 })).toBe(h2);
    expect(chainEntryHash({ ...second, step_type: "tampered" })).not.toBe(h2);
    expect(chainEntryHash({ ...second, previous_hash: h1.replace(/^./, (c) => (c === "0" ? "1" : "0")) })).not.toBe(h2);
  });

  it("verifies an HMAC over the §10 signed input, with signature removed and chain_hash covered", () => {
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", id: 1, result: { type: "final", decision: "allow", chain_hash: "abc" } };
    (envelope.result as Record<string, unknown>).signature = { algorithm: "HMAC-SHA256", value: signHmac(envelope, TEST_HMAC_KEY), key_id: "k" };
    expect(verifyHmac(envelope, TEST_HMAC_KEY)).toEqual({ status: "valid", coversChainHash: true });
    expect(verifyHmac(envelope, Buffer.from("wrong")).status).toBe("invalid");
    expect(verifyHmac({ jsonrpc: "2.0", id: 1, result: {} }, TEST_HMAC_KEY).status).toBe("absent");
    (envelope.result as Record<string, unknown>).decision = "deny";
    expect(verifyHmac(envelope, TEST_HMAC_KEY).status).toBe("invalid");
  });

  it("maps methods to hook schema files and finds provenance objects anywhere in a payload", () => {
    expect(hookSchemaFile("steps/toolCallRequest")).toBe("hooks/tool-call-request.json");
    expect(hookSchemaFile("agbom/snapshot")).toBe("hooks/agbom-snapshot.json");
    expect(hookSchemaFile("handshake/hello")).toBeNull();
    expect(findProvenance({ a: [{ provenance: { provenance_id: "p", origin: "user_input", trust: "trusted" } }], b: { provenance_id: "q" } }).map((p) => p.provenance_id)).toEqual(["p"]);
  });

  it("reads a bare JSON-RPC log as well as the Guardian's envelope-log entries", () => {
    const bare = parseTrace('{"jsonrpc":"2.0","id":"1","method":"steps/x","params":{"metadata":{"session_id":"s"},"payload":{}}}\n{"jsonrpc":"2.0","id":"1","result":{"decision":"allow"}}\n');
    expect(bare.map((l) => [l.seq, l.direction, l.method, l.rpc_id])).toEqual([[1, "request", "steps/x", "1"], [2, "response", null, "1"]]);
    const n = normalizeTrace(bare);
    expect(n.facts.get("response_to")).toEqual([[1, 2]]);
    expect(n.sessions).toEqual([{ session: "s", profiles: ["acs-core"], negotiated_version: null }]);
  });
});
