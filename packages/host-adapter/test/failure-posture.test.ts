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
    expect(events[0]).toMatchObject({
      posture: "proceed",
      posture_source: "negotiated",
      outcome: "proceeded",
      failure: { kind: "timeout" },
    });
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
    expect(events[0]).toMatchObject({ posture: "deny", posture_source: "negotiated", outcome: "blocked" });
  });

  // The case the file exists for: no handshake ever completed (Guardian was
  // already down at session start), so there is no negotiated posture. The
  // durable record has to say so -- distinct from "this deployment chose to
  // fail open" -- not just the ephemeral `reasoning` string.
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
    expect(events[0]).toMatchObject({ posture: "proceed", posture_source: "default", outcome: "proceeded" });
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

  // MUST NOT be replaced with a synthetic error. This is the test that
  // catches a wrong assumption about what THIS runtime actually throws --
  // which is exactly what happened in fix round 1's review: Task 4's own
  // test hand-built `new TypeError(...)`, which only ever proved
  // classifyDeliveryFailure handles a TypeError correctly, never that a
  // real refused connection produces one. It doesn't, on Bun (a plain
  // Error with `.code: "ConnectionRefused"`, not a TypeError) -- so that
  // test passed while the runtime's actual dead-transport case classified
  // as "unknown". Driving a real rejection here is what would have caught
  // it. Port 1 is a reliably refused connection: no service binds it
  // without root, and this sandbox has none listening there either way.
  it("classifies a real refused connection (this runtime's actual route, not a spec-conformant guess)", async () => {
    let failure: unknown;
    try {
      await fetch("http://127.0.0.1:1/acs", { method: "POST", body: "{}" });
      throw new Error("expected fetch to reject");
    } catch (error) {
      failure = error;
    }
    expect(classifyDeliveryFailure(failure).kind).toBe("transport");
  });

  // The WHATWG fetch spec's own route (a TypeError for a network error) --
  // this runtime does not take it for a refused connection, but another
  // runtime, or a future Bun, might. Kept as a synthetic case specifically
  // because there is no way to provoke a real TypeError-shaped network
  // failure on THIS runtime to drive it with instead.
  it("classifies a spec-conformant TypeError network error, covering other runtimes", () => {
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
