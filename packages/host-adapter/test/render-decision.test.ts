import { describe, expect, it } from "bun:test";
import { loadHookmap, type Hookmap } from "../src/build-envelope.ts";
import { renderDecision } from "../src/render-decision.ts";

/**
 * A hookmap for a host that is not Claude Code, deliberately.
 *
 * The old version of this file used the real hookmap's decisions block, which
 * meant every assertion here was also an assertion about one host's field
 * names -- and that was the shape of the problem PR #10's Critical finding
 * named: the adapter's own tests could not tell "renders what the hookmap
 * says" apart from "renders permissionDecision". This host nests its decision
 * two levels deep under different names, carries a field OUTSIDE that wrapper,
 * and has no permission-style field at all. Nothing in the module under test
 * knows any of it.
 *
 * The one test at the bottom does load the real file, so the shipped hookmap
 * is still exercised end to end.
 */
const hookmap: Hookmap = {
  host: "some-other-host",
  hooks: {
    BeforeTool: {
      acs_method: "steps/toolCallRequest",
      tool_name: "$.tool_name",
      arguments: "$.tool_input",
    },
  },
  decisions: {
    allow: {
      output: {
        "gate.verdict": { value: "pass" },
        "gate.note": { from: "reasoning", type: "string" },
      },
    },
    deny: {
      output: {
        "gate.verdict": { value: "fail" },
        "gate.note": { from: "reasoning", type: "string" },
        blocked: { value: true },
      },
    },
    modify: {
      output: {
        "gate.verdict": { value: "pass" },
        "gate.rewritten": { from: "modifications" },
      },
    },
  },
};

describe("renderDecision", () => {
  it("renders exactly the object the hookmap's output paths describe, nesting as declared", () => {
    expect(renderDecision({ decision: "deny", reasoning: "blocked: destructive command" }, hookmap)).toEqual({
      gate: { verdict: "fail", note: "blocked: destructive command" },
      blocked: true,
    });
  });

  it("leaves a `from` field off entirely when the decision does not carry it", () => {
    expect(renderDecision({ decision: "allow" }, hookmap)).toEqual({ gate: { verdict: "pass" } });
  });

  it("leaves a `from` field off when the decision carries the wrong type for it", () => {
    // A Guardian putting an object where the hookmap declared prose would
    // otherwise produce an output the host cannot render -- and a host that
    // rejects the whole output treats the hook as having produced no decision,
    // which is a fail-open from a decision that arrived perfectly well.
    expect(renderDecision({ decision: "allow", reasoning: { text: "not a string" } }, hookmap)).toEqual({
      gate: { verdict: "pass" },
    });
  });

  it("a warn-derived allow (allow + non-empty policy_references) still renders as a plain allow -- no separate rendering (R1.2)", () => {
    expect(
      renderDecision(
        {
          decision: "allow",
          policy_references: [{ policy_id: "stock_policy_bundle", rule_id: "drift_detected" }],
        },
        hookmap,
      ),
    ).toEqual({ gate: { verdict: "pass" } });
  });

  it("copies a whole object through a `from` field with no declared type", () => {
    expect(
      renderDecision(
        {
          decision: "modify",
          reasoning: "redacted a secret",
          modifications: { parameter_overrides: { command: "echo [REDACTED]" } },
        },
        hookmap,
      ),
    ).toEqual({
      gate: { verdict: "pass", rewritten: { parameter_overrides: { command: "echo [REDACTED]" } } },
    });
  });

  it("is hookmap-driven: mutating a decision's literal changes the rendered output with no code change", () => {
    const mutated: Hookmap = {
      ...hookmap,
      decisions: { ...hookmap.decisions, allow: { output: { "gate.verdict": { value: "review" } } } },
    };

    expect(renderDecision({ decision: "allow" }, hookmap)).toEqual({ gate: { verdict: "pass" } });
    expect(renderDecision({ decision: "allow" }, mutated)).toEqual({ gate: { verdict: "review" } });
  });

  it("is hookmap-driven: mutating a `from` changes which decision field feeds the host field", () => {
    const mutated: Hookmap = {
      ...hookmap,
      decisions: {
        ...hookmap.decisions,
        deny: { output: { "gate.verdict": { value: "fail" }, "gate.note": { from: "reason_codes" } } },
      },
    };

    expect(renderDecision({ decision: "deny", reasoning: "human text", reason_codes: "machine_code" }, mutated)).toEqual(
      { gate: { verdict: "fail", note: "machine_code" } },
    );
  });

  it("is hookmap-driven: a path with no dot puts the field alongside the wrapper, not inside it", () => {
    // The shape the old, host-named types could not express at all.
    const flat: Hookmap = {
      ...hookmap,
      decisions: { allow: { output: { verdict: { value: "pass" } } } },
    };

    expect(renderDecision({ decision: "allow" }, flat)).toEqual({ verdict: "pass" });
  });

  it("throws on an ACS decision absent from the hookmap's decisions block, rather than defaulting", () => {
    const noDeny: Hookmap = { ...hookmap, decisions: { allow: hookmap.decisions!.allow! } };

    expect(() => renderDecision({ decision: "deny", reasoning: "x" }, noDeny)).toThrow(/no decisions entry/);
  });

  it("throws when the hookmap has no decisions block at all", () => {
    const noDecisions: Hookmap = { host: "some-other-host", hooks: hookmap.hooks };

    expect(() => renderDecision({ decision: "allow" }, noDecisions)).toThrow(/no decisions block/);
  });

  it("throws on an entry with an empty or missing output block, rather than rendering nothing", () => {
    // An output with no decision in it is read by a host as "the hook produced
    // nothing", which is the same bypass a missing entry is, only quieter.
    for (const broken of [{}, { output: {} }, null]) {
      const bad: Hookmap = { ...hookmap, decisions: { allow: broken } };
      expect(() => renderDecision({ decision: "allow" }, bad)).toThrow(/non-empty "output" block/);
    }
  });

  it("throws on an output field naming neither a literal nor a source", () => {
    const bad: Hookmap = { ...hookmap, decisions: { allow: { output: { "gate.verdict": { tpye: "string" } } } } };

    expect(() => renderDecision({ decision: "allow" }, bad)).toThrow(/must name a literal/);
  });

  it("throws on two output paths that collide, rather than silently picking one", () => {
    const collides: Hookmap = {
      ...hookmap,
      decisions: { allow: { output: { gate: { value: "pass" }, "gate.verdict": { value: "pass" } } } },
    };

    expect(() => renderDecision({ decision: "allow" }, collides)).toThrow(/nests under/);
  });

  it("throws on an output path naming a reserved segment, which would mutate a prototype instead of adding a key", () => {
    const reserved: Hookmap = {
      ...hookmap,
      decisions: { allow: { output: { "__proto__.verdict": { value: "pass" } } } },
    };

    expect(() => renderDecision({ decision: "allow" }, reserved)).toThrow(/addresses no field/);
  });

  it("loads the real claude-code.hookmap.yaml and renders a deny end to end", () => {
    const real = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");

    expect(renderDecision({ decision: "deny", reasoning: "blocked" }, real)).toEqual({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  });
});
