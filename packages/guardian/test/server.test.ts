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

  // Scope boundary: a Guardian-side validation failure must surface as a bare
  // JSON-RPC error, never as an explicit ACS "deny" decision -- see
  // validate-envelope.test.ts's identical guard.
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

// Fix wave finding 1 -- a real fail-open bug: an unhandled throw from
// assemblePreToolCallSnapshot/bridge.evaluate/mapVerdict inside handleAcsRequest used
// to escape uncaught, and Bun.serve's default error page for a rejected
// fetch() is `text/html`, not JSON. guardianClient.post's `res.json()` would
// then throw a SyntaxError instead of surfacing a JSON-RPC error, and
// acs-hook.ts's catch-all exits 1 with nothing on stdout -- Claude Code
// treats that as "the hook never fired" and the tool call proceeds
// ungoverned. This guards the fix, against a real (not mocked) AGT
// evaluation -- only mapping.yaml is swapped for a fixture that marks
// `allow` require_policy_references, so a genuine AGT "allow" verdict for a
// benign command (which carries no reason/message) makes mapVerdict throw
// inside handleAcsRequest for real.
describe("startGuardian POST /acs -- evaluation failure inside handleAcsRequest", () => {
  it("a real mapVerdict throw (require_policy_references unmet) still returns a parseable JSON-RPC error in -32000..-32099, not an HTML 500", async () => {
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      mappingPath: "packages/guardian/test/fixtures/mapping.require-policy-references-on-allow.yaml",
    });

    try {
      // res.json() below is exactly guardianClient.post's call. Before the
      // fix, Bun.serve's unhandled-rejection page is text/html and this
      // throws a SyntaxError instead of resolving -- the same failure mode
      // the finding describes at guardian-client.ts:70.
      const response = await postAcs(guardian.url, toolCallEnvelope("ls -la"));

      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
      expect(response.error?.code).toBeLessThanOrEqual(-32000);
      // Never a decision -- same scope boundary as the schema-validation
      // guard above.
      expect((response as Record<string, unknown>).decision).toBeUndefined();
    } finally {
      await guardian.close();
    }
  });
});

// PR #10 review, Critical: mapping.yaml's intervention_points table is what
// V7's conformance matrix publishes, and the runtime used to hardcode
// "pre_tool_call" instead of consulting it, so the two could disagree without
// anything failing.
describe("startGuardian POST /acs -- the intervention point comes from mapping.yaml", () => {
  it("evaluates the point the table names, not pre_tool_call: a moved row changes the decision", async () => {
    // The fixture answers steps/toolCallRequest with `output`, which
    // policy/manifest.yaml does not register -- so honouring the table makes
    // AGT fail closed, while ignoring it would allow this benign command. The
    // two outcomes are opposite: this cannot pass against a hardcoded point.
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      mappingPath: "packages/guardian/test/fixtures/mapping.tool-call-at-a-different-point.yaml",
    });

    try {
      const response = await postAcs(guardian.url, toolCallEnvelope("ls -la"));

      expect(response.error).toBeUndefined();
      expect(response.result?.decision).toBe("deny");
      expect(response.result?.reason_codes).toEqual(["runtime_error:intervention_point_unknown"]);
    } finally {
      await guardian.close();
    }
  });
});

// PR #10 review, Critical: Bun.serve with no `hostname` binds `*` -- every
// interface, dual-stack -- and this endpoint has no auth, no origin check and
// no request signing, so every host that could route to the port was a policy
// oracle and a policy sink. The observable that separates the two binds is
// reachability, so that is what is asserted, rather than the label Bun prints
// for the socket (`server.hostname` reads "localhost" for a wildcard bind,
// which is exactly the reading that hid this).
describe("startGuardian binds loopback only", () => {
  async function reachable(url: string): Promise<boolean> {
    try {
      await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  it("refuses a connection to ::1, which a wildcard bind accepts", async () => {
    // `hostname: "::"` reproduces the pre-fix bind exactly: dual-stack
    // wildcard, ::1 and 127.0.0.1 both answering. It is the control, and it
    // is what stops the assertion below from passing vacuously on a machine
    // with no IPv6 loopback -- there, this expectation fails first and says
    // so, rather than letting an unreachable address look like a narrow bind.
    const wildcard = await startGuardian({ port: 0, hostname: "::", manifestPath: "policy/manifest.yaml" });
    const loopback = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });

    try {
      // Path and port both come from the url the Guardian reported, so the
      // probe cannot drift from what it actually serves.
      const wildcardEndpoint = new URL(wildcard.url);
      const loopbackEndpoint = new URL(loopback.url);

      expect(await reachable(`http://[::1]:${wildcardEndpoint.port}${wildcardEndpoint.pathname}`)).toBe(true);
      expect(await reachable(`http://127.0.0.1:${loopbackEndpoint.port}${loopbackEndpoint.pathname}`)).toBe(true);
      expect(await reachable(`http://[::1]:${loopbackEndpoint.port}${loopbackEndpoint.pathname}`)).toBe(false);
    } finally {
      await wildcard.close();
      await loopback.close();
    }
  });
});
