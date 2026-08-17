import { afterEach, describe, expect, it } from "bun:test";
import { PINNED_AGT_CLONE_ENV } from "../src/policy-input-schema.ts";
import { main } from "../src/main.ts";

describe("the conformance runner, in-process, with the schema leg disabled (no network)", () => {
  const originalEnv = process.env[PINNED_AGT_CLONE_ENV];
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[PINNED_AGT_CLONE_ENV];
    } else {
      process.env[PINNED_AGT_CLONE_ENV] = originalEnv;
    }
  });

  it("publishes all three artifacts, a 40-cell matrix, which legs ran, and exits 0 for a fully resolved matrix", async () => {
    delete process.env[PINNED_AGT_CLONE_ENV];

    const run = await main();

    // The mapping table.
    expect(run.output).toContain("AGT intervention point -> ACS v0.1.0 method (mapping.yaml: intervention_points)");
    // The coverage matrix.
    expect(run.output).toContain("AGT intervention point (rows) x AGT verdicts (columns)");
    // The trace-pillar rows.
    expect(run.output).toContain("Trace pillar (trace/otel-mapping.json)");

    expect(run.cells).toHaveLength(40);

    // The check that ran and the check that did not, both named on the
    // output's own face -- not left to a reader to infer from the matrix's
    // shape.
    expect(run.output).toMatch(/policy-input schema.*DID NOT RUN/s);
    expect(run.output).toContain(PINNED_AGT_CLONE_ENV);
    for (const check of [
      "intervention-point round trip",
      "verdict round trip",
      "action identity",
      "deny fails closed",
      "trace pillar",
    ]) {
      expect(run.output).toContain(check);
    }

    // Every one of the 40 coordinates is resolved, which is exactly the case
    // the exit-status rule reads as success.
    expect(run.exitCode).toBe(0);
  });

  it("is a fully resolved matrix -- no coordinate reads unexpressed for having no check measure it", async () => {
    delete process.env[PINNED_AGT_CLONE_ENV];

    const run = await main();

    const holes = run.cells.filter((cell) => cell.status === "unexpressed" && cell.reason === "no check measured this cell");
    expect(holes).toEqual([]);
  });
});
