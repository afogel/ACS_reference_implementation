/**
 * N40's exit-status rule, split out from main.ts so it is independently
 * testable without spinning up a Guardian or driving the real bridge:
 * `mergeCells()`'s own hole-filling behaviour is enough to produce the case
 * this function exists to catch.
 *
 * THE RULE (facts file, "The exit-status rule, restated"): exit 0 for a
 * fully RESOLVED matrix -- a red cell (`unexpressed`, with a real, checked
 * reason) is a resolved cell, not a failure, which is §V7's whole point: an
 * exit code that treated red as failure would put the matrix under exactly
 * the pressure to be green that §V7 retracted "green" to remove (`cells.ts`'s
 * own `CellStatus` doc). Exit non-zero ONLY when a cell is `unexpressed` with
 * the exact reason `mergeCoordinate` (merge-cells.ts) writes when no check
 * contributed anything at that coordinate at all -- a hole in the matrix, not
 * a red answer inside it.
 *
 * Matched on `status === "unexpressed"` AND the exact reason string together,
 * never on `status` alone: a real, checked `unexpressed` cell -- D4's two
 * points, N42's mapped-but-unmappable rows, N43's `unattributable` -- carries
 * its own true reason and must never fail the run merely for being red.
 */
import type { CoverageCell } from "./cells.ts";

/** merge-cells.ts's own literal, for the one coordinate no check touched. */
const HOLE_REASON = "no check measured this cell";

export function resolveExitCode(cells: CoverageCell[]): number {
  const hasHole = cells.some((cell) => cell.status === "unexpressed" && cell.reason === HOLE_REASON);
  return hasHole ? 1 : 0;
}
