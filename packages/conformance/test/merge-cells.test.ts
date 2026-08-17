import { describe, expect, it } from "bun:test";
import { mergeCells } from "../src/merge-cells.ts";
import { AGT_POINTS, AGT_VERDICTS } from "../src/cells.ts";

const cell = (point: string, verdict: string, status: "expressed" | "guardian_only" | "unexpressed", by: string, reason?: string) =>
  ({ point, verdict, status, measuredBy: [by], ...(reason ? { reason } : {}) }) as const;

describe("mergeCells -- the worst status wins and every check is named", () => {
  it("lets unexpressed beat guardian_only, and guardian_only beat expressed", () => {
    const merged = mergeCells(
      [cell("pre_tool_call", "warn", "expressed", "N41")],
      [cell("pre_tool_call", "warn", "guardian_only", "N42", "no wire source")],
    );
    const at = merged.find((c) => c.point === "pre_tool_call" && c.verdict === "warn")!;

    expect(at.status).toBe("guardian_only");
    expect(at.measuredBy).toEqual(["N41", "N42"]);
    expect(at.reason).toBe("no wire source");
  });

  it("carries both reasons when two checks land on the same status", () => {
    const merged = mergeCells(
      [cell("input", "transform", "unexpressed", "N41", "first")],
      [cell("input", "transform", "unexpressed", "N42", "second")],
    );

    expect(merged.find((c) => c.point === "input" && c.verdict === "transform")!.reason).toBe("first; second");
  });

  it("reports a cell no check measured as unexpressed, never as expressed by default", () => {
    const merged = mergeCells([]);

    expect(merged).toHaveLength(AGT_POINTS.length * AGT_VERDICTS.length);
    for (const c of merged) {
      expect(c.status).toBe("unexpressed");
      expect(c.reason).toBe("no check measured this cell");
      expect(c.measuredBy).toEqual([]);
    }
  });

  // The intervention-point check and the verdict check both read the same
  // mapping.yaml note back for pre_model_call/post_model_call (both fall
  // back to `row.note` on a null acs_method), so two checks landing on this
  // coordinate carry byte-identical text, not two accounts. Joining it
  // against itself would publish "X; X" -- this is the real shape,
  // reproduced directly rather than invented.
  it("dedupes identical reasons rather than joining one check's account against itself", () => {
    const merged = mergeCells(
      [cell("pre_model_call", "deny", "unexpressed", "N41", "no ACS v0.1.0 target — D4, V7 red cell")],
      [cell("pre_model_call", "deny", "unexpressed", "N42", "no ACS v0.1.0 target — D4, V7 red cell")],
    );
    const at = merged.find((c) => c.point === "pre_model_call" && c.verdict === "deny")!;

    expect(at.reason).toBe("no ACS v0.1.0 target — D4, V7 red cell");
    // Both checks are still named, even though only one copy of their
    // (identical) reason survives.
    expect(at.measuredBy).toEqual(["N41", "N42"]);
  });

  it("still joins two DIFFERENT reasons on the same status -- dedup is not merging every reason into one", () => {
    const merged = mergeCells(
      [cell("output", "escalate", "unexpressed", "N41", "first account")],
      [cell("output", "escalate", "unexpressed", "N42", "second account")],
    );

    expect(merged.find((c) => c.point === "output" && c.verdict === "escalate")!.reason).toBe(
      "first account; second account",
    );
  });
});
