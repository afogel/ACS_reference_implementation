/**
 * For each of AGT's eight intervention points: does `mapping.yaml` give it
 * an ACS method, and does the runtime resolve that method back to this same
 * point?
 *
 * Both halves matter, and the second is the one worth having. The table could
 * name a method for every point and still be a declaration nobody checked.
 * So this calls `resolveInterventionPoint`, the runtime's own resolver,
 * rather than reading the table a second way here.
 *
 * A POINT-LEVEL QUESTION, ANSWERED AT POINT LEVEL. This check never reads a
 * verdict, so its product is one `PointRoundTrip` per point, not a cell of
 * the 8 x 5. That distinction is load-bearing rather than tidy: stamping a
 * resolved point `expressed` across all five of its columns would assert
 * something about `warn` and `transform` that this question does not ask,
 * and the published grid would only be honest because `mergeCells` later
 * hides those stamps behind a worse status from a check that did ask. Read
 * alone, the stamps were a measurement lie. Whether a verdict survives the
 * round trip at a resolved point is `checkVerdicts`'s answer, and it covers
 * all 40 coordinates.
 *
 * `coverageCellsFromInterventionPoints` therefore emits cells only where
 * this question does resolve the whole column set: a point with no usable
 * ACS method is `unexpressed` for all five verdicts, because no wire message
 * reaches it at all, whichever verdict AGT would have returned. A resolver
 * THROW is such an answer too, not an escaping error: an ambiguous table is
 * a real answer about that point, and letting the throw out would take the
 * whole matrix with it.
 */
import { resolveInterventionPoint, type Mapping } from "guardian";
import { AGT_POINTS, AGT_VERDICTS, type CoverageCell } from "./cells.ts";

/**
 * One point's answer. `resolved` carries no reason: the round trip held, and
 * there is nothing about it a matrix cell could state that `checkVerdicts`
 * does not measure per verdict.
 */
export type PointRoundTrip =
  | { point: string; status: "resolved" }
  | { point: string; status: "unexpressed"; reason: string };

export function checkInterventionPoints(mapping: Mapping): PointRoundTrip[] {
  return AGT_POINTS.map((point) => resolvePoint(point, mapping));
}

/**
 * The stage that turns point-level answers into matrix cells -- named for
 * being a projection rather than a second measurement.
 *
 * Only `unexpressed` points produce cells, and each produces all five. A
 * `resolved` point produces none: this check has nothing to say about any
 * individual column there.
 */
export function coverageCellsFromInterventionPoints(results: PointRoundTrip[]): CoverageCell[] {
  return results.flatMap((result) =>
    result.status === "resolved"
      ? []
      : AGT_VERDICTS.map((verdict) => ({
          point: result.point,
          verdict,
          status: "unexpressed" as const,
          reason: result.reason,
          measuredBy: ["intervention-point round trip"],
        })),
  );
}

function resolvePoint(point: string, mapping: Mapping): PointRoundTrip {
  const row = mapping.intervention_points[point];
  if (row === undefined) {
    return {
      point,
      status: "unexpressed",
      reason: `mapping.yaml's intervention_points table has no row for AGT point "${point}"`,
    };
  }
  if (row.acs_method === null) {
    return {
      point,
      status: "unexpressed",
      reason: row.note ?? "mapping.yaml declares no ACS method for this point",
    };
  }
  try {
    const resolved = resolveInterventionPoint(row.acs_method, mapping);
    if (resolved !== point) {
      return {
        point,
        status: "unexpressed",
        reason: `mapping.yaml maps "${point}" to ${row.acs_method}, which resolves back to "${resolved}"`,
      };
    }
    return { point, status: "resolved" };
  } catch (error) {
    return { point, status: "unexpressed", reason: error instanceof Error ? error.message : String(error) };
  }
}
