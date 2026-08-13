import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import type { Hookmap, HookmapRequestHookEntry, HookmapResultHookEntry } from "../src/build-envelope.ts";
import { governStep, governsTool, type GovernedStep } from "../src/govern-step.ts";
import { GuardianTimeoutError, type DecisionOrFailure, type GuardianClient } from "../src/guardian-client.ts";
import type { ResolvedSessionConfig } from "../src/handshake.ts";
import type { SessionConfig } from "../src/session-config.ts";

/**
 * `governStep` lives outside any host shim, so a second host reuses it
 * without reproducing its fail-open guarantees -- those are documented once,
 * in govern-step.ts's own header, rather than restated here to go stale
 * separately. So the properties are pinned here, at the collaborator, and
 * not only end to end through one host's subprocess
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
  // A hook's decisions belong to the hook, so this fixture's one gate
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
    // The withholdings a result gate has beyond `deny`. Declared, because an
    // entry a hookmap does not declare is a render throw and a posture's
    // answer to it -- which is a different property, pinned elsewhere in this
    // file. What these two are here to pin is that an ask and a defer reaching
    // this kind of gate carry the replacement their entry renders from, the
    // same as a deny: this synthetic host has no more idea what to do with a
    // question about a formed output than a real one does.
    ask: { output: { outcome: { value: "stop" }, replacing_output: { from: "applied_output" } } },
    defer: { output: { outcome: { value: "stop" }, replacing_output: { from: "applied_output" } } },
    // And the other kind of replacement: a rewrite delivers, so its entry says
    // "go" while carrying one. The pair is what makes it possible to tell a
    // withholding from a redaction in the rendered output below.
    modify: { output: { outcome: { value: "go" }, replacing_output: { from: "applied_output" } } },
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

type Overrides = { hookmap?: Hookmap; hookEventName?: string; payload?: Record<string, unknown> };

/** `governStep`, with this suite's fixtures as the defaults. */
function governRaw(
  guardian: GuardianClient,
  audit: AuditSink,
  session: ResolvedSessionConfig = { config: NEGOTIATED("proceed"), failure: undefined },
  overrides: Overrides = {},
): Promise<GovernedStep> {
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

/**
 * The same call, narrowed to the steps this gate actually governs.
 *
 * `governStep` gained a third way out in §V5 review round 3, Task 2 -- a step
 * whose tool the gate's own `tools` list does not name comes back
 * `{stage: "ungoverned", decision: null}` -- and none of the fixtures above
 * declares a `tools` list, so no test using this helper can produce one. Asked
 * here, once, rather than at each of the assertions below that read
 * `.decision`: those tests are about what happened to a decision, and making
 * every one of them narrow a case its fixture cannot reach would be noise that
 * hides the one thing they are each about. The tests that ARE about the skip
 * call `governRaw` and assert on the whole discriminated union.
 */
async function govern(
  guardian: GuardianClient,
  audit: AuditSink,
  session: ResolvedSessionConfig = { config: NEGOTIATED("proceed"), failure: undefined },
  overrides: Overrides = {},
): Promise<Exclude<GovernedStep, { stage: "ungoverned" }>> {
  const governed = await governRaw(guardian, audit, session, overrides);
  if (governed.stage === "ungoverned") {
    throw new Error(
      `govern(): this fixture's gate declares no "tools" list, so it governs every tool -- an "ungoverned" ` +
        `answer here means the skip fired on a hookmap that never scoped itself, which is a defect in ` +
        `governStep and not a case for this helper's caller to handle`,
    );
  }
  return governed;
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
      // buildEnvelope throws. A hook with no hookmap entry at all is a
      // different case, entirely outside the posture's reach -- see the test
      // below.
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

  // Every render (the arriving decision's and the posture's) goes through the
  // hook's own decisions block, so a hook the hookmap does not map has
  // nothing to express either answer through.
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

  // The guard's one real hole: `hookEventName` is host-supplied -- it
  // arrives on the host's stdin -- and `hooks["toString"]` resolves to an
  // inherited Object.prototype function, which is not `undefined`. With a
  // bare index the guard passes for a prototype-named event, buildEnvelope
  // throws (a function is not a hook entry), the posture writes
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
 * A fail-open closed from the side that prevents it. A `deny` at a result
 * gate withholds by carrying a replacement for the output, and building that
 * replacement can fail: a leaf that is not prose is a leaf no replacement can
 * be expressed for. Asked at the render instead, that failure would arrive
 * with the decision already in hand and land in the render stage's catch, so
 * the delivery posture would answer it -- under `proceed`, the full
 * unredacted output delivered, the Guardian's deny dropped, and an audit
 * entry saying the decision "was honoured". With `outputs.from` on a boolean
 * leaf and a Guardian answering `deny`, that route produces exit 0,
 * `outcome: "proceeded"`, `failure.kind: "decision_unrenderable"`.
 *
 * So it is asked before a decision is sought, and the assertions below are
 * about the order as much as the refusal: a Guardian that was never called
 * and an audit log with nothing in it are what make "no decision was
 * dropped" a property of the control flow rather than of the message.
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
      stage: "honoured",
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

/**
 * The dispositions a result gate cannot carry out, and the reason they belong
 * here rather than only in one host's suite: nothing about "an output that
 * already exists cannot be held pending, and cannot be asked about" is specific
 * to a host. A gate that decides whether a step RUNS answers an ask by asking
 * and a defer by waiting; a gate that sees what a step PRODUCED has neither
 * move available, so both are withholdings there, and a withholding carries a
 * shape-preserving replacement of the output or it withholds nothing.
 *
 * The shape of the fail-open this closes: with these two treated as deliveries,
 * a host's mapping either has no entry for them -- so the render throws, the
 * render stage catches, and a `proceed` posture delivers the very output a
 * Guardian raised a question about, audited as a decision that could not be
 * rendered -- or it has an entry that renders a block with an empty wrapper,
 * which reports a withholding and performs none. Both are the same delivery.
 *
 * `NEGOTIATED("proceed")` is the posture throughout, deliberately: it is the
 * one under which the gap was a delivery, so a `deny` posture here would let
 * these tests pass on the unfixed code.
 *
 * Both fixtures are WELL-FORMED and UNEXPIRED, which is what makes them reach a
 * render as an ask and a defer at all. `validateDecision` substitutes a deny for
 * either one whose window it cannot read or has already passed, and a deny
 * withholds through machinery that was never in question -- so a bare
 * `{decision: "ask"}` here would pass against the unfixed rule and pin nothing.
 */
describe("governStep — an ask or a defer at a gate where the step has already run", () => {
  const resultHookmap: Hookmap = { host: "test-host", hooks: { OnResult: ON_RESULT } };

  const withheld = { outcome: "stop", replacing_output: { text: "[OUTPUT WITHHELD BY POLICY]", truncated: false } };

  it("withholds the output for an ask inside its window, honoured rather than postured", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({
        decisionArrived: true,
        decision: {
          decision: "ask",
          reasoning: "a human should see this output first",
          ask_details: { approver: "security-team", question: "release this?", timeout_seconds: 300 },
        },
      }),
      sink,
      { config: NEGOTIATED("proceed"), failure: undefined },
      { hookEventName: "OnResult", payload: resultPayload, hookmap: resultHookmap },
    );

    // "honoured" and still an ask: the decision that arrived is not rewritten
    // into a deny -- what changes is only what it renders as, which is the
    // mapping's business. An audit entry here would mean a posture answered.
    expect({ stage: governed.stage, decision: governed.decision.decision }).toEqual({
      stage: "honoured",
      decision: "ask",
    });
    // The whole object, because a replacement missing a sibling field is the one
    // a host discards while delivering the original.
    expect(governed.output).toEqual(withheld);
    expect(events).toEqual([]);
  });

  it("withholds the output for a defer inside its window, having nowhere to hold it", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({
        decisionArrived: true,
        decision: {
          decision: "defer",
          reasoning: "waiting on an out-of-band approval",
          defer_details: {
            reason: "awaiting change ticket",
            resolution_method: "external",
            resolution_timeout_ms: 300_000,
          },
        },
      }),
      sink,
      { config: NEGOTIATED("proceed"), failure: undefined },
      { hookEventName: "OnResult", payload: resultPayload, hookmap: resultHookmap },
    );

    expect({ stage: governed.stage, decision: governed.decision.decision }).toEqual({
      stage: "honoured",
      decision: "defer",
    });
    expect(governed.output).toEqual(withheld);
    expect(events).toEqual([]);
  });

  // The other side of the same rule, and the one that would fail if "withholds"
  // had been written as "everything but allow": a `modify` delivers a
  // replacement it built itself, and must not have it overwritten by the
  // withholding one. Without this, a rule that withheld for `modify` too would
  // pass every test above while silently turning every redaction into a
  // withholding -- the output replaced by a policy marker instead of by the
  // redacted text the Guardian asked for.
  it("leaves a modify's own replacement alone", async () => {
    const { sink, events } = recordingSink();
    const governed = await govern(
      answering({
        decisionArrived: true,
        decision: {
          decision: "modify",
          reasoning: "redaction_applied",
          modifications: { redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }] },
        },
      }),
      sink,
      { config: NEGOTIATED("proceed"), failure: undefined },
      { hookEventName: "OnResult", payload: resultPayload, hookmap: resultHookmap },
    );

    expect(governed.stage).toBe("honoured");
    expect(governed.output).toEqual({
      outcome: "go",
      replacing_output: { text: "TOKEN=[REDACTED]", truncated: false },
    });
    expect(events).toEqual([]);
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

/**
 * §V5 review round 3, Task 2. `tools` was shared hookmap vocabulary this
 * package shape-checked (`assertToolsWellFormed`) and normalised
 * (`normalizeTools`) and then had no opinion about: the only code that ACTED
 * on it lived in one host's shim, so a third host written from an existing
 * shim would load a `tools` list and govern every tool anyway -- and the
 * envelope that follows is one the deployment's policy configuration cannot
 * express a target for, answered by the negotiated posture, which is this
 * slice's recurring fail-open shape.
 *
 * The rule is `governsTool`'s now, and `governStep` asks it before it does
 * anything else. Both shims still ask it a call earlier, which is what makes
 * an out-of-scope tool cost no session validation and no handshake either --
 * that half is pinned in each host's own suite (hosts/opencode/test/
 * request-gate.test.ts and result-gate.test.ts). What is pinned HERE is the
 * half a shim cannot provide: that a shim which never asks still skips.
 */
describe("governStep — a gate governs only the tools its hookmap entry names", () => {
  /**
   * A Guardian that fails the test by being asked at all, and an audit sink
   * that records what it was told. Both assertions are about absence, so both
   * collaborators have to be able to report a call that should not happen.
   */
  function unaskedGuardian(): { guardian: GuardianClient; asked: () => number } {
    let asks = 0;
    return {
      guardian: {
        requestDecision: () => {
          asks += 1;
          return Promise.resolve({
            decisionArrived: true,
            decision: { decision: "allow" },
          } satisfies DecisionOrFailure);
        },
        post: () => Promise.reject(new Error("governStep must not use the wire primitive")),
      },
      asked: () => asks,
    };
  }

  /** The request-gate fixture, scoped to one tool name the payloads below can miss. */
  const scoped = (tools: string[]): Hookmap => ({
    host: "test-host",
    hooks: { OnStep: { ...ON_STEP, tools } },
  });

  it("returns an empty output for a tool the list does not name, contacting no Guardian and auditing nothing", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = unaskedGuardian();

    const governed = await governRaw(guardian, sink, undefined, { hookmap: scoped(["Write"]) });

    // The whole answer, asserted as one object rather than field by field:
    // an empty output is what a host applies (no keys to write, no keys to
    // merge), `null` is what says no decision was sought, and "ungoverned"
    // is what a caller narrows on.
    expect(governed).toEqual({ output: {}, decision: null, stage: "ungoverned" });
    // No round trip, and no audit entry: a step this gate declines to govern
    // is not a failure, so there is nothing for a posture to answer and
    // nothing for an entry to record. An audit line here would read as a
    // fail-open proceed that never happened.
    expect({ asked: asked(), events }).toEqual({ asked: 0, events: [] });
  });

  it("governs a tool the list does name", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = unaskedGuardian();

    const governed = await governRaw(guardian, sink, undefined, { hookmap: scoped(["Bash", "Write"]) });

    expect(governed.stage).toBe("honoured");
    expect({ asked: asked(), events }).toEqual({ asked: 1, events: [] });
  });

  /**
   * HOST #1's OWN CASE, and the reason this is a separate test rather than an
   * assumption: hosts/claude-code/claude-code.hookmap.yaml declares no `tools`
   * key at either of its gates, because its settings.json matcher (`^Bash$`)
   * already scopes both. A skip that treated an absent list as "no tools" --
   * the obvious way to write this wrong -- would silently stop governing
   * every step on the host this slice promises `+0/-0`.
   */
  it("governs every tool when the entry declares no tools list at all", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = unaskedGuardian();

    const governed = await governRaw(guardian, sink, undefined, {
      // Deliberately a name nothing anywhere lists: the claim is "every
      // tool", not "the ones some other fixture happens to name".
      payload: { ...payload, tool_name: "a-tool-no-hookmap-in-this-repo-names" },
    });

    expect(governed.stage).toBe("honoured");
    expect({ asked: asked(), events }).toEqual({ asked: 1, events: [] });
  });

  /**
   * A TOOL NAME THE HOOKMAP'S OWN PATH CANNOT READ IS UNREADABLE, NOT OUT OF
   * SCOPE. `Array.prototype.includes` answers a silent `false` for a missing,
   * non-string, or empty needle, so a skip built on it would convert a step
   * that is currently governed or audited into a silent, unaudited one -- the
   * exact asymmetry host #2's shim already refuses at its own boundary
   * (`assertUsableTool`, acs-plugin.ts). `toolNameFor` answers `undefined`
   * instead, and `governStep` falls through to whatever already handles the
   * case.
   *
   * ALL THREE CASES, because "whatever already handles it" is NOT one
   * mechanism, and `toolNameFor`'s own doc comment claimed it was until §V5
   * review round 3, Task 2, fix round 1 measured otherwise. An absent or
   * non-string name is a `buildEnvelope` throw the posture answers, audited;
   * an EMPTY name is not -- `buildEnvelope` checks the type and not the
   * length, so the step is asked about and governed. Pinned here so that the
   * comment's distinction is a property of the code rather than of the
   * paragraph, and so that the third row fails loudly if anyone "simplifies"
   * `toolNameFor` by dropping its length check.
   */
  it("does not skip a step whose tool name the hookmap's path cannot read — unreadable is not out of scope", async () => {
    const rows: Record<string, unknown>[] = [];
    for (const [label, toolName] of [
      ["absent", undefined],
      ["a non-string", 42],
      ["the empty string", ""],
    ] as const) {
      const { sink, events } = recordingSink();
      const { guardian, asked } = unaskedGuardian();
      const payload: Record<string, unknown> = { session_id: "sess-1", tool_input: { command: "ls -la" } };
      if (toolName !== undefined) {
        payload.tool_name = toolName;
      }

      const governed = await governRaw(guardian, sink, undefined, { hookmap: scoped(["Bash"]), payload });

      // WHAT each audit entry says, not merely THAT there is one (§V5 review
      // round 3, Task 2, fix round 2). The single-case version of this test
      // asserted `{outcome: "proceeded", failure: {kind:
      // "host_configuration"}}`, and widening it to a table dropped both --
      // leaving "an entry was written" pinned and its contents free, which is
      // the half that says the incident was filed correctly. A posture that
      // audited the wrong outcome, or blamed a Guardian never contacted, would
      // have passed the weakened form.
      rows.push({
        label,
        stage: governed.stage,
        asked: asked(),
        audited: events.map((event) => ({ outcome: event.outcome, failureKind: event.failure?.kind ?? null })),
      });
    }

    // Not one of them is `stage: "ungoverned"` with nothing asked and nothing
    // audited, which is the single shape this test exists to refuse.
    expect(rows).toEqual([
      // The posture answers a request that could not be built, and records it
      // as a host-side configuration fault -- never as a delivery failure,
      // because no Guardian was contacted for it to be one.
      {
        label: "absent",
        stage: "request",
        asked: 0,
        audited: [{ outcome: "proceeded", failureKind: "host_configuration" }],
      },
      {
        label: "a non-string",
        stage: "request",
        asked: 0,
        audited: [{ outcome: "proceeded", failureKind: "host_configuration" }],
      },
      // Governed, not skipped and not faulted: `buildEnvelope` accepts an
      // empty string, so this step is really asked about. (Against a live
      // Guardian and this repo's own shipped configuration that answer is a
      // deny -- `runtime_error:tool_unknown` -- which is why leaving it
      // governed is better than refusing it here. See `toolNameFor`.)
      { label: "the empty string", stage: "honoured", asked: 1, audited: [] },
    ]);
  });

  /**
   * The other half of the same measurement, and the reason the length check in
   * `toolNameFor` is load-bearing: `governsTool` itself answers `false` for an
   * empty name against any declared list. So an empty name that DID reach the
   * skip would be skipped -- silently, unaudited -- which is what the test
   * above proves does not happen.
   */
  it("would skip an empty tool name if one ever reached the predicate, which is why toolNameFor never passes one", () => {
    expect(governsTool(scoped(["Bash"]), "OnStep", "")).toBe(false);
  });

  /**
   * THE ORDERING, and the reason the skip is the FIRST thing `governStep`
   * does rather than merely an early one. `assertOutputIsReplaceable` refuses
   * a result-gate payload whose named leaf no replacement can be built for --
   * a loud, blocking stop, correctly, for a step this gate governs. But on
   * host #2 an unlisted tool's payload is EXACTLY that shape: that gate's
   * `outputs`/`exit_status` are written for the one tool it lists, and every
   * other tool's `metadata` carries something else (opencode.hookmap.yaml's
   * own measurement table). Asked after that refusal, an out-of-scope tool
   * would stop the deployment instead of being skipped.
   */
  it("skips before the result gate's own refusal, so an unlisted tool costs no stop", async () => {
    const { sink, events } = recordingSink();
    const { guardian, asked } = unaskedGuardian();

    const governed = await governRaw(guardian, sink, undefined, {
      hookEventName: "OnResult",
      // Present, resolvable, and a flag -- the payload shape the test above
      // this describe block proves is a blocking stop when the gate governs
      // the tool.
      hookmap: {
        host: "test-host",
        hooks: {
          OnResult: {
            ...ON_RESULT,
            outputs: { from: "$.step_result.truncated", within: "$.step_result" },
            tools: ["Write"],
          },
        },
      },
      payload: resultPayload,
    });

    expect(governed).toEqual({ output: {}, decision: null, stage: "ungoverned" });
    expect({ asked: asked(), events }).toEqual({ asked: 0, events: [] });
  });
});

/**
 * The predicate itself, asked directly -- the single implementation of a rule
 * two shims and `governStep` all depend on, so its edges are pinned here
 * rather than inferred from the three call sites' behaviour.
 */
describe("governsTool — the rule both hosts and governStep share", () => {
  const scopedHookmap: Hookmap = {
    host: "test-host",
    hooks: { OnStep: { ...ON_STEP, tools: ["bash", "Write"] } },
  };

  it("answers true for every tool when the entry declares no tools list", () => {
    expect([
      governsTool(hookmap, "OnStep", "Bash"),
      governsTool(hookmap, "OnStep", "anything-at-all"),
      governsTool(hookmap, "OnStep", ""),
    ]).toEqual([true, true, true]);
  });

  it("answers true for a listed tool and false for an unlisted one, case-sensitively", () => {
    expect([
      governsTool(scopedHookmap, "OnStep", "bash"),
      governsTool(scopedHookmap, "OnStep", "Write"),
      governsTool(scopedHookmap, "OnStep", "read"),
      // Case matters, and this is the asymmetry that made host #2's own suite
      // pass against a tool name its host never sends: OpenCode reports
      // `bash`, Claude Code reports `Bash`.
      governsTool(scopedHookmap, "OnStep", "Bash"),
    ]).toEqual([true, true, false, false]);
  });

  /**
   * A hook this hookmap does not map has no `tools` list to be outside of, so
   * this answers "governs" and leaves the refusal to `governStep`'s own guard
   * -- which throws, because a hookmap missing the hook that fired can express
   * neither an arriving decision nor a posture's answer to an absent one. An
   * unmapped hook answered `false` here would turn that loud stop into a
   * silent skip.
   */
  it("answers true for a hook the hookmap does not map, leaving that refusal where it belongs", () => {
    expect(governsTool(scopedHookmap, "NoSuchHook", "bash")).toBe(true);
  });

  /**
   * `hasOwnProperty`, not a bare index: `hookEventName` reaches some hosts
   * from their own payloads, and `hooks["toString"]` resolves to an inherited
   * `Object.prototype` function. Today both forms answer `true` -- that
   * function carries no `tools` field either -- so this pins the answer as a
   * property of the hookmap's own entries rather than of what
   * `Object.prototype` happens to carry, and would fail if a future edit
   * started reading anything else off the resolved entry.
   */
  it("answers true for a prototype-named hook rather than reading Object.prototype", () => {
    expect(governsTool(scopedHookmap, "toString", "bash")).toBe(true);
  });
});
