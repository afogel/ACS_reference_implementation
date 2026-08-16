export { AGT_POINTS, AGT_VERDICTS, everyCell, type CellStatus, type CoverageCell } from "./cells.ts";
export { checkFailureDomains } from "./failure-domains.ts";
export { canonicalIdentity, checkEnforcedIdentity, identityCells, type IdentityFinding } from "./identity.ts";
export { checkInterventionPoints } from "./intervention-points.ts";
export { mergeCells } from "./merge-cells.ts";
export { renderCoverageMatrix, renderMappingTable, renderTraceRows, type RenderOptions } from "./render.ts";
export { checkTracePillar, type TraceRow } from "./trace-pillar.ts";
export { checkVerdicts, invertVerdicts } from "./verdicts.ts";
