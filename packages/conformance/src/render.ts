/**
 * Three renderers, one per measurement, and none of them takes a
 * discriminator saying which kind of table it is being asked for
 * (`slices/v7/README.md`, commitment 3).
 *
 *   renderMappingTable   (N48 -> U32)  S10's declaration
 *   renderCoverageMatrix (N47 -> U30)  the 8 × 5 N41-N44 measure
 *   renderTraceRows      (N52 -> U33)  N49's attribute-against-wire-source rows
 *
 * A coverage cell is an intervention point against an AGT verdict; a trace
 * row is a required OTel attribute against its wire source; they share a verb
 * and nothing else. Detail C once wired a single `renderMatrix()` to all
 * three, which is the name that would have let the second and third arrive as
 * columns of the first -- and a coverage claim rendered by the same function
 * as everything beside it is a coverage claim whose subject is whatever was
 * rendered. `renderUpstreamDiff` is not here and is not V7's: its only input
 * is V8's `diffSurfaces()`.
 *
 * EVERY FUNCTION HERE IS PURE. Each is handed its measurement and renders
 * that one; none reads a file, a clock or a store. V6's own review found a
 * renderer that had quietly become a write, under a header claiming exactly
 * this -- so the property is asserted, not only stated: each renderer's test
 * renders the same input twice and expects the same string.
 */
import type { Mapping } from "guardian";

/** One row of `Mapping["intervention_points"]` -- read off the type rather
 * than redeclared, so this file cannot drift from what `guardian` actually
 * exports for that table's shape. Same for `VerdictRule` below. */
type IntervRow = Mapping["intervention_points"][string];
type VerdictRule = Mapping["verdicts"][string];

function renderPointRow(point: string, row: IntervRow): string {
  // A point with no ACS method gets its own row's stated reason -- never a
  // blank column, and never a reason invented here that mapping.yaml did not
  // declare. The fallback string only exists to keep this total against a
  // row that lacks `note` too; mapping.yaml's real two null rows both carry
  // one (checked below, and by N41's own identical fallback).
  const target = row.acs_method ?? `(${row.note ?? "mapping.yaml declares no ACS method for this point"})`;
  // 15, not 14: `post_model_call` (the longest point name) is 15 characters,
  // and padEnd(14) left its arrow one column right of the other seven rows
  // (review round 1, Minor 4) -- padEnd only pads up to its own argument, so
  // a length shorter than the longest real value under-aligns silently.
  return `  ${point.padEnd(15)} -> ${target}`;
}

function renderVerdictRow(verdict: string, rule: VerdictRule): string {
  // R1.2: a non-empty `policy_references` is the only field that tells
  // `warn` apart from a clean `allow` on the wire, so a rendering of this row
  // that dropped `require_policy_references` would render `warn` and `allow`
  // identically -- the exact ambiguity R1.2 exists to name.
  const qualifier = rule.require_policy_references === true ? " (non-empty policy_references required)" : "";
  return `  ${verdict.padEnd(9)} -> ${rule.decision}${qualifier}`;
}

/**
 * N48. Renders mapping.yaml's own two declaration tables --
 * `intervention_points` (AGT point -> ACS v0.1.0 method) and `verdicts` (AGT
 * verdict -> ACS decision) -- as U32's MappingTable. This is S10's
 * declaration, not a measurement of it: `renderCoverageMatrix` (N47) is what
 * V7 measures against the runtime, and the two are never the same string
 * (commitment 2).
 *
 * A pure function of the `mapping` argument alone: it never reads
 * mapping.yaml itself (only the object a caller already loaded from it), so
 * calling it twice on the same value renders the same string -- this file's
 * own PURE guarantee, asserted by render-mapping-table.test.ts rather than
 * only stated here.
 *
 * `field_synthesis` is deliberately not a third table here: it is the
 * synthesis rule for fields of one already-resolved decision (`reasoning`,
 * `reason_codes`, `policy_references`), not a second declared axis of "which
 * AGT thing maps to which ACS thing" the way `intervention_points` and
 * `verdicts` are.
 */
export function renderMappingTable(mapping: Mapping): string {
  const points = Object.entries(mapping.intervention_points)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([point, row]) => renderPointRow(point, row));

  const verdicts = Object.entries(mapping.verdicts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([verdict, rule]) => renderVerdictRow(verdict, rule));

  return [
    "AGT intervention point -> ACS v0.1.0 method (mapping.yaml: intervention_points)",
    ...points,
    "",
    "AGT verdict -> ACS decision (mapping.yaml: verdicts)",
    ...verdicts,
  ].join("\n");
}
