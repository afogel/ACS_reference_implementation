// packages/conformance/test/upstream-watch.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUpstreamWatch } from "../src/upstream-watch.ts";
import { UPSTREAM_AGT_CLONE_ENV } from "../src/fetch-upstream.ts";
import { PINNED_AGT_CLONE_ENV } from "../src/policy-input-schema.ts";

// policyInputSchema defaults to a permissive schema that accepts any
// document, so callers not testing the schema question themselves don't
// have to think about it.
function clone(verdicts: string[], policyInputSchema = "{}"): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write("policy-engine/spec/schema/manifest.schema.json", JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["input"] } } } }));
  write("policy-engine/spec/schema/wire/policy-input.schema.json", policyInputSchema);
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: verdicts } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", "{}");
  write("policy-engine/spec/reserved-reasons.json", "{}");
  write("policy-engine/policy/lib/agt_default.rego", "a := cfg.patterns\n");
  return dir;
}

describe("runUpstreamWatch -- the pinned side is read here, not inside the differ", () => {
  it("self-skips when either clone is missing", async () => {
    expect((await runUpstreamWatch({})).ran).toBe(false);
    expect((await runUpstreamWatch({ [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) })).ran).toBe(false);
  });

  it("reports a clean run when both sides agree", async () => {
    const env = { [PINNED_AGT_CLONE_ENV]: clone(["allow"]), [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) };
    const run = await runUpstreamWatch(env);

    expect(run.ran).toBe(true);
    expect(run.diffs).toEqual([]);
    expect(run.output).toContain("no watched surface moved");
  });

  // Two rows, not one: the verdict enum is extracted from
  // verdict.schema.json, a document this watch also reads whole, so a moved
  // enum value is reported once against the document and once against the
  // extracted enum. Eight surfaces are not eight files, and this is what that
  // costs -- the enum row is the one that names the moved value in AGT's own
  // terms, and the document row is the same movement seen from outside.
  it("names a changed enum value, which is the demo", async () => {
    const env = {
      [PINNED_AGT_CLONE_ENV]: clone(["allow", "deny"]),
      [UPSTREAM_AGT_CLONE_ENV]: clone(["allow", "quarantine"]),
    };
    const run = await runUpstreamWatch(env);

    expect(run.diffs).toEqual([
      {
        surface: "verdict.schema.json",
        field: "/properties/decision/enum/1",
        pinned: "deny",
        upstream: "quarantine",
      },
      { surface: "verdict enum", field: "/1", pinned: "deny", upstream: "quarantine" },
    ]);
    expect(run.output).toContain("quarantine");
  });

  // AGT relocating or removing a watched surface is the single loudest thing
  // this watch exists to notice. readSurfaces throws on a missing or moved
  // surface -- correctly, since reporting an absent surface as "unchanged"
  // would be silent rot -- but a thrown error that reaches the scheduled
  // workflow's `tee` pipeline uninterrupted is silent rot of a different
  // kind: the job still exits green. So the run must catch it and answer
  // with a report instead of letting it escape.
  it("reports a failure instead of throwing when a clone is missing an AGT surface", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "watch-empty-"));
    const env = { [PINNED_AGT_CLONE_ENV]: emptyDir, [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) };

    const run = await runUpstreamWatch(env);

    expect(run.ran).toBe(false);
    expect(run.output).toContain("manifest.schema.json");
  });

  // The pinned side isn't the only one that can be missing a surface -- main
  // moves, so an AGT release that renames or drops a watched file is a real
  // way for the upstream side to fail the same read. Each side names itself
  // in the failure it reports, so this pins the other half of that pair.
  it("reports a failure instead of throwing when the upstream clone is missing an AGT surface", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "watch-empty-"));
    const env = { [PINNED_AGT_CLONE_ENV]: clone(["allow"]), [UPSTREAM_AGT_CLONE_ENV]: emptyDir };

    const run = await runUpstreamWatch(env);

    expect(run.ran).toBe(false);
    expect(run.output).toContain("could not read main's surfaces");
    expect(run.output).toContain("manifest.schema.json");
  });

  // A read failure and a schema rejection are different answers -- the first
  // means the run itself did not complete, the second means it completed and
  // came back negative -- and this is what tells them apart: a clone that
  // reads fine but whose policy-input.schema.json now requires a field the
  // Guardian does not send. The catch inside runUpstreamWatch turns that
  // rejection into a reported line rather than letting it propagate, and the
  // surface diff above it still has to be there -- a schema failure is not a
  // reason to stop reporting what moved.
  it("reports a schema rejection as a failure line, alongside the surface diff, instead of throwing", async () => {
    const tightened = JSON.stringify({ type: "object", required: ["a_field_agt_does_not_send_today"] });
    const env = {
      [PINNED_AGT_CLONE_ENV]: clone(["allow", "deny"]),
      [UPSTREAM_AGT_CLONE_ENV]: clone(["allow", "quarantine"], tightened),
    };

    const run = await runUpstreamWatch(env);

    expect(run.ran).toBe(true);
    expect(run.schemaAgainstMain.checked).toBe(true);
    expect(run.schemaAgainstMain).toMatchObject({ ok: false });
    expect(run.output).toContain("quarantine");
    expect(run.output).toContain("FAILURE");
    expect(run.output).toContain("policy-input.schema.json");
  });
});
