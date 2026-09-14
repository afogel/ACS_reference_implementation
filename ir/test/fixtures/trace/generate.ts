/**
 * Synthetic envelope logs for `acs-ir verify`, generated rather than
 * committed so the chain hashes and HMAC signatures they carry are always
 * the ones the code under test computes. Two traces:
 *
 *  - `clean`: one session that breaches nothing the verifier can see;
 *  - `violating`: the same session with a handful of deliberate breaches
 *    (a hook before the handshake, a DENY without reasoning, a DEFER with
 *    a bad reason and missing fields, a bad signature, a tampered chain
 *    entry, a decided content-bearing step with no chain head).
 *
 * Each writes `trace.jsonl`, `guardian/context-entries.jsonl`,
 * `guardian/facts/*.facts`, and `deployment/*.facts`. Run directly:
 * `bun run ir/test/fixtures/trace/generate.ts <out dir> [clean|violating]`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainEntryHash, signHmac } from "../../../src/verify/jcs.ts";

export const TEST_HMAC_KEY = Buffer.from("acs-ir-test-key-0123456789abcdef", "utf8");
export const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AGENT = "acs-ir-fixture";
const VERSION = "0.1.0";

type Json = Record<string, unknown>;

interface Line {
  seq: number;
  recorded_at: string;
  direction: "request" | "response";
  method: string | null;
  rpc_id: string;
  envelope: Json;
}

function request(seq: number, method: string, payload: Json, extra: Json = {}, sign: boolean | "bad" = true): Line {
  const envelope: Json = {
    jsonrpc: "2.0",
    id: `rpc-${seq}`,
    method,
    params: { acs_version: VERSION, request_id: `1${String(seq).padStart(7, "0")}-0000-4000-8000-000000000000`, timestamp: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, metadata: { agent_id: AGENT, session_id: SESSION, ...(extra.metadata as Json ?? {}) }, payload },
  };
  if (sign) {
    const value = signHmac(envelope, TEST_HMAC_KEY);
    (envelope.params as Json).signature = { algorithm: "HMAC-SHA256", value: sign === "bad" ? value.replace(/^./, (c) => (c === "A" ? "B" : "A")) : value, key_id: "k1" };
  }
  return { seq, recorded_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, direction: "request", method, rpc_id: `rpc-${seq}`, envelope };
}

function response(seq: number, of: Line, result: Json): Line {
  const envelope: Json = { jsonrpc: "2.0", id: of.rpc_id, result: { type: "final", acs_version: VERSION, request_id: (of.envelope.params as Json).request_id, ...result } };
  (envelope.result as Json).signature = { algorithm: "HMAC-SHA256", value: signHmac(envelope, TEST_HMAC_KEY), key_id: "k1" };
  return { seq, recorded_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, direction: "response", method: of.method, rpc_id: of.rpc_id, envelope };
}

function serverHello(seq: number, of: Line): Line {
  const envelope: Json = {
    jsonrpc: "2.0",
    id: of.rpc_id,
    result: { negotiated_version: VERSION, methods_evaluated: ["steps/*"], selected_transport: "http", timeout_config: { default_ms: 5000 }, on_decision_failure: "proceed", profiles_accepted: ["acs-core", "acs-provenance"] },
  };
  return { seq, recorded_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, direction: "response", method: of.method, rpc_id: of.rpc_id, envelope };
}

export function generate(kind: "clean" | "violating"): { trace: Line[]; entries: { session_id: string; seq: number; entry: Json }[]; guardianFacts: Record<string, string>; deploymentFacts: Record<string, string> } {
  const bad = kind === "violating";
  const trace: Line[] = [];
  const entries: { session_id: string; seq: number; entry: Json }[] = [];
  let previous: string | null = null;
  const entry = (seq: number, step_type: string, tamper = false): string => {
    const e: Json = { entry_id: `e${seq}`, step_id: `s${seq}`, step_type, previous_hash: previous, timestamp: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, request_hash: "0".repeat(64), provenance_summary: { entry_count: 1 } };
    e.entry_hash = chainEntryHash(e);
    previous = e.entry_hash as string;
    const recorded = tamper ? { ...e, step_type: "tampered" } : e;
    entries.push({ session_id: SESSION, seq, entry: recorded });
    return e.entry_hash as string;
  };
  let seq = 1;
  const clientHello = { acs_versions_supported: [VERSION], methods_implemented: ["steps/toolCallRequest"], transports_supported: ["http"], provenance_producer: "deterministic", profiles_supported: ["acs-core", "acs-provenance"] };

  if (bad) {
    // A hook before the handshake (ACS-REQ-0007).
    const early = request(seq++, "steps/userMessage", { content: [{ type: "text", value: "hi", provenance: { provenance_id: "p0", origin: "user_input" } }] });
    trace.push(early, response(seq++, early, { decision: "allow", chain_hash: entry(early.seq, "userMessage") }));
  }
  const hello = request(seq++, "handshake/hello", clientHello);
  trace.push(hello, serverHello(seq++, hello));

  const start = request(seq++, "steps/sessionStart", {
    intent: { raw: "read the docs", parsed: [{ tool: "docs", operation: "read" }], parser_provenance: { provenance_id: "pi", origin: "user_input" }, scope_mode: "strict" },
  });
  trace.push(start, response(seq++, start, { decision: "allow", chain_hash: entry(start.seq, "sessionStart") }));

  // In the violating trace the request's signature is bad and the Guardian answers with a decision anyway (ACS-REQ-0018),
  // the DENY carries no reasoning (ACS-REQ-0003, and the schema), and the Guardian's record of the entry is tampered (ACS-REQ-0013).
  const tool = request(
    seq++,
    "steps/toolCallRequest",
    { tool: { name: "read_file" }, arguments: { path: { value: "/docs/a.md", provenance: { provenance_id: "p1", origin: "user_input", trust: "trusted" } } } },
    {},
    bad ? "bad" : true,
  );
  trace.push(tool, response(seq++, tool, bad ? { decision: "deny", chain_hash: entry(tool.seq, "toolCallRequest", true) } : { decision: "deny", reasoning: "outside intent", chain_hash: entry(tool.seq, "toolCallRequest") }));

  const result = request(seq++, "steps/toolCallResult", {
    tool: { name: "read_file" },
    exit_status: "success",
    outputs: [{ value: "contents", provenance: { provenance_id: "p2", origin: "tool_output", derived_from: ["p1"], trust: "untrusted" } }],
  });
  // The violating DEFER names a reason outside the enum and omits two of the three fields §6 requires (ACS-REQ-0004, ACS-REQ-0005).
  const deferDetails = bad
    ? { reason: "vibes", resolution_method: "human_approval" }
    : { reason: "low_confidence", resolution_method: "human_approval", resolution_timeout_ms: 1000, timeout_decision: "deny" };
  trace.push(result, response(seq++, result, { decision: "defer", reasoning: "not sure yet", defer_details: deferDetails, chain_hash: entry(result.seq, "toolCallResult") }));

  // agent_generated output labelled trusted above an untrusted ancestor (ACS-REQ-0010), and decided with no chain head (ACS-REQ-0016).
  const answer = request(seq++, "steps/agentResponse", { content: [{ type: "text", value: "done", provenance: { provenance_id: "p3", origin: "agent_generated", derived_from: ["p2"], trust: bad ? "trusted" : "untrusted" } }] });
  trace.push(answer, response(seq++, answer, bad ? { decision: "allow", reasoning: "ok" } : { decision: "allow", reasoning: "ok", chain_hash: entry(answer.seq, "agentResponse") }));

  const guardianFacts: Record<string, string> = {
    "evaluator_ran.facts": trace
      .filter((l) => l.direction === "response" && (l.envelope.result as Json)?.decision)
      .map((l) => `${l.seq}\tdeterministic\t1\n`)
      .join(""),
    "intent_established.facts": `${SESSION}\t${start.seq}\n`,
    "intent_parsed.facts": `${SESSION}\t${start.seq}\tdocs.read\n${SESSION}\t${answer.seq}\tdocs.read\n`,
    "intent_extension.facts": "",
    "intent_modification_rejected.facts": "",
    "audit_event.facts": "",
    "archived.facts": "",
    "archive_preserved.facts": "",
    "approver_verified.facts": "",
    "ask_resolved.facts": "",
    "decision_log_field.facts": trace
      .filter((l) => l.direction === "response" && (l.envelope.result as Json)?.decision)
      .map((l) => `${l.seq}\treasoning\n${l.seq}\tmodel_identifier\n`)
      .join(""),
    "intent_derivation_recorded.facts": "",
  };
  const deploymentFacts: Record<string, string> = {
    "session_batching.facts": `${SESSION}\tsupported\n`,
    "defer_bound.facts": `${SESSION}\t3\n`,
    "guardian_version.facts": `${VERSION}\n`,
    "policy_requires_provenance.facts": "",
    "strict_mode_forbidden.facts": "",
    "client_ask_capable.facts": `${SESSION}\tyes\n`,
    "agent_step_outcome.facts": trace
      .filter((l) => l.direction === "request" && l.method?.startsWith("steps/"))
      .map((l) => `${SESSION}\t${l.seq}\tapplied\n`)
      .join(""),
    "agent_audit_event.facts": "",
  };
  return { trace, entries, guardianFacts, deploymentFacts };
}

export function writeFixture(dir: string, kind: "clean" | "violating"): string {
  const { trace, entries, guardianFacts, deploymentFacts } = generate(kind);
  mkdirSync(join(dir, "guardian", "facts"), { recursive: true });
  mkdirSync(join(dir, "deployment"), { recursive: true });
  writeFileSync(join(dir, "trace.jsonl"), trace.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "guardian", "context-entries.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [name, text] of Object.entries(guardianFacts)) writeFileSync(join(dir, "guardian", "facts", name), text);
  for (const [name, text] of Object.entries(deploymentFacts)) writeFileSync(join(dir, "deployment", name), text);
  writeFileSync(join(dir, "hmac-key.hex"), TEST_HMAC_KEY.toString("hex") + "\n");
  return join(dir, "trace.jsonl");
}

if (import.meta.main) {
  const [out, kind = "violating"] = process.argv.slice(2);
  if (!out) {
    console.error("usage: bun run ir/test/fixtures/trace/generate.ts <out dir> [clean|violating]");
    process.exit(2);
  }
  console.log(writeFixture(out, kind === "clean" ? "clean" : "violating"));
}
