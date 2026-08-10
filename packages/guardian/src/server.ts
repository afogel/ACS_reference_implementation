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
 *   - Around the whole `dispatch` call in `handleAcsRequest`, as the outer
 *     net. `dispatch` rethrows anything that is not an
 *     EnvelopeValidationError, and that rethrow is live: validateEnvelope
 *     builds its Ajv registry lazily, on the first request rather than at
 *     boot, so a tree cloned without `--recurse-submodules` starts cleanly
 *     and then turns every request into an HTML 500. The outer net also
 *     writes the failure response through the same envelope-log call as any
 *     other response.
 *
 * Two DIFFERENT catches inside `dispatch` -- the evaluation catch above and
 * dispatch's own EnvelopeValidationError catch, around `validateEnvelope` --
 * now turn a steps/* failure into an honoured ACS `deny` decision instead
 * of a bare error, via N27 (denyOnInvalidEnvelope): see the module comment
 * on `dispatch` below. The outer net here is deliberately untouched by N27:
 * it exists for a `dispatch` rethrow -- a bug in the Guardian itself (e.g. a
 * missing schema directory), not an invalid envelope -- so it stays a bare
 * JSON-RPC error.
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
import { createBridge, type Annotator, type PolicyBridge } from "agt-bridge";
import { assemblePreToolCallSnapshot, type AgtPreToolCallSnapshot } from "./assemble-snapshot.ts";
import { finalResult, type AcsFinalResult } from "./acs-result.ts";
import { denyOnInvalidEnvelope, type DenyOnInvalidEnvelopeResult } from "./deny-on-invalid-envelope.ts";
import { loadMapping, mapVerdict, resolveInterventionPoint, type Mapping } from "./map-verdict.ts";
import {
  EnvelopeValidationError,
  isToolCallRequest,
  validateEnvelope,
  type AcsRequestEnvelope,
} from "./validate-envelope.ts";
import { buildServerHello, type ServerHello } from "./handshake.ts";
import { createEnvelopeLogSink, NULL_ENVELOPE_LOG_SINK, type EnvelopeLogSink } from "./envelope-log-sink.ts";

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
 * Both catches in this module -- the outer net in handleAcsRequest and the
 * evaluation-failure catch in dispatch -- surface a real error to the ACS
 * client and, through the envelope log, onto disk. A real error's message
 * (an ENOENT out of a missing schema directory, say) carries this machine's
 * absolute filesystem path, e.g.
 * `/Users/you/.../ACS_reference_implementation/packages/spec/acs/...`.
 * That is diagnostic in a way this demo's value depends on, so rather than
 * replace it with something generic, this function removes only the part
 * that discloses where this tree sits on disk, leaving the repo-relative
 * remainder (`packages/spec/acs/...`) intact.
 *
 * Takes the caught value itself, as `unknown`, rather than a pre-extracted
 * string, and calls `String()` on the whole thing. `instanceof Error` does
 * not guarantee `.message` is a string -- nothing stops it from being
 * reassigned to `undefined`, a number, or anything else after construction
 * -- and a throw from this function on the outer-net path has nothing above
 * `handleAcsRequest` to catch it. Staying total for any `unknown`, exactly
 * what a catch clause can hand it, is what keeps that path from becoming an
 * unrecorded HTML 500.
 *
 * Exported -- unlike this module's other internals (`dispatch`, `extractId`,
 * `extractMethod`, `errorResponse`) -- so the redaction above and this
 * function's totality for non-`Error`, non-string-message, and
 * otherwise-shaped `unknown` values can be asserted directly, rather than
 * only through a real Guardian and an HTTP round trip. The same behaviour is
 * also covered end to end, separately -- see server.test.ts's
 * `withFakeValidateEnvelopeGuardian` tests.
 *
 * The whole body is wrapped in its own try/catch, including the
 * `instanceof` check -- belt-and-braces, not a reaction to a live bug.
 * Nothing in this tree currently throws an `Error` whose `.message` is a
 * throwing accessor, a value whose `toString`/`valueOf` throws, or a
 * `Proxy` that throws on `get` or on `getPrototypeOf` (which would defeat
 * `instanceof Error` itself, since it walks the prototype chain through
 * `[[GetPrototypeOf]]`, before `String()` below ever runs). They are guarded
 * anyway because "unreachable today" should not be load-bearing for the one
 * function whose entire job is upholding this module's contract that
 * nothing escapes the outer net. The fallback string names the failure mode
 * rather than guessing at a partial message, since the point is that
 * nothing about the original error could be read at all.
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
  /** Path to the JSONL envelope log. Omitted means no sink: tests construct
   * Guardians freely, and a default-on sink would scatter files through the
   * working tree. `packages/guardian/src/main.ts` -- the demo path --
   * passes it. */
  envelopeLogPath?: string;
  /** Overrides the declared `on_decision_failure` posture this Guardian's
   * ServerHello carries, bypassing `handshakeResponder`'s own
   * `process.env.ACS_ON_DECISION_FAILURE` read entirely. Explicit rather
   * than an env-shaped bag on purpose: a test that needs a Guardian
   * declaring `deny` can pass one here instead of mutating `process.env`,
   * which would leak into every other test sharing that process (plan Risk
   * 7). Omitted means the real deployment path: `handshakeResponder()` is
   * called with no argument and reads the actual environment, exactly as
   * `packages/guardian/src/main.ts` needs it to. */
  onDecisionFailure?: "proceed" | "deny";
  /** A host-supplied annotator, threaded straight to `createBridge` (which
   * wraps it before handing it to AGT). Optional and off by default: the
   * main manifest (`policy/manifest.yaml`) declares no annotator, so a
   * Guardian that omits this option behaves exactly as it did before this
   * option existed -- see `policy/manifest.drift.yaml` and its own header
   * for the one manifest that does declare one. */
  annotator?: Annotator;
};
export type StartedGuardian = { url: string; close(): Promise<void> };

export async function startGuardian({
  port,
  hostname,
  manifestPath,
  mappingPath,
  envelopeLogPath,
  onDecisionFailure,
  annotator,
}: StartGuardianOptions): Promise<StartedGuardian> {
  // N31 -- construct the bridge once at boot, not per request.
  const bridge = createBridge(manifestPath, annotator ? { annotator } : undefined);
  const mapping = loadMapping(mappingPath ?? MAPPING_PATH);
  const envelopeLog = envelopeLogPath ? createEnvelopeLogSink({ path: envelopeLogPath }) : NULL_ENVELOPE_LOG_SINK;

  const server = Bun.serve({
    hostname: hostname ?? LOOPBACK_ONLY,
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== ACS_PATH) {
        return new Response("Not Found", { status: 404 });
      }
      const response = await handleAcsRequest(req, bridge, mapping, envelopeLog, onDecisionFailure);
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
 * Three phases, in order: parse, record the request, dispatch, record the
 * response. The envelope-log writes live here and only here -- `dispatch`
 * below leaves by eight routes now (seven `return`s and one rethrow). V1/V2
 * left six (five `return`s and one rethrow); N27 (V3) added two more, not
 * one -- both dispatch's EnvelopeValidationError catch and its evaluation
 * catch gained a second `return`, for the deny-decision case, beside the
 * bare-error `return` each already had. Writing S6 inside `dispatch` would
 * make totality something a future task has to remember rather than
 * something the structure guarantees.
 *
 * That guarantee only holds if every route out of `dispatch` is covered,
 * including the one that throws: the try/catch below ensures every route
 * out of `dispatch` produces a response object, and every response object
 * reaches the envelope log.
 *
 * The sink itself is total (see envelope-log-sink.ts): these two calls cannot
 * throw, so they cannot turn a governed tool call into an ungoverned one.
 */
async function handleAcsRequest(
  req: Request,
  // The role, not `ReturnType<typeof createBridge>`: this handler depends on
  // something it can tell to evaluate a snapshot, not on the shape one
  // factory happens to return.
  bridge: PolicyBridge<GuardianSnapshot>,
  mapping: Mapping,
  envelopeLog: EnvelopeLogSink,
  onDecisionFailure?: "proceed" | "deny",
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    // Nothing parseable arrived, so there is no request envelope to record
    // -- the response is deliberately recorded unpaired, which is what the
    // Inspector renders when a host sends a malformed body.
    const parseError = errorResponse(null, -32700, "Parse error");
    envelopeLog.write("response", parseError, null);
    return parseError;
  }

  // Recorded before validation, so an envelope that fails the schema is
  // visible to the Inspector rather than invisible.
  const method = extractMethod(raw);
  envelopeLog.write("request", raw, method);

  let response: JsonRpcSuccess | JsonRpcFailure;
  try {
    response = await dispatch(raw, bridge, mapping, onDecisionFailure);
  } catch (error) {
    // The outer net (whole-branch review, finding 1). Deliberately a bare
    // JSON-RPC error, not an ACS `deny`: this route is `dispatch` rethrowing
    // past N27 entirely -- a bug in the Guardian itself (e.g. a missing
    // schema directory), not an invalid envelope, so denyOnInvalidEnvelope
    // never runs here. What this buys is that the client can parse the
    // answer at all, and that S6 holds a response line paired with the
    // request line above it.
    const message = toRepoRelativeMessage(error);
    response = errorResponse(extractId(raw), EVALUATION_FAILED_CODE, `guardian failed to handle the request: ${message}`);
  }
  envelopeLog.write("response", response, method);
  return response;
}

async function dispatch(
  raw: unknown,
  bridge: ReturnType<typeof createBridge>,
  mapping: Mapping,
  onDecisionFailure?: "proceed" | "deny",
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  const rpcId = extractId(raw);

  let envelope: AcsRequestEnvelope;
  try {
    // validateEnvelope (N21) checks the general request-envelope.json shape
    // for every method, plus -- only for steps/toolCallRequest -- the
    // hook-specific payload schema. Failure is a THROWN typed error, never
    // a decision itself -- validateEnvelope stays total to its own contract
    // (see its doc comment) -- but the catch below (N27,
    // denyOnInvalidEnvelope) turns a steps/* failure into an honoured ACS
    // `deny` decision rather than a bare JSON-RPC error, since there is an
    // identifiable step to answer for. A handshake failure and an
    // undispatched method are not steps/*, so they always fall through to
    // the JSON-RPC error unchanged.
    envelope = validateEnvelope(raw);
  } catch (error) {
    if (error instanceof EnvelopeValidationError) {
      if (isStepMethod(raw)) {
        const denial = denyOnInvalidEnvelope(raw, { reasonCode: "envelope_invalid", message: error.message });
        const decisionResponse = asDecisionResponse(rpcId, denial);
        if (decisionResponse) {
          return decisionResponse;
        }
      }
      return errorResponse(rpcId, ENVELOPE_INVALID_CODE, error.message, { pointer: error.pointer });
    }
    throw error;
  }

  if (envelope.method === HANDSHAKE_METHOD) {
    const env = onDecisionFailure === undefined ? undefined : { ACS_ON_DECISION_FAILURE: onDecisionFailure };
    return successResponse(envelope.id, buildServerHello(env));
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
      // Fix wave finding 1 -- see the module-level comment above -- made
      // this a parseable JSON-RPC error instead of an HTML 500. N27
      // (denyOnInvalidEnvelope) goes one step further: AGT's evaluation
      // layer fails CLOSED (R1.5), and this catch is where that failure
      // surfaces, so it is delivered as an honoured `deny` decision rather
      // than a bare error, keeping it in §6.4's honoured path.
      const message = toRepoRelativeMessage(error);
      const denial = denyOnInvalidEnvelope(raw, { reasonCode: "evaluation_failed", message });
      const decisionResponse = asDecisionResponse(rpcId, denial);
      if (decisionResponse) {
        return decisionResponse;
      }
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

/** Best-effort method name for envelope-log labelling only. Never used to
 * dispatch -- `dispatch` reads the schema-validated envelope's own `method`. */
function extractMethod(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "method" in raw) {
    const method = raw.method;
    if (typeof method === "string") {
      return method;
    }
  }
  return null;
}

/** Whether the raw envelope names a `steps/*` method -- read before
 * validation, so it is a string test and nothing more. N27 only turns a
 * schema-validation failure into a deny decision for steps/*: a handshake
 * failure is not a governance decision (there is no step to decide about),
 * and an undispatched method is answered separately, below. */
function isStepMethod(raw: unknown): boolean {
  const method = extractMethod(raw);
  return typeof method === "string" && method.startsWith("steps/");
}

/**
 * Turns a `denyOnInvalidEnvelope` result into a JSON-RPC success response,
 * or `null` when it cannot be delivered as one -- in which case the caller
 * falls back to its own JSON-RPC error response instead.
 *
 * Two distinct reasons produce `null`, not one:
 *   - `denial.kind === "unaddressable"` -- denyOnInvalidEnvelope found no
 *     request_id and no usable JSON-RPC id anywhere on the envelope.
 *   - `denial.kind === "decision"` but `rpcId` is `null` -- the decision
 *     found an id (via `params.request_id`), but that id did not come from
 *     the envelope's own JSON-RPC `id`. `successResponse` requires a
 *     non-null id for the *response*, and a JSON-RPC response with a null
 *     id cannot be correlated by the client either -- so this is not a
 *     cast to paper over (`rpcId as string | number`), it is a real case
 *     the addressability rule exists for, and it is handled the same way
 *     `unaddressable` is: by falling back to the error response.
 */
function asDecisionResponse(rpcId: string | number | null, denial: DenyOnInvalidEnvelopeResult): JsonRpcSuccess | null {
  if (denial.kind === "decision" && (typeof rpcId === "string" || typeof rpcId === "number")) {
    return successResponse(rpcId, denial.result);
  }
  return null;
}
