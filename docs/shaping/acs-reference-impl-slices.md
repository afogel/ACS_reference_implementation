---
shaping: true
---

# ACS Reference Implementation over AGT — Slices

Implementation plan for Shape C. Ground truth for slice definitions; the shaping doc (`acs-reference-impl-shaping.md`) remains ground truth for R, shapes, and the breadboard.

Every slice ends in something demo-able.

---

## Slice Summary

| # | Slice | Parts | Demo |
|---|-------|-------|------|
| V1 | One host, one hook, a real AGT decision | C1, C3, C4 | "Ask Claude Code for a destructive shell command. AGT's stock policy denies it, and the reason lands in the transcript." |
| V2 | Envelope Inspector | C4 | "Watch the ACS request and response JSON stream live while you work." |
| V3 | All five dispositions, and both failure postures | C3, C4 | "One bundle produces allow, deny, ask, defer, and a rewritten tool call. Kill the Guardian under `proceed` and the step proceeds with an audit event; under `deny` it blocks. Posture negotiated at handshake." |
| V4 | Output redaction on Claude Code | C3 | "AGT's own package documents that Claude Code cannot redact tool output. Here it is, redacted, by AGT's stock `redact` policy." |
| V5 | Second host, zero AGT changes | C3 | "Same Guardian, same manifest, same bundle. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT." |
| V6 | Session state and provenance carriage | C4 | "The SessionContext chain grows per step. AGT emits `result_labels` at one step and gets them back as `input.ifc.source_labels` at the next, carried by ACS provenance." |
| V7 | Conformance matrix | C1, C2, C5 | "Eight intervention points by five verdicts, all green. AGT completely expressed in ACS, case by case." |
| V8 | Upstream drift watch | C6 | "Point the harness at AGT `main`. A changed enum turns a cell red and names the field." |

**Order rationale.** V1–V4 establish credibility on the host AGT already supports best, so the second-host claim in V5 lands against a working baseline rather than a promise. V7 is the deliverable Microsoft reads, but it can only be green once V1–V6 exist to be measured. V8 is what keeps V7 true after upstream moves.

---

## V1: One host, one hook, a real AGT decision

**Demo:** In Claude Code, ask for a destructive shell command. AGT's stock policy denies it; the deny reason appears in the transcript.

**⚠️ Framing correction (R4.4).** The stock bundle ships **no** shell or command patterns — `patterns.rego` carries generic PII regexes only. What is stock is the *deciding module* (`agt.patterns`) and the priority chain in `agt_default.rego`; the destructive-command regex list is ours, supplied as configuration. R2.1 still holds exactly — zero Rego authored, behaviour driven only through `data.agt.defaults.config` — but the demo must be narrated as "AGT's stock policy engine, configured", never as "Microsoft ships an `rm -rf` deny-list". Overclaiming here would breach R4.4.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U1 | P1 | claude-code | prompt input | type | → N1 | — |
| U2 | P1 | claude-code | tool permission outcome in transcript | render | — | — |
| N1 | P1 | acs-hook shim | generic hook entrypoint, reads hook JSON on stdin | call | → N2 | — |
| N2 | P1 | `@acs/host-adapter` | `buildEnvelope(event, payload, hookmap)` | call | → N4 | — |
| N3 | P1 | `@acs/host-adapter` | `renderDecision(decision, hookmap)` | call | → U2 | — |
| N4 | P1 | `@acs/host-adapter` | `createGuardianClient(url).requestDecision()` JSON-RPC over HTTP | call | → N20 | → N3 |
| N5 | P1 | `@acs/host-adapter` | `negotiateSessionConfig()` — negotiates `timeout_config`, `on_decision_failure`, profiles | call | → N28 | → S13 |
| N20 | P3 | guardian | `POST /acs` JSON-RPC 2.0 endpoint | call | → N21 | — |
| N28 | P3 | guardian | `buildServerHello()` — ServerHello | call | — | → N5 |
| S13 | P1 | store | `negotiated session config` | — | — | → N6 (V3) |
| N21 | P3 | guardian | `validateEnvelope()` against v0.1.0 schemas | call | → N23 | — |
| N23 | P3 | guardian | `assembleSnapshot()` — envelope → AGT snapshot | call | → N30 | — |
| N24 | P3 | guardian | `mapVerdict()` — AGT verdict → ACS decision | call | — | → N4 |
| N30 | P3.1 | agt-bridge | `evaluateInterventionPoint(point, snapshot)` | call | — | → N24 |
| N31 | P3.1 | agt-bridge | `AgentControl.fromPath(manifest.yaml)` at boot | call | — | → N30 |
| S1 | P1 | store | `claude-code.hookmap.yaml` | — | — | → N2, N3 |
| S7 | P3.1 | store | `manifest.yaml`, binding `rego` → `data.agt.defaults.verdict`; `policy_target` **must** resolve to a leaf string (`$.tool_call.args.command`) | — | — | → N31 |
| S8 | P3.1 | store | `data.agt.defaults.config`, shipped as `policy/lib/data.json` **inside** the bundle directory | — | — | → N31 |
| S9 | P3.1 | store | AGT stock bundle at pinned ref, every `.rego` byte-identical | — | — | → N31 |
| S10 | shared | store | `mapping.yaml` | — | — | → N23, N24 |
| S11 | shared | store | `agt.lock` | — | — | → N31 |

**Scope note.** Only `pre_tool_call` is wired. No session state, no tap, no second host. `N23` assembles the snapshot from the envelope alone; it starts reading S3/S4/S5 in V6.

**Setup cost this slice absorbs:** ⚠️ *amended* — the `opa` CLI is **no longer a setup cost*. The npm package pulls `agent-control-specification-opa-darwin-arm64`, which ships OPA 0.70.0, overridable via `ACS_OPA_PATH` / `ACS_OPA_NO_BUNDLE`. The stock bundle passes 105/105 under both it and system OPA 1.18.2. What remains: the pinned AGT checkout and the first cut of `mapping.yaml`. **This closes D7 as Rego** — Cedar's only advantage was removing an external binary, and there is no external binary.

**⚠️ Watch-for — `bundle:` resolves against the manifest's own directory.** Discovered during V1 execution, after the `./` landmine below: `bundle:` is relative to the directory holding `manifest.yaml`, not the process cwd. With the manifest at `policy/manifest.yaml`, `bundle: policy/lib` resolves to `policy/policy/lib` and every call hard-fails `runtime_error:policy_invocation_failed`. The correct value is `bundle: lib`. This failure is *loud* — unlike the `./` landmine, it denies rather than silently allowing — but the two are easily confused because both stem from how AGT joins this one field.

**⚠️ Watch-for — the `./` landmine.** `policies.<id>.bundle` must **not** begin with `./`. AGT joins the manifest directory to the literal value, yielding `<dir>/./policy/lib`; OPA's bundle loader mis-derives the data mount path from the `/./` segment and silently drops `data.json`. The policy then matches nothing and **every decision becomes `allow`** — a fail-open with no error, in a governance tool. Measured: `./policy/lib` loads, `/abs/policy/lib` loads, `/abs/./policy/lib` is UNDEFINED. `createBridge` throws on `/./`, and V1's deny test is the backstop.

**⚠️ Amendment — the config lives inside the bundle.** `data_paths` cannot deliver `data.agt.defaults.config` while `bundle:` is set: the stock bundle ships no `.manifest`, so its roots default to `""`, it owns the whole data tree, and the `--data` document is discarded. S8 therefore ships as `policy/lib/data.json`. Every stock `.rego` stays byte-identical; `data.json` is the only added file, so R2.1/R2.3 hold — we author a data document, not policy.

**⚠️ Amendment — the bridge embeds the Node SDK, not the Python SDK.** The PyO3 binding sets only `action_identity`; the Node binding sets `input_identity` and `enforced_identity` distinctly (`sdk/node/native/lib.rs:191-204`). On Python, R1.4 is unverifiable and V7's N43 is impossible. This also makes the whole repo one TypeScript toolchain. Amends shaping A4.

---

## V2: Envelope Inspector

**Demo:** Watch the ACS request and response JSON stream live while you work in Claude Code.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U20 | P4 | inspector | envelope stream, request/response JSON pairs | render | — | — |
| U21 | P4 | inspector | decision badge: decision + `policy_references` + `reason_codes` | render | — | — |
| N26 | P3 | guardian | `writeEnvelopeTap()` — **total**: never throws, never alters a decision | call | → S6 | — |
| N50 | P4 | inspector | `tailEnvelopeLog()` | observe | → U20, → U21 | — |
| S6 | P3 | store | `envelope log`, JSONL at `.acs/envelopes.jsonl` (gitignored), one entry per direction | — | — | → N50 |

**Why this early.** R5.1 and R5.2 are must-haves, and an ACS-first reader needs to see envelopes before anything more elaborate is worth showing. U21 is also how `warn` becomes visible: a `warn` arrives as `allow` with a non-empty `policy_references`, and the badge is what makes that legible rather than buried.

**Decisions taken at planning.** §V2 left the Inspector's form open; these close it, and are recorded here rather than only in the plan.

| # | Decision | Rationale |
|---|---|---|
| P1 | The Inspector is a **terminal process** — `bun run inspector`, a third terminal beside `bun run guardian` and `claude`. | Zero new dependencies, works over SSH, matches the repo's one-process-per-command shape. R7.1/R7.2 ask for a laptop and no paid dependency; a browser UI would add a server, a bundler and an asset pipeline without proving anything further about the wire. A browser view later reads the same S6 file. |
| P2 | S6 is a **file** — `.acs/envelopes.jsonl`, overridable with `ACS_ENVELOPE_LOG`. | The file is the seam that lets the Inspector import nothing from the Guardian. `jq` works on it unchanged. An in-process bus or a socket would couple P4 to P3. |
| P3 | The tap is **opt-in at the library level, on by default in the CLI**: `startGuardian` taps only when `envelopeLogPath` is passed; `packages/guardian/src/main.ts` passes it. | V1's tests construct Guardians constantly; a default-on tap would scatter files through the working tree. The demo path still gets the tap with nobody opting in. |
| P4 | Request/response pairing is by **JSON-RPC `id`**, carried as `rpc_id` on every entry. | The only identifier present in both directions. `params.request_id` exists on requests only. Pairing by arrival order breaks the moment two hooks are in flight. |
| P5 | The request is tapped **before validation**. | An envelope that fails the schema is the most useful thing an ACS-first reader can see, and it is exactly what disappears if the tap sits behind the validator. R5.1 says *every* hook firing. |

**⚠️ Watch-for — the tap must be total.** `writeEnvelopeTap` sits on the decision path. V1 shipped three separate fail-opens before they were caught (the `./` bundle landmine, `tool_unknown` failing closed, and an unhandled Guardian throw reaching the shim as an empty stdout); an observability feature that can turn a governed tool call into an ungoverned one would be the fourth. Every write is wrapped: a failure disables the tap for the process lifetime, reports once, and never propagates. V2 asserts this end to end — `rm -rf /` is still denied when every tap write fails.

**⚠️ Watch-for — S6 records the parsed envelope, unmodified.** No field stripping, no redaction, no reordering of anything we control; pretty-printing happens at render time only. An inspector that shows something other than what was sent is worse than none. The consequence is that S6 carries raw tool arguments, which is why `.acs/` is gitignored and why the runbook says so out loud. **Corrected by V2's whole-branch review:** this watch-for originally said "records the wire verbatim", and so did the plan's global constraint 11, the slice README, the runbook, and the Inspector's own renderer comment. The tap is handed `await req.json()`, so it stores a JSON *value*, not bytes — the parse collapses duplicate keys, canonicalises number literals, and hoists integer-like object keys, and `arguments` keys are host-controlled. Storing bytes instead would make `envelope` a string rather than JSON, costing the Inspector its pretty-printing and the round-trip contract test its subject. The wording was corrected everywhere rather than the code.

**⚠️ Watch-for — a schema failure appears as an error, not a decision.** In V2 an invalid envelope is tapped (P5) and then answered with a JSON-RPC error, so the Inspector renders `✖ ERROR -32010`, not a badge. `N27 denyOnInvalidEnvelope()` — the affordance that turns Guardian-side failures into honoured ACS `deny` **decisions** — is V3. The Inspector is where that change will become visible.

**Unpaired responses are real.** A body that will not parse as JSON produces a response with no preceding request and `rpc_id: null`. The Inspector renders it as `(no method) (unpaired)` rather than hiding it.

**Scope added at planning** (both amend this slice, both land in V2's PR):
- An **invariant gate** on `packages/inspector/src`: zero AGT vocabulary, zero host vocabulary, and no import of `guardian` or `agt-bridge`. R5.2 is why this slice is early, and V1 established that this project turns architectural claims into grep gates rather than prose. Joins the R3.2/R3.3 gates in `test/invariants.test.ts`.
- A **tap↔tail contract test** (`test/envelope-tap-roundtrip.test.ts`). The Inspector declares its own `TapEntry` instead of importing the Guardian's — that is what makes the gate above meaningful — and the duplication is only safe while something fails when the two drift.

---

## V3: All five dispositions, and both failure postures

**Demo:** One bundle produces allow, deny, ask, defer, and a rewritten tool call. Then kill the Guardian mid-flight twice — once under `on_decision_failure: proceed`, where the step proceeds and an audit event appears; once under `deny`, where it blocks. Same adapter, same policy, posture negotiated at handshake.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U23 | P4 | inspector | posture badge: negotiated `on_decision_failure` + count of audited fail-open proceeds | render | — | — |
| N6 | P1 | `@acs/host-adapter` | `applyFailurePosture()` — no decision within timeout → negotiated posture (default `proceed`); audits every fail-open proceed | call | → S14, → N3 | — |
| N7 | P1 | `@acs/host-adapter` | `validateDecision()` — malformed `modifications` → `DENY`; `ASK`/`DEFER` expiry → their `timeout_*` defaults | call | → N3, → N6 | — |
| N27 | P3 | guardian | `denyOnInvalidEnvelope()` — schema or bridge failure returns an explicit ACS `deny` **decision**, not a bare error | call | → N26 | → N4 |
| N51 | P4 | inspector | `tailAuditSinks()` | observe | → U23 | — |
| S14 | P1 | store | `audit sink` — every fail-open proceed, per §6.4's MUST | — | — | → N51 |

**Two failure domains, kept separate.** AGT fails closed on *evaluation* — bad policy output, invalid transform, missing paths — and that produces a `deny` **verdict**, which §6.4 says the host MUST honor regardless of posture. N27 exists so Guardian-side failures also arrive as decisions rather than bare errors, keeping them in that honored path. `on_decision_failure` only governs *delivery*: Guardian silent, transport dead, error with no decision. Conflating the two would either break AGT's invariant or halt production on a network blip.

**⚠️ Blocker discovered in V1 — S13 has no home across processes.** V1 built `S13` as an in-process store, but the Claude Code shim is a **fresh subprocess per hook invocation**, so an in-memory negotiated session config can never survive to the next hook. `negotiateSessionConfig()` is also not called on the real path in V1 at all. `N6 applyFailurePosture()` reads S13, so V3 cannot work until this is resolved: either persist the negotiated config (a session-keyed file), or have the shim talk to a session-scoped daemon. The choice ripples — V5's second host is in-process and would not share the constraint, and V6's session chain sits on the same seam. Decide this before V3 starts.

**Rest of the slice is data, not structure.** Disposition coverage lives in S1 (every ACS decision → `permissionDecision` / `updatedInput`) and S8 (stock rules configured to actually fire allow, deny, escalate, transform, and drift-warn). Once the adapter is generic, coverage is configuration.

Wire N21's error branch to N27, and N4's return through N7 here.

---

## V4: Output redaction on Claude Code

**Demo:** AGT's own Claude Code package documents that it cannot redact tool output. Here is a tool result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput`.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U3 | P1 | claude-code | rewritten tool output in transcript | render | — | — |

New entries in S1 for `PostToolUse` → `steps/toolCallResult`, and in S8 for the `redact` rules.

**Blocked on follow-up F1** — confirm by hand that `PostToolUse.updatedToolOutput` rewrites tool results as the current docs describe. If it does not, this slice drops and R3.8 moves to another capability; nothing downstream depends on it.

**Framing discipline (R4.3).** The claim is that per-host modules freeze capability at the moment they are written, while one contract picks up new host capability for every runtime at once. It is not that AGT got something wrong. Their README was accurate when written.

---

## V5: Second host, zero AGT changes

**Demo:** Same Guardian, same manifest, same bundle. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U10 | P2 | opencode | prompt input | type | → N10 | — |
| U11 | P2 | opencode | tool decision surface | render | — | — |
| U12 | P2 | opencode | redacted tool output | render | — | — |
| N10 | P2 | acs-plugin shim | OpenCode plugin hooks: `session.start`, `event`, `tool.execute.before/after/error` | call | → N11 | — |
| N11 | P2 | `@acs/host-adapter` | `buildEnvelope()` — same module as N2 | call | → N13 | — |
| N12 | P2 | `@acs/host-adapter` | `renderDecision()` — same module as N3 | call | → U11, → U12 | — |
| N13 | P2 | `@acs/host-adapter` | `createGuardianClient().requestDecision()` — same module as N4 | call | → N20 | → N16 |
| N14 | P2 | `@acs/host-adapter` | `negotiateSessionConfig()` — same module as N5 | call | → N28 | → S15 |
| N15 | P2 | `@acs/host-adapter` | `applyFailurePosture()` — same module as N6 | call | → S16, → N12 | — |
| N16 | P2 | `@acs/host-adapter` | `validateDecision()` — same module as N7 | call | → N12, → N15 | — |
| S2 | P2 | store | `opencode.hookmap.yaml` | — | — | → N11, N12 |
| S15 | P2 | store | `negotiated session config` | — | — | → N15 |
| S16 | P2 | store | `audit sink` | — | — | → N51 |

**This is the slice the whole project exists for.** The demo is the diff, not the feature. Two new artifacts — a shim and a hookmap — against zero changes anywhere else.

**Blocked on follow-up F2** — confirm an OpenCode plugin can express deny and modify through `tool.execute.before` / `.after`. AGT's own OpenCode package does both, so the mechanism is evidenced; this is confirmation, not discovery.

---

## V6: Session state and provenance carriage

**Demo:** The SessionContext chain grows per step. AGT emits `result_labels` at one step and receives them back as `input.ifc.source_labels` at the next, carried by ACS provenance.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U22 | P4 | inspector | session chain view: SessionContext entries and lineage | render | — | — |
| N22 | P3 | guardian | `appendSessionEntry()` — hash-chained SessionContext | call | → S3, → N23 | — |
| N25 | P3 | guardian | `persistResultLabels()` — AGT `result_labels` into ACS lineage | call | → S5 | — |
| S3 | P3 | store | `sessionContext`, hash-chained per `session_id` | — | — | → N23 |
| S4 | P3 | store | `intent`, immutable baseline per session | — | — | → N23 |
| S5 | P3 | store | `provenance` — `origin` / `derived_from`, carrying `result_labels` | — | — | → N23 |

**This is R8.1 made concrete.** AGT's `verdict.schema.json` says the core "stores and propagates nothing" and requires the host to persist labels and re-supply them. This slice is the Guardian doing exactly that job — the one AGT's spec asks a host to do and declines to standardize. Nothing here criticizes AGT; it fills a role AGT explicitly delegates.

Wire N21 → N22 → N23 in place of V1's direct N21 → N23.

---

## V7: Conformance matrix

**Demo:** Eight intervention points by five verdicts, all green. AGT completely expressed in ACS, case by case.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U30 | P5 | conformance | coverage matrix, 8 intervention points × 5 verdicts | render | — | — |
| U32 | P5 | conformance | rendered ACS ↔ MS-ACS mapping table | render | — | — |
| N40 | P5 | conformance | `acs-agt-conformance` runner | call | → N41, → N42, → N43, → N44 | — |
| N41 | P5 | conformance | intervention-point round trip, validated against `policy-input.schema.json` | call | — | → N47 |
| N42 | P5 | conformance | verdict round trip: AGT verdict → ACS decision → AGT verdict, assert identity | call | — | → N47 |
| N43 | P5 | conformance | `enforced_identity` recomputation check | call | — | → N47 |
| N44 | P5 | conformance | failure-domain check: an AGT evaluation error arrives as an honored `deny`; a delivery failure applies the negotiated posture and writes an audit event | call | — | → N47 |
| N47 | P5 | conformance | `renderMatrix()` | call | → U30 | — |
| N48 | P5 | conformance | `renderMappingTable()` | call | → U32 | — |

**⚠️ Gap discovered in V1 — the Guardian's outbound envelopes are validated by nothing.** Inbound requests get Ajv against all 43 v0.1.0 schemas (N21), but responses are hand-built objects checked by no schema. The conformance harness would therefore measure a wire format that was never itself contract-checked — which quietly weakens exactly the claim C2 exists to prove. Add response validation before the matrix is published. Related: V1 found that `response-envelope.json`'s `result` unconditionally `$ref`s `AcsResult`, which requires `decision` — a ServerHello has no such field, so a handshake response cannot satisfy it. That looks like a genuine v0.1.0 spec gap (no discriminated union for non-decision methods) and is worth an upstream ACS issue, not just a red cell.

**Expect two cells to be honestly red.** `pre_model_call` and `post_model_call` have no ACS v0.1.0 target — see D4. Red cells with a stated reason are worth more than a green matrix that quietly redefines the claim, and they are the forcing function for `steps/modelCall` in v0.2.

R5.3 lands here: the matrix *is* the profile declaration.

---

## V8: Upstream drift watch

**Demo:** Point the harness at AGT `main`. A changed enum value turns a cell red and names the field.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U31 | P5 | conformance | drift detail: changed point, verdict, or schema field | render | — | — |
| N45 | P5 | conformance | `fetchUpstreamSurfaces()` — AGT wire schemas and enums at `main` | call | → S12 | — |
| N46 | P5 | conformance | `diffSurfaces()` — pinned versus upstream | call | — | → N47 |
| S12 | P5 | store | upstream AGT surfaces | — | — | → N46 |

Surfaces watched, and nothing else (R2.4): `manifest.schema.json`, `policy-input.schema.json`, `verdict.schema.json`, `snapshot.schema.json`, the intervention-point enum, the verdict enum, `reserved-reasons.json`, and the stock bundle's `data.agt.defaults.config` keys.

Runs on a schedule in CI. MS-ACS is `0.3.1-beta` and warns of breaking changes between minor versions, so this is the slice that decides whether the reference implementation is still true six months after the meeting.

---

## Risks and dependencies

| # | Risk | Slice | Handling |
|---|------|-------|----------|
| 1 | `updatedToolOutput` does not behave as documented | V4 | Confirm early (F1). V4 drops cleanly if it fails |
| 2 | OpenCode plugin cannot express modify | V5 | Confirm early (F2). Falls back to deny-only, weakening but not breaking V5 |
| 3 | ~~`opa` CLI dependency raises setup friction~~ | ~~V1~~ | ✅ **Retired.** The SDK ships OPA 0.70.0 in `agent-control-specification-opa-<platform>`. No external binary, so D7 closes as Rego |
| 4 | Two model-call cells cannot go green on v0.1.0 | V7 | Ship red with a stated reason; drive `steps/modelCall` into v0.2 |
| 5 | Upstream AGT breaks the contract mid-project | all | V8 exists for this, but lands late — consider pulling N45/N46 forward if upstream churn shows up during V1 |
| 6 | ⚠️ A `./`-prefixed `bundle:` path silently disables policy — every decision becomes `allow`, with no error | V1 | `createBridge` throws on `/./`; V1's deny test is the backstop. Worth reporting upstream: a fail-open in a governance tool |
| 7 | ⚠️ `enforced_identity` bisection is unavailable over AGT's Python binding | V7 | Resolved by embedding the **Node** SDK, which serializes `input_identity` and `enforced_identity` distinctly. Had we stayed on Python, R1.4 would be unverifiable and N43 impossible |
| 8 | ⚠️ AGT's verdict carries no `rule_id` / `reason_codes` / `reasoning` | V1, V7 | `mapVerdict` synthesizes them from `reason` / `message`, and `mapping.yaml` is where that synthesis is declared — so V7 measures it rather than assuming it |
| 9 | ⚠️ S6 grows unbounded — no rotation and no size cap | V2 | Accepted. It is a gitignored local demo artifact; `: > .acs/envelopes.jsonl` truncates it safely mid-run because `tailEnvelopeLog` resets on truncation. Rotation is not built, and the runbook says so |
| 10 | ⚠️ The tap's two synchronous `appendFileSync` calls per request sit **on the decision path**, and `Bun.serve` is single-threaded | V2 | Accepted, and correct for demo scale. Surfaced by V2's whole-branch review as the neighbour of row 9: a slow filesystem (a stalled network mount, a full disk) blocks *every* in-flight request, not only the one being tapped, because there is no second thread to run them on. No correctness risk — the tap is total, so a write that fails degrades observability and never a decision (constraint 8) — and no latency budget is claimed for it. Recorded rather than fixed; an async or queued tap is the change if a deployment ever needs one |

## Open decisions carried from shaping

| # | Decision | Blocks |
|---|----------|--------|
| D1 | Confirm OpenCode as host #2 | V5 |
| D3 | Hook coverage beyond AGT's eight | V7 scope |
| D4 | Spec `steps/modelCall` for v0.2 as part of this work | V7 red cells |
| D5 | Determinism of the demo | V1 onward |
| ~~D7~~ | ✅ **Closed: Rego.** Cedar's sole advantage was avoiding an external binary; the SDK bundles OPA, so that advantage does not exist. Stock bundle verified 105/105 under the bundled OPA | ~~V1~~ |
| D8 | 🟡 Which `on_decision_failure` ships as default — V1 negotiates and stores it (N5/N28/S13); V3 applies it (N6). Leaning to the spec default `proceed`, paired with U23's audit count | V3 |
| D10 | 🔴 ⚠️ **Sharpened after V2 shipped — two required span attributes have no wire source.** `acs.evaluator` (required on the `acs.decision` span event) does not exist as a field in `AcsResult` at all, and `acs.capability` (required on `gen_ai.tool.call`) maps to `payload.capability`, which `hooks/tool-call-request.json` leaves optional. So a **downstream consumer of the ACS wire cannot emit a conformant trace** — only the Guardian can, from process-local knowledge the contract does not carry, which cuts against R5.1/R5.2 and V2's whole "S6 is readable by anything" design. Full evidence table in the shaping doc under D10. **The ACS Trace pillar is unclaimed by any slice.** `specification/v0.1.0/trace/otel-mapping.json` and `trace/ocsf-mapping.json` are *normative* — the OTel mapping states that a deployment emitting OTel for the Trace pillar MUST use its span names and required attributes verbatim, and it names `steps/toolCallRequest` → `gen_ai.tool.call` explicitly. V2's S6 is deliberately a raw envelope log, **not** an OTel or OCSF export, so this implementation currently claims neither. R5.3 says we declare what we claim and what we do not — so either V7 measures the Trace pillar as an explicit non-claim, or a slice picks it up. Surfaced during V2 planning; nothing depends on it yet | V7 scope |

**Correction log.** V1 planning verified the AGT surface by running it rather than reading it, and produced ten corrections — the SDK choice, the `./` landmine, config-inside-the-bundle, the absent stock shell patterns, the leaf `policy_target`, AGT's missing `rule_id`/`reason_codes`/`reasoning`, lowercase wire decisions, `steps/toolCallRequest` and the 19-hook count, the retired `opa` setup cost, and the Python identity collapse. Each is recorded above at the row it governs, with its evidence, in `docs/superpowers/plans/2026-08-09-v1-one-host-one-hook.md`.

V2 planning produced no corrections — §V2 had nothing wrong in it — but it did close five open choices (P1–P5, recorded under §V2), add three watch-fors, add risk row 9, and surface D10. Its plan is `docs/superpowers/plans/2026-08-09-v2-envelope-inspector.md`.

**V2's whole-branch review produced one correction of its own**, recorded at the watch-for it governs: "S6 records the wire verbatim" over-claimed byte identity that the implementation never had, and the over-claim had propagated verbatim from the plan's global constraint 11 into the slice README, the runbook, the shaping doc's S6 row, and the Inspector's renderer. Corrected in wording, not in code — see the watch-for above for why storing raw bytes would be the worse trade. The same review added risk row 10.
