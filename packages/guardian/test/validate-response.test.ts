import { describe, expect, it } from "bun:test";
import { validateResponse } from "../src/validate-response.ts";

describe("validateResponse -- N21's outbound twin", () => {
  it("accepts a decision response the Guardian actually builds", () => {
    expect(
      validateResponse({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: {
          type: "final",
          acs_version: "0.1.0",
          // A real UUID, not a readable placeholder: response-envelope.json's
          // AcsResult.request_id is `format: "uuid"`, and this field is what
          // the Guardian actually sends -- finalResult (acs-result.ts) copies
          // it straight from `params.request_id`, which validateEnvelope (N21)
          // already confirmed matches this same format before any response
          // exists to build. The value below is the same placeholder UUID
          // validate-envelope.test.ts already uses for the inbound side.
          request_id: "8f14e45f-ceea-467e-bd5f-1d4d9a4e0c8f",
          decision: "allow",
        },
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a decision response carrying a disposition ACS does not define", () => {
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { type: "final", acs_version: "0.1.0", request_id: "req-1", decision: "warn" },
    });

    expect(outcome.valid).toBe(false);
  });

  it("reports a handshake response as unexpressible rather than invalid, because the schema cannot state it", () => {
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { acs_version: "0.1.0", methods_evaluated: [], on_decision_failure: "proceed" },
    });

    expect(outcome).toEqual({
      valid: "unexpressible",
      reason:
        "response-envelope.json's `result` unconditionally $refs AcsResult, which requires `decision`; " +
        "a ServerHello has no such field, so v0.1.0 has no discriminated union for non-decision methods",
    });
  });

  it("accepts a JSON-RPC error response, which the envelope schema does express", () => {
    expect(
      validateResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    ).toEqual({ valid: true });
  });
});
