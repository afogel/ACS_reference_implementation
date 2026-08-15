# V6: Session state and provenance carriage

**Demo:** The SessionContext chain grows per step. AGT emits `result_labels` at one step and gets them back as `input.ifc.source_labels` at the next, carried in the `IfcLabels` field of the ACS provenance record.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V6 — authoritative for this slice's scope.

**Affordances:** U22, N22, N25, S3, S4, S5 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## Names frozen before implementation

No V6 code exists yet, which is the only reason this section can be written at all.
`@acs/host-adapter` already exports a cluster of `Session*` names — `SessionConfig`,
`SessionConfigStore`, `ResolvedSessionConfig`, `SessionConfigNotStoredError`,
`SessionConfigStoreFailedError`, `SessionFailureKind` — and every one of them is about
the handshake. This slice introduces a session-shaped noun that is about something else
entirely. Left to implementation time, that name gets chosen once, in one file, by
whoever writes it first, and every later file inherits it.

Each numbered sentence below is a commitment a future implementer can be held to. None
of them describes measured behaviour: there is no V6 behaviour to measure yet, so each
one fixes a name and the role that name must fill, and nothing more.

1. **`SessionContext` and `SessionConfig` are two different objects, and both names stay
   written out in full.** `SessionConfig`
   (`packages/host-adapter/src/session-config.ts`) is the stored negotiated-handshake
   value — the `timeout_config` and `on_decision_failure` this host reads back out of
   S13/S15 after `negotiateSessionConfig` writes it. `SessionContext` is this slice's
   hash-chained per-`session_id` state (S3). Neither is ever shortened to `session` in a
   type, parameter, field, or file name, and `SessionContext` is declared in the Guardian
   (R6.2, A3) rather than added to `@acs/host-adapter`. The precedent is exactly one
   object old: PR #10's review spent a round keeping `SessionConfig` distinct from
   `ServerHello` — the stored value versus the message that arrived — and V5 renamed the
   in-memory factory to `createMemorySessionConfigStore` so that it reads as the twin of
   `createFileSessionConfigStore` rather than as the default one.

2. **The IFC label store is named for IFC, and ACS `Provenance` is not that store.** The
   store's type is `IfcLabels`; its entries are the `source_labels` AGT reads back at
   `input.ifc.source_labels`. ACS `Provenance` is the object
   `spec/acs/specification/v0.1.0/provenance.json` defines — `provenance_id`, `origin`,
   `source_id`, `derived_from` — and it is already a defined field on every tool argument
   and every result output item in the v0.1.0 hook schemas (optional in the base schema,
   required under the ACS-Provenance profile). V6 does not rename it, widen it into a
   label bag, or describe it as the label store. Where the labels ride provenance they
   ride a named `IfcLabels` field on the provenance record, and every document naming
   that arrangement calls it a **field**.

3. **N25 is `persistIfcLabels()`, twinned with `supplySourceLabels()`.** They are the two
   halves of the round trip the demo sentence describes: one writes AGT's `result_labels`
   into the `IfcLabels` field once a verdict has been mapped, the other reads them back
   out as `input.ifc.source_labels` for the next snapshot. The retired name
   `persistResultLabels()` is not revived, because this Guardian has had a genuine result
   gate since V4 — `post_tool_call` — so "result labels" reads as that gate's labels
   rather than as AGT's IFC tags.

4. **N22 is `appendContextEntry()`, twinned with `loadSessionContext()`.** They are the
   writer and the reader of S3's hash chain and are named as a pair. The retired name
   `appendSessionEntry()` is what forced the change: set beside any `SessionContext`
   reader it yields `loadSessionContext` / `appendSessionEntry`, two different nouns for
   one store.

5. **Session state must be injected into both `assemblePreToolCallSnapshot` and
   `assemblePostToolCallSnapshot`, once per assembler.** Both ship today in
   `packages/guardian/src/assemble-snapshot.ts`, envelope-only, and that file's own
   header names V6 as where S3/S4/S5 arrive. N23 does not collapse into a single function
   that asks which intervention point it is on — that is the union PR #10's review closed
   and §V4 of the master doc re-closed, and it would arrive here wearing the excuse that
   the assembler needs session state either way.

## What shipped, and where

Every affordance §V6 names now has a file. `docs/demos/v6-runbook.md` is the run;
this is the map.

**U22 — the session chain view, and it checks the chain rather than only printing it.**
`packages/inspector/src/tail-session-context.ts` streams S3's JSONL as it grows, with the
same contract `tail-audit-log.ts` already had. `renderSessionChainRow`
(`packages/inspector/src/render.ts`) prints one row per entry and marks it
`✖ CHAIN BREAK` when its `prev_hash` does not match the last `hash` seen **for the same
`session_id`** — read out of a `SessionChainState`, never out of whatever line happened
to come before it, because one log carries every session the Guardian saw, in append
order, so two interleaved sessions would otherwise read as a break on every switch.
`packages/inspector/src/main.ts` tails it beside S6 and S14, under
`--session-context-log` / `ACS_SESSION_CONTEXT_LOG`. The Inspector imports nothing from
`guardian` (R5.1) and re-declares `SessionContextLogEntry` itself;
`test/session-context-roundtrip.test.ts` is what keeps the two declarations one contract,
in both directions — a runtime `toEqual` against the entry the store actually returned,
and two type-level assignments `bun run typecheck` enforces.

**N22 — `appendContextEntry()`, twinned with `loadSessionContext()`.**
`packages/guardian/src/session-context-store.ts`. `evaluateStep`
(`packages/guardian/src/server.ts`) calls it on **arrival**, before a snapshot is
assembled and before any verdict exists, so a step that is later denied is still a step
the chain records. The entry carries `method`, `request_id`, and `tool_name` — never a
decision, so nothing downstream can read a prior verdict out of S3, because none is
stored.

**N25 — `persistIfcLabels()`, twinned with `supplySourceLabels()`.**
`packages/guardian/src/ifc-labels.ts`. `evaluateStep` calls `supplySourceLabels` before
assembling and `persistIfcLabels` after `mapVerdict`. An **absent** `result_labels` (the
IFC gate did not run, or a higher-severity gate answered instead) leaves the session's
labels alone; an explicitly **empty** one clears them. Both directions copy the array, so
neither a snapshot nor a caller's own array is a way to edit S5.

**N23 — session state reaches both assemblers, once each.**
`packages/guardian/src/assemble-snapshot.ts`. `assemblePreToolCallSnapshot` and
`assemblePostToolCallSnapshot` each take an `AgtSessionState` **value** — not the store —
and each emits `input.ifc.source_labels`. Nested under `input`, because
`policy/lib/agt_ifc.rego` resolves `input.snapshot.input.ifc.source_labels`; the shorter
`ifc` at the snapshot root reads as `[]`, which that module's own
`test_does_not_read_upstream_ifc_path` pins and which `test/ifc-round-trip.test.ts`
re-measures against the shipped bundle.

**S3 — the chain.** `packages/guardian/src/session-context.ts` declares
`SessionContextEntry`, `GENESIS_HASH` (64 zeros, the `prev_hash` of a session's first
entry), and `hashEntry`, whose digest covers the predecessor's hash, the session id, the
`seq`, the timestamp, and the three step fields, in a key order fixed by a literal rather
than by `JSON.stringify` of a caller's object. `startGuardian`'s `sessionContextLog`
option wires an optional JSONL projection of the store — the store is authoritative, the
file is what U22 reads, the same relationship S6 has to the envelopes it records — and
that projection's writer is total: `packages/guardian/test/server.test.ts` drives a
Guardian whose session-context log cannot be created and asserts the tool call still
comes back `allow`.

**S4 — `Intent`, immutable, and with no shipped writer.** `setIntent` keeps the first
text a session declares and drops later ones. Nothing on the Guardian's request path
calls it: `hooks/tool-call-request.json` does carry an optional `intent` object
(`description`, `goal`), and no code in this slice reads it into S4. The store affordance
and its immutability rule ship and are tested
(`packages/guardian/test/session-context.test.ts`); the wiring from the wire field does
not.

**S5 — `Provenance`, carrying the labels on a named field.** `Provenance` is
`spec/acs/specification/v0.1.0/provenance.json`'s object — `provenance_id`, `origin`,
`source_id`, `derived_from` — plus `ifc_labels`, typed `IfcLabels`. `origin` is typed as
the spec's seven-value enum rather than `string`. One record per session, synthesized by
the Guardian (`acs:session:<session_id>`, `origin: "system"`, `source_id: "acs.guardian"`),
seeded at `["public"]`. It is **not** the per-argument `Provenance` an ACS payload can
carry: `assemblePreToolCallSnapshot` unwraps each argument's `{value, provenance}` to
`value` alone (C5), so no wire-supplied provenance reaches S5, and none carries a label
anyway — see `docs/shaping/acs-reference-impl-slices.md` §V6.

**The policy-side behaviour change is one key.** `policy/lib/data.json` gains
`config.ifc.sink_clearance: "confidential"`, which is what turns AGT's stock IFC gate on;
no Rego is authored, and `bun run verify:pin` re-clones AGT at the ref `agt.lock` names
and asserts every `.rego` under `policy/lib` is byte-identical to it (`test/pin.test.ts`,
which also asserts the bundle carries no added file but `data.json`). `policy/manifest.yaml`
also changed on this branch, in **comments only**, to follow the assembler rename.

## Where the shipped name differs from the sentence above

The commitments held. Three divergences are worth naming, each one a place where what
shipped is not literally the name its sentence uses, and the honest record is to say so
rather than to edit the sentence.

- **Commitment 2 — there is no separate IFC label store, and `IfcLabels` names the labels
  rather than a store.** `IfcLabels` is `readonly string[]`
  (`packages/guardian/src/session-context.ts`): the type of the labels, and of the
  `ifc_labels` field they ride on `Provenance`. The store is `SessionContextStore`, which
  holds the whole `SessionContext` including that record. What the commitment was for is
  intact — `Provenance` was not renamed, widened into a label bag, or described as the
  store, and the labels ride a named field on it.
- **Commitments 2 and 3 — the field is `ifc_labels`; `IfcLabels` is its type.** The
  sentences say "the `IfcLabels` field", and §V6's demo sentence and affordance table say
  it too. Grepping for a field of that name finds nothing; the declaration is
  `ifc_labels: IfcLabels`.
- **Commitment 1 — the bare identifier `session` does appear, and where it does its type
  is neither of the two the sentence governs.** `SessionContext` and `SessionConfig` are
  never shortened anywhere. `assemble-snapshot.ts` declares a third type,
  `AgtSessionState` — the resolved value an assembler injects, not the context it came
  from — and names that parameter `session`, in `ifcMember` and in both assemblers;
  `server.ts` repeats it in the assembler's function type. Nothing typed `SessionContext`
  is ever bound to a name shorter than the type.

## What this slice measured, and what it did not

Both are in `docs/demos/v6-runbook.md` with the runs attached; the wire finding and the
three the gate produced are filed at
`docs/shaping/acs-reference-impl-slices.md` §V6. The short version of the limit: **the
round trip is measured in pieces.** No single test drives a real Guardian over two steps
against the real bundle *and* asserts the labels, and today such a test could only show
`public → public`, because AGT propagates the labels it is given and originates none.
