/**
 * startGuardian (N20) serves the ACS wire boundary: a single JSON-RPC 2.0
 * endpoint, POST /acs. The spec mandates no URL path convention -- "/acs"
 * is this project's own, recorded as such in the slices doc -- so dispatch
 * inside the handler is by the JSON-RPC `method` field, never by URL path.
 *
 * Composes every earlier task, in order, for `steps/toolCallRequest`:
 *   validateEnvelope (Task 5) -> assembleSnapshot (Task 4) ->
 *   bridge.evaluate("pre_tool_call", snapshot) (Task 2) ->
 *   mapVerdict(verdict, mapping) (Task 3) -> response envelope.
 *
 * The bridge (N31: AgentControl.fromPath) and the mapping table are both
 * constructed/loaded exactly once, at startGuardian() call time -- not per
 * request -- since AGT is meant to be built at boot and evaluated
 * statelessly (R6.1).
 */
import { fileURLToPath } from "node:url";
import { createBridge } from "agt-bridge";
import { assembleSnapshot } from "./assemble-snapshot.ts";
import { loadMapping, mapVerdict, type Mapping } from "./map-verdict.ts";
import { EnvelopeValidationError, validateEnvelope, type ToolCallRequestEnvelope } from "./validate-envelope.ts";
import { handshakeResponder } from "./handshake.ts";

const MAPPING_PATH = fileURLToPath(new URL("../../../mapping.yaml", import.meta.url));

const HANDSHAKE_METHOD = "handshake/hello";
const TOOL_CALL_REQUEST_METHOD = "steps/toolCallRequest";
const ACS_PATH = "/acs";

/**
 * ACS reserves -32000..-32099 for application errors (Specification §17),
 * but only enumerates named codes -32000..-32007 in the §17.1 registry
 * (SESSION_REFUSED, UNSUPPORTED_VERSION, ...) -- none of which names "the
 * envelope failed schema validation" or "this method isn't dispatched by
 * this Guardian". Rather than reach for the generic JSON-RPC codes that
 * would otherwise fit (-32602 Invalid params, -32601 Method not found),
 * this module mints two codes from the unused part of the reserved band,
 * keeping every application-level failure inside -32000..-32099 per this
 * task's explicit instruction.
 */
const ENVELOPE_INVALID_CODE = -32010;
const METHOD_NOT_DISPATCHED_CODE = -32011;

type JsonRpcSuccess = { jsonrpc: "2.0"; id: string | number; result: Record<string, unknown> };
type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

export type StartGuardianOptions = { port: number; manifestPath: string };
export type StartedGuardian = { url: string; close(): Promise<void> };

export async function startGuardian({ port, manifestPath }: StartGuardianOptions): Promise<StartedGuardian> {
  // N31 -- construct the bridge once at boot, not per request.
  const bridge = createBridge(manifestPath);
  const mapping = loadMapping(MAPPING_PATH);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== ACS_PATH) {
        return new Response("Not Found", { status: 404 });
      }
      const response = await handleAcsRequest(req, bridge, mapping);
      return Response.json(response);
    },
  });

  return {
    url: `http://localhost:${server.port}${ACS_PATH}`,
    async close() {
      await server.stop(true);
    },
  };
}

async function handleAcsRequest(
  req: Request,
  bridge: ReturnType<typeof createBridge>,
  mapping: Mapping,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }

  const rpcId = extractId(raw);

  let envelope: ToolCallRequestEnvelope;
  try {
    // validateEnvelope (N21) checks the general request-envelope.json shape
    // for every method, plus -- only for steps/toolCallRequest -- the
    // hook-specific payload schema. Failure is a THROWN typed error, never
    // a decision (N27, the deny-on-invalid-envelope affordance, is V3): we
    // turn it into a bare JSON-RPC error below, not {decision: "deny"}.
    envelope = validateEnvelope(raw);
  } catch (error) {
    if (error instanceof EnvelopeValidationError) {
      return errorResponse(rpcId, ENVELOPE_INVALID_CODE, error.message, { pointer: error.pointer });
    }
    throw error;
  }

  if (envelope.method === HANDSHAKE_METHOD) {
    return successResponse(envelope.id, handshakeResponder());
  }

  if (envelope.method === TOOL_CALL_REQUEST_METHOD) {
    const snapshot = assembleSnapshot(envelope);
    const { verdict } = await bridge.evaluate("pre_tool_call", snapshot);
    const decision = mapVerdict(verdict, mapping);

    const result: Record<string, unknown> = {
      type: "final",
      acs_version: envelope.params.acs_version,
      request_id: envelope.params.request_id,
      ...decision,
    };
    return successResponse(envelope.id, result);
  }

  // A well-formed envelope (it passed validateEnvelope: the method matched
  // the required prefix pattern) naming a method this Guardian has no
  // handler for -- distinct from a malformed envelope, which never reaches
  // here because validateEnvelope already threw above.
  return errorResponse(rpcId, METHOD_NOT_DISPATCHED_CODE, `method not dispatched by this Guardian: ${envelope.method}`, {
    method: envelope.method,
  });
}

function successResponse(id: string | number, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Best-effort extraction of the request's JSON-RPC id for error responses,
 * per response-envelope.json: id MUST be null when it cannot be determined,
 * otherwise it matches the request id. Used only on failure paths -- a
 * successful response always uses the schema-validated envelope's id. */
function extractId(raw: unknown): string | number | null {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}
