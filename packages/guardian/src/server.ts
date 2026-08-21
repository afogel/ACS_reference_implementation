/**
 * startGuardian serves the ACS wire boundary: a single JSON-RPC 2.0 endpoint,
 * POST /acs. The spec mandates no URL path convention -- "/acs" is this
 * project's own choice -- so dispatch inside the handler is by the JSON-RPC
 * `method` field, never by URL path.
 *
 * The sequence for `steps/toolCallRequest` is: validateEnvelope ->
 * assemblePreToolCallSnapshot -> bridge.evaluate at the intervention point
 * resolveInterventionPoint picked -> mapVerdict -> response envelope.
 *
 * The middle three run inside a try/catch, and that catch is load-bearing.
 * Were a throw to escape this handler, Bun.serve would answer with its default
 * error page, which is HTML rather than JSON-RPC. The host's client calls
 * res.json() unconditionally, so an HTML body raises a SyntaxError there
 * instead of surfacing a JSON-RPC error; the hook's catch-all then exits 1
 * with nothing on stdout, which Claude Code reads as "the hook never fired"
 * and allows the tool call through ungoverned. That is a fail-open in a
 * governance tool, so the catch must stay.
 *
 * What the catch guarantees is only that a well-formed JSON-RPC error reaches
 * the client. It deliberately does not turn the failure into an ACS `deny`:
 * which disposition an evaluation failure should carry is a separate question.
 *
 * The bridge and the mapping table are both built once, when startGuardian is
 * called, rather than per request -- AGT is meant to be constructed at boot
 * and evaluated statelessly.
 *
 * The listening socket defaults to loopback (127.0.0.1). Bun.serve with no
 * `hostname` binds `*` -- every interface, dual-stack -- and this endpoint has
 * no authentication, no origin check and no request signing, so anything that
 * can open the port is both a policy oracle (ask it what would be allowed)
 * and a policy sink (feed it envelopes it evaluates as if a governed host had
 * sent them). Until the wire is authenticated, reachability IS the access
 * control, so the default is the narrowest bind a host shim on the same
 * machine can still reach. A deployment that genuinely needs a routable bind
 * -- a Guardian in its own container, say -- opts in explicitly through the
 * `hostname` option (main.ts reads ACS_GUARDIAN_HOST for it).
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
 * member today; each gate this Guardian learns to assemble adds its own
 * point-specific type here.
 *
 * Declared so the bridge seam carries the message rather than erasing it.
 * `PolicyBridge` is parameterised by the snapshot its holder sends, and this
 * is what this holder sends, so the `bridge.evaluate` calls below are checked
 * against the assemblers' own output types instead of against any object at all.
 */
type GuardianSnapshot = AgtPreToolCallSnapshot;

const MAPPING_PATH = fileURLToPath(new URL("../../../mapping.yaml", import.meta.url));

const HANDSHAKE_METHOD = "handshake/hello";
const ACS_PATH = "/acs";

/** The default bind address -- see the module header for why it is loopback
 * and not `*`. Spelled as the literal address rather than "localhost": the
 * name resolves to both ::1 and 127.0.0.1, and Bun binds only one of them,
 * so the name would make which interfaces are listening a property of the
 * machine's resolver rather than of this line. */
const LOOPBACK_ONLY = "127.0.0.1";

/**
 * ACS reserves -32000..-32099 for application errors (Specification §17),
 * but only enumerates named codes -32000..-32007 in the §17.1 registry
 * (SESSION_REFUSED, UNSUPPORTED_VERSION, ...) -- none of which names "the
 * envelope failed schema validation", "this method isn't dispatched by this
 * Guardian", or "evaluation itself failed". Rather than reach for the
 * generic JSON-RPC codes that would otherwise fit (-32602 Invalid params,
 * -32601 Method not found), this module mints three codes from the unused
 * part of the reserved band, so every application-level failure stays inside
 * -32000..-32099.
 */
const ENVELOPE_INVALID_CODE = -32010;
const METHOD_NOT_DISPATCHED_CODE = -32011;
/** A throw from assemblePreToolCallSnapshot, bridge.evaluate, or mapVerdict --
 * mapVerdict's own require_policy_references check, say, or any AGT runtime
 * error. The module header explains why this must never become dead code. */
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
  /** The address to bind. Defaults to loopback; set it only to widen the
   * bind deliberately, and read the module header first -- the endpoint is
   * unauthenticated, so widening it hands the policy decision to whoever can
   * reach the port. main.ts threads ACS_GUARDIAN_HOST into this. */
  hostname?: string;
  /** Overrides the mapping.yaml path this Guardian loads. Defaults to the
   * repo's real mapping.yaml; exists so tests can inject a deliberately
   * misconfigured mapping (e.g. require_policy_references on a decision
   * AGT emits with no reason) to exercise the evaluation-failure catch in
   * handleAcsRequest against a real bridge, without touching the mapping
   * every other consumer reads. Not meant for production use. */
  mappingPath?: string;
};
export type StartedGuardian = { url: string; close(): Promise<void> };

export async function startGuardian({
  port,
  hostname,
  manifestPath,
  mappingPath,
}: StartGuardianOptions): Promise<StartedGuardian> {
  // Construct the bridge once at boot, not per request.
  const bridge = createBridge(manifestPath);
  const mapping = loadMapping(mappingPath ?? MAPPING_PATH);

  const server = Bun.serve({
    hostname: hostname ?? LOOPBACK_ONLY,
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
  // The role, not `ReturnType<typeof createBridge>`: this handler depends on
  // something it can tell to evaluate a snapshot, not on the shape one
  // factory happens to return.
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
    // validateEnvelope checks the general request-envelope.json shape for
    // every method, plus -- only for steps/toolCallRequest -- the
    // hook-specific payload schema. Failure is a thrown typed error, never a
    // decision: we turn it into a bare JSON-RPC error below, rather than into
    // {decision: "deny"}.
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
      // `intervention_points` table rather than from a literal here, so the
      // table cannot drift away from what the runtime actually does.
      // An unresolvable method throws into the catch below rather than
      // defaulting to a point -- evaluating the wrong policy and calling the
      // result a decision is the one outcome worse than a reported failure.
      const point = resolveInterventionPoint(envelope.method, mapping);
      const verdict = await bridge.evaluate(point, snapshot);
      const decision = mapVerdict(verdict, mapping);

      return successResponse(envelope.id, finalResult(envelope.params, decision));
    } catch (error) {
      // See the module header. Deliberately a bare JSON-RPC error rather than
      // an ACS `deny` decision -- all this guarantees is that the client gets
      // a parseable envelope back instead of an HTML 500.
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
