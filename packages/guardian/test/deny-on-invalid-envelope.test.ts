import { describe, expect, it } from "bun:test";
import { denyOnInvalidEnvelope } from "../src/deny-on-invalid-envelope.ts";

const OPTS = { reasonCode: "envelope_invalid", message: "params.payload.tool is required" };

describe("denyOnInvalidEnvelope — N27", () => {
  it("returns a deny decision addressed by params.request_id", () => {
    const out = denyOnInvalidEnvelope(
      { jsonrpc: "2.0", id: "rpc-1", method: "steps/toolCallRequest", params: { acs_version: "0.1.0", request_id: "req-1" } },
      OPTS,
    );
    expect(out).toEqual({
      kind: "decision",
      result: {
        type: "final",
        acs_version: "0.1.0",
        request_id: "req-1",
        decision: "deny",
        reasoning: "params.payload.tool is required",
        reason_codes: ["envelope_invalid"],
        policy_references: [],
      },
    });
  });

  it("falls back to the JSON-RPC id when params.request_id is unusable", () => {
    const out = denyOnInvalidEnvelope({ jsonrpc: "2.0", id: "rpc-1", method: "steps/toolCallRequest", params: {} }, OPTS);
    expect(out).toMatchObject({ kind: "decision", result: { request_id: "rpc-1" } });
  });

  it("declares an acs_version even when the envelope named none", () => {
    const out = denyOnInvalidEnvelope({ jsonrpc: "2.0", id: 7, method: "steps/toolCallRequest", params: {} }, OPTS);
    expect(out).toMatchObject({ kind: "decision", result: { acs_version: "0.1.0", request_id: "7" } });
  });

  // Constraint 10 / P5: a decision must name the request it answers.
  it("reports unaddressable when there is no id of any kind", () => {
    expect(denyOnInvalidEnvelope({ jsonrpc: "2.0", method: "steps/toolCallRequest" }, OPTS)).toEqual({
      kind: "unaddressable",
    });
    expect(denyOnInvalidEnvelope(null, OPTS)).toEqual({ kind: "unaddressable" });
    expect(denyOnInvalidEnvelope({ id: { not: "a scalar" } }, OPTS)).toEqual({ kind: "unaddressable" });
  });

  it("never throws, whatever it is handed", () => {
    for (const raw of [undefined, 42, "string", [], Object.create(null)]) {
      expect(() => denyOnInvalidEnvelope(raw, OPTS)).not.toThrow();
    }
  });
});
