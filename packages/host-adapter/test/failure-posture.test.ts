import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import {
  applyFailurePosture,
  classifyDeliveryFailure,
  DEFAULT_POSTURE,
} from "../src/failure-posture.ts";
import { GuardianTimeoutError } from "../src/guardian-client.ts";
import type { SessionConfig } from "../src/session-config.ts";

function recordingSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: { path: "test", write: (e) => void events.push(e) }, events };
}

const NEGOTIATED = (posture: "proceed" | "deny"): SessionConfig => ({
  negotiated_version: "0.1.0",
  methods_evaluated: ["steps/toolCallRequest"],
  selected_transport: "http",
  timeout_config: { default_ms: 5000 },
  on_decision_failure: posture,
});

const CALL = { sessionId: "sess-1", method: "steps/toolCallRequest", rpcId: "req-1" };

describe("applyFailurePosture — R1.7", () => {
  it("proceeds under the negotiated proceed posture", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason_codes).toEqual(["decision_failure"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ posture: "proceed", outcome: "proceeded", failure: { kind: "timeout" } });
  });

  it("blocks under the negotiated deny posture", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("deny"),
      audit: sink,
      ...CALL,
    });
    expect(decision.decision).toBe("deny");
    expect(events[0]).toMatchObject({ posture: "deny", outcome: "blocked" });
  });

  // The case the file exists for: no handshake ever completed (Guardian was
  // already down at session start), so there is no negotiated posture.
  it("applies the ACS default when nothing was negotiated, and audits it", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new TypeError("Unable to connect"),
      sessionConfig: undefined,
      audit: sink,
      ...CALL,
    });
    expect(DEFAULT_POSTURE).toBe("proceed");
    expect(decision.decision).toBe("allow");
    expect(events[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
  });

  it("names the failure in reasoning, so a human sees why the step was not governed", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(decision.reasoning).toMatch(/no decision/i);
    expect(decision.reasoning).toMatch(/5000/);
  });

  // Constraint 3: a proceed with no audit entry is the silent bypass this
  // slice removes. Auditing must not be skippable, so there is no option for it.
  it("audits every proceed — the sink is a required argument", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({ failure: new Error("x"), sessionConfig: NEGOTIATED("proceed"), audit: sink, ...CALL });
    applyFailurePosture({ failure: new Error("y"), sessionConfig: NEGOTIATED("proceed"), audit: sink, ...CALL });
    expect(events).toHaveLength(2);
  });

  // Constraint 2: the sink is total, but prove the posture survives even a
  // sink that breaks its contract and throws.
  it("still returns a decision when the sink throws", () => {
    const throwing: AuditSink = { path: null, write: () => { throw new Error("sink is broken"); } };
    expect(
      applyFailurePosture({ failure: new Error("x"), sessionConfig: NEGOTIATED("deny"), audit: throwing, ...CALL })
        .decision,
    ).toBe("deny");
  });
});

describe("classifyDeliveryFailure — §6.4's three failure modes", () => {
  it("classifies a timeout", () => {
    expect(classifyDeliveryFailure(new GuardianTimeoutError(5000)).kind).toBe("timeout");
  });

  it("classifies a dead transport", () => {
    expect(classifyDeliveryFailure(new TypeError("Unable to connect. Is the computer able to access the url?")).kind)
      .toBe("transport");
  });

  it("classifies an error response that carried no decision", () => {
    const { kind, message } = classifyDeliveryFailure({ code: -32020, message: "evaluation failed: boom" });
    expect(kind).toBe("error_without_decision");
    expect(message).toContain("-32020");
  });

  it("never throws on an unknown shape", () => {
    expect(classifyDeliveryFailure(Object.create(null)).kind).toBe("unknown");
    expect(classifyDeliveryFailure(undefined).kind).toBe("unknown");
  });
});
