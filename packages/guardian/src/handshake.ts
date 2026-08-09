/**
 * handshakeResponder builds the Guardian's ServerHello (N28) -- the
 * response to `handshake/hello` -- per handshake.json's ServerHello $def
 * (spec/acs/specification/v0.1.0/handshake.json).
 *
 * V1 scope:
 *   - `methods_evaluated` is exactly the set this Guardian actually wires
 *     up, per the V1 watch-for ("only pre_tool_call is wired").
 *   - `on_decision_failure` ships the spec default, "proceed" (fail-open).
 *     D8: V1 only NEGOTIATES and STORES this value on the wire -- applying
 *     the posture (the fail-open audit path, N6/N7) is V3. Nothing here
 *     reads or acts on it beyond returning it.
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

export function handshakeResponder(): ServerHello {
  return {
    negotiated_version: NEGOTIATED_VERSION,
    methods_evaluated: METHODS_EVALUATED,
    selected_transport: "http",
    timeout_config: { default_ms: DEFAULT_TIMEOUT_MS },
    on_decision_failure: "proceed",
  };
}
