/**
 * startGuardian (N20) serves the ACS wire boundary: a single JSON-RPC 2.0
 * endpoint, POST /acs. The spec mandates no URL path convention -- "/acs"
 * is this project's own, recorded as such in the slices doc -- so dispatch
 * inside the handler is by the JSON-RPC `method` field, never by URL path.
 *
 * Composes every earlier task, in order, for `steps/toolCallRequest`:
 *   validateEnvelope (Task 5) -> assemblePreToolCallSnapshot (Task 4) ->
 *   bridge.evaluate(resolveInterventionPoint(method, mapping), snapshot)
 *   (Task 2) -> mapVerdict(verdict, mapping) (Task 3) -> response envelope.
 *
 * assemblePreToolCallSnapshot / bridge.evaluate / mapVerdict are wrapped in a try/catch
 * (fix wave finding 1): an unhandled throw here -- e.g. mapVerdict's own
 * require_policy_references check, or a genuine AGT runtime error -- would
 * otherwise escape this handler, and Bun.serve's default error page for an
 * unhandled fetch() rejection is `text/html`, not JSON-RPC. The client
 * (packages/host-adapter/src/guardian-client.ts) calls `res.json()`
 * unconditionally, so an HTML body throws a SyntaxError there instead of
 * surfacing a JSON-RPC error -- and hosts/claude-code/acs-hook.ts's catch-all
 * then exits 1 with nothing on stdout, which Claude Code treats as "the hook
 * didn't fire": the tool call proceeds **ungoverned**. That is a fail-open in
 * a governance tool. The catch below only guarantees a well-formed JSON-RPC
 * error reaches the client -- it deliberately does NOT turn the failure into
 * an ACS `deny` decision. That is N27 (denyOnInvalidEnvelope), scoped to V3;
 * deciding what disposition an evaluation failure carries is V3's call, not
 * this fix's.
 *
 * The bridge (N31: AgentControl.fromPath) and the mapping table are both
 * constructed/loaded exactly once, at startGuardian() call time -- not per
 * request -- since AGT is meant to be built at boot and evaluated
 * statelessly (R6.1).
 */
import { fileURLToPath } from "node:url";
import { createBridge, type PolicyBridge } from "agt-bridge";
import { assemblePreToolCallSnapshot, type AgtPreToolCallSnapshot } from "./assemble-snapshot.ts";
import { finalResult, type AcsFinalResult } from "./acs-result.ts";
import { loadMapping, mapVerdict, resolveInterventionPoint, type Mapping } from "./map-verdict.ts";
import {
  EnvelopeValidationError,
  isToolCallRequest,
  validateEnvelope,
  type AcsRequestEnvelope,
} from "./validate-envelope.ts";
import { buildServerHello, type ServerHello } from "./handshake.ts";

/**
 * Every snapshot message this Guardian can send an intervention point. One
 * member at this slice; each gate this Guardian learns to assemble adds its
 * own point-specific type here.
 *
 * Declared so the bridge seam carries the message rather than erasing it (PR
 * #10 review, second pass). `PolicyBridge` is parameterised by the snapshot
 * its holder sends, and this is what this holder sends -- so `bridge.evaluate`
 * below is checked against the assemblers' own output types instead of against
 * "any object at all", which is what `Record<string, unknown>` had made of it.
 */
type GuardianSnapshot = AgtPreToolCallSnapshot;

const MAPPING_PATH = fileURLToPath(new URL("../../../mapping.yaml", import.meta.url));

const HANDSHAKE_METHOD = "handshake/hello";
const ACS_PATH = "/acs";

/**
 * ACS reserves -32000..-32099 for application errors (Specification §17),
 * but only enumerates named codes -32000..-32007 in the §17.1 registry
 * (SESSION_REFUSED, UNSUPPORTED_VERSION, ...) -- none of which names "the
 * envelope failed schema validation", "this method isn't dispatched by this
 * Guardian", or "evaluation itself failed". Rather than reach for the
 * generic JSON-RPC codes that would otherwise fit (-32602 Invalid params,
 * -32601 Method not found), this module mints three codes from the unused
 * part of the reserved band, keeping every application-level failure inside
 * -32000..-32099 per this task's explicit instruction.
 */
const ENVELOPE_INVALID_CODE = -32010;
const METHOD_NOT_DISPATCHED_CODE = -32011;
/** A throw from assemblePreToolCallSnapshot, bridge.evaluate, or mapVerdict -- e.g.
 * mapVerdict's own require_policy_references check, or any AGT runtime
 * error. See fix wave finding 1's comment above handleAcsRequest's
 * tool-call branch for why this must never be dead code. */
const EVALUATION_FAILED_CODE = -32020;

type JsonRpcSuccess = { jsonrpc: "2.0"; id: string | number; result: AcsFinalResult | ServerHello };
type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

export type StartGuardianOptions = {
  port: number;
  manifestPath: string;
  /** Overrides the mapping.yaml path this Guardian loads. Defaults to the
   * repo's real mapping.yaml; exists so tests can inject a deliberately
   * misconfigured mapping (e.g. require_policy_references on a decision
   * AGT emits with no reason) to exercise the evaluation-failure catch in
   * handleAcsRequest against a real bridge, without touching the mapping
   * every other consumer reads. Not meant for production use. */
  mappingPath?: string;
};
export type StartedGuardian = { url: string; close(): Promise<void> };

export async function startGuardian({ port, manifestPath, mappingPath }: StartGuardianOptions): Promise<StartedGuardian> {
  // N31 -- construct the bridge once at boot, not per request.
  const bridge = createBridge(manifestPath);
  const mapping = loadMapping(mappingPath ?? MAPPING_PATH);

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
  // The role, not `ReturnType<typeof createBridge>` (PR #10 review): this
  // handler depends on something it can tell to evaluate a snapshot, not on
  // the shape one factory happens to return.
  bridge: PolicyBridge<GuardianSnapshot>,
  mapping: Mapping,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }

  const rpcId = extractId(raw);

  let envelope: AcsRequestEnvelope;
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
    return successResponse(envelope.id, buildServerHello());
  }

  // `isToolCallRequest`, not a method comparison spelled out again here: the
  // predicate lives beside the payload check it stands for
  // (validate-envelope.ts), so this branch cannot come to disagree with the
  // module that decided whether `params.payload` was validated as a tool
  // call. It also narrows the envelope, which is what lets assemblePreToolCallSnapshot
  // take the tool-call view rather than any request at all.
  if (isToolCallRequest(envelope)) {
    try {
      const snapshot = assemblePreToolCallSnapshot(envelope);
      // The intervention point comes from mapping.yaml's own
      // `intervention_points` table, not from a literal here (PR #10 review,
      // Critical): that table is what V7's conformance matrix publishes, and
      // a declaration the runtime does not consult is a claim nobody checks.
      // An unresolvable method throws into the catch below rather than
      // defaulting to a point -- evaluating the wrong policy and calling the
      // result a decision is the one outcome worse than a reported failure.
      const point = resolveInterventionPoint(envelope.method, mapping);
      const verdict = await bridge.evaluate(point, snapshot);
      const decision = mapVerdict(verdict, mapping);

      return successResponse(envelope.id, finalResult(envelope.params, decision));
    } catch (error) {
      // Fix wave finding 1 -- see the module-level comment above. This is
      // deliberately a bare JSON-RPC error, not an ACS `deny` decision
      // (N27 stays V3's call): the fix here is only that the client gets a
      // parseable envelope back instead of an HTML 500.
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(rpcId, EVALUATION_FAILED_CODE, `evaluation failed: ${message}`);
    }
  }

  // A well-formed envelope (it passed validateEnvelope: the method matched
  // the required prefix pattern) naming a method this Guardian has no
  // handler for -- distinct from a malformed envelope, which never reaches
  // here because validateEnvelope already threw above.
  return errorResponse(rpcId, METHOD_NOT_DISPATCHED_CODE, `method not dispatched by this Guardian: ${envelope.method}`, {
    method: envelope.method,
  });
}

function successResponse(id: string | number, result: AcsFinalResult | ServerHello): JsonRpcSuccess {
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
