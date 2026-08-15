/**
 * S3/S4/S5: the Guardian's per-session state, and the hash chain that orders
 * it.
 *
 * THREE AFFORDANCES, THREE TYPES, AND ONE AGGREGATE OVER THEM. `SessionContext`
 * is S3 and only S3 -- a session's entries and the digests that link them.
 * `Intent` is S4, `SessionProvenance` is S5, and `SessionState` is what the
 * store holds for one session: the three together. The chain's name used to sit
 * on that aggregate, so S3 read as the thing that also carried an intent and a
 * provenance record, and `loadSessionContext` returned something wider than its
 * own name (PR #15 review).
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
 * AGT's IFC tags: the type of the `ifc_labels` field below, and nothing wider.
 *
 * NOT A STORE, and the name is not one either. This Guardian has no separate
 * IFC label store: the labels are a field on a session's provenance record,
 * held alongside that session's chain and intent by the one thing here called
 * a store, `SessionContextStore` (slices/v6/README.md, commitment 2).
 *
 * ACS `Provenance` -- `spec/acs/specification/v0.1.0/provenance.json`, which
 * defines `provenance_id`, `origin`, `source_id`, `derived_from` -- carries no
 * label member. V6 does not widen it into a label bag; the labels ride a NAMED
 * FIELD on the record below.
 */
export type IfcLabels = readonly string[];

/**
 * `origin`'s seven values, as `spec/acs/specification/v0.1.0/provenance.json`
 * enumerates them. A union rather than `string`, so a value outside the
 * spec's enum is a compile error here rather than a schema failure wherever
 * this record is eventually read.
 */
export type ProvenanceOrigin =
  | "user_input"
  | "system"
  | "tool_output"
  | "retrieved"
  | "agent_generated"
  | "a2a_inbound"
  | "external";

/**
 * S5: the provenance record the Guardian synthesizes PER SESSION -- ACS
 * `Provenance` as v0.1.0 defines it, plus the one field carrying AGT's labels.
 *
 * `Session`-prefixed because this codebase has two provenance records and they
 * never meet (PR #15 review). The other one is on the WIRE: the optional
 * `provenance` member of each `{value, provenance}` argument and output an ACS
 * payload carries, typed `unknown` on the way in and stripped before any
 * snapshot is assembled (C5). This record is synthesized here, one per session,
 * seeded at the lattice floor, and never reads that member. Under one bare
 * `Provenance` a reader of provenance.json and a reader of this type had every
 * reason to think they were looking at the same record.
 */
export type SessionProvenance = {
  provenance_id: string;
  origin: ProvenanceOrigin;
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

/** S3: one session's hash chain, and nothing else the session happens to own. */
export type SessionContext = {
  session_id: string;
  entries: readonly SessionContextEntry[];
};

/**
 * S3 + S4 + S5: everything `SessionContextStore` holds for one session, named
 * for the aggregate it is rather than for the one of its three members that
 * gives the store its name.
 */
export type SessionState = {
  context: SessionContext;
  intent: Intent | undefined;
  provenance: SessionProvenance;
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

/** A session with no history yet: no entries, no intent, and its labels at the lattice floor. */
export function emptySessionState(sessionId: string): SessionState {
  return {
    context: { session_id: sessionId, entries: [] },
    intent: undefined,
    // `origin` names where data entered the system, and this record is one the
    // Guardian synthesizes to hold a session's labels -- so "system", with the
    // Guardian named in `source_id`, which is the member the spec gives for
    // "identifier within the origin".
    provenance: {
      provenance_id: `acs:session:${sessionId}`,
      origin: "system",
      source_id: "acs.guardian",
      // The lattice floor, and the deployment-supplied first label this slice
      // exists to demonstrate the need for. ACS v0.1.0 carries no label field
      // (`spec/acs/specification/v0.1.0/provenance.json` defines
      // provenance_id/origin/source_id/derived_from and nothing a sensitivity
      // could be read from), and AGT's gate denies a zero-label flow outright
      // rather than waving it through: `flow_allowed` in
      // `policy/lib/agt_ifc.rego` requires `count(labels) > 0`. A session with
      // no seed is therefore a session that can do nothing at all.
      ifc_labels: ["public"],
    },
  };
}
