import { describe, expect, it } from "bun:test";
import { everyCell } from "../src/cells.ts";
import { mergeCells } from "../src/merge-cells.ts";
import { resolveExitCode } from "../src/exit-code.ts";
import { checkVerdicts } from "../src/verdicts.ts";
import { loadMapping } from "guardian";

describe("resolveExitCode -- an unexpressed cell is resolved, a hole is not", () => {
  it("is 0 for the real mapping.yaml's own verdict cells alone -- every coordinate is resolved, never a hole", () => {
    // The verdict round trip is the one check that answers at every one of
    // the 40 coordinates, so merged alone it already leaves none untouched.
    // That is the real, structural reason `bun run conformance` exits 0
    // today, rather than an assumption this test takes on faith.
    const mapping = loadMapping("mapping.yaml");
    const cells = mergeCells(checkVerdicts(mapping));

    expect(resolveExitCode(cells)).toBe(0);
  });

  it("is 0 for a fully-covered matrix where one cell is unexpressed for a REAL, checked reason", () => {
    // Every one of the 40 coordinates gets a real contribution -- all but one
    // "expressed", the last one a genuine, checked "unexpressed" -- so the
    // only way this could read non-zero is resolveExitCode treating a real
    // finding the same as a hole, which is exactly the confusion this rule
    // exists to keep apart.
    const contributions = everyCell().map(({ point, verdict }) =>
      point === "pre_model_call" && verdict === "deny"
        ? {
            point,
            verdict,
            status: "unexpressed" as const,
            reason: "mapping.yaml declares no ACS method for this point",
            measuredBy: ["intervention-point round trip"],
          }
        : { point, verdict, status: "expressed" as const, measuredBy: ["verdict round trip"] },
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
    // The (input, allow) coordinate's own verdict cell is stripped out of the
    // contribution array before merging -- so mergeCells sees zero
    // contributions there (its own hole branch) while every other of the 39
    // coordinates still merges from a real, resolved cell.
    const mapping = loadMapping("mapping.yaml");
    const verdictCells = checkVerdicts(mapping).filter(
      (cell) => !(cell.point === "input" && cell.verdict === "allow"),
    );
    const cells = mergeCells(verdictCells);

    expect(resolveExitCode(cells)).not.toBe(0);
  });
});
