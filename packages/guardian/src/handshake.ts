/**
 * buildServerHello builds the Guardian's answer to `handshake/hello`, per
 * handshake.json's ServerHello $def
 * (spec/acs/specification/v0.1.0/handshake.json).
 *
 * V1 scope:
 *   - `methods_evaluated` is exactly the set this Guardian actually wires
 *     up, per the V1 watch-for ("only pre_tool_call is wired").
 *   - `on_decision_failure` ships the spec default, "proceed" (fail-open).
 *     D8 closes on "proceed" as the default. This responder is now deployment-
 *     configurable (N28): one binary can demo both halves of V3 without a rebuild.
 *     Applying the declared posture (N6/N7) is V3 work. A value that is neither
 *     posture throws rather than falling back -- guessing which posture a typo
 *     meant is the silent bypass this slice removes.
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

/** The two postures §6.4 defines. Anything else is a broken deployment. */
const POSTURES = ["proceed", "deny"] as const;
type Posture = (typeof POSTURES)[number];

/**
 * The deployment's declared posture. D8 closed on the spec default
 * (`proceed`, per handshake.json's own `default` and R1.7); this makes it
 * configurable so one binary can demo both halves of V3 without a rebuild.
 *
 * A value that is neither posture THROWS rather than falling back. Falling
 * back to fail-open on a typo is exactly the silent-bypass shape this slice
 * exists to remove: the deployment asked for something, and guessing which
 * posture it meant is not available to us.
 */
// The parameter type is deliberately WIDER than handshakeResponder's own
// (`{ ACS_ON_DECISION_FAILURE?: string }`), and the asymmetry is forced
// rather than accidental: the zero-argument call site passes `process.env`,
// whose index signature is `Record<string, string | undefined>` and which
// does not satisfy the narrower shape. Widening the public parameter to
// match would let any environment-like bag in where the intent is "the one
// variable this reads"; narrowing this one would need a cast at the only
// call site that matters. This is the cheaper of the two.
function readPosture(env: Record<string, string | undefined>): Posture {
  const raw = env.ACS_ON_DECISION_FAILURE;
  if (raw === undefined) {
    return "proceed";
  }
  if ((POSTURES as readonly string[]).includes(raw)) {
    return raw as Posture;
  }
  throw new Error(
    `ACS_ON_DECISION_FAILURE must be "proceed" or "deny", got ${JSON.stringify(raw)}`,
  );
}

export function buildServerHello(env?: { ACS_ON_DECISION_FAILURE?: string }): ServerHello {
  const actualEnv = env ?? process.env;
  return {
    negotiated_version: NEGOTIATED_VERSION,
    methods_evaluated: METHODS_EVALUATED,
    selected_transport: "http",
    timeout_config: { default_ms: DEFAULT_TIMEOUT_MS },
    on_decision_failure: readPosture(actualEnv),
  };
}
