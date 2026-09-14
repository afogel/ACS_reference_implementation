/**
 * N43: `validateSchemas()` -- Ajv against the pinned schemas (S13).
 *
 * Every JSON Schema under `spec/acs/specification/v0.1.0/` is registered by
 * its `$id`, so the relative `$ref`s between them resolve as published.
 * Each request envelope is validated against `request-envelope.json` and,
 * when its method is a hook, its payload against that hook's schema; each
 * response against `response-envelope.json`. Failures become
 * `schema_violation(seq, schema, path)` facts, the `external` relation the
 * structural provisions consume (ACS-REQ-0001), and the JSON-Schema layer
 * of the four-layer split is never restated in Datalog (R5).
 */
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SchemaRegistry {
  validate(schemaFile: string, value: unknown): { path: string; message: string }[];
  has(schemaFile: string): boolean;
}

export function loadSchemas(schemaDir: string): SchemaRegistry {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const byFile = new Map<string, string>();
  for (const file of Array.from(new Bun.Glob("**/*.json").scanSync({ cwd: schemaDir, onlyFiles: true })).sort()) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as { $id?: string };
    if (typeof schema.$id !== "string") continue;
    ajv.addSchema(schema, schema.$id);
    byFile.set(file, schema.$id);
  }
  return {
    has: (file) => byFile.has(file),
    validate(file, value) {
      const id = byFile.get(file);
      if (!id) throw new Error(`no schema ${file} under ${schemaDir}`);
      const fn = ajv.getSchema(id);
      if (!fn) throw new Error(`schema ${file} did not compile`);
      if (fn(value)) return [];
      return (fn.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
    },
  };
}

/** `steps/toolCallRequest` -> `hooks/tool-call-request.json`; `agbom/snapshot` -> `hooks/agbom-snapshot.json`; `system/ping` -> `hooks/system-ping.json`. */
export function hookSchemaFile(method: string): string | null {
  const m = /^(steps|agbom|system)\/([A-Za-z]+)$/.exec(method);
  if (!m) return null;
  const name = (m[2] as string).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `hooks/${m[1] === "steps" ? "" : `${m[1]}-`}${name}.json`;
}
