import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { AGT_POINTS, AGT_VERDICTS } from "../src/cells.ts";
import {
  checkInterventionPoints,
  coverageCellsFromInterventionPoints,
} from "../src/intervention-points.ts";

const mapping = loadMapping("mapping.yaml");

describe("the axes come from AGT, not from us", () => {
  it("has eight intervention points, which is AGT's closed set", () => {
    expect(AGT_POINTS).toHaveLength(8);
    expect(AGT_POINTS).toContain("pre_tool_call");
    expect(AGT_POINTS).toContain("post_model_call");
  });

  it("has five AGT verdicts, and none of ACS's own three that differ", () => {
    expect(AGT_VERDICTS).toEqual(["allow", "deny", "escalate", "transform", "warn"]);
    expect(AGT_VERDICTS).not.toContain("modify");
    expect(AGT_VERDICTS).not.toContain("ask");
    expect(AGT_VERDICTS).not.toContain("defer");
  });
});

describe("the intervention-point round trip", () => {
  const results = checkInterventionPoints(mapping);

  it("answers once per point, not once per point per verdict", () => {
    // The question this check asks never reads a verdict, so its product is
    // one answer per point. Returning 40 cells would mean stamping an answer
    // onto four columns it did not measure.
    expect(results).toHaveLength(AGT_POINTS.length);
    expect(results.map((r) => r.point).sort()).toEqual([...AGT_POINTS].sort());
  });

  it("resolves every point that mapping.yaml gives an ACS method", () => {
    const preToolCall = results.find((r) => r.point === "pre_tool_call");

    expect(preToolCall?.status).toBe("resolved");
  });

  it("marks both model-call points unexpressed, carrying mapping.yaml's own stated reason", () => {
    for (const point of ["pre_model_call", "post_model_call"]) {
      const result = results.find((r) => r.point === point);

      expect(result?.status).toBe("unexpressed");
      expect(result?.status === "unexpressed" && result.reason).toBe(
        "no ACS v0.1.0 method carries a model call, so this point is unexpressed at every verdict",
      );
    }
  });

  it("fails the round trip when a row's acs_method resolves back to a different point", () => {
    // Two rows naming one method: resolveInterventionPoint throws rather than
    // picking by YAML key order, and this check records that as unexpressed rather
    // than letting the throw escape and take the whole matrix with it.
    const ambiguous = {
      ...mapping,
      intervention_points: {
        ...mapping.intervention_points,
        output: { acs_method: "steps/toolCallRequest" },
      },
    };
    const broken = checkInterventionPoints(ambiguous).find((r) => r.point === "pre_tool_call");

    expect(broken?.status).toBe("unexpressed");
    expect(broken?.status === "unexpressed" && broken.reason).toMatch(/more than one/);
  });
});

describe("the projection onto matrix coordinates", () => {
  it("emits nothing for a resolved point, because this check answers no verdict column there", () => {
    const cells = coverageCellsFromInterventionPoints(checkInterventionPoints(mapping));

    expect(cells.some((cell) => cell.point === "pre_tool_call")).toBe(false);
  });

  it("emits all five columns for an unexpressed point, because no verdict reaches it either", () => {
    const cells = coverageCellsFromInterventionPoints(checkInterventionPoints(mapping)).filter(
      (cell) => cell.point === "pre_model_call",
    );

    expect(cells).toHaveLength(AGT_VERDICTS.length);
    expect(cells.map((cell) => cell.verdict).sort()).toEqual([...AGT_VERDICTS].sort());
    for (const cell of cells) {
      expect(cell.status).toBe("unexpressed");
      expect(cell.measuredBy).toContain("intervention-point round trip");
    }
  });
});
