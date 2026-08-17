import { describe, expect, it } from "bun:test";
import { everyCell } from "../src/cells.ts";
import { mergeCells } from "../src/merge-cells.ts";
import { resolveExitCode } from "../src/exit-code.ts";
import { checkInterventionPoints } from "../src/intervention-points.ts";
import { loadMapping } from "guardian";

describe("resolveExitCode -- a red cell is resolved, a hole is not", () => {
  it("is 0 for the real mapping.yaml's own intervention-point cells alone -- every coordinate is resolved (red or not), never a hole", () => {
    // checkInterventionPoints always returns exactly 40 cells (one per
    // everyCell() coordinate, see intervention-points.ts's own function) --
    // merged alone, that already leaves no coordinate untouched, so this is
    // the real, structural reason `bun run conformance` always exits 0 today
    // and not an assumption this test takes on faith.
    const mapping = loadMapping("mapping.yaml");
    const cells = mergeCells(checkInterventionPoints(mapping));

    expect(resolveExitCode(cells)).toBe(0);
  });

  it("is 0 for a fully-covered matrix where one cell is unexpressed for a REAL, checked reason -- red is resolved, not a failure", () => {
    // Every one of the 40 coordinates gets a real contribution -- all but one
    // "expressed", the last one a genuine, checked "unexpressed" -- so the
    // only way this could read non-zero is resolveExitCode treating a real
    // red the same as a hole, which is exactly the confusion this rule
    // exists to keep apart.
    const contributions = everyCell().map(({ point, verdict }) =>
      point === "pre_model_call" && verdict === "deny"
        ? { point, verdict, status: "unexpressed" as const, reason: "mapping.yaml declares no ACS method for this point", measuredBy: ["N41"] }
        : { point, verdict, status: "expressed" as const, measuredBy: ["N41"] },
    );
    const cells = mergeCells(contributions);

    expect(resolveExitCode(cells)).toBe(0);
  });

  it("is non-zero when mergeCells is handed no contributions at all -- every one of the 40 coordinates is a hole", () => {
    // mergeCells() with zero arguments is the real function this coordinate
    // shape comes from (merge-cells.ts's own contributions.length === 0
    // branch), not a hand-typed stand-in for it.
    const cells = mergeCells();

    expect(resolveExitCode(cells)).not.toBe(0);
  });

  it("is non-zero when even one of the 40 coordinates has no contribution, the rest fully resolved", () => {
    // The (input, allow) coordinate's own intervention-point cell is
    // stripped out of the contribution array before merging -- so
    // mergeCells sees zero contributions there (its own hole branch) while
    // every other of the 39 coordinates still merges from a real, resolved
    // intervention-point cell.
    const mapping = loadMapping("mapping.yaml");
    const n41 = checkInterventionPoints(mapping).filter(
      (cell) => !(cell.point === "input" && cell.verdict === "allow"),
    );
    const cells = mergeCells(n41);

    expect(resolveExitCode(cells)).not.toBe(0);
  });
});
