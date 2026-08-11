import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import {
  applyFailurePosture,
  classifyDeliveryFailure,
  classifySessionFailure,
  DEFAULT_POSTURE,
} from "../src/failure-posture.ts";
import { GuardianTimeoutError } from "../src/guardian-client.ts";
import { SessionConfigNotStoredError } from "../src/handshake.ts";
import type { SessionConfig } from "../src/session-config.ts";

function recordingSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    sink: {
      path: "test",
      write: (e) => {
        events.push(e);
        return true;
      },
    },
    events,
  };
}

/** A sink that behaves exactly as the real one does when it cannot write:
 * it does not throw, it reports nothing back to the caller but false, and it
 * records nothing. The reproduction was ACS_AUDIT_LOG pointing at a path
 * under a regular file. */
function unwritableSink(): AuditSink {
  return { path: "test", write: () => false };
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

// Constraints 2 and 3 genuinely disagree here, and 3 governs: §6.4 makes the
// audit entry a MUST for a step that proceeds without a decision, so a
// proceed that could not be recorded is a silent bypass -- the one outcome
// this slice exists to make impossible. Reproduced before this fix: with
// ACS_AUDIT_LOG under a regular file, the step proceeded, exited 0, and wrote
// no entry; the only trace was a stderr line from a subprocess that succeeded.
describe("applyFailurePosture — an unauditable proceed is not a proceed (constraint 3, §6.4)", () => {
  it("downgrades a proceed it could not audit to deny, with its own reason code", () => {
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: unwritableSink(),
      ...CALL,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason_codes).toEqual(["decision_failure", "audit_unavailable"]);
    expect(decision.reasoning).toMatch(/could not be recorded/i);
  });

  it("downgrades when the sink throws outright, not only when it reports false", () => {
    const throwing: AuditSink = { path: null, write: () => { throw new Error("sink is broken"); } };
    expect(
      applyFailurePosture({
        failure: new GuardianTimeoutError(5000),
        sessionConfig: NEGOTIATED("proceed"),
        audit: throwing,
        ...CALL,
      }).decision,
    ).toBe("deny");
  });

  // A deny needs no downgrade: the step is blocked either way, and the failed
  // write is already reported by the sink's own error path. It must not pick
  // up the downgrade's reason code, which would misdescribe why it blocked.
  it("leaves an unauditable deny alone", () => {
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("deny"),
      audit: unwritableSink(),
      ...CALL,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason_codes).toEqual(["decision_failure"]);
  });

  it("still proceeds when the entry WAS recorded -- the downgrade is about the record, not the posture", () => {
    const { sink } = recordingSink();
    expect(
      applyFailurePosture({
        failure: new GuardianTimeoutError(5000),
        sessionConfig: NEGOTIATED("proceed"),
        audit: sink,
        ...CALL,
      }).decision,
    ).toBe("allow");
  });
});

describe("applyFailurePosture — a request that was never sent is not a delivery failure (I2)", () => {
  const NOT_SENT = { ...CALL, method: null, stage: "request" as const };

  it("classifies it as host_configuration, not unknown", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({
      failure: new Error('buildEnvelope: hookmap has no entry for hook "PostToolUse"'),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...NOT_SENT,
    });
    expect(events[0]?.failure.kind).toBe("host_configuration");
    expect(events[0]?.method).toBeNull();
  });

  // The audit trail must not send an incident review to the wrong process.
  it("does not blame the guardian in the reasoning or the reason code", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({
      failure: new Error("no entry for this hook"),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...NOT_SENT,
    });
    expect(decision.reasoning).not.toMatch(/guardian/i);
    expect(decision.reasoning).toMatch(/could not build a request/i);
    expect(decision.reason_codes).toEqual(["host_configuration"]);
  });

  it("still names the guardian when a request really was sent", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(decision.reasoning).toMatch(/guardian/i);
  });
});

// A decision that arrived and was honoured, which this host then could not
// express, used to be audited as "no decision arrived from the guardian
// (unknown: ...)". Both halves were false: one arrived, and the cause is
// precisely known. It is the same misattribution the `request` stage above
// fixed, read the other way round -- and it sends an incident reviewer to a
// Guardian that answered correctly.
describe("applyFailurePosture — a decision that arrived and could not be rendered (B1)", () => {
  const UNRENDERABLE = {
    ...CALL,
    stage: "render" as const,
    failure: new Error('renderDecision: hookmap has no decisions entry for ACS decision "quarantine"'),
  };

  it("classifies it as decision_unrenderable, not as a delivery failure", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({ sessionConfig: NEGOTIATED("proceed"), audit: sink, ...UNRENDERABLE });
    expect(events[0]?.failure.kind).toBe("decision_unrenderable");
    expect(events[0]?.failure.message).toContain("quarantine");
  });

  it("says a decision arrived and this host could not express it", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({ sessionConfig: NEGOTIATED("proceed"), audit: sink, ...UNRENDERABLE });
    expect(decision.reasoning).toMatch(/a decision arrived from the guardian .* and was honoured/i);
    expect(decision.reasoning).toMatch(/could not express it/i);
    // The exact claim that was false, asserted directly rather than inferred
    // from the sentence above: it must not say none arrived.
    expect(decision.reasoning).not.toMatch(/no decision arrived/i);
    expect(decision.reason_codes).toEqual(["decision_unrenderable"]);
  });

  // Constraint 1 is untouched by the reclassification: the posture still
  // decides, and it still decides the same way it would for any other
  // failure. Only what the record SAYS about the failure changed.
  it("still applies the posture, unchanged, in both directions", () => {
    const { sink } = recordingSink();
    expect(applyFailurePosture({ sessionConfig: NEGOTIATED("proceed"), audit: sink, ...UNRENDERABLE }).decision)
      .toBe("allow");
    const second = recordingSink();
    expect(
      applyFailurePosture({ sessionConfig: NEGOTIATED("deny"), audit: second.sink, ...UNRENDERABLE }).decision,
    ).toBe("deny");
  });
});

describe("applyFailurePosture — a session config that could not be established is recorded (I3)", () => {
  it("carries the session failure into the audited entry, beside the step's own failure", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: undefined,
      audit: sink,
      sessionFailure: new Error("EACCES: permission denied, mkdir '.acs/sessions'"),
      ...CALL,
    });
    expect(events[0]?.failure.kind).toBe("timeout");
    expect(events[0]?.session_failure?.message).toContain("EACCES");
  });

  // B2: the two session-establishment failures used to share one constant
  // (`kind: "session_config"`), separated only by free text. In a
  // Guardian-down session EVERY entry carries the note, so the one
  // occurrence that actually costs something -- a ServerHello that arrived
  // and could not be kept -- was buried in it.
  it("distinguishes a handshake that never came back from a ServerHello it could not keep", () => {
    const unreachable = recordingSink();
    applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: undefined,
      audit: unreachable.sink,
      sessionFailure: new Error("Unable to connect. Is the computer able to access the url?"),
      ...CALL,
    });
    expect(unreachable.events[0]?.session_failure?.kind).toBe("handshake_failed");

    const unstored = recordingSink();
    applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("deny"),
      audit: unstored.sink,
      sessionFailure: new SessionConfigNotStoredError("handshake: the Guardian's ServerHello could not be stored", {
        config: NEGOTIATED("deny"),
      }),
      ...CALL,
    });
    expect(unstored.events[0]?.session_failure?.kind).toBe("session_config_unstored");
  });

  it("classifySessionFailure is total: an unrecognised throw still gets a kind", () => {
    expect(classifySessionFailure("not an error at all")).toEqual({
      kind: "handshake_failed",
      message: "not an error at all",
    });
  });

  it("omits the field entirely when the session config was fine", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(events[0]).not.toHaveProperty("session_failure");
  });

  it("says so in the reasoning a human reads, rather than discarding it", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: undefined,
      audit: sink,
      sessionFailure: new Error("EACCES: permission denied"),
      ...CALL,
    });
    expect(decision.reasoning).toMatch(/could not be established or stored/i);
    expect(decision.reasoning).toContain("EACCES");
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
