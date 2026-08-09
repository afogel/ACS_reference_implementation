import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { startGuardian } from "../src/index.ts";

const HANDSHAKE_SCHEMA_PATH = "spec/acs/specification/v0.1.0/handshake.json";

/** Compiles the ServerHello $def straight out of the pinned handshake.json --
 * not a hand-copied shape -- so this test fails the moment our ServerHello
 * drifts from the schema, per the task's "read the schema yourself" note. */
function validateServerHello(candidate: unknown): void {
  const handshakeSchema = JSON.parse(readFileSync(HANDSHAKE_SCHEMA_PATH, "utf8")) as {
    $defs: { ServerHello: Record<string, unknown> };
  };
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(handshakeSchema.$defs.ServerHello);
  const valid = validate(candidate);
  if (!valid) {
    throw new Error(`ServerHello failed schema validation: ${JSON.stringify(validate.errors)}`);
  }
}

function makeEnvelope(
  method: string,
  payload: Record<string, unknown>,
  overrides: { id?: number; requestId?: string } = {},
): Record<string, unknown> {
  const { id = 1, requestId = crypto.randomUUID() } = overrides;
  return {
    jsonrpc: "2.0",
    method,
    id,
    params: {
      acs_version: "0.1.0",
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: { agent_id: "agent-1", session_id: crypto.randomUUID() },
      payload,
    },
  };
}

function toolCallEnvelope(command: string, overrides: { id?: number; requestId?: string } = {}) {
  return makeEnvelope(
    "steps/toolCallRequest",
    { tool: { name: "run_shell" }, arguments: { command: { value: command } } },
    overrides,
  );
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

async function postAcs(url: string, body: unknown): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as JsonRpcResponse;
}

let url: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  url = guardian.url;
  close = guardian.close;
});

afterAll(async () => {
  await close();
});

describe("startGuardian POST /acs", () => {
  it("handshake/hello returns a schema-valid ServerHello with timeout_config.default_ms and on_decision_failure: proceed", async () => {
    const response = await postAcs(url, makeEnvelope("handshake/hello", {}, { id: 42 }));

    expect(response.error).toBeUndefined();
    expect(response.id).toBe(42);
    expect(response.result).toBeDefined();

    const serverHello = response.result as Record<string, unknown>;
    validateServerHello(serverHello);
    expect((serverHello.timeout_config as { default_ms: number }).default_ms).toBeGreaterThan(0);
    expect(serverHello.on_decision_failure).toBe("proceed");
  });

  it("steps/toolCallRequest carrying rm -rf / denies, with non-empty reasoning and reason_codes, echoing request_id", async () => {
    const requestId = crypto.randomUUID();
    const response = await postAcs(url, toolCallEnvelope("rm -rf /", { requestId }));

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("deny");
    expect(response.result?.request_id).toBe(requestId);
    expect(typeof response.result?.reasoning).toBe("string");
    expect((response.result?.reasoning as string).length).toBeGreaterThan(0);
    expect(Array.isArray(response.result?.reason_codes)).toBe(true);
    expect((response.result?.reason_codes as unknown[]).length).toBeGreaterThan(0);
  });

  it("steps/toolCallRequest carrying ls -la allows, echoing request_id", async () => {
    const requestId = crypto.randomUUID();
    const response = await postAcs(url, toolCallEnvelope("ls -la", { requestId }));

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("allow");
    expect(response.result?.request_id).toBe(requestId);
  });

  it("an unknown method returns a JSON-RPC error in the ACS-reserved -32000..-32099 range, not a decision", async () => {
    // Well-formed envelope (matches the method-prefix pattern, real ACS hook
    // name) but not one this Guardian dispatches -- distinct from a
    // malformed envelope, which fails schema validation instead.
    const response = await postAcs(url, makeEnvelope("steps/sessionStart", {}, { id: 7 }));

    expect(response.result).toBeUndefined();
    expect(response.id).toBe(7);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
    expect(response.error?.code).toBeLessThanOrEqual(-32000);
  });

  // Scope boundary (N27 is V3, not this task): a Guardian-side validation
  // failure must surface as a bare JSON-RPC error, never as an explicit ACS
  // "deny" decision -- see validate-envelope.test.ts's identical guard.
  it("an envelope that fails schema validation returns a JSON-RPC error in -32000..-32099, never a deny decision", async () => {
    const bad = toolCallEnvelope("rm -rf /");
    delete (bad.params as Record<string, unknown>).acs_version;

    const response = await postAcs(url, bad);

    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
    expect(response.error?.code).toBeLessThanOrEqual(-32000);
  });
});
