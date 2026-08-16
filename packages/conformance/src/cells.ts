/**
 * The 8 × 5's axes and its cell, and both come from somewhere the Guardian
 * could not also be wrong about (`slices/v7/README.md`, commitment 5).
 *
 * The rows are AGT's `InterventionPoint` and the columns its `Decision` --
 * the `Readonly` consts the pinned SDK exports, which is what makes
 * commitment 1's enum a fact rather than a list this repository keeps in step
 * by hand. Reading them off `mapping.yaml` instead would have measured the
 * declaration against itself, and hardcoding them here would have measured
 * this file.
 */
import { Decision, InterventionPoint } from "agent-control-specification";

export const AGT_POINTS: readonly string[] = Object.values(InterventionPoint).sort();
export const AGT_VERDICTS: readonly string[] = Object.values(Decision).sort();

/**
 * What a cell resolved to. NOT `green` / `red`: §V7 retracted "green" as a
 * success name, because a matrix that must be green is a matrix under
 * pressure to redefine its claim.
 *
 *   expressed      ACS v0.1.0 expresses AGT here.
 *   guardian_only  the Guardian can do it from process-local knowledge and a
 *                  wire consumer cannot. Three independent findings have
 *                  landed on this one -- the `warn` column (§V3), D10's two
 *                  Trace attributes, and R1.4's identity -- which is itself
 *                  the finding V7 publishes.
 *   unexpressed    it cannot, and `reason` says why.
 *
 * There is no fourth member and no default. `status` is required, so a cell
 * cannot come to read as expressed by having gone unmeasured -- which is the
 * one way a resolved matrix could quietly become a green one.
 */
export type CellStatus = "expressed" | "guardian_only" | "unexpressed";

export type CoverageCell = {
  point: string;
  verdict: string;
  status: CellStatus;
  reason?: string;
  /** Which checks contributed to this cell. A cell no check touched is a
   * defect the runner reports, not a cell that passed. */
  measuredBy: string[];
};

/** Every (point, verdict) pair, in a stable order. The renderers and every
 * check iterate this, so no two of them can disagree about what the matrix's
 * shape is. */
export function everyCell(): { point: string; verdict: string }[] {
  return AGT_POINTS.flatMap((point) => AGT_VERDICTS.map((verdict) => ({ point, verdict })));
}
