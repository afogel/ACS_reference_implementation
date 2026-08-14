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

5. **Session state is injected into both `assemblePreToolCallSnapshot` and
   `assemblePostToolCallSnapshot`, once per assembler.** Both ship today in
   `packages/guardian/src/assemble-snapshot.ts`, envelope-only, and that file's own
   header names V6 as where S3/S4/S5 arrive. N23 does not collapse into a single function
   that asks which intervention point it is on — that is the union PR #10's review closed
   and §V4 of the master doc re-closed, and it would arrive here wearing the excuse that
   the assembler needs session state either way.

Implementation goes here.
