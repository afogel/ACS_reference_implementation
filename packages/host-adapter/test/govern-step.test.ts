import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import type { Hookmap, HookmapRequestHookEntry, HookmapResultHookEntry } from "../src/build-envelope.ts";
import { governStep } from "../src/govern-step.ts";
import { GuardianTimeoutError, type DecisionOrFailure, type GuardianClient } from "../src/guardian-client.ts";
import type { ResolvedSessionConfig } from "../src/handshake.ts";
import type { SessionConfig } from "../src/session-config.ts";

/**
 * `governStep` is the exchange that used to live inside
 * hosts/claude-code/acs-hook.ts, and the reason it moved is that slice V5's
 * second host would otherwise have had to reproduce it -- including the parts
 * where the fail-opens govern-step.ts's own header counts were closed -- the
 * count lives there, once, rather than being restated here to go stale
 * separately. So the properties are pinned HERE, at the
 * collaborator, and not only end to end through one host's subprocess
 * (hosts/claude-code/test/posture.test.ts, which still proves the whole thing
 * against a real Guardian).
 *
 * A deliberately synthetic hookmap, naming no real host's fields: this
 * function is host-agnostic, and a test written against the shipped Claude Code
 * hookmap would not catch it quietly becoming otherwise.
 */
const ON_STEP: HookmapRequestHookEntry = {
  acs_method: "steps/toolCallRequest",
  tool_name: "$.tool_name",
  arguments: "$.tool_input",
  // V4: a hook's decisions belong to the hook, so this fixture's one gate
  // carries its own block.
  decisions: {
    allow: { output: { outcome: { value: "go" }, note: { from: "reasoning", type: "string" } } },
    deny: { output: { outcome: { value: "stop" }, note: { from: "reasoning", type: "string" } } },
  },
};

const hookmap: Hookmap = { host: "test-host", hooks: { OnStep: ON_STEP } };

const payload = { session_id: "sess-1", tool_name: "Bash", tool_input: { command: "ls -la" } };

/**
 * A RESULT gate on the same synthetic host: a gate that sees what a step
 * produced, and therefore the one kind of gate where a decision has to be able
 * to replace an output. Its `outputs` block is what makes it one -- read off the
 * entry's shape, never off the event name.
 *
 * `text` is prose and `truncated` is a flag, deliberately side by side, because
 * the property under test is which of the two a replacement can be built for.
 */
const ON_RESULT: HookmapResultHookEntry = {
  acs_method: "steps/toolCallResult",
  tool_name: "$.tool_name",
  outputs: { from: "$.step_result.text", within: "$.step_result" },
  exit_status: { literal: "success" },
  decisions: {
    allow: { output: { outcome: { value: "go" } } },
    deny: { output: { outcome: { value: "stop" }, replacing_output: { from: "applied_output" } } },
  },
};

const resultPayload = {
  session_id: "sess-1",
  tool_name: "Bash",
  step_result: { text: "TOKEN=ghp_ABCDEF123456", truncated: false },
};

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
  overrides: { hookmap?: Hookmap; hookEventName?: string; payload?: Record<string, unknown> } = {},
) {
  return governStep({
    hookEventName: overrides.hookEventName ?? "OnStep",
    payload: overrides.payload ?? payload,
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
      // A hookmap path that does not resolve against this payload:
      // buildEnvelope throws. This case used to name a hook the hookmap has no
      // entry for, which V4 moved out of the posture's reach entirely -- see the
      // test below -- while leaving every other way a request can fail to be
      // built exactly where it was.
      { hookmap: { ...hookmap, hooks: { OnStep: { ...ON_STEP, tool_name: "$.no_such_field" } } } },
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

  // V4, and the one behaviour the per-hook move deliberately changes -- a
  // pre-existing fail-open closed, not a reclassification. Every render (the
  // arriving decision's and the posture's) now goes through the hook's OWN
  // decisions block, so a hook the hookmap does not map has nothing to express
  // either answer through. Before the move there was one top-level block, in the
  // shipped hookmap a PreToolUse-shaped one, so an unmapped hook WAS answered by
  // the posture -- and that answer was rendered in the wrong gate's shape and
  // written with exit 0. A deployment that had negotiated `deny` emitted a
  // permission field at an event that does not read one: the host saw no
  // decision, the step ran, and the audit said "blocked".
  //
  // So it throws before this step is asked about or audited, and the caller
  // answers it the way it answers a hookmap that will not load (exit 2).
  it("throws, auditing nothing, for a hook this hookmap does not map -- it cannot express an answer for one", async () => {
    const { sink, events } = recordingSink();

    await expect(
      govern(answering({ decisionArrived: true, decision: { decision: "allow" } }), sink, undefined, {
        hookEventName: "NotInTheHookmap",
      }),
    ).rejects.toThrow(/no entry for hook "NotInTheHookmap"/);

    // Nothing proceeded, so nothing claims to have proceeded.
    expect(events).toEqual([]);
  });

  // Review finding, and the guard's one real hole: `hookEventName` is
  // host-supplied -- it arrives on the host's stdin -- and `hooks["toString"]`
  // resolves to an inherited Object.prototype function, which is not
  // `undefined`. With a bare index the guard PASSES for a prototype-named event,
  // buildEnvelope throws (a function is not a hook entry), the posture writes
  // `outcome: "proceeded"`, and only then does renderDecision throw -- the exact
  // durable false record the guard exists to prevent, reachable without touching
  // the hookmap at all. Asserted on the audit log rather than only on the throw,
  // because both spellings throw and only one of them audits.
  //
  // Mutation-tested: with `hasOwnProperty` reverted to a bare index, this case
  // fails on `events` (one "proceeded" entry) while the plain unmapped-hook case
  // above still passes.
  it.each(["toString", "constructor", "valueOf", "__proto__"])(
    "throws, auditing nothing, for the prototype-named hook %p -- a bare index would have let it through",
    async (hookEventName) => {
      const { sink, events } = recordingSink();

      await expect(
        govern(answering({ decisionArrived: true, decision: { decision: "allow" } }), sink, undefined, {
          hookEventName,
        }),
      ).rejects.toThrow(/governStep: hookmap has no entry for hook/);

      expect(events).toEqual([]);
    },
  );

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

/**
 * THE TWELFTH FAIL-OPEN, from the side that closes it. A `deny` at a result gate
 * withholds by carrying a replacement for the output, and building that
 * replacement can fail: a leaf that is not prose is a leaf no replacement can be
 * expressed for. Asked at the render, that failure arrived with the decision
 * already in hand and landed in the render stage's catch, so the delivery
 * posture answered it -- under `proceed`, the full unredacted output delivered,
 * the Guardian's deny dropped, and an audit entry saying the decision "was
 * honoured". Measured before the fix, with `outputs.from` on a boolean leaf and a
 * Guardian answering `deny`: exit 0, `outcome: "proceeded"`,
 * `failure.kind: "decision_unrenderable"`.
 *
 * So it is asked before a decision is sought, and the assertions below are about
 * the ORDER as much as the refusal: a Guardian that was never called and an audit
 * log with nothing in it are what make "no decision was dropped" a property of
 * the control flow rather than of the message.
 */
describe("governStep — a result gate whose named output no replacement can be built for", () => {
  /** A Guardian that would answer `deny`, and records whether it was ever asked.
   * The deny matters: it is the decision that would have been dropped. */
  function askedGuardian(): { guardian: GuardianClient; asked: () => number } {
    let asks = 0;
    return {
      guardian: {
        requestDecision: () => {
          asks += 1;
          return Promise.resolve({
            decisionArrived: true,
            decision: { decision: "deny", reasoning: "secret in output" },
          } satisfies DecisionOrFailure);
        },
        post: () => Promise.reject(new Error("governStep must not use the wire primitive")),
      },
      asked: () => asks,
    };
  }

  const resultHookmap = (from: string): Hookmap => ({
    host: "test-host",
    hooks: { OnResult: { ...ON_RESULT, outputs: { from, within: "$.step_result" } } },
  });

  it("refuses before the Guardian is asked, under a posture that would otherwise have proceeded", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = askedGuardian();

    await expect(
      govern(guardian, sink, { config: NEGOTIATED("proceed"), failure: undefined }, {
        hookEventName: "OnResult",
        payload: resultPayload,
        // Present, resolvable, and a flag: the envelope builds, the decision
        // arrives, and nothing can be patched in its place.
        hookmap: resultHookmap("$.step_result.truncated"),
      }),
    ).rejects.toThrow(/no replacement can be built for the output its hookmap entry names/);

    // The two assertions the message cannot make: nothing was asked, so no
    // decision existed to be dropped, and nothing was audited, so no entry
    // claims a step proceeded.
    expect(asked()).toBe(0);
    expect(events).toEqual([]);
  });

  // The refusal has to be about the leaf and not about the gate: a result gate
  // whose named leaf IS prose governs exactly as before, and its deny withholds.
  it("lets a gate whose named leaf is prose govern, and its deny still withholds", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = askedGuardian();

    const governed = await govern(guardian, sink, undefined, {
      hookEventName: "OnResult",
      payload: resultPayload,
      hookmap: resultHookmap("$.step_result.text"),
    });

    expect({ stage: governed.stage, decision: governed.decision.decision }).toEqual({
      stage: "guardian",
      decision: "deny",
    });
    // The whole object, because a replacement missing a sibling field is the one
    // a host discards while delivering the original.
    expect(governed.output).toEqual({
      outcome: "stop",
      replacing_output: { text: "[OUTPUT WITHHELD BY POLICY]", truncated: false },
    });
    expect({ asked: asked(), events }).toEqual({ asked: 1, events: [] });
  });

  // The failure that stays with the posture, and the distinction that keeps the
  // refusal above from swallowing it: a payload that does not carry what the
  // hookmap describes is `buildEnvelope`'s report, at stage "request", where a
  // host firing one hook for several tools is the deployment's own negotiated
  // question rather than a broken deployment.
  it("leaves a payload that carries no such leaf to the posture, at stage \"request\"", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = askedGuardian();

    const governed = await govern(guardian, sink, undefined, {
      hookEventName: "OnResult",
      payload: { session_id: "sess-1", tool_name: "Bash", step_result: { truncated: false } },
      hookmap: resultHookmap("$.step_result.text"),
    });

    expect(governed.stage).toBe("request");
    expect(asked()).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "proceeded", failure: { kind: "host_configuration" } });
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
