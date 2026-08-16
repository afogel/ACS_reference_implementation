import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { AGT_VERDICTS } from "../src/cells.ts";
import { checkVerdicts, invertVerdicts } from "../src/verdicts.ts";

const mapping = loadMapping("mapping.yaml");

describe("the inverse is derived from mapping.yaml, not written beside it", () => {
  it("discriminates warn from allow by the field R1.2 says distinguishes them", () => {
    const inverse = invertVerdicts(mapping);

    expect(inverse.get("allow|false")).toBe("allow");
    expect(inverse.get("allow|true")).toBe("warn");
  });

  it("throws when two AGT verdicts collide on one ACS decision with no discriminator", () => {
    const collided = {
      ...mapping,
      verdicts: { ...mapping.verdicts, escalate: { decision: "deny" as const } },
    };

    expect(() => invertVerdicts(collided)).toThrow(/deny/);
  });

  it("keys a decision by itself when only one AGT verdict reaches it, not by emptiness", () => {
    // deny is the only AGT verdict mapping.yaml sends to ACS "deny": emptiness
    // has nothing to discriminate there, so this must invert regardless of
    // whether a reason-carrying deny left policy_references non-empty.
    const inverse = invertVerdicts(mapping);

    expect(inverse.get("deny")).toBe("deny");
  });
});

describe("N42 -- the verdict round trip", () => {
  const cells = checkVerdicts(mapping);
  const at = (point: string, verdict: string) => cells.find((c) => c.point === point && c.verdict === verdict)!;

  it("round-trips allow, deny, escalate and transform at the request gate", () => {
    for (const verdict of ["allow", "deny", "escalate", "transform"]) {
      expect(at("pre_tool_call", verdict).status).toBe("expressed");
    }
  });

  it("round-trips deny even though a faithful deny synthesizes non-empty policy_references, because deny is the only AGT verdict on ACS deny", () => {
    // A real AGT deny carries a reason (policy/lib/agt_default.rego's
    // pattern_reason, defaulting to "pattern_blocked"), so mapVerdict's
    // field_synthesis -- which reads verdict.reason unconditionally, not only
    // where require_policy_references is declared -- gives the resulting ACS
    // "deny" non-empty policy_references too. That emptiness has no
    // discriminating job to do here, and the round trip must hold regardless
    // of it: this is the regression a per-verdict emptiness key (rather than
    // one scoped to decisions two verdicts share) would fail the moment
    // deny's probe told the truth about what AGT sends.
    expect(at("pre_tool_call", "deny").status).toBe("expressed");
  });

  it("round-trips allow without inventing a reason the pinned bundle's own allow verdict does not send", () => {
    // The pinned bundle's allow verdict is
    // {"decision":"allow","result_labels":["public"]} -- no reason, no
    // message. A probe that gave allow a reason it doesn't send would
    // synthesize policy_references mapVerdict would never actually produce
    // for a real allow, and the round trip would misread it as warn.
    expect(at("pre_tool_call", "allow").status).toBe("expressed");
  });

  it("resolves warn as guardian-only, naming the annotation a wire consumer cannot supply", () => {
    const cell = at("pre_tool_call", "warn");

    expect(cell.status).toBe("guardian_only");
    expect(cell.reason).toMatch(/drift_score/);
  });

  it("marks transform unexpressed at a point whose row declares no modifications rule", () => {
    // agent_startup has an acs_method and no modifications rule, so mapVerdict
    // throws rather than answering with a MODIFY the host has nothing to apply.
    expect(at("agent_startup", "transform").status).toBe("unexpressed");
    expect(at("agent_startup", "transform").reason).toMatch(/declares no modifications rule/);
    // ...and its other four verdicts are unaffected, which is what makes this
    // a per-cell fact rather than a per-point one.
    expect(at("agent_startup", "deny").status).toBe("expressed");
  });

  it("marks every verdict unexpressed at a point ACS v0.1.0 has no wire method for", () => {
    // pre_model_call and post_model_call carry acs_method: null (D4): no ACS
    // method ever resolves to either, so no verdict fired there could reach a
    // wire consumer to round-trip through. mapVerdict does not consult
    // acs_method -- left unguarded, it would answer every non-transform
    // verdict here as if the round trip held, which is the fiction this
    // guard exists to keep N42 from reporting as fact.
    for (const point of ["pre_model_call", "post_model_call"]) {
      for (const verdict of AGT_VERDICTS) {
        expect(at(point, verdict).status).toBe("unexpressed");
        expect(at(point, verdict).reason).toBe("no ACS v0.1.0 target — D4, V7 red cell");
      }
    }
  });
});
