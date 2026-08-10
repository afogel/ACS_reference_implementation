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
 * Every throw on this path is caught, in two places, because nothing may
 * escape the fetch handler. Bun.serve would answer an unhandled rejection with
 * its default error page, which is HTML rather than JSON-RPC. The host's
 * client calls res.json() unconditionally, so an HTML body raises a
 * SyntaxError there instead of surfacing a JSON-RPC error; the hook's
 * catch-all then exits 1 with nothing on stdout, which Claude Code reads as
 * "the hook never fired" and allows the tool call through ungoverned. That is
 * a fail-open in a governance tool.
 *
 * The two catches are:
 *   - Inside `dispatch`, around assemblePreToolCallSnapshot, bridge.evaluate
 *     and mapVerdict: the evaluation itself.
 *   - Around the whole `dispatch` call in `handleAcsRequest`, as the outer net.
 *     `dispatch` rethrows anything that is not an EnvelopeValidationError, and
 *     that rethrow is live: validateEnvelope builds its Ajv registry lazily, on
 *     the first request rather than at boot, so a tree cloned without
 *     `--recurse-submodules` starts cleanly and then turns every request into
 *     an HTML 500. The outer net also puts the failure response back on the
 *     tapped path, so the envelope log records it like any other response.
 *
 * Neither catch turns the failure into an ACS `deny` decision: which
 * disposition a Guardian-side failure should carry is a separate question.
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
import { createEnvelopeTap, NULL_TAP, type EnvelopeTap } from "./envelope-tap.ts";

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
// This tree's own absolute root -- `packages/guardian/src` is always three
// directories under it, the same relationship MAPPING_PATH above relies on.
// Used only to redact it out of error text before that text leaves the
// Guardian; see toRepoRelativeMessage below.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[/\\]+$/, "");
// The lookahead requires the root to be followed by a path separator or the
// end of the string, before the optional `[/\\]?` consumes one such
// separator. Without it, a *sibling* directory whose name merely extends
// the root (`ACS_reference_implementation_old`) matched too: the literal
// text of REPO_ROOT is a prefix of that name, so it stripped, leaving a
// misleading `_old/packages/spec` behind -- not a disclosure of this tree's
// own location, since it's a different directory entirely, but a
// diagnostic that then reads as if it were one. The lookahead makes that
// prefix match fail outright, so a message naming the sibling is left
// alone, in full.
const REPO_ROOT_PATTERN = new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\\\]|$)[/\\\\]?`, "g");

/**
 * Both catches in this module (the outer net in handleAcsRequest and the
 * evaluation-failure catch in dispatch) surface a real error to the ACS
 * client and, via the tap, into S6 -- and a real error's message (an ENOENT
 * out of a missing schema directory, say) carries this machine's absolute
 * filesystem path, e.g.
 * `/Users/you/.../ACS_reference_implementation/packages/spec/acs/...`.
 * That is diagnostic in a way this demo's value depends on, so the fix is
 * not to replace it with something generic -- it is to remove only the
 * part of it that discloses where this tree sits on disk, leaving the
 * repo-relative remainder (`packages/spec/acs/...`) intact.
 *
 * Takes the caught value itself, as `unknown`, rather than a pre-extracted
 * string. Both call sites already had to guard with
 * `error instanceof Error ? error.message : String(error)` because a catch
 * clause's binding is `unknown` -- but an earlier version of this helper
 * took that guard's *result* and assumed it was a string, which is true of
 * every message this tree's own code happens to produce, not something
 * `instanceof Error` guarantees: nothing stops `.message` from being
 * reassigned to `undefined`, a number, or anything else after construction.
 * That earlier version threw `TypeError: undefined is not an object
 * (evaluating 'message.replace')` on exactly such an Error -- reachable
 * only from the outer catch, since the inner catch's own throw is itself
 * caught by the outer one, but reachable there with nothing above
 * `handleAcsRequest` to catch it: the untapped HTML-500 fail-open this
 * module's header exists to prevent. `String()` on the whole caught value
 * keeps this helper total for any `unknown`, matching what a catch clause
 * can actually hand it.
 *
 * Exported (unlike this module's other internals -- `dispatch`,
 * `extractId`, `extractMethod`, `errorResponse`) so the anchor behaviour
 * above and this function's totality for non-`Error`, non-string-message,
 * and otherwise-shaped `unknown` values can be asserted directly, rather
 * than only through a real Guardian and an HTTP round trip. The blocking
 * regression this exists to prevent is still covered end to end, separately
 * -- see server.test.ts's `withFakeValidateEnvelopeGuardian` tests.
 *
 * The whole body is wrapped in its own try/catch, including the
 * `instanceof` check -- belt-and-braces, not a reaction to a live bug.
 * Nothing in this tree throws an `Error` whose `.message` is a
 * throwing accessor, a value whose `toString`/`valueOf` throws, or a
 * `Proxy` that throws on `get` or on `getPrototypeOf` (which would defeat
 * `instanceof Error` itself, since it walks the prototype chain through
 * `[[GetPrototypeOf]]`, before `String()` below ever runs) -- all four are
 * unreachable from any throw site in this repo today, same as the shape the
 * previous fix in this module closed. They are guarded anyway because
 * "unreachable today" should not be load-bearing for the one function whose
 * entire job is upholding this module's stated contract that nothing
 * escapes the outer net: this project has already found five fail-opens of
 * this shape, the last one introduced by a fix for a minor, and V3 (N27
 * `denyOnInvalidEnvelope`) adds new routes through this exact path. The
 * fallback string names the failure mode rather than guessing at a partial
 * message, since the point is that nothing about the original error could
 * be read at all.
 */
export function toRepoRelativeMessage(error: unknown): string {
  try {
    const message = String(error instanceof Error ? error.message : error);
    return message.replace(REPO_ROOT_PATTERN, "");
  } catch {
    return "<unprintable error>";
  }
}

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
/** Any throw the Guardian did not turn into a response itself: mapVerdict's
 * own require_policy_references check, an AGT runtime error, or -- through
 * handleAcsRequest's outer net -- a failure to even build the schema registry.
 * The module header explains why none of this may become dead code. */
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
  /** Path to S6, the JSONL envelope log (N26). Omitted means no tap: every
   * V1 test constructs Guardians freely and a default-on tap would scatter
   * files through the working tree. `packages/guardian/src/main.ts` -- the
   * demo path -- passes it. See the plan's decision P3. */
  envelopeLogPath?: string;
};
export type StartedGuardian = { url: string; close(): Promise<void> };

export async function startGuardian({
  port,
  hostname,
  manifestPath,
  mappingPath,
  envelopeLogPath,
}: StartGuardianOptions): Promise<StartedGuardian> {
  // Construct the bridge once at boot, not per request.
  const bridge = createBridge(manifestPath);
  const mapping = loadMapping(mappingPath ?? MAPPING_PATH);
  const tap = envelopeLogPath ? createEnvelopeTap({ path: envelopeLogPath }) : NULL_TAP;

  const server = Bun.serve({
    hostname: hostname ?? LOOPBACK_ONLY,
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== ACS_PATH) {
        return new Response("Not Found", { status: 404 });
      }
      const response = await handleAcsRequest(req, bridge, mapping, tap);
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

/**
 * Three phases, in order: parse, tap the request, dispatch, tap the
 * response. The tap calls live here and only here -- `dispatch` below leaves
 * by six routes (five `return`s and one rethrow) and V3's N27 adds a
 * seventh, so tapping inside it would make totality something a future task
 * has to remember rather than something the structure guarantees.
 *
 * That guarantee is only as good as its coverage of the throwing route, and
 * the whole-branch review's finding 1 found it uncovered: `dispatch`'s
 * rethrow used to leave this function without a response at all, so the
 * client got a Bun.serve HTML 500 that S6 never recorded. The try/catch
 * below closes it -- every route out of `dispatch` now produces a response
 * object, and every response object gets tapped.
 *
 * The tap itself is total (see envelope-tap.ts): these two calls cannot
 * throw, so they cannot turn a governed tool call into an ungoverned one.
 */
async function handleAcsRequest(
  req: Request,
  // The role, not `ReturnType<typeof createBridge>`: this handler depends on
  // something it can tell to evaluate a snapshot, not on the shape one
  // factory happens to return.
  bridge: PolicyBridge<GuardianSnapshot>,
  mapping: Mapping,
  tap: EnvelopeTap,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    // Nothing parseable arrived, so there is no request envelope to tap --
    // the response is deliberately recorded unpaired, which is what the
    // Inspector renders when a host sends a malformed body.
    const parseError = errorResponse(null, -32700, "Parse error");
    tap.write("response", parseError, null);
    return parseError;
  }

  // Decision P5: before validation, so an envelope that fails the schema is
  // visible to the Inspector rather than invisible.
  const method = extractMethod(raw);
  tap.write("request", raw, method);

  let response: JsonRpcSuccess | JsonRpcFailure;
  try {
    response = await dispatch(raw, bridge, mapping);
  } catch (error) {
    // The outer net (whole-branch review, finding 1). Deliberately a bare
    // JSON-RPC error, not an ACS `deny`: N27 stays V3's call. What this
    // buys is that the client can parse the answer at all, and that S6
    // holds a response line paired with the request line above it.
    const message = toRepoRelativeMessage(error);
    response = errorResponse(extractId(raw), EVALUATION_FAILED_CODE, `guardian failed to handle the request: ${message}`);
  }
  tap.write("response", response, method);
  return response;
}

async function dispatch(
  raw: unknown,
  bridge: ReturnType<typeof createBridge>,
  mapping: Mapping,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
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
      const message = toRepoRelativeMessage(error);
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
    const id = raw.id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}

/** Best-effort method name for tap labelling only. Never used to dispatch --
 * `dispatch` reads the schema-validated envelope's own `method`. */
function extractMethod(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "method" in raw) {
    const method = raw.method;
    if (typeof method === "string") {
      return method;
    }
  }
  return null;
}
