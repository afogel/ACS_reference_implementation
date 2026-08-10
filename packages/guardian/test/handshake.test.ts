import { describe, expect, it } from "bun:test";
import { handshakeResponder } from "../src/handshake.ts";

describe("handshakeResponder — negotiated posture (D8, R1.7)", () => {
  it("ships the ACS spec default when nothing is configured", () => {
    expect(handshakeResponder({}).on_decision_failure).toBe("proceed");
  });

  it("declares fail-closed when the deployment asks for it", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "deny" }).on_decision_failure).toBe("deny");
  });

  it("declares fail-open when the deployment asks for it explicitly", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "proceed" }).on_decision_failure).toBe("proceed");
  });

  // A typo must not silently pick a posture. Fail-open is the spec default,
  // but "dney" is not a request for it -- it is a broken deployment, and a
  // governance tool that guesses here is the whole problem this slice is about.
  it("throws on a value that is neither posture, naming the value", () => {
    expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: "dney" })).toThrow(/dney/);
  });

  // An empty string is explicitly set (not undefined), so it is a broken
  // deployment that must throw, not silently fall back to fail-open.
  it("throws on an empty string, treating it as explicit misconfiguration", () => {
    expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: "" })).toThrow();
  });

  it("still declares every ServerHello field handshake.json requires", () => {
    const hello = handshakeResponder({});
    expect(Object.keys(hello).sort()).toEqual(
      ["methods_evaluated", "negotiated_version", "on_decision_failure", "selected_transport", "timeout_config"],
    );
    expect(hello.timeout_config.default_ms).toBe(5000);
  });
});
