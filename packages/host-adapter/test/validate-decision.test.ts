import { describe, expect, it } from "bun:test";
import { applyModifications, ModificationsInvalidError, validateDecision } from "../src/validate-decision.ts";

const FRESH = { elapsedMs: 10 };
const ARGS = { command: "echo ghp_ABCDEF123456", timeout: 30 };

describe("validateDecision — malformed modifications fail closed (R1.8, §6.3)", () => {
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

  // Fix round 1, item 4: an empty path segment list ("" or "/") addresses
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

  // Fix round 1, item 5: a malformed redactions entry must be denied
  // whether or not parameter_overrides is also present -- the overlap
  // check alone used to be the only thing validating a path's shape, and
  // it only ran when overrides existed too.
  it("denies a redaction with a missing or non-string path even with no parameter_overrides present", () => {
    expect(validateDecision(
      { decision: "modify", reasoning: "r", modifications: { redactions: [{}] } },
      { ...FRESH, originalArguments: ARGS },
    ).decision).toBe("deny");
  });
});

describe("validateDecision — ASK and DEFER expiry (R1.8)", () => {
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

  // Fix round 1, item 2: every other ASK test here produces the same verdict
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

  // Fix round 1, item 1: pins the exact boundary (strict `>`, per the
  // module's own comment) so a regression to `>=` would fail here even
  // though every other ASK test above sits far past the boundary.
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

  // Fix round 1, item 1: DEFER's own boundary, pinned the same way as ASK's
  // above. resolution_timeout_ms: 50 -- below, exactly at, and just past.
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

  // Constraint 1: an arriving deny is honoured. There is no path in this
  // module that can turn one into anything else.
  it("never rewrites a deny", () => {
    for (const elapsed of [0, 1, 1_000_000]) {
      expect(validateDecision({ decision: "deny", reasoning: "r" }, { elapsedMs: elapsed, originalArguments: ARGS }).decision)
        .toBe("deny");
    }
  });
});

describe("applyModifications — §6.3", () => {
  it("overrides named arguments and leaves the rest", () => {
    expect(applyModifications(ARGS, { parameter_overrides: { command: "echo [REDACTED]" } }))
      .toEqual({ command: "echo [REDACTED]", timeout: 30 });
  });

  it("replaces a redacted field with its replacement, defaulting to [REDACTED]", () => {
    expect(applyModifications(ARGS, { redactions: [{ path: "/command" }] }))
      .toEqual({ command: "[REDACTED]", timeout: 30 });
    expect(applyModifications(ARGS, { redactions: [{ path: "/command", replacement: "***" }] }))
      .toEqual({ command: "***", timeout: 30 });
  });

  it("does not mutate the arguments it was given", () => {
    const original = { command: "keep me" };
    applyModifications(original, { parameter_overrides: { command: "changed" } });
    expect(original).toEqual({ command: "keep me" });
  });

  // Fix round 1, item 3: the only multi-segment path used elsewhere in this
  // suite ("/env/TOKEN") sits in a disjointness test that denies, so it
  // never reaches the apply loop -- setAtPath's recursive clone was correct
  // on trace but unexercised. This applies a depth-2 redaction for real and
  // checks both halves: the new value, and that the nested object it
  // descended into is left alone -- the half a shallow clone would break.
  it("applies a depth-2 redaction without mutating the nested object it descends into", () => {
    const original = { env: { TOKEN: "secret", OTHER: "keep" } };
    const result = applyModifications(original, { redactions: [{ path: "/env/TOKEN" }] });

    expect(result).toEqual({ env: { TOKEN: "[REDACTED]", OTHER: "keep" } });
    expect(original).toEqual({ env: { TOKEN: "secret", OTHER: "keep" } });
    expect(original.env).not.toBe(result.env);
  });

  it("throws on a modifications object that violates §6.3", () => {
    expect(() => applyModifications(ARGS, { modified_content: "x", redactions: [{ path: "/command" }] }))
      .toThrow(ModificationsInvalidError);
  });

  // Fix round 1, item 4: same rule as validateDecision's test above, at the
  // applyModifications level directly.
  it("throws on a redaction with an empty path", () => {
    expect(() => applyModifications(ARGS, { redactions: [{ path: "" }] })).toThrow(ModificationsInvalidError);
    expect(() => applyModifications(ARGS, { redactions: [{ path: "/" }] })).toThrow(ModificationsInvalidError);
  });

  // Fix round 1, item 5: a missing/non-string path must fail closed with a
  // clean ModificationsInvalidError, not a bare JS error surfaced from deep
  // inside the apply loop -- regardless of whether parameter_overrides is
  // also present.
  it("throws a clean ModificationsInvalidError on a missing or non-string redaction path, not raw JS error text", () => {
    expect(() => applyModifications(ARGS, { redactions: [{}] })).toThrow(ModificationsInvalidError);
    expect(() => applyModifications(ARGS, { redactions: [{ path: 42 }] })).toThrow(ModificationsInvalidError);
  });
});
