/**
 * The conformance runner's exit-status rule, split out from main.ts so it is
 * independently testable without spinning up a Guardian or driving the real
 * bridge: `mergeCells()`'s own hole-filling behaviour is enough to produce
 * the case this function exists to catch.
 *
 * THE RULE: exit 0 for a fully resolved matrix -- an `unexpressed` cell,
 * carrying a real, checked reason, is a resolved cell rather than a failure.
 * An exit code that treated it as one would put the matrix under exactly the
 * pressure to be all-expressed that `cells.ts`'s own `CellStatus` doc
 * explains why this project refuses. Exit non-zero only when a cell is
 * `unexpressed` with the exact reason `mergeCoordinate` (merge-cells.ts)
 * writes when no check contributed anything at that coordinate at all -- a
 * hole in the matrix, not an answer inside it.
 *
 * Matched on `status === "unexpressed"` and the exact reason string together,
 * never on `status` alone: a real, checked `unexpressed` cell -- the two
 * model-call points with no ACS v0.1.0 target, a mapped-but-unmappable
 * verdict row, an identity finding that could not be attributed -- carries
 * its own true reason and must never fail the run merely for reporting a
 * gap the specification really has.
 *
 * `red` and `green` are deliberately absent from this file's vocabulary.
 * `CellStatus` retired them, and an exit rule that still spoke them would
 * teach the axis the statuses replaced.
 */
import type { CoverageMatrix } from "./cells.ts";

/** merge-cells.ts's own literal, for the one coordinate no check touched. */
const HOLE_REASON = "no check measured this cell";

export function resolveExitCode(cells: CoverageMatrix): number {
  const hasHole = cells.some((cell) => cell.status === "unexpressed" && cell.reason === HOLE_REASON);
  return hasHole ? 1 : 0;
}
