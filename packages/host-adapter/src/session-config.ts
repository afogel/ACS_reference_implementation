/**
 * The negotiated session config store: where `negotiateSessionConfig` writes
 * this session's config once capability negotiation completes.
 *
 * `SessionConfig` is the one noun for that stored message, here as in
 * handshake.ts. "ServerHello" names what the Guardian sent, and appears below
 * only where the subject genuinely is the arrival rather than the stored value.
 *
 * Two implementations share one interface: an in-memory store for an
 * in-process host, and a file-backed store for a host whose hooks run as
 * fresh subprocesses (Claude Code) and so cannot share memory across a
 * handshake and the tool call that follows it. N6/N7 (slice V3) read
 * whichever store the host wired up, without knowing which one it is.
 *
 * A factory rather than a module-level singleton, matching this package's
 * existing style (loadHookmap, buildEnvelope take every dependency as an
 * argument; nothing here relies on hidden shared state) and so a test can
 * hold its own store without one test's handshake bleeding into another's
 * assertions.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The two fields of the Guardian's answer this host actually reads, which is
 * what makes this the stored config rather than a claim about the wire message.
 * Loose on purpose beyond them: a Guardian may return fields this host never
 * names, and `Record<string, unknown>` lets those round-trip through the store
 * untouched rather than being silently dropped. */
export type SessionConfig = {
  timeout_config: { default_ms: number; per_method_ms?: Record<string, number> };
  on_decision_failure: "proceed" | "deny";
} & Record<string, unknown>;

export type SessionConfigStore = {
  /** The most recently stored config, or undefined before any handshake completes. */
  get(): SessionConfig | undefined;
  /** Overwrites the stored config. Called by negotiateSessionConfig with the
   * config it validated out of the Guardian's ServerHello. */
  set(config: SessionConfig): void;
};

/**
 * A `SessionConfig` must at minimum carry the two fields this host reads. The
 * predicate exists so `negotiateSessionConfig` can ASK that question of the
 * Guardian's ServerHello before storing one, rather than casting the arrival
 * into this type and calling it a config -- a cast would make the name a claim
 * nothing checked.
 *
 * Deliberately NOT the five fields handshake.json's ServerHello $def requires.
 * This checks what this host needs, so `SessionConfig` is the honest name for
 * what it certifies; naming the stored type after the wire message would
 * over-claim in exactly the way a cast would.
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

/**
 * A `session_id` reaches this module from a host payload and becomes part of
 * a filesystem path, so it is validated as untrusted input: one path segment
 * of safe characters, nothing else. `.` and `..` are excluded by the dot
 * rule below rather than by the character class, which would admit both.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export class InvalidSessionIdError extends Error {
  constructor(sessionId: unknown) {
    super(
      `session_id ${JSON.stringify(sessionId)} is not a safe path segment: ` +
        "expected 1-128 characters of [A-Za-z0-9._-], and neither \".\" nor \"..\"",
    );
    this.name = "InvalidSessionIdError";
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new InvalidSessionIdError(sessionId);
  }
}

/** Where a session's negotiated config lives. Exported so tests and the
 * runbook name the same path this module writes. */
export function sessionConfigPath(dir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(dir, `${sessionId}.json`);
}

/**
 * A `SessionConfig` must at minimum carry the two fields N6 and the client
 * timeout read. Anything less is treated as "not negotiated" rather than
 * trusted half-way: the caller then applies the ACS default, which is a
 * defined posture, where a half-read config is not.
 */
function isSessionConfig(value: unknown): value is SessionConfig {
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

export type CreateFileSessionConfigStoreOptions = {
  /** Directory holding one file per session. Created on first write. */
  dir: string;
  /** The host's session identifier. Untrusted: validated here, once. */
  sessionId: string;
};

/**
 * S13 with a home that outlives the process (P1).
 *
 * The Claude Code shim is a fresh subprocess per hook, so the negotiated
 * ServerHello has to be readable by a process that never handshook. It also
 * has to be readable when the Guardian is unreachable -- that is the only
 * situation the posture exists for -- which is why this is a local file and
 * not a lookup.
 *
 * `get` is TOTAL: a missing, unreadable, malformed, or partial file returns
 * undefined, never throws. The caller resolves undefined to the ACS default
 * (`proceed`, audited). A throw here would kill the hook process and take
 * the decision with it -- the exact failure this store exists to prevent.
 *
 * `set` writes to a temp file and renames, so a concurrent reader (Claude
 * Code may run hooks in parallel) sees either the old complete config or the
 * new one, never a half-written file.
 */
export function createFileSessionConfigStore({
  dir,
  sessionId,
}: CreateFileSessionConfigStoreOptions): SessionConfigStore {
  const path = sessionConfigPath(dir, sessionId);

  return {
    get(): SessionConfig | undefined {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
      return isSessionConfig(parsed) ? parsed : undefined;
    },

    set(config: SessionConfig): void {
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      try {
        writeFileSync(temp, `${JSON.stringify(config)}\n`);
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file may not exist; nothing to clean up.
        }
        throw error;
      }
    },
  };
}
