import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import type { Hookmap } from "../src/build-envelope.ts";
import { governStep } from "../src/govern-step.ts";
import { GuardianTimeoutError, type DecisionOrFailure, type GuardianClient } from "../src/guardian-client.ts";
import type { ResolvedSessionConfig } from "../src/handshake.ts";
import type { SessionConfig } from "../src/session-config.ts";

/**
 * `governStep` is the exchange a host shim collaborates with, factored out
 * so a second host does not have to reproduce it -- including the parts
 * that close a fail-open. Its properties are pinned HERE, at the
 * collaborator, and not only end to end through one host's subprocess
 * (hosts/claude-code/test/posture.test.ts, which still proves the whole thing
 * against a real Guardian).
 *
 * A deliberately synthetic hookmap, naming no real host's fields: this
 * function is host-agnostic, and a test written against the shipped Claude Code
 * hookmap would not catch it quietly becoming otherwise.
 */
const hookmap: Hookmap = {
  host: "test-host",
  hooks: {
    OnStep: { acs_method: "steps/toolCallRequest", tool_name: "$.tool_name", arguments: "$.tool_input" },
  },
  decisions: {
    allow: { output: { outcome: { value: "go" }, note: { from: "reasoning", type: "string" } } },
    deny: { output: { outcome: { value: "stop" }, note: { from: "reasoning", type: "string" } } },
  },
};

const payload = { session_id: "sess-1", tool_name: "Bash", tool_input: { command: "ls -la" } };

function recordingSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    sink: {
      path: "test",
      write: (event) => {
        events.push(event);
        return true;
      },
    },
    events,
  };
}

const NEGOTIATED = (posture: "proceed" | "deny"): SessionConfig => ({
  timeout_config: { default_ms: 5000 },
  on_decision_failure: posture,
});

/** A Guardian that answers every request with `answer`, and never posts. */
function answering(answer: DecisionOrFailure): GuardianClient {
  return {
    requestDecision: () => Promise.resolve(answer),
    post: () => Promise.reject(new Error("governStep must not use the wire primitive")),
  };
}

function govern(
  guardian: GuardianClient,
  audit: AuditSink,
  session: ResolvedSessionConfig = { config: NEGOTIATED("proceed"), failure: undefined },
  overrides: { hookmap?: Hookmap; hookEventName?: string } = {},
) {
  return governStep({
    hookEventName: overrides.hookEventName ?? "OnStep",
    payload,
    hookmap: overrides.hookmap ?? hookmap,
    guardian,
    session,
    sessionId: "sess-1",
    audit,
  });
}

describe("governStep — a decision that arrived", () => {
  it("renders it and reports the guardian as the stage, auditing nothing", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({ decisionArrived: true, decision: { decision: "deny", reasoning: "blocked by policy" } }),
      sink,
    );

    expect(governed.stage).toBe("honoured");
    expect(governed.decision.decision).toBe("deny");
    expect(governed.output).toEqual({ outcome: "stop", note: "blocked by policy" });
    // Nothing failed to be delivered, so nothing is recorded as a failure.
    expect(events).toEqual([]);
  });

  // A decision that arrives always outranks the posture: the posture here is
  // `deny`, so a step answered by the posture would be blocked -- and this
  // arriving `allow` must still be honoured. The mirror case (an arriving deny
  // under a `proceed` posture) is pinned end to end in posture.test.ts.
  it("outranks the negotiated posture, in both directions", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({ decisionArrived: true, decision: { decision: "allow" } }),
      sink,
      { config: NEGOTIATED("deny"), failure: undefined },
    );

    expect({ stage: governed.stage, decision: governed.decision.decision }).toEqual({
      stage: "honoured",
      decision: "allow",
    });
    expect(events).toEqual([]);
  });

  // validateDecision runs on the arriving decision, and its substitutions
  // are decisions, not failures: an expired `ask` becomes its own timeout
  // disposition rather than reaching the posture. The stage stays
  // "honoured" because a decision did arrive and was honoured.
  it("puts it through the host's own validation without changing the stage", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({
        decisionArrived: true,
        decision: {
          decision: "ask",
          ask_details: { approver: "security-team", question: "run this?", timeout_seconds: 0 },
        },
      }),
      sink,
    );

    expect({ stage: governed.stage, decision: governed.decision.decision }).toEqual({
      stage: "honoured",
      decision: "deny",
    });
    expect(events).toEqual([]);
  });
});

describe("governStep — the three failure stages name three different incidents", () => {
  // "request": nothing was ever asked of anything, so the audit reasoning
  // must not blame a Guardian that was never contacted. This wiring -- a
  // build failure IS the request stage -- is pinned directly here, at the
  // collaborator, rather than only derived by inspecting a local variable's
  // state inside a catch block somewhere else.
  it("files a request that could not be built under \"request\", and never reaches the Guardian", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({ decisionArrived: true, decision: { decision: "allow" } }),
      sink,
      { config: NEGOTIATED("proceed"), failure: undefined },
      // A hook the hookmap has no entry for: buildEnvelope throws.
      { hookEventName: "NotInTheHookmap" },
    );

    expect(governed.stage).toBe("request");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      posture: "proceed",
      posture_source: "negotiated",
      outcome: "proceeded",
      // Never an ACS method, because none was ever determined.
      method: null,
      rpc_id: null,
      failure: { kind: "host_configuration" },
    });
    expect(governed.decision.reasoning).toContain("no decision was ever sought");
  });

  it("files no decision arriving under \"delivery\", carrying the failure the client reported", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(answering({ decisionArrived: false, failure: new GuardianTimeoutError(120) }), sink);

    expect(governed.stage).toBe("delivery");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "proceeded",
      method: "steps/toolCallRequest",
      failure: { kind: "timeout" },
    });
    expect(events[0]?.failure.message).toContain("120ms");
    expect(events[0]?.rpc_id).toBeString();
  });

  // A refusal is a delivery-stage event like any other -- nothing here
  // branches on it, which is the property the module header claims -- but it
  // is not a delivery FAILURE, so the posture must not answer it. The posture
  // here is `proceed`, deliberately: under `deny` this passes unfixed, and the
  // rendered output is the half a host actually writes.
  it("blocks a refused step under a proceed posture, and renders the deny", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({ decisionArrived: false, failure: { code: -32020, message: "evaluation failed" } }),
      sink,
    );

    expect(governed.stage).toBe("delivery");
    expect(governed.decision.decision).toBe("deny");
    expect(governed.output).toEqual({ outcome: "stop", note: governed.decision.reasoning });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      posture: "proceed",
      outcome: "blocked",
      method: "steps/toolCallRequest",
      failure: { kind: "refused" },
    });
  });

  // "render": a decision DID arrive and was honoured in principle; only this
  // host's expression of it failed. Auditing that as "no decision arrived" would
  // send an incident reviewer to a Guardian that answered correctly.
  it("files a decision this hookmap cannot express under \"render\", and still produces an output", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(answering({ decisionArrived: true, decision: { decision: "quarantine" } }), sink);

    expect(governed.stage).toBe("render");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "proceeded", failure: { kind: "decision_unrenderable" } });
    expect(governed.decision.reasoning).toMatch(/a decision arrived .* and was honoured/i);
    // The posture's own decision is renderable by construction, so there is
    // always something on the way out.
    expect(governed.output).toEqual({ outcome: "go", note: governed.decision.reasoning });
  });
});

describe("governStep — the session's failure travels beside the step's own", () => {
  it("records both, under their own kinds, without merging them", async () => {
    const { sink, events } = recordingSink();
    await govern(answering({ decisionArrived: false, failure: new GuardianTimeoutError(5000) }), sink, {
      config: NEGOTIATED("deny"),
      failure: new Error("Unable to connect. Is the computer able to access the url?"),
    });

    expect(events[0]).toMatchObject({
      posture: "deny",
      posture_source: "negotiated",
      outcome: "blocked",
      failure: { kind: "timeout" },
      session_failure: { kind: "handshake_failed" },
    });
  });

  it("applies the ACS default when no config was negotiated at all", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(answering({ decisionArrived: false, failure: new Error("dead") }), sink, {
      config: undefined,
      failure: undefined,
    });

    expect(governed.decision.decision).toBe("allow");
    expect(events[0]).toMatchObject({ posture: "proceed", posture_source: "default", outcome: "proceeded" });
    expect(events[0]?.session_failure).toBeUndefined();
  });

  // §6.4's MUST outranks the posture: a fail-open proceed that could not be
  // recorded is a silent bypass, so it becomes a deny. Every path out of
  // governStep that has no decision goes through the one function that enforces
  // this, which is what makes it unskippable rather than remembered.
  it("blocks rather than proceeding when the entry could not be written", async () => {
    const unwritable: AuditSink = { path: "test", write: () => false };
    const governed = await govern(answering({ decisionArrived: false, failure: new Error("dead") }), unwritable);

    expect(governed.decision.decision).toBe("deny");
    expect(governed.decision.reason_codes).toEqual(["decision_failure", "audit_unavailable"]);
    expect(governed.output).toEqual({ outcome: "stop", note: governed.decision.reasoning });
  });
});
