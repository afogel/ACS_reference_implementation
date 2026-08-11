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
| V5 | Second host, zero AGT changes | C3 | "Same Guardian, same manifest, same bundle. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT." |
| V6 | Session state and provenance carriage | C4 | "The SessionContext chain grows per step. AGT emits `result_labels` at one step and gets them back as `input.ifc.source_labels` at the next, carried by ACS provenance." |
| V7 | Conformance matrix | C1, C2, C5 | "Eight intervention points by five verdicts, every cell resolved — green where ACS v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim." |
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

**Scope note.** Only `pre_tool_call` is wired. No session state, no envelope log, no second host. `N23` assembles the snapshot from the envelope alone; it starts reading S3/S4/S5 in V6.

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

Two consequences. First, `warn` is reachable and V3 makes it live, closing the gap V2 left open where U21's `◐ ALLOW (policy fired — ACS "warn")` badge state was unit-tested but never seen. Second — **for V7** — the score has no source on the ACS v0.1.0 wire: `hooks/tool-call-request.json` carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent`, and nothing a drift or confidence score could honestly be derived from. So a wire consumer cannot drive AGT's `warn` gate; the Guardian must originate the score. AGT's own design says as much ("Hosts run a behaviour-drift detector **outside the policy engine**") and the Guardian is the host here, so this is AGT working as intended and a note about ACS v0.1.0's coverage — the same shape as D10's two attributes.

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

**Demo:** AGT's own Claude Code package documents that it cannot redact tool output. Here is a tool result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput` **in the tool's own output shape** — which is the condition that makes it work at all.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U3 | P1 | claude-code | rewritten tool output in transcript | render | — | — |

New entries in S1 for `PostToolUse` → `steps/toolCallResult`, and in S8 for the `redact` rules. Beyond those, the slice extends six existing affordances to a **second ACS method** rather than adding new ones: `N2 buildEnvelope` (result payload), `N3 renderDecision` (see the correction below), `N7 validateDecision` (array-index descent), `N21 validateEnvelope`, `N23 assembleSnapshot` (**a sibling `assembleResultSnapshot`, not a branch** — see the correction below), `N24 mapVerdict` (a result-side `modifications` synthesis).

**⚠️ F1 resolved during V4 planning — the slice proceeds, with two conditions attached.** Confirmed by hand against Claude Code **2.1.227**: `PostToolUse.hookSpecificOutput.updatedToolOutput` exists ("Replaces the tool output before it is sent to the model") and does rewrite tool results. Risk row 1 retires. But two things the original row did not anticipate govern the whole slice, and both were found by running it:

**⚠️ Watch-for — a replacement that does not match the tool's own output schema is silently discarded, and the ORIGINAL output is delivered.** This is the slice's central hazard and it is a fail-open. A hook returning `updatedToolOutput: "[REDACTED]"` — a plain string, the natural reading of "redact the output", and exactly the shape §6.3's `modified_content` provides — produced this, while the model received the real secret:

> `PostToolUse hook returned updatedToolOutput that does not match Bash's output shape; using original output. [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received string"}]`

`Bash`'s shape is `{stdout, stderr, interrupted, isImage, noOutputExpected}`. So a redaction is only a redaction if it preserves every sibling field, and the adapter gets there by patching a **clone of the object the host handed it** at a hookmap-named path — never by constructing a new one. Where it cannot, it fails closed. This is why AGT's README says "cannot **reliably** redact": the wording is exact, and this watch-for is the evidence for it rather than a correction of it.

**⚠️ Watch-for — a `deny` at the result gate does not suppress anything.** Rendering deny as Claude Code's documented `{"decision":"block","reason":…}` was tested directly: the model received the real stdout **and** the block reason. The tool has already run and its result has already been formed. So `block` alone would *report* a suppression that did not happen — the same "reported but never took effect" shape §V3 found when V1 copied a raw `modifications` object into `updatedInput`. Deny renders as `block` **and** a replacing `updatedToolOutput`; only the latter withholds.

**⚠️ Correction — "new entries in S1" understates it; `decisions` is one block shared by every hook.** ~~N3 requires a `permissionDecision` and hardcodes three Claude Code field names (`permissionDecision`, `permissionDecisionReason`, `updatedInput`) … declares host output field names as data (`set` / `from` / `top_level`).~~ **Superseded before V4 began.** PR #10's review landed the field-name half on `slice/v1`, on this same reasoning: `renderDecision` now reads an `output:` map of **dotted host paths** to `{value}` or `{from, type}`, names no host field, and `test/invariants.test.ts` gates that. A path with **no dot** already renders top-level, which is how `PostToolUse` gets its `decision`/`reason` beside `hookSpecificOutput.updatedToolOutput` — so `set` / `from` / `top_level` **never shipped and is not built**. Struck through rather than deleted because a row naming a shape that never existed is the ghost-name defect PR #11 filed against `N26`, and V5 would have inherited it.

What is still V4's: `decisions` is a **single top-level block** for all hooks, `renderDecision` takes no hook name, and three gates require every decision to declare a `permissionDecision` — `assertRenderableDecisions` at hookmap load, `assertHostAcceptsEveryDecision` in the shim, and the shim's missing-wrapper refusal. `PostToolUse` has no such field, so the block moves **under each hook** and all three gates learn the hook. That is what makes **V5's `N12` — "`renderDecision()` — same module as `N3`" — literally true**: V4 is where a second *hook* forces the split a second *host* would have forced anyway.

**⚠️ Watch-for — a clean `PostToolUse` allow renders *nothing*, and two fail-open guards are gate-specific because of it.** At `PreToolUse`, an output with no decision in it means the tool call proceeds ungoverned, so `renderDecision` refuses an empty rule and the shim refuses an output with no `hookSpecificOutput` wrapper. Both refusals are correct there and **wrong** at a gate where the tool has already run: "nothing to change, deliver it unchanged" is the honest answer for a clean result, and refusing it would exit 2 on every clean tool call. Neither guard is relaxed — each learns the hook. The `allow` entry declares one **conditional** field, `hookSpecificOutput.additionalContext` from `reasoning` (present in 2.1.227's `PostToolUse` schema), so the rule is non-empty while the rendered output is: a plain allow renders `{}`, and an observe-only allow (AGT `warn` → ACS allow, R1.2) reaches the transcript — the same gap §V3 closed for `PreToolUse`'s `allow`, closed the same way at the second gate.

**⚠️ Correction — the result gate is a *sibling* of the request gate at every layer, not a branch inside it.** This slice's own sentence above said "`N23 assembleSnapshot` (a `post_tool_call` branch)", and PR #10's review had already ruled otherwise on `slice/v1`: `assembleSnapshot` takes the **narrow** `ToolCallRequestEnvelope`, reachable only through `isToolCallRequest`, and its doc comment says *"A later slice's `post_tool_call` snapshot is a sibling type beside this one, not a widening of it."* So V4 adds `ToolCallResultEnvelope`, `isToolCallResult`, `AgtPostToolCallSnapshot` and `assembleResultSnapshot`, each beside its twin, and the Guardian dispatches on **the predicate that narrowed the envelope** — never on the method string and never on the resolved intervention point. The two snapshots share no member but `envelope.budgets`, which is why a union type is the wrong answer. `mapping.yaml` declares six methods with points and this Guardian assembles two, so a point-driven dispatch would hand a `steps/sessionStart` envelope to whichever assembler came first and return a verdict that looks perfectly well-formed while having evaluated the wrong policy against the wrong shape. `N23`'s affordance row now names both functions.

**⚠️ Watch-for — `validateEnvelope` gained a payload schema for the result method, which moves a boundary.** Before V4, `validateEnvelope` payload-checked only `steps/toolCallRequest` and a `steps/toolCallResult` envelope fell through to a bare `method_not_dispatched` JSON-RPC error — which the host adapter reads as *no decision arrived*, and answers with the negotiated posture. Now a malformed result envelope gets N27's honoured `envelope_invalid` **deny** instead. Intended and fail-closed, and worth stating because it is the one place this slice changed what an existing method-shaped failure does. Note also that `outputs: []` is schema-valid (`hooks/tool-call-result.json` sets no `minItems`), reaches the assembler, and AGT answers `deny` / `runtime_error:path_missing` — pinned, because "empty output" is the shape most likely to be answered with an allow by a later change.

**⚠️ Correction — ACS's result payload carries no tool arguments.** `hooks/tool-call-result.json` requires `tool`, `exit_status`, `outputs` and nothing else. So at this gate the wire cannot supply `tool_call.args`, and the Guardian synthesizes `tool_call: { name }` from `payload.tool.name` — load-bearing, because AGT resolves `tool_name_from` before policy runs and fails **closed** (`runtime_error:path_missing`) without it. A policy wanting both the call and its result must correlate through `request_id_ref`, which is **V6's** session chain. V7 records the cell.

**⚠️ Correction — `modifications.modified_content` has no applicable target on this host at *either* gate.** §V3 recorded that this adapter has no mapping from an opaque replacement string onto `updatedInput`, an arguments object. The result gate refuses it for the same reason: `updatedToolOutput` must match a structured output shape. That upgrades V3's note from "this adapter has no mapping" to "**this host has no target**", which is the stronger statement V7's matrix should carry.

**⚠️ Amendment — the config ships, and a second config is forbidden.** `redact` lands in `policy/lib/data.json` beside `patterns`, and `policy/manifest.yaml` gains a `post_tool_call` point (`policy_target: "$.tool_result.outputs[0].value"`, `policy_target_kind: tool_result`). Both edits are additive; the full suite was unchanged by them when measured during planning (347 pass, 1 skip, 0 fail) — a baseline the review redistribution has since moved to 396 pass, 1 skip, 0 fail, so V4 re-measures rather than trusting it. A *separate* config document was considered and rejected — config lives inside the bundle directory (V1's amendment), so a second config means a second **bundle**, i.e. a fork of the pinned `.rego` files, which is exactly what R2.2/R2.3 forbid and `verify:pin` exists to catch. §V3's `manifest.drift.yaml` is not the precedent it resembles: a second *manifest* over the same `bundle: lib` is cheap, a second *config* is not. Consequence: `docs/demos/v3-runbook.md` says this rule was "reverted after", which V4's PR corrects — the rule now ships.

**Scope added at planning** (all amend this slice, all land in V4's PR):
- **S1's `decisions` block becomes per-hook**, and `N3`'s signature gains the hook name — its affordance row is amended with the change, not after it. See the correction above; the field-name half is already done.
- **The fourth invariant gate is *widened*, not added.** It already exists in `test/invariants.test.ts` and passes, asserting that `packages/host-adapter/src` names none of `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `hookSpecificOutput` — landed by PR #10's review. V4 adds `updatedToolOutput`, the one term its own work could get wrong, and mutation-tests that term specifically: the other four pass whether or not the fifth is in the list. This project turns architectural claims into grep gates rather than prose.
- **Array-index descent, in `N7`'s extracted `modifications.ts`.** `/outputs/0/value` is *the* redaction path for a result payload and is rejected today (V3 rejected array descent because a naive `setAtPath` rewrites the array as `{"0": …}`). Arrays are now edited in place, with every existing guard — reserved segments, absent targets, disjointness — untouched. PR #12's review moved `applyModifications` out of `validateDecision` into its own module, so this lands there.
- **`exit_status` is a hookmap literal `success`.** Claude Code fires a separate `PostToolUseFailure` event (present in 2.1.227's hook schema) which this slice does not wire, so `PostToolUse` genuinely means success — recorded as a known gap rather than derived from a field that does not carry it. V7's matrix gets the cell.

**Framing discipline (R4.3).** The claim is that per-host modules freeze capability at the moment they are written, while one contract picks up new host capability for every runtime at once. It is not that AGT got something wrong. Their README was accurate when written.

**And it is accurate now (R4.4).** Quoted in full from `agent-governance-claude-code/README.md:39` at the pinned ref, under its own heading **"## Important parity gaps"**: *"`PostToolUse` in Claude cannot reliably redact tool output after the tool has already executed, so this package does not claim Copilot-style output suppression parity."* Read precisely: "cannot **reliably**", and "does not **claim** parity" — a scoping statement about the package, not an assertion that the host cannot do it. The two watch-fors above are exactly *why* that wording is right. What V4 shows is that meeting the reliability condition is a contract-level job done once, not a per-host module's job redone for every runtime.

Plan: `docs/superpowers/plans/2026-08-11-v4-output-redaction.md`.

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

**Demo:** Eight intervention points by five verdicts, every cell resolved — green where ACS v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim.

**⚠️ Demo corrected (was "all green").** The original sentence was already contradicted by this slice's own body, which has expected two honestly-red model-call cells since shaping; D10 adds two more. A matrix that must be all green to count is a matrix under pressure to redefine the claim, which is the opposite of what C2 is for. The demo now asks for every cell *resolved*, which is achievable and is the stronger deliverable.

| # | Place | Component | Affordance | Control | Wires Out | Returns To |
|---|-------|-----------|------------|---------|-----------|------------|
| U30 | P5 | conformance | coverage matrix, 8 intervention points × 5 verdicts | render | — | — |
| U32 | P5 | conformance | rendered ACS ↔ MS-ACS mapping table | render | — | — |
| U33 | P5 | conformance | trace-pillar row: each required OTel attribute, its v0.1.0 wire source, and whether a wire consumer can emit it | render | — | — |
| N40 | P5 | conformance | `acs-agt-conformance` runner | call | → N41, → N42, → N43, → N44 | — |
| N41 | P5 | conformance | intervention-point round trip, validated against `policy-input.schema.json` | call | — | → N47 |
| N42 | P5 | conformance | verdict round trip: AGT verdict → ACS decision → AGT verdict, assert identity | call | — | → N47 |
| N43 | P5 | conformance | `enforced_identity` recomputation check | call | — | → N47 |
| N44 | P5 | conformance | failure-domain check: an AGT evaluation error arrives as an honored `deny`; a delivery failure applies the negotiated posture and writes an audit event | call | — | → N47 |
| N49 | P5 | conformance | trace-pillar check: every attribute `trace/otel-mapping.json` marks required, resolved against the v0.1.0 wire schemas | call | — | → N47 |
| N47 | P5 | conformance | `renderMatrix()` | call | → U30, → U33 | — |
| N48 | P5 | conformance | `renderMappingTable()` | call | → U32 | — |

**⚠️ Gap discovered in V1 — the Guardian's outbound envelopes are validated by nothing.** Inbound requests get Ajv against all 43 v0.1.0 schemas (N21), but responses are hand-built objects checked by no schema. The conformance harness would therefore measure a wire format that was never itself contract-checked — which quietly weakens exactly the claim C2 exists to prove. Add response validation before the matrix is published. Related: V1 found that `response-envelope.json`'s `result` unconditionally `$ref`s `AcsResult`, which requires `decision` — a ServerHello has no such field, so a handshake response cannot satisfy it. That looks like a genuine v0.1.0 spec gap (no discriminated union for non-decision methods) and is worth an upstream ACS issue, not just a red cell.

**⚠️ The Trace pillar lands here too (D10), and two of its cells are already known red.** `trace/otel-mapping.json` is normative — a deployment emitting OTel for the Trace pillar MUST use its span names and required attributes verbatim. Measured against the pinned schemas after V2 shipped:

| Required by the mapping | Source in v0.1.0 | Cell |
|---|---|---|
| `gen_ai.tool.name` on `gen_ai.tool.call` | `payload.tool.name`, `required` | 🟢 |
| `acs.capability` on `gen_ai.tool.call` | `payload.capability`, **optional** — `hooks/tool-call-request.json` requires only `tool` and `arguments` | 🔴 a conformant envelope may omit it |
| `acs.decision` on the `acs.decision` span event | `AcsResult.decision`, `required` | 🟢 |
| `acs.evaluator` on the `acs.decision` span event | **none** — `AcsResult` has no such field | 🔴 no wire source |
| `acs.confidence`, `acs.evaluator_version`, `acs.model_id` (required "when present in the decision envelope") | **none** — no such fields in `AcsResult` | 🔴 can never be present |

`N49` is what turns that table into measured cells rather than this prose, and `U33` renders it. The finding worth publishing is not the missing fields but their consequence: **a downstream consumer of the ACS wire cannot emit a conformant trace** — only the Guardian can, from process-local knowledge the contract does not carry. That cuts directly against R5.1/R5.2 and against V2's design, where S6 is readable by anything and the Inspector proves it by importing nothing. An OTel exporter reading S6 hits the same wall.

**Scope boundary:** V7 *measures* the Trace pillar. It does not build an exporter. If an exporter is ever wanted it has to live in the Guardian for the reason above, and that is a slice of its own, not V7 scope.

**⚠️ One more cell to resolve, from V3.** AGT's `warn` verdict is reachable only through a host-supplied annotation — the stock drift gate reads `input.annotations.drift_score`, and annotations come from a manifest-declared annotator, never from the snapshot (§V3's evidence). The ACS v0.1.0 tool-call-request payload carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent` and nothing a drift or confidence score could be derived from. So the matrix's `warn` column resolves the same way D10's attributes did: **green for the Guardian, red for a wire consumer** — a downstream ACS consumer cannot drive AGT's `warn` gate, because the contract does not carry the input that gate reads. V3 makes `warn` live from a deployment-supplied score, which is what AGT's design asks a host to do, so this is a note about ACS v0.1.0's coverage rather than about AGT.

**Expect two cells to be honestly red — now four.** `pre_model_call` and `post_model_call` have no ACS v0.1.0 target (D4), and the two Trace attributes above have no wire source (D10). Red cells with a stated reason are worth more than a green matrix that quietly redefines the claim, and they are the forcing function for `steps/modelCall` and for an `evaluator` field on `AcsResult` in v0.2.

R5.3 lands here: the matrix *is* the profile declaration — including the Trace pillar, which this implementation declares it does **not** claim, with the measured reason attached.

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
| 1 | ~~`updatedToolOutput` does not behave as documented~~ | ~~V4~~ | ✅ **Retired.** F1 resolved by hand against Claude Code 2.1.227 during V4 planning: it exists and rewrites tool results, so V4 does not drop. Replaced by rows 15 and 16, which are the conditions the original row did not anticipate |
| 2 | OpenCode plugin cannot express modify | V5 | Confirm early (F2). Falls back to deny-only, weakening but not breaking V5 |
| 3 | ~~`opa` CLI dependency raises setup friction~~ | ~~V1~~ | ✅ **Retired.** The SDK ships OPA 0.70.0 in `agent-control-specification-opa-<platform>`. No external binary, so D7 closes as Rego |
| 4 | Two model-call cells cannot go green on v0.1.0 | V7 | Ship red with a stated reason; drive `steps/modelCall` into v0.2 |
| 5 | Upstream AGT breaks the contract mid-project | all | V8 exists for this, but lands late — consider pulling N45/N46 forward if upstream churn shows up during V1 |
| 6 | ⚠️ A `./`-prefixed `bundle:` path silently disables policy — every decision becomes `allow`, with no error | V1 | `createBridge` throws on `/./`; V1's deny test is the backstop. Worth reporting upstream: a fail-open in a governance tool |
| 7 | ⚠️ `enforced_identity` bisection is unavailable over AGT's Python binding | V7 | Resolved by embedding the **Node** SDK, which serializes `input_identity` and `enforced_identity` distinctly. Had we stayed on Python, R1.4 would be unverifiable and N43 impossible |
| 8 | ⚠️ AGT's verdict carries no `rule_id` / `reason_codes` / `reasoning` | V1, V7 | `mapVerdict` synthesizes them from `reason` / `message`, and `mapping.yaml` is where that synthesis is declared — so V7 measures it rather than assuming it |
| 9 | ⚠️ S6 grows unbounded — no rotation and no size cap | V2 | Accepted. It is a gitignored local demo artifact; `: > .acs/envelopes.jsonl` truncates it safely mid-run because `tailEnvelopeLog` resets on truncation. Rotation is not built, and the runbook says so |
| 10 | ⚠️ The sink's two synchronous `appendFileSync` calls per request sit **on the decision path**, and `Bun.serve` is single-threaded | V2 | Accepted, and correct for demo scale. Surfaced by V2's whole-branch review as the neighbour of row 9: a slow filesystem (a stalled network mount, a full disk) blocks *every* in-flight request, not only the one being recorded, because there is no second thread to run them on. No correctness risk — the sink is total, so a write that fails degrades observability and never a decision (constraint 8) — and no latency budget is claimed for it. Recorded rather than fixed; an async or queued sink is the change if a deployment ever needs one |

| 11 | ⚠️ AGT's stock `warn` gate has no ACS v0.1.0 wire source | V3, V7 | Accepted and recorded rather than worked around. The only stock rule emitting `warn` is the drift gate, which reads `input.annotations.drift_score`; annotations reach the policy input from a manifest-declared annotator, never from the snapshot (verified across five placements). The ACS v0.1.0 tool-call-request payload carries no field a score could be derived from, so the Guardian must originate it — which is what AGT's design asks a host to do. V3 makes `warn` live through `policy/manifest.drift.yaml` and says plainly in the runbook that the score is deployment-supplied, not wire-derived. V7's matrix records the cell with that reason |
| 12 | ⚠️ V3's fixture bundles could drift from the pinned bundle and quietly void R2.2/R2.3 | V3 | Covering five verdict classes needs five config documents, and config lives in the bundle directory (the shipped SDK exposes no data-push API). The test helper that builds each fixture bundle asserts every copied `.rego` is byte-identical to `policy/lib`'s, and V3's last task runs `bun run verify:pin` — so a fixture that forked the bundle fails rather than passing quietly |

| 13 | ⚠️ S14's `seq` is derived by reading the log, so two hooks running concurrently can emit the same number | V3, V6 | Accepted and recorded. The sink runs in a fresh subprocess per hook, so `seq` is derived from the entries already in the file at open time — which makes it per-session monotonic where a per-instance counter made every entry `#1`. Nothing synchronises the read, so parallel hooks can duplicate a number; harmless while a host fires hooks one at a time, wrong the day one does not. It also re-reads the whole log on first write, on the decision path, against a file with no rotation. **V6 matters here:** a per-session monotonic sequence is the natural index for its hash-chained session history, and it would need the duplicate closed first |
| 14 | ~~⚠️ When the negotiated ServerHello cannot be *persisted*, the posture it declared is still not applied to the current hook~~ | V3 | ✅ **Closed.** Visibility shipped first (the failure lands in the audit entry as `session_failure` rather than being swallowed by a bare `catch {}`), and the deferred half is now closed too: `handshake()` throws `SessionConfigNotStoredError` carrying the ServerHello it could not store, and the shim applies that value to the step that negotiated it (`store.get() ?? negotiated`). Persisting is an optimisation for later hooks — the shipped host runs each hook in a fresh subprocess — while the value in hand is authoritative for this one, so a deployment declaring `deny` no longer fails *open* on the very step whose posture it just negotiated. `session_failure` still travels into the entry, so the persistence failure stays visible; pinned by `hosts/claude-code/test/posture.test.ts`'s "applies a ServerHello it could not persist to the step that negotiated it" |

| 15 | ⚠️ A tool-output replacement that does not match the tool's own output schema is **silently discarded**, and Claude Code delivers the original — secret and all | V4 | The slice's central hazard, and a fail-open of the same family as the nine already closed. Measured, with Claude Code's own text: *"returned updatedToolOutput that does not match Bash's output shape; using original output"*. Handled structurally rather than by care: the adapter patches a **clone of the object the host handed it**, at a path S1 names, so every sibling field survives by construction; where it cannot express the edit in the host's shape it fails **closed** (a withholding deny), never "applied" with nothing applied. Pinned by a test asserting every sibling field, and mutation-tested |
| 16 | ⚠️ A `deny` at the result gate does not suppress output — `block` is a reason, not a withholding | V4, V7 | Measured: the model received the real stdout *and* the block reason. Deny therefore renders as `block` **and** a replacing `updatedToolOutput`; only the latter withholds. Left as prose in an earlier draft of §V4 and now structural, because rendering `block` alone would report a suppression that did not happen — the exact shape §V3 found when V1 copied a raw `modifications` object into `updatedInput`. V7's matrix records the cell: on this host, at this gate, `deny` is expressible only *through* the modify mechanism |

## Open decisions carried from shaping

| # | Decision | Blocks |
|---|----------|--------|
| D1 | Confirm OpenCode as host #2 | V5 |
| D3 | Hook coverage beyond AGT's eight | V7 scope |
| D4 | Spec `steps/modelCall` for v0.2 as part of this work | V7 red cells |
| D5 | Determinism of the demo | V1 onward |
| ~~D7~~ | ✅ **Closed: Rego.** Cedar's sole advantage was avoiding an external binary; the SDK bundles OPA, so that advantage does not exist. Stock bundle verified 105/105 under the bundled OPA | ~~V1~~ |
| ~~D8~~ | ✅ **Closed: `proceed`, the spec default.** R1.7 and `handshake.json`'s own `default` both fix it, and V1 already shipped it in `handshakeResponder()`. V3 makes it deployment-declared (`ACS_ON_DECISION_FAILURE`) so one binary demos both halves, with `proceed` when unset — and a value that is neither posture **throws** rather than falling back, because guessing a posture from a typo is the silent bypass this slice exists to remove. Paired with U23's audit count, per the original reasoning | ~~V3~~ |
| ~~D10~~ | ✅ **Closed: V7 owns it, as a measured non-claim.** The ACS Trace pillar (`trace/otel-mapping.json`, `trace/ocsf-mapping.json`) is normative and was unclaimed by any slice. It now lands in V7 as `N49`/`U33` — V7 *measures* the pillar rather than emitting it, and the matrix declares it as a pillar this implementation does not claim, with the reason attached. Two required attributes already measure red: `acs.evaluator` has no field in `AcsResult` at all, and `acs.capability` maps to an optional payload field. The consequence is the publishable part — **a downstream consumer of the ACS wire cannot emit a conformant trace**, only the Guardian can, from knowledge the contract does not carry. Building an exporter would be a slice of its own, not V7 scope. Evidence tables in §V7 and in the shaping doc under D10 | `specification/v0.1.0/trace/otel-mapping.json` and `trace/ocsf-mapping.json` are *normative* — the OTel mapping states that a deployment emitting OTel for the Trace pillar MUST use its span names and required attributes verbatim, and it names `steps/toolCallRequest` → `gen_ai.tool.call` explicitly. V2's S6 is deliberately a raw envelope log, **not** an OTel or OCSF export, so this implementation currently claims neither. R5.3 says we declare what we claim and what we do not. Surfaced during V2 planning, measured after V2 shipped, and settled into V7 | V7 (N49, U33) |

**Correction log.** V1 planning verified the AGT surface by running it rather than reading it, and produced ten corrections — the SDK choice, the `./` landmine, config-inside-the-bundle, the absent stock shell patterns, the leaf `policy_target`, AGT's missing `rule_id`/`reason_codes`/`reasoning`, lowercase wire decisions, `steps/toolCallRequest` and the 19-hook count, the retired `opa` setup cost, and the Python identity collapse. Each is recorded above at the row it governs, with its evidence, in `docs/superpowers/plans/2026-08-09-v1-one-host-one-hook.md`.

V2 planning produced no corrections — §V2 had nothing wrong in it — but it did close five open choices (P1–P5, recorded under §V2), add three watch-fors, add risk row 9, and surface D10. Its plan is `docs/superpowers/plans/2026-08-09-v2-envelope-inspector.md`.

**V3 planning produced five corrections**, each recorded at the row it governs in §V3, and each verified by running AGT rather than reading it. Its plan is `docs/superpowers/plans/2026-08-10-v3-dispositions-and-postures.md`. In order of consequence: ACS `defer` has no AGT verdict behind it, so the demo promised something AGT cannot produce (and ACS being wider is the point, not a gap to fill); `annotations` never reaches the policy input from the snapshot, which is what makes `warn` reachable only from a Guardian-originated score; the stock approval gate is a single global switch, so several verdict classes need several config documents; "the rest is data, not structure" missed two load-bearing structural pieces on the `modify` path; and `guardianClient.post` had no timeout, without which N6 could never fire. Two of the five are notes about **ACS v0.1.0's** coverage rather than AGT's, and go to V7's matrix as resolved cells with reasons. D8 closed on the spec default in the same pass.

**V4 planning produced six corrections and closed F1**, each recorded at the row it governs in §V4, and each verified by running the thing rather than reading its documentation — Claude Code 2.1.227 and AGT at the pinned ref. In order of consequence: a tool-output replacement that does not match the tool's own output schema is **silently discarded and the original delivered**, which makes the naive redaction a fail-open; a `deny` at the result gate does not suppress anything, so `block` alone would report a withholding that never happened; `renderDecision` cannot express this gate at all, which forces S1's `decisions` block to become per-hook and — not incidentally — makes V5's "same module as N3" true rather than aspirational; ACS's result payload carries no tool arguments, so `tool_call.name` is synthesized and correlation is V6's; `modifications.modified_content` has no target on this host at *either* gate, upgrading §V3's note to a stronger V7 statement; and a second config document is impossible without forking the pinned bundle, so `redact` ships in `policy/lib/data.json` — which in turn makes §V3's runbook sentence about reverting that edit stale. Three of the six are notes about **ACS v0.1.0's** coverage or about this host, never about AGT: its README's "cannot *reliably* redact" is exactly right, and V4's evidence is what shows why. Its plan is `docs/superpowers/plans/2026-08-11-v4-output-redaction.md`.

**V2's whole-branch review produced one correction of its own**, recorded at the watch-for it governs: "S6 records the wire verbatim" over-claimed byte identity that the implementation never had, and the over-claim had propagated verbatim from the plan's global constraint 11 into the slice README, the runbook, the shaping doc's S6 row, and the Inspector's renderer. Corrected in wording, not in code — see the watch-for above for why storing raw bytes would be the worse trade. The same review added risk row 10.
