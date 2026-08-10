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
 * Sends `handshake/hello`, waits for the Guardian's ServerHello, stores the
 * session config it validates out of that arrival, and returns that config.
 * Throws if the Guardian responds with a JSON-RPC error rather than a result,
 * or if what arrived is not a usable session config.
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
  const serverHello: unknown = response.result;
  if (!isSessionConfig(serverHello)) {
    throw new Error(
      `handshake: the Guardian's ServerHello is not a usable session config -- expected an object with ` +
        `on_decision_failure "proceed" or "deny" and a numeric timeout_config.default_ms, got ` +
        `${JSON.stringify(serverHello)}`,
    );
  }

  const sessionConfig: SessionConfig = serverHello;
  store.set(sessionConfig);
  return sessionConfig;
}
