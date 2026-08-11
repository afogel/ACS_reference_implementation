import { describe, expect, it } from "bun:test";
import { validateDecision } from "../src/validate-decision.ts";

const FRESH = { elapsedMs: 10 };
const ARGS = { command: "echo ghp_ABCDEF123456", timeout: 30 };

describe("validateDecision — malformed modifications fail closed (§6.3)", () => {
  it("passes a modify whose modifications are well formed, and applies them", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "redacted", modifications: { parameter_overrides: { command: "echo [REDACTED]" } } },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("modify");
    expect(out.applied_input).toEqual({ command: "echo [REDACTED]", timeout: 30 });
  });

  it("denies when modified_content is combined with parameter_overrides", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { modified_content: "whole", parameter_overrides: { command: "x" } },
      },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
  });

  it("denies when a redaction path and an override key address the same field", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { redactions: [{ path: "/command" }], parameter_overrides: { command: "x" } },
      },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
  });

  // Two redactions must be disjoint from each other, not only from the
  // overrides. Without this check, `/a` then `/a/b` would yield
  // `{a: {b: "[REDACTED]"}}`: the first redaction discarded, `keep` silently
  // gone from the arguments the host was about to run, and the decision
  // still rendered as an applied modify. Losing an argument is worse than
  // failing to redact one, and both are worse than a deny.
  it("denies two redaction paths that overlap each other", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "/a" }, { path: "/a/b" }] } },
      { elapsedMs: 10, originalArguments: { a: { b: 1, keep: "important" } } },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
    expect(out.reasoning).toMatch(/not disjoint/);
  });

  it("denies two identical redaction paths", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "/a" }, { path: "/a" }] } },
      { elapsedMs: 10, originalArguments: { a: "x" } },
    );
    expect(out.decision).toBe("deny");
  });

  it("still allows two redactions on genuinely disjoint paths", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "/a" }, { path: "/b" }] } },
      { elapsedMs: 10, originalArguments: { a: "x", b: "y", c: "keep" } },
    );
    expect(out.decision).toBe("modify");
    expect(out.applied_input).toEqual({ a: "[REDACTED]", b: "[REDACTED]", c: "keep" });
  });

  it("denies on ancestor/descendant overlap, not just exact equality", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { redactions: [{ path: "/env/TOKEN" }], parameter_overrides: { env: {} } },
      },
      { ...FRESH, originalArguments: { env: { TOKEN: "t" } } },
    );
    expect(out.decision).toBe("deny");
  });

  it("denies a modify carrying no modifications at all", () => {
    const out = validateDecision({ decision: "modify", reasoning: "r" }, { ...FRESH, originalArguments: ARGS });
    expect(out.decision).toBe("deny");
  });

  // An empty path segment list ("" or "/") addresses
  // no field. Applying it would report a successful modify while redacting
  // nothing -- a policy that fired and did not take effect -- so this fails
  // closed the same as any other unusable modifications object.
  it("denies a redaction with an empty path -- it would redact nothing while reporting success", () => {
    expect(validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "" }] } },
      { ...FRESH, originalArguments: ARGS },
    ).decision).toBe("deny");
    expect(validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "/" }] } },
      { ...FRESH, originalArguments: ARGS },
    ).decision).toBe("deny");
  });

  // A malformed redactions entry must be denied whether or not
  // parameter_overrides is also present -- validation must not depend on
  // which other fields happen to be there.
  it("denies a redaction with a missing or non-string path even with no parameter_overrides present", () => {
    expect(validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{}] } },
      { ...FRESH, originalArguments: ARGS },
    ).decision).toBe("deny");
  });

  // The hazard this guards against: if unchecked, the decision would stay
  // `modify`, `applied_input` would carry BOTH the invented key and the
  // untouched original, the hookmap would render `permissionDecision: allow`
  // with that updatedInput, and the host would run the original
  // un-redacted command -- while reporting the rewrite as applied. Nothing
  // would be audited, because the audit sink records delivery failures, not
  // this.
  it("denies a parameter_overrides key that names no existing argument, instead of inventing the field", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "redacted",
        // "cmd", not "command": one character away from the real argument.
        modifications: { parameter_overrides: { cmd: "echo [REDACTED]" } },
      },
      { ...FRESH, originalArguments: { command: "echo ghp_SECRET123456" } },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
    // The secret must not survive into anything the host would run.
    expect(out.applied_input).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("ghp_SECRET123456");
  });

  it("denies a redaction path whose target is absent from the arguments that were sent", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "redacted",
        modifications: { redactions: [{ path: "/env/TOKEN" }] },
      },
      { ...FRESH, originalArguments: { command: "echo ghp_SECRET123456" } },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
    expect(out.applied_input).toBeUndefined();
  });

  // V4's C7 legalized this: the ACS result payload's redaction path is
  // /outputs/0/value, so a Guardian must be able to address an array
  // element. This test used to pin the opposite -- a blanket refusal of
  // any multi-segment redaction that descended through an array -- because
  // a naive write turns ["a","b"] into {"0":"[REDACTED]","1":"b"}, which is
  // not the edit that was asked for and would reach the host as an object
  // where it expects a list. The refusal is now conditional on the index
  // being real (modifications.ts), so this is deliberately rewritten as
  // the positive case rather than relaxed: checking only `decision` would
  // pass with the array-safe write path deleted, the same weakness the
  // comment below calls out for the reserved-segment tests.
  it("applies a redaction addressing an array element, and keeps the array an array", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: "/items/0" }] } },
      { ...FRESH, originalArguments: { items: ["a", "b"] } },
    );
    expect(out.decision).toBe("modify");
    expect(out.applied_input).toEqual({ items: ["[REDACTED]", "b"] });
    expect(Array.isArray((out.applied_input as { items: unknown }).items)).toBe(true);
  });

  // The reasoning is asserted, not just the deny: an absent-target check
  // alone already denies all three of these (none is an OWN property of an
  // arguments object), so a test that only checked `decision` would pass with
  // this guard deleted -- blind to the thing it exists to pin.
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    it(`denies a redaction path or override key naming ${segment}, and says why`, () => {
      const redaction = validateDecision(
        { decision: "modify", reasoning: "r", modifications: { redactions: [{ path: `/${segment}` }] } },
        { ...FRESH, originalArguments: ARGS },
      );
      expect(redaction.decision).toBe("deny");
      expect(redaction.reasoning).toContain(`reserved segment "${segment}"`);

      const override = validateDecision(
        { decision: "modify", reasoning: "r", modifications: { parameter_overrides: { [segment]: "x" } } },
        { ...FRESH, originalArguments: ARGS },
      );
      expect(override.decision).toBe("deny");
      expect(override.reasoning).toContain(`reserved segment "${segment}"`);
    });
  }

  // modified_content alone passed validation and then applied nothing: the
  // apply step has no mapping from a wholesale content replacement onto an
  // arguments object, so it returned the arguments untouched and still
  // reported `modify`. Same shape as an absent target, one branch over.
  it("denies a modify carrying only modified_content, which this host cannot apply to an arguments object", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { modified_content: "echo [REDACTED]" } },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
    expect(out.applied_input).toBeUndefined();
  });

  // Both of these fail closed either way, but the raw JS error text
  // ("...map is not a function") should never be what lands in the deny's
  // reasoning, which is the audit record a human reads.
  it("reports a clean ModificationsInvalidError for a non-object redactions entry or a non-array redactions", () => {
    for (const modifications of [{ redactions: [null] }, { redactions: "abc" }, { redactions: [42] }]) {
      const out = validateDecision(
        { decision: "modify", reasoning: "r", modifications },
        { ...FRESH, originalArguments: ARGS },
      );
      expect(out.decision).toBe("deny");
      expect(out.reasoning).toContain("modifications cannot be honoured as specified");
      expect(out.reasoning).not.toContain("is not a function");
    }
  });

  it("reports a clean ModificationsInvalidError for a non-object parameter_overrides", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "r", modifications: { parameter_overrides: ["command"] } },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
    expect(out.reasoning).toContain("parameter_overrides must be an object");
  });
});

describe("validateDecision — ASK and DEFER expiry", () => {
  it("passes a fresh ask through untouched", () => {
    const ask = {
      decision: "ask",
      reasoning: "approval required",
      ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 60 },
    };
    expect(validateDecision(ask, { ...FRESH, originalArguments: ARGS }).decision).toBe("ask");
  });

  it("substitutes an expired ask with its timeout_disposition", () => {
    const out = validateDecision(
      {
        decision: "ask",
        reasoning: "approval required",
        ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 1, timeout_disposition: "allow" },
      },
      { elapsedMs: 2_000, originalArguments: ARGS },
    );
    expect(out.decision).toBe("allow");
    expect(out.reason_codes).toContain("ask_expired");
  });

  // ask-details.json defaults timeout_disposition to "deny", and §6 says that
  // default is deliberate. Absent must mean deny, never allow.
  it("denies an expired ask that names no timeout_disposition", () => {
    const out = validateDecision(
      {
        decision: "ask",
        reasoning: "approval required",
        ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 1 },
      },
      { elapsedMs: 2_000, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
  });

  // Every other ASK test here produces the same verdict
  // whether or not the timeout_seconds -> ms conversion happens at all
  // (1s/2000ms reads "expired" either way; 60s/10ms reads "not expired"
  // either way), so the `* 1000` was unverified. timeout_seconds: 1 is
  // 1000ms; elapsedMs: 500 is under that and so correctly NOT expired --
  // but if the conversion were dropped (comparing 500 against the bare
  // "1"), this would wrongly read as expired. Kept as its own case so a
  // future "simplification" that drops the multiply cannot pass unnoticed.
  it("does not expire an ask at 500ms against a 1-second timeout -- the case that catches a dropped seconds->ms conversion", () => {
    const out = validateDecision(
      {
        decision: "ask",
        reasoning: "approval required",
        ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 1 },
      },
      { elapsedMs: 500, originalArguments: ARGS },
    );
    expect(out.decision).toBe("ask");
  });

  // Pins the exact boundary (strict `>`, per the module's own comment) so a
  // regression to `>=` would fail here even though every other ASK test
  // above sits far past the boundary.
  // timeout_seconds: 1 -> timeoutMs 1000. Below, exactly at, and just past.
  it("expires an ask strictly after its timeout, not at or before it", () => {
    const askDetails = { approver: { type: "user" }, question: "ok?", timeout_seconds: 1 };
    expect(
      validateDecision(
        { decision: "ask", reasoning: "r", ask_details: askDetails },
        { elapsedMs: 999, originalArguments: ARGS },
      ).decision,
    ).toBe("ask");
    expect(
      validateDecision(
        { decision: "ask", reasoning: "r", ask_details: askDetails },
        { elapsedMs: 1_000, originalArguments: ARGS },
      ).decision,
    ).toBe("ask");
    expect(
      validateDecision(
        { decision: "ask", reasoning: "r", ask_details: askDetails },
        { elapsedMs: 1_001, originalArguments: ARGS },
      ).decision,
    ).not.toBe("ask");
  });

  it("substitutes an expired defer with its timeout_decision, defaulting to deny", () => {
    const details = { reason: "low_confidence", resolution_method: "timeout", resolution_timeout_ms: 50 };
    // This pair already discriminates resolution_timeout_ms's own unit
    // (milliseconds, no conversion): 500 is past a 50ms timeout only because
    // 50 is read as milliseconds, not, say, mistakenly multiplied up as if
    // it were seconds (which would put the timeout at 50000ms and make 500
    // read as not-expired instead). No separate conversion case needed here
    // the way ASK needed one above.
    expect(
      validateDecision({ decision: "defer", reasoning: "r", defer_details: details }, { elapsedMs: 500, originalArguments: ARGS })
        .decision,
    ).toBe("deny");
    expect(
      validateDecision({ decision: "defer", reasoning: "r", defer_details: details }, { elapsedMs: 10, originalArguments: ARGS })
        .decision,
    ).toBe("defer");
  });

  // defer-details.json permits `timeout_decision: "ask"`. Substituting it
  // naively would emit `{decision: "ask"}` with no `ask_details` -- a
  // message ACS's own schema rejects, and one this module's peer resolver
  // would deny as `ask_details_invalid` if anything ever asked it. Nothing
  // does: no substitution re-enters `validateDecision`, so a malformed ask
  // would go straight to the host's renderer.
  describe("an expired defer whose timeout_decision is ask", () => {
    const askOnTimeout = {
      reason: "low_confidence",
      resolution_method: "human_approval",
      resolution_timeout_ms: 50,
      timeout_decision: "ask",
    };

    const expired = () =>
      validateDecision(
        { decision: "defer", reasoning: "r", defer_details: askOnTimeout },
        { elapsedMs: 500, originalArguments: ARGS },
      );

    it("denies closed rather than raising a question it cannot form", () => {
      expect(expired().decision).toBe("deny");
    });

    it("names the configuration fault, not merely an expiry", () => {
      // Its own code: an operator needs to know the deployment declared an
      // escalation the Guardian gave it no means to make.
      expect(expired().reason_codes).toEqual(["defer_ask_unaskable"]);
      expect(expired().reasoning).toContain("timeout_decision=ask");
    });

    it("never emits an ask whose ask_details its own peer would reject", () => {
      // The precise defect: an `ask` reaching a host with no approver,
      // question or timeout_seconds behind it.
      const substituted = expired();
      expect(substituted.decision).not.toBe("ask");
      expect(substituted.ask_details).toBeUndefined();
    });

    it("still returns the defer untouched inside its window", () => {
      expect(
        validateDecision(
          { decision: "defer", reasoning: "r", defer_details: askOnTimeout },
          { elapsedMs: 10, originalArguments: ARGS },
        ).decision,
      ).toBe("defer");
    });
  });

  // DEFER's own boundary, pinned the same way as ASK's above.
  // resolution_timeout_ms: 50 -- below, exactly at, and just past.
  it("expires a defer strictly after its resolution_timeout_ms, not at or before it", () => {
    const deferDetails = { reason: "low_confidence", resolution_method: "timeout", resolution_timeout_ms: 50 };
    expect(
      validateDecision(
        { decision: "defer", reasoning: "r", defer_details: deferDetails },
        { elapsedMs: 49, originalArguments: ARGS },
      ).decision,
    ).toBe("defer");
    expect(
      validateDecision(
        { decision: "defer", reasoning: "r", defer_details: deferDetails },
        { elapsedMs: 50, originalArguments: ARGS },
      ).decision,
    ).toBe("defer");
    expect(
      validateDecision(
        { decision: "defer", reasoning: "r", defer_details: deferDetails },
        { elapsedMs: 51, originalArguments: ARGS },
      ).decision,
    ).not.toBe("defer");
  });

  it("denies an ask or defer whose details are missing entirely", () => {
    expect(validateDecision({ decision: "ask", reasoning: "r" }, { ...FRESH, originalArguments: ARGS }).decision)
      .toBe("deny");
    expect(validateDecision({ decision: "defer", reasoning: "r" }, { ...FRESH, originalArguments: ARGS }).decision)
      .toBe("deny");
  });
});

describe("validateDecision — everything else passes through", () => {
  it("leaves allow and deny exactly as they arrived", () => {
    const allow = { decision: "allow", reason_codes: ["drift_detected"], policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }] };
    expect(validateDecision(allow, { ...FRESH, originalArguments: ARGS })).toEqual(allow);
    const deny = { decision: "deny", reasoning: "blocked", reason_codes: ["destructive_shell_command_blocked"] };
    expect(validateDecision(deny, { ...FRESH, originalArguments: ARGS })).toEqual(deny);
  });

  // An arriving deny is honoured. There is no path in this
  // module that can turn one into anything else.
  it("never rewrites a deny", () => {
    for (const elapsed of [0, 1, 1_000_000]) {
      expect(validateDecision({ decision: "deny", reasoning: "r" }, { elapsedMs: elapsed, originalArguments: ARGS }).decision)
        .toBe("deny");
    }
  });
});

/**
 * V4. At a gate that sees what a step PRODUCED, the applied document still has
 * to be projected onto the output object the host already holds -- and that
 * projection happens INSIDE this module's apply step, so a projection that
 * cannot land is the same `deny` as a rewrite that could not be applied.
 *
 * That placement is the property these tests exist for. Projecting after
 * `validateDecision` returned would put these failures outside the only catch
 * that can answer them with a decision, where a caller's delivery posture would
 * answer them instead -- and a `proceed` posture there is an unredacted output
 * delivered because a redaction could not be expressed. The end-to-end proof is
 * hosts/claude-code/test/post-tool-use.test.ts; this is the seam.
 */
describe("validateDecision — the result gate projects the applied document onto the host's output", () => {
  const OUTPUT_TARGET = {
    payload: {
      tool_response: { stdout: "TOKEN=ghp_ABCDEF123456", stderr: "", interrupted: false, isImage: false },
    },
    outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
  };
  /** The result payload the pointer below addresses -- what `modificationTarget`
   * answers for a result envelope, and NOT an arguments bag. */
  const RESULT_DOCUMENT = { tool: { name: "Bash" }, exit_status: "success", outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] };
  const REDACT = {
    decision: "modify",
    reasoning: "redaction_applied",
    modifications: { redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }] },
  };

  it("lands the applied leaf in `applied_output`, a clone of `within` with every sibling intact", () => {
    const out = validateDecision(REDACT, {
      ...FRESH,
      originalArguments: RESULT_DOCUMENT,
      outputTarget: OUTPUT_TARGET,
    });

    expect(out.decision).toBe("modify");
    // The whole object: a replacement carrying the redacted leaf ALONE is the
    // shape the host silently discards, delivering the original.
    expect(out.applied_output).toEqual({
      stdout: "TOKEN=[REDACTED]",
      stderr: "",
      interrupted: false,
      isImage: false,
    });
    // `applied_input` is the OTHER gate's field. A decision carries one or the
    // other, never both: an arguments bag is a tool input and a projected output
    // object is a tool result, and a host renders from the one its gate names.
    expect(out.applied_input).toBeUndefined();
  });

  it("does not mutate the payload the host handed us", () => {
    validateDecision(REDACT, { ...FRESH, originalArguments: RESULT_DOCUMENT, outputTarget: OUTPUT_TARGET });

    expect(OUTPUT_TARGET.payload.tool_response.stdout).toBe("TOKEN=ghp_ABCDEF123456");
  });

  // The fail-closed case, and the reason `replacingOutput` compares types at
  // all: the host validates a replacement against the tool's own output schema
  // and delivers the ORIGINAL when it does not match. Prose in place of a number
  // is exactly that mismatch, so writing it would withhold nothing and redact
  // nothing -- while the decision reported a rewrite.
  it("denies, rather than throwing, when the replacement is not a shape the host's own leaf admits", () => {
    const out = validateDecision(REDACT, {
      ...FRESH,
      originalArguments: RESULT_DOCUMENT,
      outputTarget: {
        payload: { tool_response: { stdout: 42, stderr: "" } },
        outputs: OUTPUT_TARGET.outputs,
      },
    });

    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
    expect(out.applied_output).toBeUndefined();
  });

  // A pointer the ACS payload does have and the host's output object does not
  // reach. It applies cleanly to the document and changes nothing the host can
  // see, so the projection is the only place left that can notice -- and it
  // notices by finding no leaf to patch.
  it("denies a rewrite whose leaf the host payload does not have", () => {
    const out = validateDecision(REDACT, {
      ...FRESH,
      originalArguments: RESULT_DOCUMENT,
      outputTarget: { payload: { tool_response: { stderr: "" } }, outputs: OUTPUT_TARGET.outputs },
    });

    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
  });
});
