import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgtEvidence, PolicyBridge } from "agt-bridge";
import { checkPolicyInputSchema, UPSTREAM_AGT_CLONE_ENV } from "../src/policy-input-schema.ts";

/** trash the fixture directory this describe block builds -- never rm -rf. */
async function trashDir(dir: string): Promise<void> {
  await Bun.$`trash ${dir}`.quiet();
}

const evidenceFor = (policyInput: unknown): PolicyBridge => ({
  async evaluate() {
    throw new Error("not used by this test");
  },
  async evaluateWithEvidence(): Promise<AgtEvidence> {
    return {
      verdict: { decision: "allow" },
      policyInput,
      inputIdentity: `sha256:${"0".repeat(64)}`,
      enforcedIdentity: `sha256:${"0".repeat(64)}`,
    };
  },
});

describe("N41 schema leg -- self-skips without the clone, validates against it when present", () => {
  const originalEnv = process.env[UPSTREAM_AGT_CLONE_ENV];
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[UPSTREAM_AGT_CLONE_ENV];
    } else {
      process.env[UPSTREAM_AGT_CLONE_ENV] = originalEnv;
    }
  });

  it(`does not run when ${UPSTREAM_AGT_CLONE_ENV} is unset, and says so`, async () => {
    delete process.env[UPSTREAM_AGT_CLONE_ENV];

    const result = await checkPolicyInputSchema(evidenceFor({ marker: "ok" }));

    expect(result.ran).toBe(false);
    if (!result.ran) {
      expect(result.reason).toContain(UPSTREAM_AGT_CLONE_ENV);
    }
  });

  describe("with a fixture clone standing in for the pinned AGT repo", () => {
    // A throwaway fixture schema, not a copy of AGT's real one (R2.4) --
    // this describe block tests that the module reads the schema file at
    // the right path inside the clone and reports Ajv's own verdict on it
    // accurately, not that AGT's real contract has any particular shape.
    let clone: string;
    beforeEach(() => {
      clone = mkdtempSync(join(tmpdir(), "policy-input-schema-fixture-"));
      const schemaDir = join(clone, "policy-engine/spec/schema/wire");
      mkdirSync(schemaDir, { recursive: true });
      writeFileSync(
        join(schemaDir, "policy-input.schema.json"),
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["marker"],
          properties: { marker: { const: "ok" } },
        }),
      );
      process.env[UPSTREAM_AGT_CLONE_ENV] = clone;
    });
    afterEach(async () => {
      await trashDir(clone);
    });

    it("runs and validates the constructed policy input at both points the Guardian actually sends one for", async () => {
      const result = await checkPolicyInputSchema(evidenceFor({ marker: "ok" }));

      expect(result.ran).toBe(true);
      if (result.ran) {
        expect(result.points.sort()).toEqual(["post_tool_call", "pre_tool_call"]);
      }
    });

    it("throws, naming the point and AGT's own schema, when a constructed policy input fails validation", async () => {
      await expect(checkPolicyInputSchema(evidenceFor({ marker: "not ok" }))).rejects.toThrow(
        /pre_tool_call.*policy-input\.schema\.json/s,
      );
    });
  });
});
