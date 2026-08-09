/**
 * The negotiated session config store (S13): where handshake() (N5) writes
 * the Guardian's ServerHello once a session's capability negotiation
 * completes.
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

/** The fields of the Guardian's ServerHello this store holds. Loose on
 * purpose: a later slice's negotiation may return fields this slice never
 * names -- `Record<string, unknown>` lets those round-trip through the
 * store untouched rather than being silently dropped. */
export type SessionConfig = {
  timeout_config: { default_ms: number; per_method_ms?: Record<string, number> };
  on_decision_failure: "proceed" | "deny";
} & Record<string, unknown>;

export type SessionConfigStore = {
  /** The most recently stored config, or undefined before any handshake completes. */
  get(): SessionConfig | undefined;
  /** Overwrites the stored config. Called by handshake() (N5) with the Guardian's ServerHello. */
  set(config: SessionConfig): void;
};

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
