/**
 * The host half of `handshake/hello`: send a ClientHello, keep what comes back
 * as this session's config.
 *
 * The stored message is a `SessionConfig`, never a `ServerHello`.
 * `isSessionConfig` requires the two fields this host actually needs, not the
 * five handshake.json's ServerHello $def requires, so naming the stored type
 * after the wire message would over-claim what this host validates.
 * `ServerHello` stays scoped to one thing: what the Guardian sent, before this
 * host has confirmed it can use it.
 *
 * Stores only. Applying the negotiated posture -- falling back to
 * `timeout_config` when the Guardian is slow or silent, recording a fail-open
 * audit event per `on_decision_failure: "proceed"` -- happens elsewhere, which
 * keeps a policy runtime's own evaluation-layer fail-closed behaviour distinct
 * from wire-delivery failure. This module does not retry, does not time out,
 * and does not write to an audit sink: it sends one request, stores one response.
 *
 * `negotiateSessionConfig`, not `handshake`: the old name was one of four for a
 * single negotiation (`handshake` / `handshakeResponder` / `SessionConfig` /
 * `ServerHello`), and the least informative of them -- a bare wire verb that
 * said nothing about what the caller gets. This one names the message it
 * produces, matching the `<verb><Message>` shape of the Guardian's own half.
 *
 * V1 SCOPE -- stores only. Applying the negotiated posture (falling back
 * to `timeout_config` when the Guardian is slow or silent; recording a
 * fail-open audit event per `on_decision_failure: "proceed"`) is N6/N7,
 * and belongs to slice V3. That boundary is deliberate: this project keeps
 * a policy runtime's own evaluation-layer fail-closed behaviour distinct
 * from wire-delivery failure, and V3 is where the wire-delivery half
 * lands. This module does not retry and does not write to an audit sink --
 * it sends one request, stores one response, and returns or throws.
 *
 * V3: this call CAN time out (`HandshakeOptions.timeoutMs`, optional). It
 * has to -- there is no negotiated `timeout_config` yet at the point this
 * runs, so a caller with nothing else to bound it would otherwise hang on
 * a Guardian that accepts the connection and never answers, for exactly as
 * long as it takes Claude Code's own hook timeout to kill the process:
 * unaudited, and with nothing on stdout. What happens on a timeout (or any
 * other delivery failure) is still the caller's decision, not this
 * module's -- it only throws `GuardianTimeoutError`, same as
 * `guardianClient.post` always has; applying a posture to that throw is
 * N6/N7's job, one layer up.
 *
 * R3.2: this module knows ACS handshake vocabulary and JSON-RPC, nothing
 * else. It has no runtime dependency on the Guardian package -- it talks
 * to the Guardian only through the client role it is given, over the wire.
 */
import { randomUUID } from "node:crypto";
import type { GuardianClient, JsonRpcRequest } from "./guardian-client.ts";
import { isSessionConfig, type SessionConfig, type SessionConfigStore } from "./session-config.ts";

const HANDSHAKE_METHOD = "handshake/hello";
const ACS_VERSION = "0.1.0";

export type HandshakeOptions = {
  /** The Guardian to negotiate with -- `createGuardianClient(url)` for the
   * endpoint startGuardian returned (test-only) or the one this deployment is
   * configured for. A client rather than a URL because that is the seam: this
   * module knows the handshake, not how to reach a Guardian. */
  guardian: GuardianClient;
  /** This Observed Agent's identity on the wire (ACS metadata.agent_id). */
  agentId: string;
  /** This session's identity on the wire (ACS metadata.session_id, a uuid). */
  sessionId: string;
  /** Bounds this handshake round trip (§6.4). There is no negotiated
   * `timeout_config` yet -- negotiating it is what this call is for -- so a
   * caller with nothing better should pass the ACS default
   * (`DEFAULT_TIMEOUT_MS`, failure-posture.ts). Omitted means no timeout at
   * all, matching how `guardianClient.post` itself treats an absent
   * `timeoutMs`; a caller that omits this accepts a Guardian that accepts
   * the connection and never answers hanging indefinitely. */
  timeoutMs?: number;
};

/**
 * Thrown when the Guardian answered with a ServerHello this host could not
 * KEEP -- as opposed to a handshake that never got an answer at all. The two
 * are materially different incidents and must not be squashed into one:
 *
 *   - A handshake that never reached the Guardian negotiated nothing. There
 *     is no posture to apply, and `posture_source: "default"` already says
 *     so.
 *   - A ServerHello that arrived and could not be *persisted* DID negotiate
 *     a posture. Persisting it is an optimisation for the hooks that come
 *     after this one (the shipped host runs each hook in a fresh
 *     subprocess, so the file is how a later process finds it); the value in
 *     hand is authoritative for the step that negotiated it. Discarding it
 *     because the write failed is how a deployment that declared
 *     `on_decision_failure: deny` fails *open* on the very step it just
 *     negotiated -- the fail-open shape this project keeps finding.
 *
 * `config` carries the negotiated ServerHello whenever there is one to
 * carry, so a caller can apply it to the current step and still report the
 * persistence failure. It is undefined only when there was never a usable
 * config to begin with.
 */
export class SessionConfigNotStoredError extends Error {
  /** Which of the local failures this is -- see classifySessionFailure. */
  readonly kind: "session_config_unstored" | "server_hello_invalid";
  /** The negotiated ServerHello, when one was negotiated. Undefined for
   * `server_hello_invalid`, where what arrived was not a usable config and
   * so there is genuinely nothing to apply. */
  readonly config: SessionConfig | undefined;

  constructor(
    message: string,
    {
      kind = "session_config_unstored",
      cause,
      config,
    }: { kind?: "session_config_unstored" | "server_hello_invalid"; cause?: unknown; config?: SessionConfig } = {},
  ) {
    super(message, { cause });
    this.name = "SessionConfigNotStoredError";
    this.kind = kind;
    this.config = config;
  }
}

/**
 * Sends `handshake/hello`, waits for the Guardian's ServerHello, stores it
 * into `store`, and returns it. Throws if the Guardian responds with a
 * JSON-RPC error rather than a result, and throws
 * `SessionConfigNotStoredError` -- carrying the ServerHello -- if the store
 * refuses to persist what did arrive.
 */
export async function negotiateSessionConfig(
  options: HandshakeOptions,
  store: SessionConfigStore,
): Promise<SessionConfig> {
  const requestId = randomUUID();

  const envelope: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: HANDSHAKE_METHOD,
    id: requestId,
    params: {
      acs_version: ACS_VERSION,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: { agent_id: options.agentId, session_id: options.sessionId },
      // ClientHello shape (handshake.json's $defs.ClientHello). Not schema-
      // enforced on this method by the Guardian's own validateEnvelope
      // (Task 5) today, but supplied honestly rather than left empty.
      payload: {
        acs_versions_supported: [ACS_VERSION],
        methods_implemented: ["steps/toolCallRequest"],
        transports_supported: ["http"],
        provenance_producer: "none",
      },
    },
  };

  // `post`, not `requestDecision`: this method's result is a ServerHello, not
  // a decision, and a handshake failure is a different incident from a step
  // that got no decision. It travels as a throw, separately.
  const response = await options.guardian.post(envelope, { timeoutMs: options.timeoutMs });
  if (response.error) {
    throw new Error(`handshake: Guardian rejected handshake/hello: ${response.error.message}`);
  }

  // Validated BEFORE storing, not cast and hoped for. This is the single point
  // where the Guardian's ServerHello becomes this host's SessionConfig, and it
  // becomes one by being checked -- named for the wire while it is still only
  // an arrival, and for the store once it is one.
  //
  // `get()` re-validates, so an unusable hello on disk is harmless to READ --
  // but writing one has a consequence nothing else surfaces: every `get()`
  // afterwards returns undefined, so every hook re-handshakes, forever, and
  // the deployment silently pays a round trip per hook while running on the
  // ACS default posture rather than the one its Guardian keeps declaring.
  // Rejecting it here turns that into a reported failure that travels as
  // `session_failure` on the audit entry (same route as an unstorable one),
  // instead of nothing at all.
  const serverHello = response.result as unknown;
  if (!isSessionConfig(serverHello)) {
    throw new SessionConfigNotStoredError(
      `handshake: the Guardian's ServerHello is not a usable session config -- expected an object with ` +
        `on_decision_failure "proceed" or "deny" and a numeric timeout_config.default_ms, got ` +
        `${JSON.stringify(serverHello)}`,
      { kind: "server_hello_invalid" },
    );
  }

  const sessionConfig: SessionConfig = serverHello;
  try {
    store.set(sessionConfig);
  } catch (error) {
    // The store is documented to throw here rather than swallow (an
    // unwritable `.acs/sessions` is a real deployment fault and hiding it
    // would be the silent half of the bug this error class exists for), so
    // this rethrows -- but with the negotiated ServerHello attached, so the
    // caller can still apply it to the step that negotiated it.
    throw new SessionConfigNotStoredError(
      `handshake: the Guardian's ServerHello could not be stored ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      { cause: error, config: sessionConfig },
    );
  }
  return sessionConfig;
}
