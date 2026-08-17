// packages/conformance/test/upstream-schema-check.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkPolicyInputSchemaAt } from "../src/policy-input-schema.ts";
import { createBridge } from "agt-bridge";

const SCHEMA_REL = "policy-engine/spec/schema/wire/policy-input.schema.json";

function cloneWithSchema(schema: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "upstream-schema-"));
  const full = join(dir, SCHEMA_REL);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(schema));
  return dir;
}

describe("checkPolicyInputSchemaAt -- the document we send, against the schema at a given clone", () => {
  it("validates against a permissive schema", async () => {
    const bridge = createBridge("policy/manifest.yaml");
    const result = await checkPolicyInputSchemaAt(bridge, cloneWithSchema({ type: "object" }));

    expect(result.ran).toBe(true);
  });

  it("reports a FAILURE, not a skip, when the schema at that clone rejects what we send", async () => {
    const bridge = createBridge("policy/manifest.yaml");
    const tightened = { type: "object", required: ["a_field_agt_does_not_send_today"] };

    await expect(checkPolicyInputSchemaAt(bridge, cloneWithSchema(tightened))).rejects.toThrow(
      /policy-input\.schema\.json/,
    );
  });
});
