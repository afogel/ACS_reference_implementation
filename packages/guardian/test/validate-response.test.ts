import { describe, expect, it } from "bun:test";
import { validateResponse } from "../src/validate-response.ts";

// A real UUID, not a readable placeholder: response-envelope.json's
// AcsResult.request_id is `format: "uuid"`, and this field is what the
// Guardian actually sends -- finalResult (acs-result.ts) copies it straight
// from `params.request_id`, which validateEnvelope already confirmed
// matches this same format before any response exists to build. The same
// placeholder UUID validate-envelope.test.ts already uses for the inbound
// side, reused here rather than a second one invented for the outbound side.
const PLACEHOLDER_REQUEST_ID = "8f14e45f-ceea-467e-bd5f-1d4d9a4e0c8f";

describe("validateResponse -- validateEnvelope's outbound twin", () => {
  it("accepts a decision response the Guardian actually builds", () => {
    expect(
      validateResponse({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: {
          type: "final",
          acs_version: "0.1.0",
          request_id: PLACEHOLDER_REQUEST_ID,
          decision: "allow",
        },
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a decision response carrying a disposition ACS does not define", () => {
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      // request_id is the placeholder UUID here too, not a non-UUID literal:
      // with a non-UUID request_id, this test would pass for the wrong
      // reason -- errors[0] would be the request_id format failure, not the
      // decision enum failure, so the assertion below would hold
      // identically if "warn" became a legal ACS decision tomorrow. A valid
      // request_id isolates the one field this test is actually about.
      result: { type: "final", acs_version: "0.1.0", request_id: PLACEHOLDER_REQUEST_ID, decision: "warn" },
    });

    expect(outcome).toEqual({
      valid: false,
      pointer: "/result/decision",
      message: "/result/decision must be equal to one of the allowed values",
    });
  });

  it("reports a decision response that merely lost its decision as invalid, not unexpressible", () => {
    // The fixture isServerHelloResponse's rationale names: no `decision`,
    // same as a ServerHello, but also no `methods_evaluated` -- a malformed
    // AcsResult, not a handshake response. Weakening the AND in
    // isServerHelloResponse to `!("decision" in result)` alone would excuse
    // this as unexpressible instead of reporting it invalid; every other
    // fixture in this file passes identically under that weakening, so this
    // one exists to catch it.
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { type: "final", acs_version: "0.1.0", request_id: PLACEHOLDER_REQUEST_ID },
    });

    expect(outcome).toEqual({
      valid: false,
      pointer: "/result",
      message: "/result must have required property 'decision'",
    });
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
