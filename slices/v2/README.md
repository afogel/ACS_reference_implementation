# V2: Envelope Inspector

**Demo:** Watch the ACS request and response JSON stream live while you work.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V2 — authoritative for this slice's scope.

**Affordances:** U20, U21, N26, N50, S6 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## What this slice delivers

The Guardian records every ACS envelope crossing its wire into a JSONL log
(`packages/guardian/src/envelope-tap.ts` → `.acs/envelopes.jsonl`, S6/N26), and
`bun run inspector` (`packages/inspector`) tails that log and renders each entry live:
a header line, a decision badge for responses, then the envelope as pretty JSON
(U20/U21, N50). The demo is a third terminal beside `bun run guardian` and the agent
host. [`docs/demos/v2-runbook.md`](../../docs/demos/v2-runbook.md) walks it through with
the real captured output for a deny, an allow, a schema-invalid envelope, and an
unparseable body.

Three properties make this worth more than a log viewer:

- **The envelope log sink is total by construction.** N26 — `createEnvelopeLogSink`, and
  the `write` method on the `EnvelopeLogSink` it returns — sits on the decision path. A
  write failure disables the sink for the process lifetime, reports once, and never
  propagates — an observability feature must not be able to turn a governed tool call
  into an ungoverned one. `packages/guardian/test/envelope-tap-wiring.test.ts` asserts
  exactly that end to end: *"still denies `rm -rf /` when every envelope-log write
  fails"*.
- **The request is recorded before validation.** An envelope that fails the schema is
  the most useful thing an ACS-first reader can see, and it is exactly what disappears
  if the sink sits behind the validator. R5.1 says *every* hook firing.
- **The Inspector imports nothing from the Guardian.** It re-declares `EnvelopeLogEntry`
  rather than importing it, so "inspectable on the wire" is a claim about the file rather
  than about our own type graph — a third-party reader of S6 has only the file, and so
  does this one. Two gates in [`test/invariants.test.ts`](../../test/invariants.test.ts)
  enforce it: zero AGT vocabulary and zero host vocabulary in
  `packages/inspector/src` (R5.2), and no import of `guardian` or `agt-bridge` (R5.1).
  The duplication is kept honest by the round-trip contract test, which exercises both
  real implementations against one file.

## What is explicitly not in this slice

- **A schema-invalid envelope surfaces as a JSON-RPC error, not a `deny` decision.**
  The Inspector renders `✖ ERROR -32010`. `N27 denyOnInvalidEnvelope()` — the affordance
  that turns Guardian-side schema and bridge failures into honoured ACS `deny`
  **decisions** — is **V3**, alongside `N6 applyFailurePosture()` and
  `N7 validateDecision()`.
- **U23, the posture badge**, and **N51 `tailAuditSinks()`** — the negotiated
  `on_decision_failure` and the count of audited fail-open proceeds — are **V3**. There
  is no considered fail-open/fail-closed posture in this tree yet.
- **U22, the session chain view** — SessionContext entries and lineage — is **V6**,
  which is where session state and provenance carriage land.
- **No log rotation.** S6 grows without bound. Accepted for V2 and recorded in the
  slices doc; `: > .acs/envelopes.jsonl` truncates it safely mid-run because the tail
  resets on truncation.

`.acs/envelopes.jsonl` records the JSON value the Guardian parsed, unmodified — no field
stripping, no redaction, no reordering of anything we control — so it carries raw tool
arguments. It is gitignored for that reason and is never committed.

The precision matters, and V2 first shipped this claim too strongly. The sink is handed
`await req.json()`, so it stores a JSON *value*, not the request's bytes: the parse has
already collapsed duplicate keys, canonicalised number literals (`1.0` → `1`), and
hoisted integer-like object keys ahead of the rest — and `arguments` keys are
host-controlled, so `{"0": …, "a": …}` is a shape a real host can send. Storing raw bytes
would make the entry's `envelope` field a string rather than a JSON value, which costs
the Inspector its pretty-printing and costs the round-trip contract test its subject. The
accurate sentence is the better trade, and the whole-branch review is what caught the
inaccurate one.

The implementation plan this slice followed, task by task, is
[`docs/superpowers/plans/2026-08-09-v2-envelope-inspector.md`](../../docs/superpowers/plans/2026-08-09-v2-envelope-inspector.md).
