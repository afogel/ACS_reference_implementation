import { describe, expect, it } from "bun:test";
import { loadMapping, mapVerdict, resolveInterventionPoint, type Mapping } from "../src/map-verdict.ts";

const m = loadMapping("mapping.yaml");

describe("mapVerdict", () => {
  it("maps allow to allow", () => {
    expect(mapVerdict({ decision: "allow" }, m).decision).toBe("allow");
  });

  it("maps deny, carrying reason and message into ACS fields", () => {
    const d = mapVerdict(
      { decision: "deny", reason: "destructive_shell_command_blocked", message: "matched pattern X" },
      m,
    );
    expect(d.decision).toBe("deny");
    expect(d.reasoning).toBe("matched pattern X");
    expect(d.reason_codes).toEqual(["destructive_shell_command_blocked"]);
    expect(d.policy_references?.[0]?.rule_id).toBe("destructive_shell_command_blocked");
  });

  // The whole warn round trip rests on this.
  it("maps warn to allow WITH non-empty policy_references", () => {
    const d = mapVerdict({ decision: "warn", reason: "drift_detected", message: "drift 0.8" }, m);
    expect(d.decision).toBe("allow");
    expect(d.policy_references?.length).toBeGreaterThan(0);
    expect(d.policy_references?.[0]?.rule_id).toBe("drift_detected");
  });

  it("distinguishes warn-allow from clean allow by policy_references", () => {
    expect(mapVerdict({ decision: "allow" }, m).policy_references ?? []).toHaveLength(0);
  });

  it("maps escalate to ask and transform to modify", () => {
    expect(mapVerdict({ decision: "escalate", reason: "approval_required" }, m).decision).toBe("ask");
    expect(
      mapVerdict(
        { decision: "transform", reason: "redacted", transform: { path: "$policy_target", value: "x" } },
        m,
      ).decision,
    ).toBe("modify");
  });

  it("emits only lowercase decisions", () => {
    for (const dec of ["allow", "deny", "warn", "escalate", "transform"] as const) {
      // transform maps to a MODIFY, which requires a transform object -- this
      // loop's own point is decision casing, not that shape, so it supplies
      // one for the one decision that needs it.
      const verdict =
        dec === "transform"
          ? { decision: dec, reason: "r", transform: { path: "$policy_target", value: "x" } }
          : { decision: dec, reason: "r" };
      const out = mapVerdict(verdict, m).decision;
      expect(out.toLowerCase()).toBe(out);
    }
  });

  // This throw path (require_policy_references marked true, but no
  // policy_references could be synthesized) is real: a "warn" verdict with
  // no `reason` hits it directly, and it's exactly what the Guardian's
  // evaluation-failure catch (server.test.ts) has to survive without turning
  // it into an HTML 500 or a silent decision.
  it("throws when require_policy_references is set but verdict.reason is empty", () => {
    expect(() => mapVerdict({ decision: "warn" }, m)).toThrow(/require_policy_references/);
  });

  // Confirms mapVerdict reads `field_synthesis.reason_codes.wrap` from the
  // mapping declaration rather than assuming array-wrapping, so an edit to
  // the table changes behaviour.
  describe("field_synthesis.reason_codes.wrap is read, not assumed", () => {
    it("wraps per the declared mode, on the shipped mapping", () => {
      expect(mapVerdict({ decision: "deny", reason: "r" }, m).reason_codes).toEqual(["r"]);
    });

    it("throws for a wrap mode this mapping cannot express, rather than array-wrapping anyway", () => {
      // loadMapping casts the parsed YAML and validates nothing, so a mapping
      // declaring an unknown mode type-checks and reaches mapVerdict. Silently
      // array-wrapping it would synthesize a reason_codes the mapping never
      // asked for and hand it to a host as a decision's machine-readable half.
      const unknownMode = {
        ...m,
        field_synthesis: { ...m.field_synthesis, reason_codes: { source: "verdict.reason", wrap: "csv" } },
      } as unknown as Mapping;

      expect(() => mapVerdict({ decision: "deny", reason: "r" }, unknownMode)).toThrow(
        /field_synthesis\.reason_codes\.wrap as "csv"/,
      );
    });
  });
});

// These tests read the real mapping.yaml's intervention_points table, so a
// row edited there without a matching runtime change fails somewhere rather
// than nowhere.
describe("resolveInterventionPoint", () => {
  it("answers the ACS method the shipped mapping wires, from the table rather than a literal", () => {
    expect(resolveInterventionPoint("steps/toolCallRequest", m)).toBe("pre_tool_call");
    expect(resolveInterventionPoint("steps/agentResponse", m)).toBe("output");
  });

  it("throws for a method no row names, rather than defaulting to a point", () => {
    // The fail-open this function is shaped against: any default here would
    // evaluate one intervention point's policy for a different method's
    // snapshot and call the result a decision.
    expect(() => resolveInterventionPoint("steps/userMessage", { ...m, intervention_points: {} })).toThrow(
      /maps no AGT intervention point/,
    );
  });

  it("throws when two rows name the same ACS method, rather than letting YAML key order pick", () => {
    const ambiguous = {
      ...m,
      intervention_points: {
        pre_tool_call: { acs_method: "steps/toolCallRequest" },
        pre_model_call: { acs_method: "steps/toolCallRequest" },
      },
    };

    expect(() => resolveInterventionPoint("steps/toolCallRequest", ambiguous)).toThrow(/more than one/);
  });

  it("resolves every other declared ACS method from the same table", () => {
    // One row resolving is not evidence the table is being read -- a literal
    // would satisfy that. These are the rest of the rows mapping.yaml ships.
    expect(resolveInterventionPoint("steps/toolCallResult", m)).toBe("post_tool_call");
    expect(resolveInterventionPoint("steps/sessionStart", m)).toBe("agent_startup");
    expect(resolveInterventionPoint("steps/agentResponse", m)).toBe("output");
  });

  it("never resolves to a row whose acs_method is null", () => {
    // mapping.yaml really does ship two of these: the model-call points have
    // no ACS v0.1.0 target. A resolver comparing loosely would match a
    // null row and evaluate the wrong intervention point's policy.
    const allNull = {
      ...m,
      intervention_points: {
        pre_model_call: { acs_method: null },
        post_model_call: { acs_method: null },
      },
    } as unknown as Mapping;

    expect(() => resolveInterventionPoint("steps/toolCallRequest", allNull)).toThrow(
      /maps no AGT intervention point/,
    );
  });

  it("throws when the mapping declares no intervention_points table at all", () => {
    // loadMapping's `as Mapping` is unchecked, so a mapping.yaml edited to
    // drop the table type-checks and reaches here. Standing in for that.
    const tableless = { ...m, intervention_points: undefined } as unknown as Mapping;

    expect(() => resolveInterventionPoint("steps/toolCallRequest", tableless)).toThrow(
      /no intervention_points table/,
    );
  });
});

describe("mapVerdict — transform becomes a MODIFY that carries modifications", () => {
  it("synthesizes parameter_overrides from the transform's $policy_target value", () => {
    const decision = mapVerdict(
      {
        decision: "transform",
        reason: "redaction_applied",
        transform: { path: "$policy_target", value: "echo [REDACTED]" },
      },
      m,
    );
    expect(decision.decision).toBe("modify");
    expect(decision.modifications).toEqual({ parameter_overrides: { command: "echo [REDACTED]" } });
  });

  it("keeps the synthesized reason_codes and policy_references a MODIFY still needs", () => {
    const decision = mapVerdict(
      { decision: "transform", reason: "redaction_applied", transform: { path: "$policy_target", value: "x" } },
      m,
    );
    expect(decision.reason_codes).toEqual(["redaction_applied"]);
    expect(decision.policy_references).toEqual([{ policy_id: "agt_stock", rule_id: "redaction_applied" }]);
  });

  // A MODIFY with no modifications is invalid per §6, and silently emitting
  // one would make the host apply nothing while reporting a rewrite. Fail loudly.
  it("throws when a transform verdict carries no transform object", () => {
    expect(() => mapVerdict({ decision: "transform", reason: "redaction_applied" }, m)).toThrow(
      /transform/,
    );
  });

  it("throws when the transform names a path this mapping cannot express", () => {
    expect(() =>
      mapVerdict(
        { decision: "transform", reason: "x", transform: { path: "$.some.other.leaf", value: "y" } },
        m,
      ),
    ).toThrow(/\$policy_target/);
  });

  it("leaves every other verdict's shape untouched", () => {
    expect(mapVerdict({ decision: "allow" }, m).modifications).toBeUndefined();
    expect(mapVerdict({ decision: "deny", reason: "r", message: "m" }, m).modifications).toBeUndefined();
    // `escalate -> ask` is asserted above, in the test whose subject that is;
    // this line is about the same thing as its two neighbours -- that only a
    // `modify` grows a `modifications` object.
    expect(mapVerdict({ decision: "escalate", reason: "approval_required", message: "m" }, m).modifications)
      .toBeUndefined();
  });

  // Simulates a mapping.yaml edit that declares an `into` this mapping
  // cannot express -- something loadMapping's unchecked `as Mapping` would
  // let through unnoticed. The cast here stands in for that malformed YAML,
  // proving the runtime rejects it loudly instead of silently misbuilding or
  // disagreeing with the declaration.
  it("throws when mapping.yaml declares an into this mapping cannot express", () => {
    const withUnsupportedInto = {
      ...m,
      field_synthesis: {
        ...m.field_synthesis,
        modifications: { ...m.field_synthesis.modifications, into: "redactions" },
      },
    } as unknown as Mapping;
    expect(() =>
      mapVerdict(
        { decision: "transform", reason: "x", transform: { path: "$policy_target", value: "y" } },
        withUnsupportedInto,
      ),
    ).toThrow(/redactions/);
  });
});
