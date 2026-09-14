/**
 * N41: `normalizeTrace()` -- an envelope log into the vocabulary's wire
 * relations (S9).
 *
 * The trace is JSON Lines. Each line is either the Guardian's envelope-log
 * entry, `{seq, recorded_at, direction, method, rpc_id, envelope}`, or a
 * bare JSON-RPC message, in which case direction is read from its shape
 * (`method` present: a request) and `seq` is the line number. Sessions come
 * from `params.metadata.session_id`; a response inherits its request's
 * session through the JSON-RPC id. Nothing here judges anything: every
 * relation is a plain restatement of what the wire carried, so a predicate
 * can be checked against the log without re-reading the log.
 */
import { readFileSync } from "node:fs";
import type { FactSet, Tuple } from "./facts.ts";
import { canonicalize, sha256Hex } from "./jcs.ts";

export interface TraceLine {
  seq: number;
  direction: "request" | "response";
  method: string | null;
  rpc_id: string | null;
  envelope: unknown;
}

export interface SessionInfo {
  session: string;
  /** Profiles the session negotiated: ServerHello's `profiles_accepted`, else ClientHello's `profiles_supported`, else `acs-core`. */
  profiles: string[];
  negotiated_version: string | null;
}

export interface NormalizedTrace {
  lines: TraceLine[];
  facts: FactSet;
  sessions: SessionInfo[];
  /** `seq` of each request -> its session; responses map through `response_to`. */
  sessionOf: Map<number, string>;
}

export function readTrace(path: string): TraceLine[] {
  return parseTrace(readFileSync(path, "utf8"));
}

export function parseTrace(text: string): TraceLine[] {
  const lines: TraceLine[] = [];
  let n = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    n++;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if ("envelope" in value && typeof value.direction === "string") {
      lines.push({
        seq: typeof value.seq === "number" ? value.seq : n,
        direction: value.direction === "response" ? "response" : "request",
        method: typeof value.method === "string" ? value.method : methodOf(value.envelope),
        rpc_id: idOf(value.envelope) ?? (value.rpc_id === undefined || value.rpc_id === null ? null : String(value.rpc_id)),
        envelope: value.envelope,
      });
    } else {
      const isRequest = Array.isArray(value) ? true : "method" in value;
      lines.push({ seq: n, direction: isRequest ? "request" : "response", method: methodOf(value), rpc_id: idOf(value), envelope: value });
    }
  }
  return lines;
}

export function normalizeTrace(lines: TraceLine[]): NormalizedTrace {
  const facts: FactSet = new Map();
  const add = (relation: string, tuple: Tuple): void => {
    facts.set(relation, [...(facts.get(relation) ?? []), tuple]);
  };
  const sessionOf = new Map<number, string>();
  const requestByRpc = new Map<string, number>();
  const sessions = new Map<string, SessionInfo>();
  const lastHead = new Map<string, string>();

  for (const line of lines) {
    const env = firstEnvelope(line.envelope);
    if (line.direction === "request") {
      const params = obj(env?.params);
      const metadata = obj(params?.metadata);
      const session = str(metadata?.session_id) ?? "";
      const method = line.method ?? str(env?.method) ?? "";
      sessionOf.set(line.seq, session);
      if (line.rpc_id !== null) requestByRpc.set(line.rpc_id, line.seq);
      add("envelope", [line.seq, session, "request", method, line.rpc_id ?? ""]);
      add("request", [line.seq, session, method, str(params?.request_id) ?? "", str(params?.timestamp) ?? ""]);
      if (Array.isArray(line.envelope)) add("array_input", [line.seq]);
      if (method === "handshake/hello") {
        add("handshake", [line.seq, session]);
        const hello = obj(params?.payload) ?? params;
        for (const v of arr(hello?.acs_versions_supported)) if (typeof v === "string") add("client_version", [session, v]);
        const info = sessions.get(session) ?? { session, profiles: [], negotiated_version: null };
        const supported = arr(hello?.profiles_supported).filter((p): p is string => typeof p === "string");
        if (info.profiles.length === 0 && supported.length) info.profiles = supported;
        sessions.set(session, info);
      }
      if (method.startsWith("steps/")) add("hook", [line.seq, session, method]);
      if (!sessions.has(session) && session !== "") sessions.set(session, { session, profiles: [], negotiated_version: null });
      // Provenance objects anywhere in the payload.
      for (const p of findProvenance(params?.payload)) {
        add("provenance", [line.seq, session, p.provenance_id, p.origin]);
        add("provenance_fingerprint", [session, p.provenance_id, sha256Hex(canonicalize(p)).slice(0, 16)]);
        for (const parent of arr(p.derived_from)) if (typeof parent === "string") add("derived_from", [line.seq, p.provenance_id, parent]);
        if (typeof p.trust === "string") add("trust", [line.seq, p.provenance_id, p.trust]);
      }
      // §8: the Observed Agent's cross-check head, against the last head the Guardian published for the session.
      const crossCheck = str(obj(metadata?.session_state)?.chain_hash);
      const published = lastHead.get(session);
      if (crossCheck !== null && published !== undefined && crossCheck !== published) add("chain_mismatch_observed", [session, line.seq]);
      continue;
    }

    // A response: pair it, then read its result or error.
    const requestSeq = line.rpc_id !== null ? requestByRpc.get(line.rpc_id) : undefined;
    const session = requestSeq !== undefined ? (sessionOf.get(requestSeq) ?? "") : "";
    sessionOf.set(line.seq, session);
    add("envelope", [line.seq, session, "response", line.method ?? "", line.rpc_id ?? ""]);
    if (requestSeq !== undefined) add("response_to", [requestSeq, line.seq]);
    const result = obj(env?.result);
    const error = obj(env?.error);
    if (error && typeof error.code === "number") add("error_code", [line.seq, error.code]);
    if (result) {
      for (const field of Object.keys(result)) add("result_field", [line.seq, field]);
      const decision = str(result.decision);
      if (decision !== null) add("decision", [line.seq, decision.toLowerCase()]);
      const head = str(result.chain_hash);
      if (head !== null) {
        add("chain_hash_published", [line.seq, head]);
        lastHead.set(session, head);
      }
      const defer = obj(result.defer_details);
      if (defer) {
        for (const field of Object.keys(defer)) add("defer_field", [line.seq, field]);
        const reason = str(defer.reason);
        if (reason !== null) add("defer_reason", [line.seq, reason]);
      }
      const accepted = arr(result.profiles_accepted).filter((p): p is string => typeof p === "string");
      if (accepted.length && session) {
        const info = sessions.get(session) ?? { session, profiles: [], negotiated_version: null };
        info.profiles = accepted;
        info.negotiated_version = str(result.negotiated_version);
        sessions.set(session, info);
      }
    }
  }

  const sessionList = [...sessions.values()].map((s) => ({ ...s, profiles: s.profiles.length ? s.profiles : ["acs-core"] }));
  return { lines, facts, sessions: sessionList, sessionOf };
}

interface ProvenanceObject {
  provenance_id: string;
  origin: string;
  source_id?: unknown;
  derived_from?: unknown;
  trust?: unknown;
}

export function findProvenance(value: unknown, out: ProvenanceObject[] = []): ProvenanceObject[] {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (const v of value) findProvenance(v, out);
    return out;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.provenance_id === "string" && typeof o.origin === "string") {
    const p: ProvenanceObject = { provenance_id: o.provenance_id, origin: o.origin };
    if (o.source_id !== undefined) p.source_id = o.source_id;
    if (o.derived_from !== undefined) p.derived_from = o.derived_from;
    if (o.trust !== undefined) p.trust = o.trust;
    out.push(p);
  }
  for (const v of Object.values(o)) findProvenance(v, out);
  return out;
}

function firstEnvelope(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return obj(value[0]);
  return obj(value);
}

function methodOf(value: unknown): string | null {
  return str(firstEnvelope(value)?.method);
}

function idOf(value: unknown): string | null {
  const id = firstEnvelope(value)?.id;
  return id === undefined || id === null ? null : String(id);
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
