import { diffSurfaces, type SurfaceDiff } from "./diff-surfaces.ts";
import { fetchUpstreamSurfaces, UPSTREAM_AGT_CLONE_ENV } from "./fetch-upstream.ts";
import { PINNED_AGT_CLONE_ENV } from "./policy-input-schema.ts";
import { renderUpstreamDiff } from "./render-upstream-diff.ts";
import { asPinned, readSurfaces } from "./surfaces.ts";

export type UpstreamWatchRun = {
  readonly ran: boolean;
  readonly output: string;
  readonly diffs: readonly SurfaceDiff[];
};

/**
 * Assembles the run: reads the pinned side, fetches the upstream side, hands
 * both to the differ, and renders what came back.
 *
 * The pinned side is read HERE rather than inside the differ, so the differ
 * has no store to reach for and no ref to resolve -- it is told two snapshots
 * and compares them. Both clones are made by the shell script, which is the
 * only place in this slice that touches the network.
 *
 * Reports and never refuses: the answer carries what moved, and no caller
 * turns it into an exit code. A moved surface is something a human reads,
 * not something that fails a build.
 */
export function runUpstreamWatch(env: Record<string, string | undefined> = process.env): UpstreamWatchRun {
  const pinnedClone = env[PINNED_AGT_CLONE_ENV];
  const upstream = fetchUpstreamSurfaces(env);
  if (pinnedClone === undefined || pinnedClone.length === 0 || upstream === undefined) {
    return {
      ran: false,
      diffs: [],
      output:
        `Upstream contract watch: skipped. Both ${PINNED_AGT_CLONE_ENV} and ${UPSTREAM_AGT_CLONE_ENV} must name ` +
        `an AGT clone; run it through scripts/run-upstream-watch.sh, which makes both.`,
    };
  }

  const pinned = asPinned(readSurfaces(pinnedClone));
  const diffs = diffSurfaces(pinned, upstream);
  return { ran: true, diffs, output: renderUpstreamDiff(diffs) };
}

if (import.meta.main) {
  const run = runUpstreamWatch();
  console.log(run.output);
}
