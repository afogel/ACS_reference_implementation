/**
 * S3/S4/S5: the Guardian's per-session state, and the hash chain that orders
 * it.
 *
 * DECLARED HERE, NOT IN `@acs/host-adapter`, and that is R6.2/A3 rather than
 * a filing preference: the adapter is what a HOST links against, and a host
 * neither writes this chain nor is trusted to. `@acs/host-adapter` already
 * exports a `Session*` cluster -- `SessionConfig`, `SessionConfigStore`,
 * `ResolvedSessionConfig` and friends -- and every one of them is about the
 * handshake. `SessionContext` is a different object with a different owner,
 * so it is never shortened to `session`, and the two names always appear
 * written out in full (slices/v6/README.md, commitment 1).
 *
 * THIS CHAIN DOES NOT INHERIT S14's DUPLICATE-`seq` HAZARD, and the reason is
 * structural rather than careful. Risk row 13 of the slices doc says a
 * per-session monotonic sequence "would need the duplicate closed first" --
 * true of S14's, which a fresh host subprocess derives per hook by re-reading
 * the log, so two concurrent hooks can derive the same number. `seq` here is
 * assigned by the store that owns the chain, in the Guardian's single
 * `Bun.serve` process, and the ORDER is carried by `prev_hash` rather than by
 * the counter: two entries claiming the same `seq` would still have to agree
 * on a hash covering the entry before them. `seq` is an index for readers,
 * not the chain's integrity.
 */
import { createHash } from "node:crypto";

/**
 * AGT's IFC tags, as a store rather than as ACS `Provenance`.
 *
 * `Provenance` is the object `spec/acs/specification/v0.1.0/provenance.json`
 * defines -- `provenance_id`, `origin`, `source_id`, `derived_from` -- and it
 * carries no label member. V6 does not widen it into a label bag; the labels
 * ride a NAMED FIELD on the record below (slices/v6/README.md, commitment 2).
 */
export type IfcLabels = readonly string[];

/** ACS `Provenance` as v0.1.0 defines it, plus the one field carrying AGT's labels. */
export type Provenance = {
  provenance_id: string;
  origin: string;
  source_id?: string;
  derived_from?: readonly string[];
  /** AGT's labels. A field ON the provenance record, not a redefinition of it. */
  ifc_labels: IfcLabels;
};

/** S4: the immutable per-session baseline. First one written wins. */
export type Intent = { readonly text: string; readonly recorded_at: string };

/** What a step contributes to the chain. Deliberately not the whole envelope. */
export type SessionStep = { method: string; request_id: string; tool_name: string };

export type SessionContextEntry = {
  session_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  recorded_at: string;
  method: string;
  request_id: string;
  tool_name: string;
};

export type SessionContext = {
  session_id: string;
  intent: Intent | undefined;
  entries: readonly SessionContextEntry[];
  provenance: Provenance;
};

/** The `prev_hash` of a session's first entry. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The hash covering one entry: its predecessor, its position, and its own
 * facts. Key order is fixed by the literal below rather than by
 * `JSON.stringify` of a caller's object, so the digest cannot change because
 * a field was declared somewhere else.
 */
export function hashEntry(input: Omit<SessionContextEntry, "hash">): string {
  const canonical = JSON.stringify([
    input.prev_hash,
    input.session_id,
    input.seq,
    input.recorded_at,
    input.method,
    input.request_id,
    input.tool_name,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A session with no history yet: no intent, no entries, no labels. */
export function emptySessionContext(sessionId: string): SessionContext {
  return {
    session_id: sessionId,
    intent: undefined,
    entries: [],
    provenance: { provenance_id: `acs:session:${sessionId}`, origin: "acs.guardian", ifc_labels: [] },
  };
}
