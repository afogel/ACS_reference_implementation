export {
  AGT_POINTS,
  AGT_VERDICTS,
  everyCell,
  type CellStatus,
  type CoverageCell,
  type CoverageMatrix,
  type MappingTable,
} from "./cells.ts";
export { resolveExitCode } from "./exit-code.ts";
export { checkDenyFailsClosed } from "./failure-domains.ts";
export {
  canonicalIdentity,
  checkEnforcedBinding,
  checkInputIdentity,
  coverageCellsFromIdentity,
  measureIdentity,
  type EnforcedBindingCheck,
  type IdentityFinding,
  type InputIdentityCheck,
} from "./identity.ts";
export {
  checkInterventionPoints,
  coverageCellsFromInterventionPoints,
  type PointRoundTrip,
} from "./intervention-points.ts";
export { mergeCells } from "./merge-cells.ts";
export { checkPolicyInputSchema, PINNED_AGT_CLONE_ENV, type SchemaLegResult } from "./policy-input-schema.ts";
export { renderCoverageMatrix, renderMappingTable, renderTraceRows, type RenderOptions } from "./render.ts";
export { checkTracePillar, type TraceRow } from "./trace-pillar.ts";
export { checkVerdicts, invertVerdicts } from "./verdicts.ts";
