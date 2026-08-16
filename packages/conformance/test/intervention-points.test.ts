import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { AGT_POINTS, AGT_VERDICTS } from "../src/cells.ts";
import { checkInterventionPoints } from "../src/intervention-points.ts";

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

describe("N41 -- the intervention-point round trip", () => {
  const cells = checkInterventionPoints(mapping);

  it("produces one cell per point per verdict, and no others", () => {
    expect(cells).toHaveLength(AGT_POINTS.length * AGT_VERDICTS.length);
  });

  it("round-trips every point that mapping.yaml gives an ACS method", () => {
    const expressed = cells.filter((c) => c.point === "pre_tool_call");

    expect(expressed).toHaveLength(5);
    for (const cell of expressed) {
      expect(cell.status).toBe("expressed");
      expect(cell.measuredBy).toContain("N41");
    }
  });

  it("marks both model-call points unexpressed, carrying mapping.yaml's own stated reason", () => {
    for (const point of ["pre_model_call", "post_model_call"]) {
      const cells_ = cells.filter((c) => c.point === point);
      expect(cells_).toHaveLength(5);
      for (const cell of cells_) {
        expect(cell.status).toBe("unexpressed");
        expect(cell.reason).toBe("no ACS v0.1.0 target — D4, V7 red cell");
      }
    }
  });

  it("fails the round trip when a row's acs_method resolves back to a different point", () => {
    // Two rows naming one method: resolveInterventionPoint throws rather than
    // picking by YAML key order, and N41 records that as unexpressed rather
    // than letting the throw escape and take the whole matrix with it.
    const ambiguous = {
      ...mapping,
      intervention_points: {
        ...mapping.intervention_points,
        output: { acs_method: "steps/toolCallRequest" },
      },
    };
    const broken = checkInterventionPoints(ambiguous).filter((c) => c.point === "pre_tool_call");

    for (const cell of broken) {
      expect(cell.status).toBe("unexpressed");
      expect(cell.reason).toMatch(/more than one/);
    }
  });
});
