/**
 * The negotiated session config store (S13): where negotiateSessionConfig (N5)
 * writes this session's config once a session's capability negotiation
 * completes.
 *
 * `SessionConfig` is the one noun for that stored message, here as in
 * handshake.ts -- "ServerHello" names what the Guardian sent, and appears below
 * only where the subject genuinely is the arrival rather than the stored value
 * (PR #10 review, naming symmetry; see handshake.ts's header for the rule).
 *
 * V1 SCOPE: storage only. Nothing in this module reads or acts on the
 * stored config -- applying it (falling back to timeout_config when the
 * Guardian is silent, honoring on_decision_failure's fail-open/fail-closed
 * posture) is N6/N7, which belongs to slice V3.
 *
 * A factory rather than a module-level singleton, matching this package's
 * existing style (loadHookmap, buildEnvelope take every dependency as an
 * argument; nothing here relies on hidden shared state) and so a test can
 * hold its own store without one test's handshake bleeding into another's
 * assertions.
 */

/** The two fields of the Guardian's answer this host actually reads, which is
 * what makes this the stored config rather than a claim about the wire message.
 * Loose on purpose beyond them: a later slice's negotiation may return fields
 * this slice never names -- `Record<string, unknown>` lets those round-trip
 * through the store untouched rather than being silently dropped. */
export type SessionConfig = {
  timeout_config: { default_ms: number; per_method_ms?: Record<string, number> };
  on_decision_failure: "proceed" | "deny";
} & Record<string, unknown>;

export type SessionConfigStore = {
  /** The most recently stored config, or undefined before any handshake completes. */
  get(): SessionConfig | undefined;
  /** Overwrites the stored config. Called by negotiateSessionConfig (N5) with
   * the config it validated out of the Guardian's ServerHello. */
  set(config: SessionConfig): void;
};

/**
 * A `SessionConfig` must at minimum carry the two fields this host reads. The
 * predicate exists so `negotiateSessionConfig` (N5) can ASK that question of
 * the Guardian's ServerHello before storing one, instead of casting the
 * arrival into this type and calling it a config (PR #10 review, Important):
 * `as unknown as SessionConfig` made the name a claim nothing checked, which
 * is the same defect as a type named for a validation it does not perform.
 *
 * Deliberately NOT the five fields handshake.json's ServerHello $def requires.
 * This checks what this host needs, so `SessionConfig` is the honest name for
 * what it certifies; naming the stored type after the wire message would
 * over-claim in exactly the way the cast did.
 */
export function isSessionConfig(value: unknown): value is SessionConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const posture = candidate.on_decision_failure;
  const timeout = candidate.timeout_config;
  return (
    (posture === "proceed" || posture === "deny") &&
    typeof timeout === "object" &&
    timeout !== null &&
    typeof (timeout as Record<string, unknown>).default_ms === "number"
  );
}

/** Creates a fresh, empty session config store. */
export function createSessionConfigStore(): SessionConfigStore {
  let current: SessionConfig | undefined;
  return {
    get(): SessionConfig | undefined {
      return current;
    },
    set(config: SessionConfig): void {
      current = config;
    },
  };
}
