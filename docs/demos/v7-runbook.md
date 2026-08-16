# V7 demo runbook: the conformance matrix, captured

**The demo, in the slice's own words** (`slices/v7/README.md`, and the corrected form in
`docs/shaping/acs-reference-impl-slices.md` §V7):

> Eight intervention points by five AGT verdicts, every cell resolved — green where ACS
> v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the Trace pillar,
> measured as an explicit non-claim.

This runbook is written from one real run of this tree's own conformance runner — the
committed Guardian, the committed AGT bridge, the pinned `policy/lib` bundle, and a real
network fetch of AGT's own schema at the ref `agt.lock` pins. Nothing here is composed or
hand-edited: the block below is pasted from that one run, and it is not re-run piecemeal to
produce a nicer-looking excerpt.

**No host and no model appears anywhere in this file.** `packages/conformance/src/main.ts`
starts one Guardian itself, in-process, on an OS-assigned port (`port: 0`), for the one
check that needs a live HTTP round trip (N44); it calls the AGT bridge directly
(`createBridge("policy/manifest.yaml")`) for everything else, and closes the Guardian in a
`finally` before exiting. Nothing in the run path is a Claude Code or OpenCode hook, and
nothing in it asks a model anything.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- **Network access to GitHub.** `scripts/run-conformance.sh` clones AGT at `agt.lock`'s
  pinned ref into a fresh temporary directory and points `UPSTREAM_AGT_CLONE` at it before
  running the harness, so the schema leg below (N41's second half, against AGT's own
  `policy-input.schema.json`) can validate against the real upstream file rather than
  self-skip. `bun run verify:pin` has the same shape, for the same reason.
- **`trash` on PATH.** The script refuses to run without it: `rm -rf` is not permitted in
  this repo, and the temporary clone is cleaned up with `trash` in an `EXIT` trap.

## The command, captured

```bash
$ bun run conformance
```

```
$ bash scripts/run-conformance.sh
=== U32 mapping table (N48, S10's declaration) ===
AGT intervention point -> ACS v0.1.0 method (mapping.yaml: intervention_points)
  agent_shutdown  -> steps/sessionEnd
  agent_startup   -> steps/sessionStart
  input           -> steps/userMessage
  output          -> steps/agentResponse
  post_model_call -> (no ACS v0.1.0 target — D4, V7 red cell)
  post_tool_call  -> steps/toolCallResult
  pre_model_call  -> (no ACS v0.1.0 target — D4, V7 red cell)
  pre_tool_call   -> steps/toolCallRequest

AGT verdict -> ACS decision (mapping.yaml: verdicts)
  allow     -> allow
  deny      -> deny
  escalate  -> ask
  transform -> modify
  warn      -> allow (non-empty policy_references required)

=== U30 coverage matrix (N47, N41-N44 merged) ===
AGT intervention point (rows) x AGT verdicts (columns)
Each cell measures ACS v0.1.0's expressive power against AGT's vocabulary at that point x verdict -- it is NOT a claim about which methods this Guardian evaluates. Which methods this Guardian evaluates is a different question, answered by this Guardian's own ServerHello (its methods_evaluated field), never by this table.

                 allow         deny          escalate      transform     warn          
agent_shutdown   ✔             ✔[1]          ✔             ✖[2]          ◐[3]          
agent_startup    ✔             ✔[1]          ✔             ✖[4]          ◐[3]          
input            ✔             ✔[1]          ✔             ✖[5]          ◐[3]          
output           ✔             ✔[1]          ✔             ✖[6]          ◐[3]          
post_model_call  ✖[7]          ✖[7]          ✖[7]          ✖[7]          ✖[7]          
post_tool_call   ✔             ✔[1]          ✔             ◐[8]          ◐[3]          
pre_model_call   ✖[7]          ✖[7]          ✖[7]          ✖[7]          ✖[7]          
pre_tool_call    ✔             ✔[1]          ✔             ◐[8]          ◐[3]          

Legend: ✔ expressed   ◐ guardian_only   ✖ unexpressed

[1] AGT's evaluation layer fails closed (R1.5, §6.4): an otherwise well-formed envelope missing a required request-envelope.json field (params.metadata) arrives as an honoured ACS deny decision at this point, never a bare JSON-RPC error -- denyOnInvalidEnvelope (N27) is what does it, measured live against this Guardian at this point specifically. Domain (2), the wire's delivery-failure half of R1.7, is a different claim, is the host's rather than the Guardian's, and is measured separately by hosts/claude-code/test/posture.test.ts.
[2] mapping.yaml maps AGT decision "transform" to ACS "modify", but its intervention_points row for "agent_shutdown" declares no modifications rule, so this mapping cannot express the rewrite
[3] AGT's only stock warn gate reads input.annotations.drift_score, which reaches the policy input from a manifest-declared annotator and never from the snapshot; no ACS v0.1.0 method payload carries a field a drift score could be derived from, so the Guardian must originate it
[4] mapping.yaml maps AGT decision "transform" to ACS "modify", but its intervention_points row for "agent_startup" declares no modifications rule, so this mapping cannot express the rewrite
[5] mapping.yaml maps AGT decision "transform" to ACS "modify", but its intervention_points row for "input" declares no modifications rule, so this mapping cannot express the rewrite
[6] mapping.yaml maps AGT decision "transform" to ACS "modify", but its intervention_points row for "output" declares no modifications rule, so this mapping cannot express the rewrite
[7] no ACS v0.1.0 target — D4, V7 red cell
[8] ACS v0.1.0 carries no action-identity field on any of its 43 schemas, so a wire consumer cannot bind an approval to the action that executed; AGT's enforced identity binds to the policy target it rewrote, not to the document the host applies modifications to

=== U33 trace rows (N52, N49's measurement) ===
Trace pillar (trace/otel-mapping.json): each required OTel attribute against its v0.1.0 wire source, and whether a downstream consumer of the ACS wire -- not this Guardian -- could emit it from that source alone. R5.3 declares this implementation does NOT claim the Trace pillar; this table is what that declaration is measured against.

  ✔ gen_ai.tool.name      on gen_ai.tool.call                               <- hooks/tool-call-request.json#tool.name
  ✖ acs.capability        on gen_ai.tool.call                               <- hooks/tool-call-request.json#capability hooks/tool-call-request.json's "capability" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.capability being emitted
  ✔ gen_ai.tool.name      on gen_ai.tool.result                             <- hooks/tool-call-result.json#tool.name
  ✔ acs.exit_status       on gen_ai.tool.result                             <- hooks/tool-call-result.json#exit_status
  ✔ acs.session.id        on acs.session                                    <- request-envelope.json#AcsParams.metadata.session_id
  ✔ acs.session.reason    on acs.session.end                                <- hooks/session-end.json#reason
  ✔ acs.session.id        on acs.message.user                               <- request-envelope.json#AcsParams.metadata.session_id
  ✔ acs.content.types     on acs.message.user                               <- hooks/user-message.json#content[].type
  ✔ acs.session.id        on acs.message.agent                              <- request-envelope.json#AcsParams.metadata.session_id
  ✔ acs.agent.id          on acs.message.agent                              <- request-envelope.json#AcsParams.metadata.agent_id
  ✔ acs.decision          on acs.decision                                   <- response-envelope.json#AcsResult.decision
  ✖ acs.evaluator         on acs.decision                                   <- response-envelope.json#AcsResult.metadata.evaluator response-envelope.json's "AcsResult.metadata.evaluator" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.evaluator being emitted
  ✖ acs.reasoning         on acs.decision                                   <- response-envelope.json#AcsResult.reasoning response-envelope.json's "AcsResult.reasoning" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.reasoning being emitted
  ✖ acs.confidence        on acs.decision                                   <- response-envelope.json#AcsResult.metadata.confidence response-envelope.json's "AcsResult.metadata.confidence" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.confidence being emitted
  ✖ acs.evaluator_version on acs.decision                                   <- response-envelope.json#AcsResult.metadata.evaluator_version response-envelope.json's "AcsResult.metadata.evaluator_version" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.evaluator_version being emitted
  ✖ acs.model_id          on acs.decision                                   <- response-envelope.json#AcsResult.metadata.model_id response-envelope.json's "AcsResult.metadata.model_id" exists but is optional there, so a conformant envelope may omit it -- a wire consumer cannot rely on acs.model_id being emitted
  ✔ acs.provenance.origin on (every step span, when Provenance is attached) <- provenance.json#origin

Legend: ✔ emittable by a wire consumer alone   ✖ not emittable (reason inline)

=== Legs measured ===
N41 intervention-point round trip (resolver): RAN
N41 policy-input schema (AGT's own policy-input.schema.json, agt.lock's pinned ref): RAN -- validated pre_tool_call, post_tool_call
N42 verdict round trip: RAN
N43 enforced identity (pre_tool_call, post_tool_call, merged): RAN
N44 failure domains (live Guardian, wire-level): RAN
N49 trace pillar: RAN
```

Exit code `0`. `bun run conformance` prints `$ bash scripts/run-conformance.sh` as its own
first line — that is `bun` echoing the script it runs, not part of the runner's own output,
and it is genuine: kept rather than trimmed. The capture is 74 lines and ends, as shown, with
the `=== Legs measured ===` block.

## Reading the capture

**The `N41 policy-input schema` leg reads `RAN`, not `DID NOT RUN`.** That line is the one
leg that needs the real network fetch — it validates the policy input this Guardian actually
constructs at `pre_tool_call` and `post_tool_call` against AGT's own
`policy-input.schema.json`, fetched from the clone `scripts/run-conformance.sh` made. Had the
fetch failed or been skipped, this line would read `DID NOT RUN -- <reason>` instead, and the
capture above would be recording a self-skip rather than a real validation. It does not.

**Every leg in the last block ran.** All six lines read `RAN`: the two round trips (N41, N42),
the schema leg just above, the merged enforced-identity check (N43, driven at both
transform-capable points), the live-Guardian failure-domain check (N44), and the trace-pillar
check (N49). Only the schema leg's line is actually conditional — the `schemaLegLine` ternary
in `packages/conformance/src/main.ts` (around line 117) prints `DID NOT RUN -- <reason>` when
`UPSTREAM_AGT_CLONE` is unset. The other five (`main.ts:132, 134-137`) are unconditional
literal strings, not self-reporting checks: each prints because `main()` reached that line
without throwing, and a check that failed to run at all would have thrown before reaching it —
leaving no captured output whatsoever, not a false `RAN`.

**The coverage matrix's own header line states its subject.** The line printed directly under
`=== U30 coverage matrix ===` reads: *"Each cell measures ACS v0.1.0's expressive power
against AGT's vocabulary at that point x verdict — it is NOT a claim about which methods this
Guardian evaluates."* That sentence is this table's own scope statement, not a gloss added
here — `packages/conformance/test/render-coverage-matrix.test.ts` asserts the rendered table
matches `/expressive power/i`.

**Three symbols, not two.** `✔` (expressed), `◐` (`guardian_only`), `✖` (`unexpressed`) — no
cell is blank and no cell defaults to `✔`; `status` is required on every one of the 40
coordinates the matrix covers, which is what makes "no check measured this cell" impossible to
mistake for a pass.

**`✖[7]` covers ten of the forty cells** — every verdict at `pre_model_call` and
`post_model_call`, the two rows with no ACS v0.1.0 target at all (D4), so their own `warn`
cells read `✖[7]` (`unexpressed`) rather than `◐[3]`. That block is `unexpressed`, not
`guardian_only` — D4's model-call gap is a separate finding from the three below, not a third
instance of the same shape.

**Six rows of the Trace table read `✖`**, every one for the same stated reason: the wire
field exists and is optional. One is `acs.capability`, sourced from
`hooks/tool-call-request.json#capability`; the other five are sourced from
`response-envelope.json`'s `AcsResult` — four from `AcsResult.metadata` (`evaluator`,
`confidence`, `evaluator_version`, `model_id`) and one from `AcsResult.reasoning` directly.
`AcsResult.metadata` declares a fifth member, `evaluation_duration_ms`, that carries no
Trace-pillar row at all — `trace/otel-mapping.json` does not name it as a required or
conditional attribute, so it does not appear in this table either way. `AcsResult.required`
is `["type", "acs_version", "request_id", "decision"]`; `metadata` has no `required` list of
its own, so none of the six is required.

**`◐[3]` (`warn`, six rows) and `◐[8]` (`transform` at the two tool-call points) are two of
the declaration's three `guardian_only` findings.** The third is the six `✖` Trace rows just
above — and that third finding is not a coverage-matrix cell at all: the U33 block's own
legend (`Legend: ✔ emittable by a wire consumer alone   ✖ not emittable`) has no
`guardian_only` symbol, because a trace row pairs an attribute with a wire source, not an
intervention point with a verdict. So the declaration's three findings sharing one shape are
carried across **two tables, not one** — the U30 coverage matrix carries two of them, the
U33 trace table carries the third.

## What this file is, and is not

This file is the **evidence**: one real, reproducible run, pasted verbatim. It is not the
**declaration** — `slices/v7/README.md` states which ACS profiles and pillars this
implementation claims and which it does not, and points at the tables above (and at
`test/handshake-declares-what-it-evaluates.test.ts`, which this runner does not drive) for
each line of it. Commitment 2 above and R5.3 both turn on those staying two separate
artifacts; nothing in this file stands in for that declaration, and nothing in it should be
read as one.

## Verify

```bash
bun test          # includes packages/conformance/test/main.test.ts, in-process, with the
                  # network-only schema leg left to self-skip there rather than fetching
                  # on every test run
bun run typecheck
bun run verify:pin        # re-clones AGT and byte-diffs the pinned bundle — needs network
```

**`bun run verify:zero-diff` is deliberately not in the list above — it does not pass from
this HEAD, and that is not a V7 defect.** Captured real, run bare, exactly as a reader would
run it:

```bash
$ bun run verify:zero-diff
```

```
$ bash scripts/verify-zero-diff.sh
verify-zero-diff: R3.4 violated -- these are frozen for this slice:
packages/agt-bridge/src/index.ts
packages/guardian/src/assemble-snapshot.ts
packages/guardian/src/handshake.ts
packages/guardian/src/ifc-labels.ts
packages/guardian/src/index.ts
packages/guardian/src/main.ts
packages/guardian/src/map-verdict.ts
packages/guardian/src/server.ts
packages/guardian/src/session-context-store.ts
packages/guardian/src/session-context.ts
packages/guardian/src/validate-envelope.ts
packages/guardian/src/validate-response.ts
policy/lib/data.json
```

Exit code `1`. The measured reason: `scripts/verify-zero-diff.sh:15` reads
`base="${1:-slice/v4}"`, so a bare invocation always diffs HEAD against `slice/v4` — the base
V5's own R3.4 proof was written against ("the second host costs zero added AGT code"). V6
legitimately changed ten of the thirteen files listed above under those same frozen paths
(`git diff --stat slice/v4 slice/v6 -- packages/guardian/src/
packages/agt-bridge/src/index.ts policy/lib/data.json`), and V7 added the other three:
`validate-response.ts` (Task 2), the `evaluateWithEvidence` bridge change to
`agt-bridge/src/index.ts` (Task 1) — both in-scope V7 work this plan's own "Cross-slice work"
table names as intentional — and `map-verdict.ts`, which changed for neither: a doc-comment
fix landing commitment 2, correcting a comment that used to call `mapping.yaml`'s
`intervention_points` table "the same table V7's conformance matrix publishes" to instead
name it as V7's **mapping table**, not its coverage matrix — the same collapse this
declaration exists to prevent, one comment over. R3.4 is
**V5's** claim, and it is only measurable with HEAD at `slice/v5` — `docs/demos/v5-runbook.md:661-692`
has the real, passing capture from there. Run bare from any later HEAD, the script asks a
different question — "has nothing under these paths changed since `v4`" — and correctly
answers no. Not a V7 defect, and not fixed here.

## What was not verified

- **R3.4 does not hold, and was never claimed to hold, at this HEAD.** The capture above is
  `verify:zero-diff`'s real, current failure, not a pass — see "Verify" for the measured
  reason. Nothing in this runbook demonstrates R3.4 at V7's own HEAD, because R3.4 was never
  V7's claim to hold; it is V5's, and V5's own runbook is where it is captured passing.
- **This runbook does not verify which methods this Guardian evaluates.** The U30 coverage
  matrix measures ACS v0.1.0's expressive power against AGT's vocabulary — its own header
  line says so on its own face — and is not a claim about Guardian dispatch. What this
  Guardian actually dispatches (`steps/toolCallRequest`, `steps/toolCallResult`, and none of
  the other four mapped methods) is pinned by
  `test/handshake-declares-what-it-evaluates.test.ts`, which `bun run conformance` does not
  drive and this file does not capture.
- **No host and no model appears anywhere in this file** (stated in full at the top) —
  nothing here shows how a host renders any cell of the matrix, or how a model sees a
  decision built from one.
- **This capture carries no timestamps or ids to reproduce or fail to reproduce.** Unlike a
  `curl`-driven runbook, `bun run conformance` takes no input that varies per run — the two
  fixture snapshots (`PRE_TOOL_CALL_SNAPSHOT`, `POST_TOOL_CALL_SNAPSHOT`) are literals in
  `packages/conformance/src/main.ts`, so a re-run against an unchanged tree and an unchanged
  upstream AGT ref should reproduce this file's block byte for byte.
