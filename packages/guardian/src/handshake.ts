/**
 * buildServerHello builds the Guardian's ServerHello (N28) -- the answer to
 * `handshake/hello` -- per handshake.json's ServerHello $def
 * (spec/acs/specification/v0.1.0/handshake.json).
 *
 * V1 scope:
 *   - `methods_evaluated` is exactly the set this Guardian actually wires
 *     up, per the V1 watch-for ("only pre_tool_call is wired").
 *   - `on_decision_failure` ships the spec default, "proceed" (fail-open).
 *     D8: V1 only NEGOTIATES and STORES this value on the wire -- applying
 *     the posture (the fail-open audit path, N6/N7) is V3. Nothing here
 *     reads or acts on it beyond returning it.
 *
 * WHY THIS IS NOT CALLED `handshakeResponder` (PR #10 review, Important, and
 * fix wave finding 7 before it -- honesty, not a scope increase): this
 * function never reads the incoming ClientHello. The client (host-adapter's
 * `negotiateSessionConfig`) genuinely sends one, but every field below is a
 * constant, returned unconditionally. So "negotiated_version" and
 * "selected_transport" are DECLARED by this Guardian, not actually negotiated
 * against what the client proposed, and a name containing "responder" claimed
 * a negotiation the body does not perform. `build<Message>` says exactly what
 * happens: it assembles the one message this side of the handshake owns. That
 * distinction matters in a reference implementation of a wire *contract*.
 * Real negotiation (reading ClientHello, picking a mutually-supported
 * version/transport, rejecting what isn't) is future work, not attempted here
 * -- see the matching note in docs/demos/v1-runbook.md.
 *
 * Naming symmetry with the host side: each side of this exchange now names its
 * own message once, with the same `<verb><Message>` morphology --
 * `buildServerHello` here, `negotiateSessionConfig` in
 * packages/host-adapter/src/handshake.ts. The asymmetry between "build" and
 * "negotiate" is deliberate and is the truth about the code: the host really
 * does perform an exchange, and this side really does return constants.
 */

export type ServerHello = {
  negotiated_version: string;
  methods_evaluated: string[];
  selected_transport: "http" | "https" | "stdio";
  timeout_config: { default_ms: number; per_method_ms?: Record<string, number> };
  on_decision_failure: "proceed" | "deny";
};

/** The ACS spec version every schema and mapping in this repo is pinned to. */
const NEGOTIATED_VERSION = "0.1.0";

/** Only intervention point wired in V1 (mapping.yaml's pre_tool_call). */
const METHODS_EVALUATED = ["steps/toolCallRequest"];

/**
 * Deployment-chosen default; handshake.json's timeout_config.default_ms
 * carries no spec-mandated number. 5s bounds worst-case added latency on a
 * synchronous pre-tool-call decision without being so tight that a
 * momentarily slow Guardian trips it.
 */
const DEFAULT_TIMEOUT_MS = 5000;

export function buildServerHello(): ServerHello {
  return {
    negotiated_version: NEGOTIATED_VERSION,
    methods_evaluated: METHODS_EVALUATED,
    selected_transport: "http",
    timeout_config: { default_ms: DEFAULT_TIMEOUT_MS },
    on_decision_failure: "proceed",
  };
}
