/**
 * N41. For each of AGT's eight intervention points: does `mapping.yaml` give
 * it an ACS method, and does the runtime resolve that method back to this
 * same point?
 *
 * Both halves matter, and the second is the one worth having. The table could
 * name a method for every point and still be a declaration nobody checked --
 * which is what it was until the PR #10 review found the Guardian hardcoding
 * `pre_tool_call` beside it. So this calls `resolveInterventionPoint`, the
 * runtime's own resolver, rather than reading the table a second way here.
 *
 * A point with no ACS method is `unexpressed` for all five of its verdicts,
 * carrying the reason mapping.yaml's own row states. A resolver THROW is also
 * a resolved cell, not an escaping error: an ambiguous table is a real answer
 * about that point, and letting the throw out would take the whole matrix
 * with it.
 */
import { resolveInterventionPoint, type Mapping } from "guardian";
import { AGT_VERDICTS, everyCell, type CoverageCell } from "./cells.ts";

export function checkInterventionPoints(mapping: Mapping): CoverageCell[] {
  return everyCell().map(({ point, verdict }) => ({
    point,
    verdict,
    ...resolvePoint(point, mapping),
    measuredBy: ["N41"],
  }));
}

function resolvePoint(point: string, mapping: Mapping): { status: CoverageCell["status"]; reason?: string } {
  const row = mapping.intervention_points[point];
  if (row === undefined) {
    return {
      status: "unexpressed",
      reason: `mapping.yaml's intervention_points table has no row for AGT point "${point}"`,
    };
  }
  if (row.acs_method === null) {
    return { status: "unexpressed", reason: row.note ?? "mapping.yaml declares no ACS method for this point" };
  }
  try {
    const resolved = resolveInterventionPoint(row.acs_method, mapping);
    if (resolved !== point) {
      return {
        status: "unexpressed",
        reason: `mapping.yaml maps "${point}" to ${row.acs_method}, which resolves back to "${resolved}"`,
      };
    }
    return { status: "expressed" };
  } catch (error) {
    return { status: "unexpressed", reason: error instanceof Error ? error.message : String(error) };
  }
}
