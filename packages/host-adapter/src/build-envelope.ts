/**
 * buildEnvelope (N2) turns a host's own hook invocation into an ACS v0.1.0
 * request envelope (steps/* methods), driven entirely by a hookmap (S1) --
 * never by host-specific literals baked into this function.
 *
 * R3.2: this package knows ACS and hookmaps, nothing else. No file under
 * packages/host-adapter/ may name a policy runtime, its rule language, or
 * its decision vocabulary -- verified mechanically by Task 10's grep gate.
 * This module has no runtime dependency on the Guardian package or the
 * policy-bridge package that sits behind it; it talks to the Guardian
 * over the wire (Task 8), never in-process.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** One hook's mapping onto an ACS method: S1's `hooks.<hookName>` entry. */
export type HookmapHookEntry = {
  /** The ACS `steps/*` method this hook fires. Never hardcoded here. */
  acs_method: string;
  /** JSONPath-lite (`$.foo.bar`) into the raw hook payload for the tool/step name. */
  tool_name: string;
  /** JSONPath-lite (`$.foo.bar`) into the raw hook payload for the argument bag. */
  arguments: string;
};

/**
 * S1 in full: hook-name -> ACS method mapping (consumed here) plus
 * decision -> host-output mapping (consumed by Task 8's renderDecision,
 * not by this module -- present on the type only so a hookmap loaded
 * whole, as `loadHookmap` does, round-trips without loss).
 */
export type Hookmap = {
  host: string;
  hooks: Record<string, HookmapHookEntry>;
  decisions?: Record<string, unknown>;
};

/** An ACS argument wrapper: every hook argument is `{value, provenance?}`. */
type AcsArgument = { value: unknown };

/** The ACS v0.1.0 request envelope this module produces. */
export type AcsRequestEnvelope = {
  jsonrpc: "2.0";
  method: string;
  id: string;
  params: {
    acs_version: string;
    request_id: string;
    timestamp: string;
    metadata: {
      agent_id: string;
      session_id: string;
    };
    payload: {
      tool: { name: string };
      arguments: Record<string, AcsArgument>;
    };
  };
};

const ACS_VERSION = "0.1.0";

/** Loads and parses a hookmap YAML file (e.g. S1's claude-code.hookmap.yaml). */
export function loadHookmap(path: string): Hookmap {
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Hookmap;
}

/**
 * Resolves a JSONPath-lite reference (`$.foo.bar`, or `$` alone) against a
 * raw hook payload. Only dotted field access is supported -- every S1
 * path in this slice is a single top-level field, and nothing here needs
 * array indexing or filters.
 */
function resolvePath(payload: Record<string, unknown>, path: string): unknown {
  const segments = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fixed, arbitrary namespace UUID used only to derive a stable v5 UUID from
// a host session id that is not itself a UUID -- Claude Code's session_id
// is host-assigned free-form text with no uuid guarantee, but ACS's
// metadata.session_id schema field requires format "uuid". Never
// regenerate this constant: doing so changes every derived session_id.
const SESSION_ID_NAMESPACE = "11c79ebd-8469-4b4e-8de0-72674add484c";

/**
 * Maps a host's raw session id onto a schema-valid uuid. If the host
 * already hands us a uuid, it is carried through unchanged (lowercased).
 * Otherwise a RFC 4122 version-5 (namespace + SHA-1) uuid is derived
 * deterministically -- the same raw session id always derives the same
 * uuid, so per-session correlation on the Guardian side survives the
 * translation honestly, rather than a random uuid being minted and
 * silently discarding the host's real session identity.
 */
export function toSessionUuid(rawSessionId: string): string {
  if (UUID_RE.test(rawSessionId)) {
    return rawSessionId.toLowerCase();
  }

  const namespaceBytes = Buffer.from(SESSION_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([namespaceBytes, Buffer.from(rawSessionId, "utf8")]))
    .digest();

  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds an ACS v0.1.0 request envelope from a raw hook invocation.
 * `hookmap` drives every host-shape decision: the ACS method, and where
 * the tool/step name and argument bag live in the raw payload. An event
 * name absent from `hookmap.hooks` throws -- there is no default method
 * and no partial envelope.
 */
export function buildEnvelope(event: string, payload: Record<string, unknown>, hookmap: Hookmap): AcsRequestEnvelope {
  const entry = hookmap.hooks[event];
  if (!entry) {
    throw new Error(`buildEnvelope: hookmap has no entry for hook "${event}"`);
  }

  const toolName = resolvePath(payload, entry.tool_name);
  if (typeof toolName !== "string") {
    throw new Error(
      `buildEnvelope: hookmap path "${entry.tool_name}" for hook "${event}" did not resolve to a string`,
    );
  }

  const rawArguments = resolvePath(payload, entry.arguments);
  const args: Record<string, AcsArgument> = {};
  if (rawArguments !== null && typeof rawArguments === "object") {
    for (const [key, value] of Object.entries(rawArguments as Record<string, unknown>)) {
      args[key] = { value };
    }
  }

  const rawSessionId = payload.session_id;
  if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
    throw new Error(`buildEnvelope: hook payload for "${event}" is missing a "session_id" string field`);
  }

  const requestId = randomUUID();

  return {
    jsonrpc: "2.0",
    method: entry.acs_method,
    id: requestId,
    params: {
      acs_version: ACS_VERSION,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: {
        agent_id: hookmap.host,
        session_id: toSessionUuid(rawSessionId),
      },
      payload: {
        tool: { name: toolName },
        arguments: args,
      },
    },
  };
}
