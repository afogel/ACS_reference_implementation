# V7: Conformance matrix

**Demo:** Eight intervention points by five AGT verdicts, every cell resolved — `expressed` where ACS v0.1.0 expresses AGT, `guardian_only` where only process-local Guardian knowledge can, `unexpressed` with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V7 — authoritative for this slice's scope.

**Affordances:** U30, U32, U33, N40-N44, N47, N48, N49, N52, S10 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances). This slice declares no store of its own; S10 (`mapping.yaml`) is the shared one it reads, and commitment 2 below is about what it is called.

## Names frozen before implementation

No V7 code exists yet, which is the only reason this section can be written at all. This
slice publishes tables, and it measures three different things into them: coverage cells,
trace-pillar rows, and — through V8 — upstream surface diffs. All three get called "the
matrix" in conversation, and Detail C until now had one `renderMatrix()` wired to all
three. Left to implementation time that name gets written once, by whoever builds the
first of the three, and the other two arrive as columns of it. That is not a tidiness
problem: a coverage claim that renders through the same function as everything else beside
it is a coverage claim whose subject is whatever was rendered.

Each numbered sentence below is a commitment a future implementer can be held to. None of
them describes measured behaviour: there is no V7 behaviour to measure yet, so each one
fixes a name and the role that name must fill, and nothing more.

1. **The 8 × 5 is intervention points by *AGT* verdicts, and every description says "AGT".**
   The five columns are AGT's verdict vocabulary — `allow`, `deny`, `warn`, `escalate`,
   `transform` — which is the `Decision` const the pinned SDK exports
   (`agent-control-specification@0.3.1-beta.0`, `dist/src/index.d.ts`; `agt.lock` pins that
   version) and the union `packages/agt-bridge/src/index.ts` declares. That is the enum,
   named in full once; elsewhere "five AGT verdicts" is enough. ACS v0.1.0 has five
   dispositions of its own — `allow`, `deny`, `modify`, `ask`, `defer`
   (`spec/acs/specification/v0.1.0/response-envelope.json`) — and they are a *different*
   five: `warn`, `escalate` and `transform` are not among them; `modify`, `ask` and `defer`
   are not AGT's. `mapping.yaml`'s `verdicts` table is the one place the two lists meet
   (`warn` → `allow` with non-empty `policy_references`, `escalate` → `ask`, `transform` →
   `modify`), and ACS `defer` has no AGT verdict behind it at all (§V3). So an unqualified
   "five verdicts" names both vocabularies and distinguishes neither, in the one document
   whose entire subject is that they are not the same list. The eight rows are AGT's
   intervention points, likewise the SDK's `InterventionPoint` const and exactly the eight
   keys of `mapping.yaml`'s `intervention_points`.

   **Landed:** `packages/conformance/src/cells.ts` reads `AGT_POINTS` / `AGT_VERDICTS` off
   the pinned SDK's own `Readonly` `InterventionPoint` / `Decision` consts
   (`import { Decision, InterventionPoint } from "agent-control-specification"`), not off
   `mapping.yaml`. The rendered matrix's header line names both axes — `"AGT intervention
   point (rows) x AGT verdicts (columns)"` — in `docs/demos/v7-runbook.md`'s captured U30
   block.

2. **`Mapping`, `MappingTable` and `CoverageMatrix` name three different things, and the
   8 × 5 is never called a mapping.** `Mapping` is S10's data: what `mapping.yaml` declares
   in its `intervention_points`, `verdicts` and `field_synthesis` tables, read by the
   runtime (`packages/guardian/src/map-verdict.ts`) and by this harness from the same file.
   `MappingTable` is U32's rendering of that data, produced by N48 `renderMappingTable()`.
   `CoverageMatrix` is U30's measurements — what N41–N44 return, cell by cell. A type,
   file or variable named for one of the three never holds either of the others. The
   distinction is not cosmetic: the mapping is a declaration this project authored, the
   matrix is a result the harness measured, and a name that covers both lets the
   declaration stand in for its own evidence.

   **Landed:** three files, not one. `packages/conformance/src/cells.ts` declares
   `CoverageCell`/`CoverageMatrix`'s data; `packages/conformance/src/render.ts` declares
   `renderMappingTable()` (`MappingTable`, U32) and `renderCoverageMatrix()`
   (`CoverageMatrix`, U30) as separate functions — `renderTraceRows`'s own header says it
   "shares no rendering code with `renderCoverageMatrix`", since a trace row and a coverage
   cell are two different shapes; `Mapping` itself is imported from
   `guardian` — by `render.ts`, `verdicts.ts`, `failure-domains.ts` and
   `intervention-points.ts` alike — and declared nowhere in this package.

3. **N47 is `renderCoverageMatrix()`, and nothing in this repository is named
   `renderMatrix`.** Detail C wired one `renderMatrix()` to U30, U31 *and* U33. It is now
   three affordances, one per measurement: **N47 `renderCoverageMatrix()` → U30** (the
   cells N41–N44 measure), **N52 `renderTraceRows()` → U33** (N49's rows), and **N53
   `renderUpstreamDiff()` → U31**, which is **V8's** — it has no input until V8's N46
   `diffSurfaces()` exists, so it sits in §V8's table rather than §V7's. Each is told one
   measurement and renders that one; none of them takes a discriminator saying which kind
   of table it is being asked for, which is the union this split exists to prevent.

   **Landed:** gated by `test/invariants.test.ts`'s `"nothing in this repository is named
   renderMatrix"` test, which scans `packages/agt-bridge/src`, `packages/conformance/src`,
   `packages/guardian/src`, `packages/host-adapter/src`, `packages/inspector/src` and
   `hosts` (comments stripped first, so it cannot fire on this note's own prose) and asserts
   `code.includes("renderMatrix")` is `false` in every file.

4. **A trace-pillar row is not a cell of the 8 × 5, and no name in this slice claims to
   emit a trace.** U33's rows pair a required OTel attribute with its v0.1.0 wire source;
   a coverage cell pairs an intervention point with an AGT verdict. They are two tables
   with two shapes, which is why they have two renderers, and a trace row never becomes a
   sixth column. `trace/otel-mapping.json` states its own normativity — a deployment
   emitting OTel for the Trace pillar must use its span names and required attributes
   verbatim — and §V7's scope boundary is that V7 *measures* that pillar and does not build
   an exporter. So the two verbs this slice's names may take are *check* and *render* —
   N49 checks the attributes, N52 renders the rows — and nothing here is called
   `exportTrace`, `traceExporter` or `emitSpan`. A name in the emitting mood would be the
   first half of building the exporter §V7 says is a slice of its own.

   **Landed:** two files, one verb each. `packages/conformance/src/trace-pillar.ts`
   declares `checkTracePillar` (N49, the check) and states in its own header that nothing
   in it is named `exportTrace`, `traceExporter` or `emitSpan`; `packages/conformance/src/render.ts`
   declares `renderTraceRows` (N52, the render) separately from `renderCoverageMatrix`. Two
   tables, two renderers — both visible as the `U30`/`U33` blocks in
   `docs/demos/v7-runbook.md`.

5. **The harness imports the Guardian and calls it, and the Inspector's import ban does not
   transfer.** `packages/inspector` imports nothing from `guardian`, `agt-bridge` or
   `host-adapter` and re-declares every entry type it reads, gated by
   `test/invariants.test.ts` — because R5.1/R5.2 are claims about a *third party* reading the
   wire, and the ban is what makes them measurable. C2 and R5.3 are claims about **this
   runtime**: that the translation it performs loses nothing, and that the profile it declares
   is the one it implements. Calling the runtime is the evidence for those, and a harness that
   re-derived the mapping from `mapping.yaml` on its own would publish a table that agrees with
   the file and says nothing about what the Guardian does with it — the exact defect the PR #10
   review found, where `server.ts` hardcoded `"pre_tool_call"` while that table sat there
   claiming to be the mapping. So N41's round trip goes through `resolveInterventionPoint` and
   N42's through `mapVerdict`, both imported, and `Mapping` is imported rather than redeclared.

   The bound runs the other way instead: **the harness takes its expected values from nowhere
   the Guardian could also be wrong about.** The eight rows are AGT's `InterventionPoint` and
   the five columns its `Decision` — both `Readonly` consts the pinned SDK exports
   (`agent-control-specification`, `dist/src/index.d.ts`), which is what makes commitment 1's
   enum a fact rather than a list this repository keeps in step by hand. The mapping's contents
   come from `mapping.yaml` read as a file. A matrix whose axes came from a list the Guardian
   hardcodes would be measuring the Guardian against itself, which is the failure mode the
   import buys and this sentence pays for. `loadMapping` casts the parsed YAML with `as Mapping`
   and validates nothing, so the imported type is a convenience for the harness and never a
   check it may lean on.

   **Landed:** `packages/conformance/src/main.ts` imports `loadMapping` and `startGuardian`
   from `guardian` (line 49) and `createBridge` from `agt-bridge` (line 48); N41's round
   trip goes through `checkInterventionPoints`, which imports `resolveInterventionPoint`
   from `guardian` (`packages/conformance/src/intervention-points.ts:18`), and N42's through
   `checkVerdicts`, which imports `mapVerdict` from `guardian`
   (`packages/conformance/src/verdicts.ts:30`) — `main.ts` itself imports only
   `checkInterventionPoints`/`checkVerdicts`, neither SDK-facing import directly.

6. **N43 is a *recomputation* check, and nothing in this slice is named for a field ACS
   v0.1.0 does not have.** AGT's `InterventionPointResult` carries `inputIdentity`,
   `enforcedIdentity` and the `policyInput` they hash — the distinction A4 was amended to the
   Node SDK to get (§V1 C1). ACS v0.1.0 carries no action-identity field at all: `identity`
   appears in exactly two of the 43 schemas, as `session-start.json`'s `user_identity` and as
   prose in `skill-register.json`, and neither is this. So N43 measures a Guardian-side
   recomputation and says so; a name here that implied the wire carried an identity — an
   `enforced_identity` member on anything envelope-shaped — would be the same collapse
   commitment 2 forbids, one field over. §V7 records what that resolves the R1.4 cell to.

   **Landed:** `packages/conformance/src/identity.ts` (N43, `checkEnforcedIdentity`), whose
   own header states the identity is *measured* — the SHA-256 of the key-sorted,
   whitespace-free JSON of the policy input, prefixed `sha256:` — not read from AGT's docs,
   and reproduces exactly against the pinned SDK. Its header also records the nearest miss
   this repository found: `context-entry.json`'s `request_hash`
   (`context-entry.json:21-24`), "Lowercase-hex SHA-256 of the JCS-canonicalized (RFC 8785)
   request envelope's params object" — not wire-transmitted (`context-entry.json:5`, "not
   transmitted in full on the wire") and committed to the request as received, not to the
   policy target after AGT's own transform.

## Finding from Task 2 (N21's outbound twin): two ways a Guardian-built decision fails its own schema

Task 2 (`packages/guardian/src/validate-response.ts`) checks every response this
Guardian sends against `response-envelope.json`, the same way N21 already checks every
inbound request. Wiring it into `handleAcsRequest` and running the existing test suite
against it (`bun test`, unmodified otherwise) surfaced real Guardian-built responses that
fail that check — logged, not thrown (see that module's own doc comment for why it must
never throw), but real. Both are measured against `mapping.yaml` and
`packages/guardian/src/map-verdict.ts` as they stand today; neither is Task 2's to fix —
closing either is a `map-verdict.ts` / `mapping.yaml` design decision this slice's own
scope boundary puts outside a response-validation task.

1. **`reasoning` is missing whenever the firing policy rule sets no `verdict.message` —
   measured today for `redact.rego`'s `modify`, not for `deny`.**
   `field_synthesis.reasoning.source` (`mapping.yaml`) reads `verdict.message`, and
   `AgtVerdict.message` (`packages/agt-bridge/src/index.ts`) is optional. `patterns.rego`
   (deny) and `approval.rego` (escalate) both set it, so those two verdicts' responses carry
   `reasoning`; `redact.rego` (transform → ACS `modify`) sets `reason` (feeding
   `reason_codes`) and never `message`, so `mapVerdict` leaves `reasoning` unset for every
   redaction this Guardian sends, and `response-envelope.json`'s `allOf` requires
   `reasoning` on `modify` (also `deny`, `ask`, `defer`, unaffected here since those verdicts
   do set it). This is not a new discovery — `hosts/claude-code/test/post-tool-use.test.ts`
   already documents it in prose at its `"redacts a secret..."` and
   `"says why it redacted..."` cases ("the pinned bundle's own redaction verdict comes back
   carrying `reason_codes` and `policy_references` and NO `reasoning` string") — Task 2 is
   the first thing to catch it as a schema failure rather than as a hand-written note.
   Measured live: `test/dispositions.test.ts`'s `"transform arrives as modify..."` case and
   several `hosts/opencode/test/request-gate.test.ts` / `result-gate.test.ts` redaction
   cases log `/result must have required property 'reasoning'`.

2. **`ask_details` has no field to be missing from — `AcsDecision` never declares one.**
   `packages/guardian/src/map-verdict.ts`'s `AcsDecision` type carries `decision`,
   `reasoning`, `reason_codes`, `policy_references` and `modifications`; it has no
   `ask_details` or `defer_details` member, and `mapVerdict` sets neither for any verdict.
   `response-envelope.json` requires `ask_details` whenever `decision: "ask"` — which
   `mapping.yaml`'s `verdicts` table reaches from AGT's `escalate` — so every ACS `ask`
   this Guardian has ever built fails the schema by construction, not incidentally.
   Measured live: `test/dispositions.test.ts`'s `"escalate arrives as ask"` case logs
   `/result must have required property 'ask_details'`. `defer_details` is the same gap
   one verdict over, unreached today only because `mapping.yaml` maps no AGT verdict to
   ACS `defer` at all (commitment 1 above) — the same construction would fail it the
   moment anything did.

## What this implementation claims, and where each line is measured

R5.3 asks for a declaration with its evidence beside it, and the two are not one artifact
(commitment 2 above; §V7). `docs/demos/v7-runbook.md` is the evidence — one real, captured
run of `bun run conformance`. This section is the declaration: which ACS profiles and
pillars this implementation claims, and which it does not, with the measurement that backs
each line named beside it. A line below reads "claimed" only where a named test, a named
source file, or the runbook's own captured output backs it; everywhere else reads "not
claimed", with the measured reason.

### The seven ACS profiles

`spec/acs/specification/v0.1.0/handshake.json` defines the profile enum twice, identically,
on `ClientHello.properties.profiles_supported` and `ServerHello.properties.profiles_accepted`:
`acs-core`, `acs-trace`, `acs-inspect`, `acs-inspect-dynamic`, `acs-provenance`, `acs-crypto`,
`acs-audit`. `profiles_supported`'s own description: *"'acs-core' is the mandatory baseline
and SHOULD always be included. Other profiles are optional and independently claimable."*

| Profile | Claimed | Measured |
|---|---|---|
| `acs-core` | Qualified — not a bare claim | The Guardian serves `handshake/hello` and both `steps/toolCallRequest`/`steps/toolCallResult` (`packages/guardian/src/server.ts`; `test/handshake-declares-what-it-evaluates.test.ts`). But this slice's own Task 2 measured two ways a Guardian-built response fails `response-envelope.json` — see "Finding from Task 2" above. A bare "claimed" here is contradicted by this slice's own evidence |
| `acs-trace` | Not claimed | Six required OTel attributes resolve to wire fields that are present but optional — the U33 block of `docs/demos/v7-runbook.md`; `packages/conformance/src/trace-pillar.ts` |
| `acs-inspect` | Not claimed | Nothing implements `agbom/*`. The string occurs in exactly two source files, both incidentally: an AJV schema registration in `packages/guardian/src/validate-envelope.ts` and a scope-boundary comment in `packages/conformance/src/trace-pillar.ts`. No `agbom` method is dispatched anywhere in `packages/` or `hosts/` |
| `acs-inspect-dynamic` | Not claimed | Same reason — no `agbom` method, including `agbom/changed`, is dispatched anywhere in this tree. The string `agbom/changed` itself is named, but only incidentally: a scope-boundary comment in `packages/conformance/src/trace-pillar.ts` and a schema registration in `packages/guardian/src/validate-envelope.ts` |
| `acs-provenance` | Not claimed | The ClientHello this repo's host adapter sends declares `provenance_producer: "none"` — a literal in the source, not an inference (`packages/host-adapter/src/handshake.ts:253`) |
| `acs-crypto` | Not claimed | Nothing in this tree produces a signature. `signature` appears in Guardian source only as an optional **inbound** field's type on `AcsRequestParams` (`packages/guardian/src/validate-envelope.ts:70`) |
| `acs-audit` | Not claimed | `AcsResult.chain_hash` is never set by anything in this tree. `chain_hash` occurs in Guardian source only as an inbound `session_state` field's type (`packages/guardian/src/validate-envelope.ts:49`) |

"Not claimed, because this Guardian never sets `chain_hash`" is a complete and honest reason
for declining `acs-audit`, and it stops there: nothing above extends into a claim about V6's
`session-context.ts` or its own hash chain, which is a different mechanism and V6's
measurement, not this slice's.

**Neither wire field a profile declaration would travel on is populated, in either
direction.** `ServerHello` declares twelve properties and requires four
(`negotiated_version`, `methods_evaluated`, `selected_transport`, `timeout_config`); two of
the eight optional ones are exactly the fields this declaration would use —
`profiles_accepted` ("Conformance profiles accepted for this session") and `trace_emission`
("Trace-pillar negotiation... Deployments claiming ACS-Trace MUST emit Trace events under at
least one of OTel or OCSF for every supported ACS step"). `packages/guardian/src/handshake.ts`'s
`ServerHello` type declares five members (`negotiated_version`, `methods_evaluated`,
`selected_transport`, `timeout_config`, `on_decision_failure`) and `buildServerHello` returns
exactly those five — neither `profiles_accepted` nor `trace_emission` is among them. On the
client side, `packages/host-adapter/src/handshake.ts`'s ClientHello payload has four members
(`acs_versions_supported`, `methods_implemented`, `transports_supported`,
`provenance_producer`), and `profiles_supported` is not one of them either. Both fields are
optional, so neither omission is a schema failure — but it means this declaration is prose in
a README, and the wire has a field for it that this implementation leaves empty in both
directions. That is not fixed here: populating `profiles_accepted` is a Guardian change
outside this task's three files, and it needs the ClientHello side to mean anything before it
would carry information. It is the same shape as V4's `methods_evaluated` finding — a
declared field naming less than the wire actually does — which this repo treats as
load-bearing rather than cosmetic.

### The Trace pillar, and the three `guardian_only` findings it shares a shape with

Not claimed. U33's own capture (`docs/demos/v7-runbook.md`) has six rows reading `✖`, every
one for the same reason: the wire field the OTel mapping requires exists and is optional. One
is `acs.capability` (`hooks/tool-call-request.json#capability`); the other five come from
`response-envelope.json`'s `AcsResult` — four from `metadata` (`evaluator`, `confidence`,
`evaluator_version`, `model_id`) and one, `reasoning`, directly. `AcsResult.required` is
`["type", "acs_version", "request_id", "decision"]`; `metadata` declares no `required` list
of its own. `metadata`'s own description states the purpose outright: *"ACS-defined
evaluator and observability metadata... keeping the split clean lets Trace consumers key on
a stable shape."* The fields exist, and they exist for this. What they are not is required.
So the finding is: **a downstream consumer of the ACS wire cannot emit a conformant trace** —
only the Guardian can, from process-local knowledge the contract does not carry.

Three independent findings in this slice's own measurement share a related shape, and are
stated here as one, per `docs/shaping/acs-reference-impl-slices.md:531`: the `warn` column
(AGT's only stock warn gate reads `input.annotations.drift_score`, and no ACS v0.1.0 method
payload carries a field that score could be derived from), the six Trace-pillar rows above,
and R1.4's identity (commitment 6 above — `packages/conformance/src/identity.ts` measures
what AGT's enforced identity actually binds to: the policy target it rewrote, not the
document the host applies modifications to). One of the three is **optionality** — the Trace
attributes are fields the wire could carry, and never has to; the other two are a flat
**absence**: the `warn` gate's input, because no ACS v0.1.0 method payload carries a field a
drift score could be derived from, and R1.4's identity, because ACS v0.1.0 has no
action-identity field to be optional in the first place (commitment 6 above). The one finding
all three share regardless: **v0.1.0's response envelope carries a decision and never has to
carry the evidence for it** — a downstream consumer can read what was decided, and can
neither reproduce it nor bind it to what executed.

The v0.2 fork this raises is published here, not resolved, per
`docs/shaping/acs-reference-impl-slices.md:529`: adding `enforced_identity` to `AcsResult` is
necessary and not sufficient, because the host applies ACS `modifications` to the **ACS**
payload while AGT hashed its **policy input** — two documents, two vocabularies. v0.2 needs
either **(a)** an identity computed over a canonicalization of the *ACS* action the host will
execute, which AGT does not produce today, or **(b)** enough of the policy input on the
decision envelope for the host to recompute, which re-exposes exactly the snapshot ACS keeps
host-side. This slice does not pick a branch, and it files nothing upstream.

### What `expressed` measures, and what it does not

`packages/guardian/src/handshake.ts:88`'s `METHODS_EVALUATED` is the literal
`["steps/toolCallRequest", "steps/toolCallResult"]` — the only two ACS methods this Guardian
dispatches. `mapping.yaml` gives an `acs_method` to six of its eight intervention points (the
U32 mapping table in `docs/demos/v7-runbook.md`), so four mapped points (`agent_startup`,
`agent_shutdown`, `input`, `output`) are never evaluated by this Guardian at all — even
though the U30 coverage matrix in the same runbook resolves each of those four rows `✔`
(expressed) at `allow`, `deny` and `escalate`, exactly as `pre_tool_call` and
`post_tool_call` — the two points this Guardian actually dispatches — do.

That is not a defect in the matrix. It measures **ACS v0.1.0's expressive power**, not this
Guardian's coverage, and its own header line says so on its own face: *"Each cell measures
ACS v0.1.0's expressive power against AGT's vocabulary at that point x verdict — it is NOT a
claim about which methods this Guardian evaluates,"* a sentence
`packages/conformance/test/render-coverage-matrix.test.ts` asserts the rendered table matches
(`/expressive power/i`). What the matrix cannot do is stop a reader from taking `✔` at, say,
`input`/`allow` as "this implementation governs the `input` point" — that reading is wrong,
and this declaration is the artifact whose job is to say so directly: **this Guardian
evaluates exactly `steps/toolCallRequest` and `steps/toolCallResult` — two of the six mapped
methods — and none of the other four** (`steps/sessionStart`, `steps/sessionEnd`,
`steps/userMessage`, `steps/agentResponse`), per `METHODS_EVALUATED` and pinned by
`test/handshake-declares-what-it-evaluates.test.ts`, which drives a candidate envelope for
every mapped method through a live Guardian and asserts equality, in both directions, between
the methods it does not answer `method_not_dispatched` for and the ServerHello's
`methods_evaluated`. `handshake.json` makes the consequence load-bearing: *"Methods listed by
the client but absent here are NOT evaluated; the Guardian's enforcement does not cover them.
Clients MAY still emit them for audit but MUST treat them as ALLOW-by-default."*
