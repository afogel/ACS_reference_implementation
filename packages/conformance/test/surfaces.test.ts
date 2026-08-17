// packages/conformance/test/surfaces.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readSurfaces, asPinned, asUpstream, SURFACE_NAMES } from "../src/surfaces.ts";

function fakeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write(
    "policy-engine/spec/schema/manifest.schema.json",
    JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["pre_tool_call", "output"] } } } }),
  );
  write("policy-engine/spec/schema/wire/policy-input.schema.json", JSON.stringify({ title: "policy input" }));
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: ["allow", "deny"] } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", JSON.stringify({ title: "snapshot" }));
  write("policy-engine/spec/reserved-reasons.json", JSON.stringify({ reasons: ["tool_unknown"] }));
  write("policy-engine/policy/lib/agt_default.rego", "x := cfg.drift.warn_threshold\ny := cfg.patterns\nz := cfg.drift.warn_threshold\n");
  return dir;
}

describe("readSurfaces -- the eight declared surfaces, and nothing else", () => {
  it("names exactly eight surfaces", () => {
    expect(SURFACE_NAMES).toHaveLength(8);
  });

  it("reads the four wire documents whole", () => {
    const s = readSurfaces(fakeClone());
    expect(s["policy-input.schema.json"]).toEqual({ title: "policy input" });
    expect(s["snapshot.schema.json"]).toEqual({ title: "snapshot" });
  });

  it("extracts the intervention-point enum from inside manifest.schema.json", () => {
    expect(readSurfaces(fakeClone())["intervention-point enum"]).toEqual(["pre_tool_call", "output"]);
  });

  it("extracts the verdict enum from inside verdict.schema.json", () => {
    expect(readSurfaces(fakeClone())["verdict enum"]).toEqual(["allow", "deny"]);
  });

  it("derives the defaults config keys from the rego source, deduped and sorted", () => {
    expect(readSurfaces(fakeClone())["data.agt.defaults.config keys"]).toEqual(["drift.warn_threshold", "patterns"]);
  });

  it("throws when a surface is missing rather than reporting it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "surfaces-empty-"));
    expect(() => readSurfaces(dir)).toThrow(/manifest.schema.json/);
  });

  it("brands a snapshot as pinned or upstream without changing it", () => {
    const s = readSurfaces(fakeClone());
    expect(s).toEqual(asPinned(s));
    expect(s).toEqual(asUpstream(s));
  });
});
