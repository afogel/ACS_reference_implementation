import { describe, expect, it } from "bun:test";
import { loadMapping, mapVerdict } from "../src/map-verdict.ts";

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

  // R1.2 — the whole warn round trip rests on this.
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
    expect(mapVerdict({ decision: "transform", reason: "redacted" }, m).decision).toBe("modify");
  });

  it("emits only lowercase decisions (C7)", () => {
    for (const dec of ["allow", "deny", "warn", "escalate", "transform"] as const) {
      const out = mapVerdict({ decision: dec, reason: "r" }, m).decision;
      expect(out.toLowerCase()).toBe(out);
    }
  });

  // Fix wave finding 1 -- previously-deferred coverage gap: this throw path
  // (require_policy_references marked true, but no policy_references could
  // be synthesized) had no test. It's real: a "warn" verdict with no
  // `reason` hits it directly, and it's exactly what the Guardian's
  // evaluation-failure catch (server.test.ts) now has to survive without
  // turning it into an HTML 500 or a silent decision.
  it("throws when require_policy_references is set but verdict.reason is empty (R1.2's load-bearing check)", () => {
    expect(() => mapVerdict({ decision: "warn" }, m)).toThrow(/require_policy_references/);
  });
});
