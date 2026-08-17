// packages/conformance/test/upstream-watch.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUpstreamWatch } from "../src/upstream-watch.ts";
import { UPSTREAM_AGT_CLONE_ENV } from "../src/fetch-upstream.ts";
import { PINNED_AGT_CLONE_ENV } from "../src/policy-input-schema.ts";

function clone(verdicts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write("policy-engine/spec/schema/manifest.schema.json", JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["input"] } } } }));
  write("policy-engine/spec/schema/wire/policy-input.schema.json", "{}");
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: verdicts } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", "{}");
  write("policy-engine/spec/reserved-reasons.json", "{}");
  write("policy-engine/policy/lib/agt_default.rego", "a := cfg.patterns\n");
  return dir;
}

describe("runUpstreamWatch -- the pinned side is read here, not inside the differ", () => {
  it("self-skips when either clone is missing", () => {
    expect(runUpstreamWatch({}).ran).toBe(false);
    expect(runUpstreamWatch({ [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) }).ran).toBe(false);
  });

  it("reports a clean run when both sides agree", () => {
    const env = { [PINNED_AGT_CLONE_ENV]: clone(["allow"]), [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) };
    const run = runUpstreamWatch(env);

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
  it("names a changed enum value, which is the demo", () => {
    const env = {
      [PINNED_AGT_CLONE_ENV]: clone(["allow", "deny"]),
      [UPSTREAM_AGT_CLONE_ENV]: clone(["allow", "quarantine"]),
    };
    const run = runUpstreamWatch(env);

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
});
