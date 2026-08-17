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
 * This module knows ACS handshake vocabulary and JSON-RPC, nothing else. It has
 * no runtime dependency on the Guardian package -- it talks to the Guardian
 * only through the client role it is given, over the wire.
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
  const response = await options.guardian.post(envelope);
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
