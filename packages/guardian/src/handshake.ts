/**
 * buildServerHello builds the Guardian's answer to `handshake/hello`, per
 * handshake.json's ServerHello $def
 * (spec/acs/specification/v0.1.0/handshake.json).
 *
 * `build`, not `negotiate`: this function never reads the incoming
 * ClientHello. The host really does send one, but every field below is a
 * constant returned unconditionally, so `negotiated_version` and
 * `selected_transport` are DECLARED by this Guardian rather than agreed
 * against what the client proposed. Real negotiation -- reading the
 * ClientHello, picking a mutually supported version and transport, rejecting
 * what isn't -- is future work; see docs/demos/v1-runbook.md.
 *
 * `methods_evaluated` is exactly the set this Guardian wires up.
 * `on_decision_failure` ships the spec default, "proceed" (fail-open). This
 * side only declares it on the wire; nothing here reads or acts on it.
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
