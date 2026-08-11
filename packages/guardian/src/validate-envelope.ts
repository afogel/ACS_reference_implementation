/**
 * validateEnvelope checks an incoming ACS request envelope against the
 * v0.1.0 JSON Schemas pinned in the spec/acs submodule
 * (spec/acs/specification/v0.1.0/request-envelope.json), and -- for
 * `steps/toolCallRequest` -- additionally against the hook-specific
 * payload schema (hooks/tool-call-request.json).
 *
 * It returns an `AcsRequestEnvelope`: a request of ANY method, named the
 * same thing the host's own builder names it
 * (packages/host-adapter/src/build-envelope.ts). Narrowing to the tool-call
 * view is a separate, explicit step (`isToolCallRequest`), so a method this
 * module validated only generically can never be read as one whose
 * hook-specific payload was checked.
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

/** request-envelope.json's Metadata $def -- method-independent. */
export type AcsRequestMetadata = {
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

/**
 * request-envelope.json's AcsParams $def. `payload` is deliberately as open
 * here as the schema itself leaves it -- "Hook-specific payload. Schema
 * depends on method." -- because that is the honest shape of a request whose
 * method has not been discriminated yet.
 */
export type AcsRequestParams = {
  acs_version: string;
  request_id: string;
  timestamp: string;
  nonce?: string;
  tenant_id?: string;
  metadata: AcsRequestMetadata;
  payload: Record<string, unknown>;
  signature?: { algorithm: string; value: string; key_id: string };
};

/**
 * A validated ACS request of ANY method -- `handshake/hello`,
 * `steps/toolCallRequest`, or anything else request-envelope.json's method
 * pattern admits. This is what `validateEnvelope` returns, and it is the
 * consumer half of the host's `AcsRequestEnvelope`
 * (packages/host-adapter/src/build-envelope.ts): one wire message, one noun,
 * on both sides of the seam.
 *
 * It used to be called `ToolCallRequestEnvelope` (PR #10 review, Critical,
 * and its naming-symmetry companion): every method was typed as a tool call,
 * so handshake traffic arrived under a name that lied about it, and the
 * consumer's noun was the narrower and more misleading of the two. The
 * tool-call shape now lives in `ToolCallRequestEnvelope` below and is
 * reachable only after the method has been checked.
 */
export type AcsRequestEnvelope = {
  jsonrpc: "2.0";
  method: string;
  id: string | number;
  params: AcsRequestParams;
};

/**
 * hooks/tool-call-request.json's payload shape -- the payload this module
 * additionally validates when, and only when, the method is
 * `steps/toolCallRequest`.
 */
export type ToolCallRequestPayload = {
  tool: { name: string; version?: string; provider?: string };
  operation?: string;
  capability?: string;
  arguments: Record<string, AcsArgument>;
  raw_command?: string;
  intent?: { description?: string; goal?: string };
};

/**
 * The method-narrowed view of an `AcsRequestEnvelope`: same envelope, with
 * `method` pinned to the one method whose payload has actually been validated
 * against hooks/tool-call-request.json, and `payload` narrowed to that
 * schema's shape.
 *
 * Reachable only through `isToolCallRequest` below, never returned by
 * `validateEnvelope` directly. That is the whole point: the narrow type is
 * the *conclusion* of a method check, not the type every request is handed
 * back as.
 *
 * Spelled with `Omit` rather than an intersection so `params.payload` is
 * exactly `ToolCallRequestPayload`, not `ToolCallRequestPayload &
 * Record<string, unknown>` -- the intersection type-checks but leaves every
 * property lookup resolving against an index signature too, which is how a
 * typo silently becomes `unknown` instead of an error.
 */
export type ToolCallRequestEnvelope = Omit<AcsRequestEnvelope, "method" | "params"> & {
  method: typeof TOOL_CALL_REQUEST_METHOD;
  params: Omit<AcsRequestParams, "payload"> & { payload: ToolCallRequestPayload };
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
export function validateEnvelope(input: unknown): AcsRequestEnvelope {
  const validateTopLevel = getValidator(REQUEST_ENVELOPE_SCHEMA_ID);
  if (!validateTopLevel(input)) {
    throw toValidationError(validateTopLevel.errors, "");
  }

  const envelope = input as AcsRequestEnvelope;

  if (envelope.method === TOOL_CALL_REQUEST_METHOD) {
    const validatePayload = getValidator(TOOL_CALL_REQUEST_SCHEMA_ID);
    if (!validatePayload(envelope.params.payload)) {
      throw toValidationError(validatePayload.errors, "/params/payload");
    }
  }

  return envelope;
}

/**
 * The one way to get from a validated ACS request to the tool-call view of
 * it. Narrows on `method`, which is exactly the condition under which
 * `validateEnvelope` above validated `params.payload` against
 * hooks/tool-call-request.json -- so the narrowing is not a convenient cast,
 * it is a claim the same module already checked.
 *
 * Kept next to that check on purpose: the two must agree about which method
 * carries a tool-call payload, and they can only be trusted to agree while
 * they read the same constant in the same file. A second ACS method adds its
 * own predicate and its own narrow type beside these, rather than widening
 * either.
 */
export function isToolCallRequest(envelope: AcsRequestEnvelope): envelope is ToolCallRequestEnvelope {
  return envelope.method === TOOL_CALL_REQUEST_METHOD;
}
