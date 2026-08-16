/**
 * N40 -- the runner. Publishes the TWO artifacts C5 names
 * (`docs/shaping/acs-reference-impl-shaping.md`, the Parts table: "Published
 * artifact = mapping table + coverage matrix") -- U32's mapping table and
 * U30's coverage matrix -- and beside them a third table that is not C5's:
 * U33's trace rows, which N49 measures and N52 renders. The count is worth
 * getting right here, because C5 named a third thing once already and the
 * PR #16 review removed it: the note under that table says C5 "names the two
 * published artifacts, so it uses the two published names".
 *
 * This is a RUNNER, not a test: its job is to drive every check Tasks 3-8
 * built, merge their answers, render all three tables, and say plainly which
 * legs actually measured them -- not to assert anything about the result
 * itself. `bun run conformance`
 * (scripts/run-conformance.sh) is the one caller that runs it for real;
 * `test/main.test.ts` is the other, in-process, with the one leg that needs
 * the network (below) left to self-skip.
 *
 * FOUR CHECKS MERGED, AND A FIFTH BESIDE THEM: `checkInterventionPoints`
 * (N41), `checkVerdicts` (N42), `checkEnforcedIdentity` (N43, driven at BOTH
 * transform-capable gates and merged -- N43 measures `pre_tool_call` as well
 * as `post_tool_call` because the two were found not to diverge, and a runner
 * calling it for one would narrow a measurement that was widened on purpose;
 * see identity.ts's own header), and `checkFailureDomains`
 * (N44), fed to `mergeCells` -- never concatenated, which is exactly the
 * misuse `renderCoverageMatrix`'s own duplicate-coordinate throw exists to
 * catch (render.ts's own header). `checkTracePillar` (N49) is separate: its
 * `TraceRow[]` has no (point, verdict) coordinate to merge into the matrix
 * at all, and is rendered on its own as U33.
 *
 * THE SCHEMA LEG (N41's second half)
 * is orthogonal to the matrix: it asks whether the policy input the
 * Guardian actually constructs at `pre_tool_call` / `post_tool_call`
 * validates against AGT's own `policy-input.schema.json`, which has no
 * verdict axis to place a cell at (the same document regardless of which
 * verdict AGT eventually returns for it). It self-skips without
 * `UPSTREAM_AGT_CLONE`, and the runner names -- on the output's own face --
 * whether it ran, so a matrix published without it cannot be mistaken for
 * one that includes it.
 *
 * A GUARDIAN, STARTED AND CLOSED HERE, for N44 alone (the only check that
 * drives one over HTTP rather than in-process) -- `port: 0` so this runner
 * never collides with a Guardian someone already has listening on the
 * runbook's default port, closed in a `finally` so a check that throws
 * (several of these do, deliberately, on a broken invariant -- see e.g.
 * failure-domains.ts's own header) never leaks the listener.
 */
import { createBridge } from "agt-bridge";
import { loadMapping, startGuardian } from "guardian";
import type { InterventionSnapshot } from "agt-bridge";
import type { CoverageCell } from "./cells.ts";
import { checkInterventionPoints } from "./intervention-points.ts";
import { checkVerdicts } from "./verdicts.ts";
import { checkEnforcedIdentity, identityCells } from "./identity.ts";
import { checkFailureDomains } from "./failure-domains.ts";
import { checkTracePillar } from "./trace-pillar.ts";
import { mergeCells } from "./merge-cells.ts";
import { renderCoverageMatrix, renderMappingTable, renderTraceRows } from "./render.ts";
import { checkPolicyInputSchema } from "./policy-input-schema.ts";
import { resolveExitCode } from "./exit-code.ts";

const MANIFEST_PATH = "policy/manifest.yaml";
const MAPPING_PATH = "mapping.yaml";

/** The same REDACTABLE / REDACTABLE_COMMAND shapes `test/identity.test.ts`
 * drives -- a real transform at both transform-capable gates, so this
 * runner's own N43 cells report the measured `guardian_only` finding
 * (R1.4), not the no-rewrite case a benign fixture would report instead. */
const PRE_TOOL_CALL_SNAPSHOT: InterventionSnapshot = {
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "Bash", args: { command: "echo ghp_ONLYINCOMMAND999" }, id: "t1" },
  input: { ifc: { source_labels: ["public"] } },
};
const POST_TOOL_CALL_SNAPSHOT: InterventionSnapshot = {
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "Bash" },
  tool_result: { outputs: [{ value: "TOKEN=ghp_ONLYINOUTPUT999\n" }] },
  input: { ifc: { source_labels: ["public"] } },
};

export type ConformanceRun = {
  /** Everything this runner publishes, as one string -- the three tables plus
   * the legs report, in the order printed. This is the text R5.3's declaration
   * and `docs/demos/v7-runbook.md` are written from, which is why the legs
   * report is part of it rather than a log line: a reader of the runbook must
   * be able to see which legs measured the tables above without running
   * anything. */
  output: string;
  /** The merged matrix `renderCoverageMatrix` rendered `output`'s coverage
   * section from -- exposed alongside the text so a caller (this file's own
   * test) can assert its shape precisely instead of pattern-matching text. */
  cells: CoverageCell[];
  /** 0 for a fully resolved matrix, non-zero for a hole (exit-code.ts's own
   * `resolveExitCode` -- see that file for the rule this reads). */
  exitCode: number;
};

export async function main(): Promise<ConformanceRun> {
  const mapping = loadMapping(MAPPING_PATH);
  const bridge = createBridge(MANIFEST_PATH);
  const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST_PATH });

  try {
    const n41 = checkInterventionPoints(mapping);
    const n42 = checkVerdicts(mapping);
    const [preFinding, postFinding] = await Promise.all([
      checkEnforcedIdentity(bridge, "pre_tool_call", PRE_TOOL_CALL_SNAPSHOT),
      checkEnforcedIdentity(bridge, "post_tool_call", POST_TOOL_CALL_SNAPSHOT),
    ]);
    const n43 = [...identityCells(preFinding), ...identityCells(postFinding)];
    const n44 = await checkFailureDomains(guardian.url);

    const cells = mergeCells(n41, n42, n43, n44);
    const traceRows = checkTracePillar();
    const schemaLeg = await checkPolicyInputSchema(bridge);

    const schemaLegLine = schemaLeg.ran
      ? `N41 policy-input schema (AGT's own policy-input.schema.json, agt.lock's pinned ref): RAN -- validated ${schemaLeg.points.join(", ")}`
      : `N41 policy-input schema (AGT's own policy-input.schema.json, agt.lock's pinned ref): DID NOT RUN -- ${schemaLeg.reason}`;

    const output = [
      "=== U32 mapping table (N48, S10's declaration) ===",
      renderMappingTable(mapping),
      "",
      "=== U30 coverage matrix (N47, N41-N44 merged) ===",
      renderCoverageMatrix(cells),
      "",
      "=== U33 trace rows (N52, N49's measurement) ===",
      renderTraceRows(traceRows),
      "",
      "=== Legs measured ===",
      "N41 intervention-point round trip (resolver): RAN",
      schemaLegLine,
      "N42 verdict round trip: RAN",
      "N43 enforced identity (pre_tool_call, post_tool_call, merged): RAN",
      "N44 failure domains (live Guardian, wire-level): RAN",
      "N49 trace pillar: RAN",
    ].join("\n");

    return { output, cells, exitCode: resolveExitCode(cells) };
  } finally {
    await guardian.close();
  }
}

if (import.meta.main) {
  const run = await main();
  console.log(run.output);
  if (run.exitCode !== 0) {
    console.error(
      `\nconformance: exit ${run.exitCode} -- the coverage matrix has a coordinate no check measured (see the ` +
        `"no check measured this cell" cell(s) above), not a red cell (V7 does not treat red as failure)`,
    );
  }
  process.exit(run.exitCode);
}
