/**
 * validateEnvelope checks an incoming ACS request envelope against the
 * v0.1.0 JSON Schemas pinned in the spec/acs submodule
 * (spec/acs/specification/v0.1.0/request-envelope.json), and -- for
 * `steps/toolCallRequest` -- additionally against the hook-specific
 * payload schema (hooks/tool-call-request.json).
 *
 * Failure is a THROWN, typed EnvelopeValidationError -- never a returned
 * decision. Turning a rejection into an explicit ACS "deny" decision is
 * N27, which belongs to a later slice (V3). The caller (Task 6, the
 * Guardian server) is responsible for turning a thrown error into a
 * JSON-RPC error response.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

/** An ACS argument wrapper: `{value, provenance?}`. */
export type AcsArgument = { value: unknown; provenance?: unknown };

/**
 * The validated shape of a `steps/toolCallRequest` envelope, per
 * request-envelope.json's AcsParams/Metadata $defs plus
 * hooks/tool-call-request.json's payload shape.
 *
 * This is the canonical envelope type for the project: assemble-snapshot.ts
 * re-exports it rather than declaring its own -- Task 4 left a local,
 * narrower `ToolCallRequestEnvelope` there as a temporary seam explicitly
 * flagged for reconciliation with this task.
 */
export type ToolCallRequestEnvelope = {
  jsonrpc: "2.0";
  method: string;
  id: string | number;
  params: {
    acs_version: string;
    request_id: string;
    timestamp: string;
    nonce?: string;
    tenant_id?: string;
    metadata: {
      agent_id: string;
      agent_name?: string;
      session_id: string;
      turn_id?: string;
      parent_turn_id?: string;
      session_state?: { chain_hash?: string };
      environment?: "development" | "staging" | "production";
      platform?: string;
      platform_version?: string;
      user_context?: { user_id?: string; roles?: string[]; authentication_method?: string };
    };
    payload: {
      tool: { name: string; version?: string; provider?: string };
      operation?: string;
      capability?: string;
      arguments: Record<string, AcsArgument>;
      raw_command?: string;
      intent?: { description?: string; goal?: string };
    };
    signature?: { algorithm: string; value: string; key_id: string };
  };
};

/**
 * Thrown when an envelope fails schema validation. `pointer` is the JSON
 * pointer (relative to the envelope root) of the first failing location --
 * synthesized from Ajv's instancePath + missingProperty for `required`
 * failures, since Ajv itself reports those against the parent object, not
 * the missing child -- so a human (or Task 6's JSON-RPC error mapping) can
 * find the offending field without re-deriving it from `errors`.
 */
export class EnvelopeValidationError extends Error {
  readonly pointer: string;
  readonly errors: ErrorObject[];

  constructor(pointer: string, errors: ErrorObject[]) {
    const detail = errors[0]?.message ?? "invalid";
    super(`ACS envelope failed schema validation at ${pointer}: ${detail}`);
    this.name = "EnvelopeValidationError";
    this.pointer = pointer;
    this.errors = errors;
  }
}

const SCHEMA_ROOT = fileURLToPath(new URL("../../../spec/acs/specification/v0.1.0/", import.meta.url));
const REQUEST_ENVELOPE_SCHEMA_ID = "https://acs.org/schema/v0.1.0/request-envelope.json";
const TOOL_CALL_REQUEST_SCHEMA_ID = "https://acs.org/schema/v0.1.0/hooks/tool-call-request.json";
const TOOL_CALL_REQUEST_METHOD = "steps/toolCallRequest";

function listSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSchemaFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Builds one Ajv instance with every v0.1.0 schema registered under its
 * own $id (agbom/, hooks/, inspect/, trace/ included), so the modular
 * $refs between them -- e.g. hooks/tool-call-request.json's
 * argument.provenance ref to "../provenance.json" -- resolve the way the
 * spec authors intended: against $id, not file path. Ajv resolves a
 * relative $ref against the referencing schema's own $id as base URI, so
 * registering every schema up front is sufficient; nothing needs
 * inlining or rewriting.
 *
 * strict:true is left ON. Every v0.1.0 schema compiles cleanly under it
 * once ajv-formats supplies the "uuid" and "date-time" format validators
 * the schemas declare (Ajv core recognizes no formats on its own, and
 * strict mode would otherwise reject them as unknown) -- verified against
 * all 43 schema files under v0.1.0/. Nothing else needed disabling.
 */
function buildAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of listSchemaFiles(SCHEMA_ROOT)) {
    const schema = JSON.parse(readFileSync(file, "utf8")) as { $id?: string };
    if (schema.$id && !ajv.getSchema(schema.$id)) {
      ajv.addSchema(schema);
    }
  }
  return ajv;
}

let ajv: ReturnType<typeof buildAjv> | undefined;

function getValidator(schemaId: string): ValidateFunction {
  if (!ajv) {
    ajv = buildAjv();
  }
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`validate-envelope: schema not registered: ${schemaId}`);
  }
  return validate;
}

/** The JSON pointer an Ajv error names, honoring `required`'s
 * missingProperty (Ajv reports the parent's instancePath there, not the
 * missing child's). */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missingProperty = (error.params as { missingProperty: string }).missingProperty;
    return `${error.instancePath}/${missingProperty}`;
  }
  return error.instancePath || "/";
}

function toValidationError(errors: ErrorObject[] | null | undefined, prefix: string): EnvelopeValidationError {
  const list = errors ?? [];
  const firstPointer = list[0] ? pointerOf(list[0]) : "/";
  return new EnvelopeValidationError(`${prefix}${firstPointer}`, list);
}

/**
 * Validates an incoming envelope against request-envelope.json, and --
 * only when `method` is `steps/toolCallRequest` -- additionally validates
 * `params.payload` against hooks/tool-call-request.json. Returns the
 * envelope, typed, on success. Throws EnvelopeValidationError on any
 * failure; never returns a decision.
 */
export function validateEnvelope(input: unknown): ToolCallRequestEnvelope {
  const validateTopLevel = getValidator(REQUEST_ENVELOPE_SCHEMA_ID);
  if (!validateTopLevel(input)) {
    throw toValidationError(validateTopLevel.errors, "");
  }

  const envelope = input as ToolCallRequestEnvelope;

  if (envelope.method === TOOL_CALL_REQUEST_METHOD) {
    const validatePayload = getValidator(TOOL_CALL_REQUEST_SCHEMA_ID);
    if (!validatePayload(envelope.params.payload)) {
      throw toValidationError(validatePayload.errors, "/params/payload");
    }
  }

  return envelope;
}
