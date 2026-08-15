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
same contract `tail-audit-log.ts` already had. The check and the printing are **two
functions** (`packages/inspector/src/render.ts`): `checkSessionChainLink` decides whether
an entry links to its predecessor and records that entry's `hash` for the next one;
`renderSessionChainRow` renders the row that decision produced and writes nothing, so
rendering twice yields the same string twice. A link is broken when `prev_hash` does not
match the last `hash` seen **for the same `session_id`** — read out of a
`SessionChainState`, never out of whatever line happened to come before it, because one
log carries every session the Guardian saw, in append order, so two interleaved sessions
would otherwise read as a break on every switch.
**What the check is not:** it compares **links** and never recomputes `hashEntry` over the
entry in front of it, so it is not tamper-evidence. Three edits read as unbroken, each one
measured against `checkSessionChainLink`: a self-consistent rewrite (edit a step field,
leave `hash` and `prev_hash` alone), a trailing truncation, and a deleted **first** entry —
that last one because an entry with no predecessor in view is never marked, and nothing
requires a session's first row to carry `GENESIS_HASH` or `seq` 1. What it does catch,
also measured, is a link that stopped matching: a clobbered `prev_hash`, or a dropped
**middle** entry. So it detects corruption and naive edits, not an adversary with write
access to the log.
The row prints `session_id=`, not the bare `session=` it first shipped with: S14's row a
few lines above it prints `audit_session=`, qualified precisely because that value is the
host's own raw identifier and is not comparable to anything on the wire, and both stream
past one eye when `main.ts` tails both logs.
`packages/inspector/src/main.ts` tails it beside S6 and S14, under
`--session-context-log` / `ACS_SESSION_CONTEXT_LOG`, and the tailer and both chain
functions are exported from `packages/inspector/src/index.ts` beside the other two
tailers. The Inspector imports nothing from
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
labels alone; an explicitly **empty** one clears them. That distinction is a fact about a
verdict, so it is read here, next to the verdict; what to do about it is the store's, and
the store is **told** — `SessionContextStore.replaceIfcLabels` and `.sourceLabels`, both
naming the field, so no caller has to load a session and write a whole provenance record
back to change one member. Both directions copy the array, so neither a snapshot nor a
caller's own array is a way to edit S5.

**N23 — the session's labels reach both assemblers, once each.**
`packages/guardian/src/assemble-snapshot.ts`. `assemblePreToolCallSnapshot` and
`assemblePostToolCallSnapshot` each take the session's `IfcLabels` **value** — not the
store — and each emits `input.ifc.source_labels`. Nested under `input`, because
`policy/lib/agt_ifc.rego` resolves `input.snapshot.input.ifc.source_labels`; the shorter
`ifc` at the snapshot root reads as `[]`, which that module's own
`test_does_not_read_upstream_ifc_path` pins and which `test/ifc-round-trip.test.ts`
re-measures against the shipped bundle.

**S3 — the chain, and only the chain.** `packages/guardian/src/session-context.ts`
declares `SessionContext` as a session id and its entries — S4 and S5 sit beside it on
`SessionState`, the aggregate the store holds, rather than inside the type named for the
chain. `loadSessionContext` returns the former; `store.load` returns the latter. The same
file declares
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

**S5 — `SessionProvenance`, carrying the labels on a named field.** `SessionProvenance` is
`spec/acs/specification/v0.1.0/provenance.json`'s object — `provenance_id`, `origin`,
`source_id`, `derived_from` — plus `ifc_labels`, typed `IfcLabels`. `origin` is typed as
the spec's seven-value enum rather than `string`. One record per session, synthesized by
the Guardian (`acs:session:<session_id>`, `origin: "system"`, `source_id: "acs.guardian"`),
seeded at `["public"]`. The `Session` prefix is load-bearing: it is **not** the
per-argument provenance an ACS payload can carry, and under a bare `Provenance` the two
were one word for two records that never meet. `assemblePreToolCallSnapshot` unwraps each
argument's `{value, provenance}` to
`value` alone (C5), so no wire-supplied provenance reaches S5, and none carries a label
anyway — see `docs/shaping/acs-reference-impl-slices.md` §V6.

**The policy-side behaviour change is one key.** `policy/lib/data.json` gains
`config.ifc.sink_clearance: "confidential"`, which is what turns AGT's stock IFC gate on;
no Rego is authored, and `bun run verify:pin` re-clones AGT at the ref `agt.lock` names
and asserts every `.rego` under `policy/lib` is byte-identical to it (`test/pin.test.ts`,
which also asserts the bundle carries no added file but `data.json`). `policy/manifest.yaml`
also changed on this branch, in **comments only**, to follow the assembler rename.

## Where the shipped name differs from the sentence above

The commitments held. Two divergences are worth naming, each one a place where what
shipped is not literally the name its sentence uses, and the honest record is to say so
rather than to edit the sentence.

- **Commitment 2 — there is no separate IFC label store, and `IfcLabels` names the labels
  rather than a store.** `IfcLabels` is `readonly string[]`
  (`packages/guardian/src/session-context.ts`): the type of the labels, and of the
  `ifc_labels` field they ride on `SessionProvenance`. The store is `SessionContextStore`,
  which holds a session's chain, intent and provenance record together as `SessionState`.
  What the commitment was for is intact — the ACS record was not widened into a label bag
  and the labels ride a named field on it.
- **Commitments 2 and 3 — the field is `ifc_labels`; `IfcLabels` is its type.** The
  sentences say "the `IfcLabels` field", and §V6's demo sentence and affordance table say
  it too. Grepping for a field of that name finds nothing; the declaration is
  `ifc_labels: IfcLabels`.

**A third divergence was reported here and has since been closed rather than kept.** The
bare identifier `session` did appear: `assemble-snapshot.ts` declared a one-field type
`AgtSessionState` (`{ sourceLabels }`) and bound it to a parameter called `session` in
`ifcMember`, in both assemblers, and in `server.ts`'s assembler function type. The PR #15
review's reading is the one that holds — a bag announcing session state and holding
labels, under a name commitment 1 reserves for neither object it governs, on the same step
where V3 already bound `GovernStepInput.session` to `ResolvedSessionConfig`. Both
assemblers now take `sourceLabels: IfcLabels`, and no parameter anywhere in the Guardian
is named `session`.

## What the PR #15 review changed

That review found seven naming and shape defects in what this slice first shipped. Each is
fixed above rather than recorded as a divergence, because each was a defect and not a
trade-off: `AgtSessionState` dropped (as described just above); `IfcLabels`' own doc
comment still calling itself a store, which this README's divergence 1 had already denied;
`Provenance` renamed `SessionProvenance`, since two records of that name never meet;
N25 loading a session and writing a whole provenance record back, replaced by two verbs the
store owns; `SessionContext` renamed to `SessionState` where it means the aggregate, so S3's
name is S3's alone; `renderSessionChainRow` split into a check that records and a renderer
that is pure, because fused they made re-rendering one entry report a chain break; and
U22's bare `session=` label, which collided with S14's deliberately-qualified
`audit_session=` on the same tail. The seventh's second half is why the Inspector barrel now
exports the third tailer.

## What this slice measured, and what it did not

Both are in `docs/demos/v6-runbook.md` with the runs attached; the wire finding and the
three the gate produced are filed at
`docs/shaping/acs-reference-impl-slices.md` §V6. The short version of the limit: **the
round trip is measured in pieces.** No single test drives a real Guardian over two steps
against the real bundle *and* asserts the labels, and today such a test could only show
`public → public`, because AGT propagates the labels it is given and originates none.

**Nothing bounds what this slice accumulates.** `createMemorySessionContextStore`'s
`sessions` map is never evicted, each session's `entries` array only grows, and the JSONL
projection has no rotation — so a long-lived Guardian, which is the deployment a
per-session state model implies, grows without bound in memory and on disk. S6 and S14
already have the same property. Recorded as a property of a reference implementation, not
fixed here.

The implementation plan this slice followed, task by task, is
[`docs/superpowers/plans/2026-08-14-v6-session-state-and-provenance-carriage.md`](../../docs/superpowers/plans/2026-08-14-v6-session-state-and-provenance-carriage.md).
