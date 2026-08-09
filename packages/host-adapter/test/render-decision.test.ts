import { describe, expect, it } from "bun:test";
import { loadHookmap, type Hookmap } from "../src/build-envelope.ts";
import { renderDecision } from "../src/render-decision.ts";

// Same decisions block as S1's real hosts/claude-code/claude-code.hookmap.yaml
// (Task 7's own fixture) -- kept local so these tests don't depend on the
// real file staying byte-identical, except for the one test below that
// deliberately does load the real file.
const hookmap: Hookmap = {
  host: "claude-code",
  hooks: {
    PreToolUse: {
      acs_method: "steps/toolCallRequest",
      tool_name: "$.tool_name",
      arguments: "$.tool_input",
    },
  },
  decisions: {
    allow: { permissionDecision: "allow" },
    deny: { permissionDecision: "deny", reason_from: "reasoning" },
    ask: { permissionDecision: "ask" },
    defer: { permissionDecision: "defer" },
    modify: { permissionDecision: "allow", updatedInput_from: "modifications" },
  },
};

describe("renderDecision", () => {
  it("renders a deny with the ACS reasoning carried into permissionDecisionReason -- the demo's payoff", () => {
    const { hookSpecificOutput } = renderDecision(
      "PreToolUse",
      { decision: "deny", reasoning: "blocked: destructive command matched a stock rule" },
      hookmap,
    );

    expect(hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked: destructive command matched a stock rule",
    });
  });

  it("renders an allow with permissionDecision allow and no reason", () => {
    const { hookSpecificOutput } = renderDecision("PreToolUse", { decision: "allow" }, hookmap);

    expect(hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow" });
  });

  it("a warn-derived allow (allow + non-empty policy_references) still renders as a plain allow -- no separate rendering (R1.2)", () => {
    const { hookSpecificOutput } = renderDecision(
      "PreToolUse",
      {
        decision: "allow",
        policy_references: [{ policy_id: "stock_policy_bundle", rule_id: "drift_detected" }],
      },
      hookmap,
    );

    expect(hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow" });
  });

  it("renders modify with updatedInput carried from the hookmap-named field", () => {
    const { hookSpecificOutput } = renderDecision(
      "PreToolUse",
      {
        decision: "modify",
        reasoning: "redacted a secret",
        modifications: { arguments: { command: { value: "echo [REDACTED]" } } },
      },
      hookmap,
    );

    expect(hookSpecificOutput.permissionDecision).toBe("allow");
    expect(hookSpecificOutput.updatedInput).toEqual({ arguments: { command: { value: "echo [REDACTED]" } } });
  });

  it("is hookmap-driven: mutating decisions.allow changes the rendered output with no code change", () => {
    const mutated: Hookmap = {
      ...hookmap,
      decisions: { ...hookmap.decisions, allow: { permissionDecision: "ask" } },
    };

    const original = renderDecision("PreToolUse", { decision: "allow" }, hookmap);
    const changed = renderDecision("PreToolUse", { decision: "allow" }, mutated);

    expect(original.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(changed.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("is hookmap-driven: mutating deny's reason_from changes which field feeds permissionDecisionReason", () => {
    const mutated: Hookmap = {
      ...hookmap,
      decisions: { ...hookmap.decisions, deny: { permissionDecision: "deny", reason_from: "reason_codes" } },
    };

    const { hookSpecificOutput } = renderDecision(
      "PreToolUse",
      { decision: "deny", reasoning: "human text", reason_codes: "machine_code" },
      mutated,
    );

    expect(hookSpecificOutput.permissionDecisionReason).toBe("machine_code");
  });

  it("throws on an ACS decision absent from the hookmap's decisions block, rather than defaulting", () => {
    const noDeny: Hookmap = { ...hookmap, decisions: { allow: hookmap.decisions!.allow! } };

    expect(() => renderDecision("PreToolUse", { decision: "deny", reasoning: "x" }, noDeny)).toThrow();
  });

  it("throws when the hookmap has no decisions block at all", () => {
    const noDecisions: Hookmap = { host: "claude-code", hooks: hookmap.hooks };

    expect(() => renderDecision("PreToolUse", { decision: "allow" }, noDecisions)).toThrow();
  });

  it("loads the real claude-code.hookmap.yaml and renders a deny end to end", () => {
    const real = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");

    const { hookSpecificOutput } = renderDecision("PreToolUse", { decision: "deny", reasoning: "blocked" }, real);

    expect(hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked",
    });
  });
});
