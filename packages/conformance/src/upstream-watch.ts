import { createBridge } from "agt-bridge";
import { diffSurfaces, type SurfaceDiff } from "./diff-surfaces.ts";
import { fetchUpstreamSurfaces, UPSTREAM_AGT_CLONE_ENV } from "./fetch-upstream.ts";
import { checkPolicyInputSchemaAt, PINNED_AGT_CLONE_ENV } from "./policy-input-schema.ts";
import { renderUpstreamDiff } from "./render-upstream-diff.ts";
import { asPinned, readSurfaces, type PinnedSurfaces, type UpstreamSurfaces } from "./surfaces.ts";

const MANIFEST_PATH = "policy/manifest.yaml";

/**
 * What re-asking the policy-input schema question of `main` answers, beside
 * the surface diff. A surface diff says a field moved; this says whether the
 * document the Guardian actually sends still validates against the schema
 * as it stands on `main` today -- a field can move without the document we
 * send ever touching it, and a field the diff never names can still be the
 * one a tightened `required` now rejects.
 *
 * `checked: false` only when the run itself did not happen -- one of the two
 * clones was missing or unreadable -- because there is then no clone of
 * `main` to ask the question against.
 */
export type SchemaAgainstMain =
  | { readonly checked: false }
  | { readonly checked: true; readonly ok: true; readonly points: readonly string[] }
  | { readonly checked: true; readonly ok: false; readonly reason: string };

type SchemaAgainstMainChecked = Extract<SchemaAgainstMain, { checked: true }>;

const NOT_CHECKED: SchemaAgainstMain = { checked: false };

export type UpstreamWatchRun = {
  readonly ran: boolean;
  readonly output: string;
  readonly diffs: readonly SurfaceDiff[];
  readonly schemaAgainstMain: SchemaAgainstMain;
};

function skipped(reason: string): UpstreamWatchRun {
  return { ran: false, diffs: [], schemaAgainstMain: NOT_CHECKED, output: reason };
}

function renderSchemaAgainstMain(result: SchemaAgainstMainChecked): string {
  return result.ok
    ? `Policy-input schema against main: the policy input we send still validates against main ` +
        `(checked at ${result.points.join(", ")}).`
    : `Policy-input schema against main: FAILURE -- ${result.reason}`;
}

/**
 * Assembles the run: reads the pinned side, fetches the upstream side, hands
 * both to the differ, re-asks the policy-input schema question of the
 * upstream clone, and renders what came back.
 *
 * The pinned side is read HERE rather than inside the differ, so the differ
 * has no store to reach for and no ref to resolve -- it is told two snapshots
 * and compares them. Both clones are made by the shell script, which is the
 * only place in this slice that touches the network.
 *
 * Both variables are checked for presence BEFORE either side is read. Reading
 * used to start with the upstream side regardless, so a malformed upstream
 * clone would throw even on a run that was only ever going to self-skip for
 * a missing pinned clone -- the wrong clone got blamed for a run that was
 * never going to happen.
 *
 * Reading itself is wrapped, because `readSurfaces` throws on a missing or
 * relocated surface -- correctly: a watch that reported an absent surface as
 * "unchanged" would be exactly the silent rot this exists to catch. But an
 * uncaught throw here does not stay loud. The scheduled workflow runs this
 * through `tee "$GITHUB_STEP_SUMMARY"` with no `pipefail`, so an uncaught
 * throw on the left of that pipe still leaves the job green with an empty
 * summary and the real error stranded in the raw log -- silent rot of a
 * different kind, from the harness built to prevent it. So a read failure on
 * either side is caught and turned into a report naming which side and what
 * went missing, and the run answers `ran: false` rather than propagating.
 *
 * The schema re-check is handled the same way for the same reason: it keeps
 * its own shipped behaviour of throwing on a genuine validation failure, and
 * that throw is caught here and rendered as a failure line rather than
 * allowed to escape. This slice reports; it never refuses, and nothing here
 * fails a build.
 */
export async function runUpstreamWatch(
  env: Record<string, string | undefined> = process.env,
): Promise<UpstreamWatchRun> {
  const pinnedClone = env[PINNED_AGT_CLONE_ENV];
  const upstreamClone = env[UPSTREAM_AGT_CLONE_ENV];
  const bothPresent =
    pinnedClone !== undefined && pinnedClone.length > 0 && upstreamClone !== undefined && upstreamClone.length > 0;
  if (!bothPresent) {
    return skipped(
      `Upstream contract watch: skipped. Both ${PINNED_AGT_CLONE_ENV} and ${UPSTREAM_AGT_CLONE_ENV} must name ` +
        `an AGT clone; run it through scripts/run-upstream-watch.sh, which makes both.`,
    );
  }

  let pinned: PinnedSurfaces;
  try {
    pinned = asPinned(readSurfaces(pinnedClone));
  } catch (error) {
    return skipped(
      `Upstream contract watch: could not read the pinned ref's surfaces -- ${(error as Error).message}`,
    );
  }

  let upstream: UpstreamSurfaces;
  try {
    // fetchUpstreamSurfaces only answers undefined when its own variable is
    // absent, and that was already ruled out by `bothPresent` above.
    upstream = fetchUpstreamSurfaces(env)!;
  } catch (error) {
    return skipped(`Upstream contract watch: could not read main's surfaces -- ${(error as Error).message}`);
  }

  const diffs = diffSurfaces(pinned, upstream);

  let schemaAgainstMain: SchemaAgainstMainChecked;
  try {
    const bridge = createBridge(MANIFEST_PATH);
    const result = await checkPolicyInputSchemaAt(bridge, upstreamClone);
    schemaAgainstMain = result.ran
      ? { checked: true, ok: true, points: result.points }
      : { checked: true, ok: false, reason: result.reason };
  } catch (error) {
    schemaAgainstMain = { checked: true, ok: false, reason: (error as Error).message };
  }

  const output = [renderUpstreamDiff(diffs), "", renderSchemaAgainstMain(schemaAgainstMain)].join("\n");
  return { ran: true, diffs, schemaAgainstMain, output };
}

if (import.meta.main) {
  const run = await runUpstreamWatch();
  console.log(run.output);
}
