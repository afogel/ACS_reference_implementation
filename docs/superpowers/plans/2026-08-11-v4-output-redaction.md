# V4: Output redaction on Claude Code

## Slice Contract

| Field | Value |
|---|---|
| **Slice ID** | **#5** (`gh issue view 5`) — not the PR (#13), not a bare "V4" |
| **Slices doc** | [`docs/shaping/acs-reference-impl-slices.md`](../../shaping/acs-reference-impl-slices.md) §V4, **line 165** |
| **Demo** (verbatim) | "AGT's own Claude Code package documents that it cannot ***reliably*** redact tool output, and does not *claim* parity. Here is a tool result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput` **in the tool's own output shape** — which is the condition that makes it reliable, and therefore the condition AGT's wording was scoping around." ⚠️ **This row was labelled "verbatim" while dropping "reliably" — see C1 below.** |
| **Components** | `U3` — P1, claude-code, *rewritten tool output in transcript*, render. Plus the slice's own sentence: "New entries in **S1** for `PostToolUse` → `steps/toolCallResult`, and in **S8** for the `redact` rules." |
| **Parked items** | §V4 defers nothing to a later slice. |
| **Watch-for notes** | §V4 carries none. Its nearest equivalent is the **Framing discipline** paragraph, quoted verbatim under Global Constraint 1. |
| **Corrections** | §V4 carries no ⚠️ markers. **This plan adds eight** (below). C1–C7 landed in the slices doc with this plan's own commit `56d49da`; C8 arrives with the revision below and lands in Task 10 Step 3, alongside the rows the redistribution invalidated. |
| **Requirements** | `R3.8` (the slice's own: a capability frozen out of one AGT host module is reachable through the contract), `R4.3` (framing is integration-surface reduction, never deficiency), `R4.4` (AGT's modules described accurately). Carried in from the track: `R1.6` (a `modify` is satisfied by the rewrite *landing*), `R1.2`, `R3.2`, `R3.4`, `R5.1`. |
| **Blocker** | **F1** — "Confirm by hand that Claude Code `PostToolUse.updatedToolOutput` rewrites tool results as documented." **✅ Resolved during planning** — see Evidence 1–3. Risk row 1 retires with it. |
| **Slices doc says Parts** | `C3` (Slice Summary, line 20). |

---

## Revision — the review redistribution landed under this plan

This plan was written against the stack as it stood before PR #10, #11 and #12's 48 review
findings were redistributed onto `slice/v1`…`slice/v3`. That work landed **beneath** V4 and moved
four things this plan assumed were V4's to do. Recorded here rather than left for an implementer to
discover mid-task, because in three of the four cases the plan now names a symbol or a rule shape
that **never shipped** — the same ghost-name defect PR #11's review filed against `N26`.

Measured at `slice/v4`'s tip (`56d49da`): **396 pass, 1 skip, 0 fail, 397 tests across 29 files**;
`bun run typecheck` clean. Every "347" in this plan predates the redistribution.

| # | What the plan assumed | What is actually true now |
|---|---|---|
| R1 | **Task 4 is V4's biggest task**: `renderDecision` hardcodes `permissionDecision`/`permissionDecisionReason`/`updatedInput` and requires a permission field | **Already done, in a better shape.** PR #10's review (Critical) landed it: `renderDecision(decision, hookmap)` reads `decisions.<d>.output`, a map of **dotted host paths** to `{value}` or `{from, type}`, and names no host field. `test/invariants.test.ts:123` already gates that. Task 4 shrinks to what is genuinely left — see R2 |
| R2 | The rule shape is `set:` / `from:` / `top_level: {set, from}` | **That shape never existed.** The shipped shape is one `output:` map, and a path with **no dot** already lands top-level — `render-decision.ts`'s own doc says so. `top_level` is deleted from this plan: adding it would be a second way to express what dotted paths already express |
| R3 | Task 5 edits `validate-decision.ts` lines 128–142 | The array rejection moved to **`packages/host-adapter/src/modifications.ts:114–127`** (`applyModifications`), extracted from `validateDecision` by PR #12's `governStep` wave. Same rejection, same reason, different file |
| R4 | Task 10 writes a new fourth gate, and amends the slices doc | The gate **exists and passes**, missing exactly one term (`updatedToolOutput`). The slices-doc amendments **already landed** in `56d49da`. Task 10 becomes: add the term, mutation-test it, and run the whole-slice verification |

### What Task 4 still has to do, and why it is still a task

Three gates written when `PreToolUse` was the only hook. Each assumes every decision has a
permission field, and `PostToolUse` has none:

1. `hookmap.decisions` is a **single top-level block** shared by all hooks. `renderDecision` takes
   no hook name. Two hooks needing different renderings cannot both be expressed.
2. `assertRenderableDecisions` (`build-envelope.ts:106`, load time) iterates that one block and
   requires `allow` and `deny` in it. Per-hook, that minimum applies **per hook** — a
   posture-produced allow or deny can arrive at either gate.
3. `assertHostAcceptsEveryDecision` (`acs-hook.ts:257`) requires **every** decision to declare a
   literal `hookSpecificOutput.permissionDecision` that Claude Code accepts. `PostToolUse` cannot
   satisfy this, and the check is not decoration — it is what stops a hookmap from silently turning
   decisions into ungoverned tool calls. It must become per-hook, not be relaxed.

### C8 — a new correction: what a `PostToolUse` **allow** renders

Nothing in this plan or §V4 asked this, and it collides with a fail-open guard.

At `PreToolUse`, an output with no decision in it means the tool call **proceeds ungoverned**, so
`renderDecision` refuses to render an empty rule and `asClaudeCodeOutput` refuses an output with no
wrapper. Both refusals are correct there. At `PostToolUse` the tool has **already run**: "nothing"
is the honest answer for a clean result, and Task 7's own second test asserts exactly that — no
`updatedToolOutput` key at all. So both refusals are **gate-specific**, and V4 must make that
explicit rather than weaken either guard globally.

The resolution needs no new hookmap vocabulary, because `renderDecision`'s static check is on the
**rule** while its skip is on the **value**: a rule declaring one `from` field the decision does not
carry passes the check and renders `{}`. So `PostToolUse.decisions.allow` declares one real field —
`hookSpecificOutput.additionalContext`, present in 2.1.227's `PostToolUse` schema (Evidence 1) —
sourced `from: reasoning, type: string`. Then:

- a **plain** allow carries no `reasoning`, renders `{}`, and delivers the output unchanged;
- an **observe-only** allow (AGT `warn` → ACS allow with `policy_references`, R1.2) carries a
  synthesized `reasoning` and it reaches the transcript.

That is the same gap V3 closed for `PreToolUse`'s `allow`, closed the same way at the second gate —
naming symmetry across symmetric roles rather than a special case. What remains is the shim's
wrapper refusal, which must become per-hook alongside gate 3 above: a `PostToolUse` output with an
empty wrapper is the correct clean-result answer, and a `PreToolUse` one is still the fail-open it
always was.

### One stale doc comment to fix in passing

`build-envelope.ts:68–70` still describes renderable as *"a non-null object naming a non-empty
string `permissionDecision`, the one field renderDecision writes into Claude Code's output
unconditionally"* — the pre-redistribution rule. Lines 95–100 of the same comment give the correct
declarative one. Task 4 edits this function; it corrects the contradiction while it is there.

---

## Evidence

Every row below was produced by **running** the thing, in the discipline V1 and V3 planning set — never by reading a doc and believing it. Claude Code is **2.1.227**; AGT is pinned at `81955d48025c6b11deb3fc9dabf89f74f4145775` (`agt.lock`), SDK `0.3.1-beta.0`.

Probe scripts and captures are reproducible from the commands in each row; nothing here is quoted from memory.

### 1. `updatedToolOutput` exists and rewrites tool results — **F1 answered: yes**

Claude Code 2.1.227's `PostToolUse` `hookSpecificOutput` schema, read out of the shipped binary:

```js
Te({hookEventName:At("PostToolUse"),
    additionalContext:N().optional(),
    updatedToolOutput:oo().optional().describe("Replaces the tool output before it is sent to the model"),
    updatedMCPToolOutput:oo().optional().describe("Replaces the output for MCP tools only. Prefer updatedToolOutput, which works for all tools")})
```

Confirmed end to end: a `PostToolUse` hook on `Bash` returning a shape-preserving `updatedToolOutput` caused the model to report the tool output as `[REDACTED]` where the command had actually echoed `ghp_SECRET123456`.

### 2. **The replacement must match the tool's own output schema, or the ORIGINAL is delivered**

This is the single most important fact in the slice, and it is a fail-open.

A hook returning `updatedToolOutput: "[REDACTED-BY-HOOK]"` — a plain string, the natural reading of "redact the output", and exactly the shape ACS §6.3's `modified_content` provides — was **silently discarded**. The model received the real secret. Claude Code recorded this attachment and continued:

```
PostToolUse hook returned updatedToolOutput that does not match Bash's output shape;
using original output. [
  { "expected": "object", "code": "invalid_type", "path": [],
    "message": "Invalid input: expected object, received string" }
]
```

The binary's own branch confirms the fallback is deliberate — on a schema mismatch it restores the original data and pushes an error attachment. **A redaction that does not match the shape is not a redaction; it is an unredacted delivery plus a log line.**

`Bash`'s output shape, captured from a real `PostToolUse` payload:

```json
"tool_response": { "stdout": "ghp_SECRET123456", "stderr": "",
                   "interrupted": false, "isImage": false, "noOutputExpected": false }
```

### 3. **A `deny` at the result gate cannot suppress output** — `block` is not suppression

Rendering an ACS `deny` at `PostToolUse` as Claude Code's documented `{"decision":"block","reason":…}` was tested directly. The model's own report of what it received:

> "So: both. I received the real stdout, and separately a post-execution hook declared the result policy-denied."

The tool has already executed and its result has already been formed; `block` injects a reason, it does not withhold anything. Rendering deny as `block` alone would **report a suppression that did not happen** — the identical "reported but never took effect" shape V3 found when V1 copied a raw `modifications` object into `updatedInput` (§V3's structure correction).

The honest rendering is `block` **and** a replacing `updatedToolOutput`, tested together:

> "The tool result came back as `[OUTPUT WITHHELD BY POLICY]` — the actual stdout was redacted before reaching me. A `PostToolUse:Bash` hook then fired a blocking error: … policy denied this tool result"

So on this host, at this gate, **`updatedToolOutput` is the only mechanism that withholds anything**, and every ACS disposition that means "the model must not see this" has to go through it.

### 4. AGT's stock `redact` policy fires at `post_tool_call`, from configuration alone

Run against the pinned bundle with `data.agt.defaults.config.redact` set and **zero Rego authored**:

```json
{ "decision": "transform", "reason": "redaction_applied",
  "transform": { "path": "$policy_target",
                 "value": "GITHUB_TOKEN=[REDACTED] and [REDACTED]" } }
```

`transformedPolicyTarget` carries the same substituted string, so the bridge already surfaces the value without the Guardian re-deriving it. `policy/lib/redact.rego` is the deciding module; `cfg.redact.patterns` and `cfg.redact.replacement` are the configuration (S8). R2.1/R2.4 hold exactly as in V1 and V3.

### 5. `policy_target` reaches into the result, and a missing `tool_call.name` fails **closed**

| Snapshot at `post_tool_call` | Verdict |
|---|---|
| `tool_call:{name}` + `tool_result:{outputs:[{value}]}`, target `$.tool_result.outputs[0].value` | `transform` / `redaction_applied` ✅ |
| **no `tool_call` at all** | `deny` / `runtime_error:path_missing` — fails **closed** |
| output text matching the *deny* pattern instead | `deny` / `destructive_shell_command_blocked` |

Two consequences. JSONPath **array indexing works** in `policy_target`, so the ACS payload's `outputs[0].value` is addressable directly. And `tool_name_from: "$.tool_call.name"` is load-bearing at this point: the Guardian must synthesize `tool_call: { name }` into the post-tool snapshot, because ACS's result payload has no `tool_call` member of its own.

### 6. One config document drives both gates, and it is the **shipped** one

A single `data.json` carrying both `patterns` (V1's destructive-command deny) and `redact` served `pre_tool_call` and `post_tool_call` together. V3's five-config-documents problem does **not** recur here: V3 needed five because `approval.required` is a global switch that makes `allow`/`transform`/`warn` unreachable in the same document, and V4 turns no such switch on.

**An earlier draft of this row said V4 must not edit `policy/lib/data.json`, on the reasoning that `redact` also changes `pre_tool_call` for a token-shaped command. That was wrong twice over and is corrected here rather than left to be discovered.**

First, it is not avoidable the way that draft assumed. Config lives *inside* the bundle directory (V1's amendment: `data_paths` is discarded while `bundle:` is set), so "V4 ships its own config" would mean V4 ships its own **bundle directory** — a copy of the pinned `.rego` files, which is precisely the fork R2.2/R2.3 forbid and `verify:pin` exists to catch. V3's `manifest.drift.yaml` is not the precedent it looked like: a second *manifest* over the same `bundle: lib` is cheap, a second *config* is not.

Second, the behaviour change it worried about does not materialise. Adding `redact` to `policy/lib/data.json` and running the full suite: **347 pass, 1 skip, 0 fail** — unchanged. The three fixtures using token-shaped strings are unit tests and `test/dispositions.test.ts`, which builds its own config bundle. Nothing depends on the old `allow`.

And the change is the *right* behaviour, already demonstrated: V3's runbook produced its live `modify` capture by adding exactly this `redact` rule to exactly this file, then reverting. What V4 changes is that the rule stops being a temporary edit for a screenshot and becomes what the deployment ships — one config, one stock policy, redacting at both gates.

**Consequence to carry:** `docs/demos/v3-runbook.md` says the rule was *"reverted after"*. Once V4 ships it, that sentence is stale and must be amended in this PR (Task 9), or V3's runbook describes a file that no longer looks like that.

### 7. AGT's documented limitation, quoted from the pinned ref

`agent-governance-claude-code/README.md:39`, under the heading **"## Important parity gaps"**:

> `PostToolUse` in Claude cannot reliably redact tool output after the tool has already executed, so this package does not claim Copilot-style output suppression parity.

The same README lists what the package *does* enforce: `SessionStart`, `UserPromptSubmit`, `PreToolUse`. There is no `PostToolUse` enforcement in it.

**Read it precisely, because R4.4 turns on this.** AGT says "cannot **reliably**" and "does not **claim** parity" — a scoping statement about the package, not an assertion that the host cannot do it. Evidence 2 and 3 are exactly *why* that wording is right: the naive form is silently discarded, and the documented blocking form does not suppress. AGT's README was accurate when written and is accurate now. What V4 shows is that meeting the reliability condition is a **contract-level** job that gets done once, not a per-host module's job redone for every runtime.

---

## Corrections this plan makes to the slices doc

C1–C7 landed in §V4 with commit `56d49da`. C8, and the corrections the review redistribution
forced on C4 and on two Scope-added rows, land in Task 10 Step 3 — same PR.

| # | Correction |
|---|---|
| C1 | **F1 resolved, and risk row 1 retires.** §V4 says "Blocked on follow-up F1 … If it does not, this slice drops and R3.8 moves to another capability." It does, so the slice proceeds — with the two conditions in C2 and C3 attached. |
| C2 | **The demo sentence is incomplete as written.** "delivered through `updatedToolOutput`" is true but omits the condition that makes it work: the replacement must preserve the tool's own output shape, or Claude Code delivers the original. The demo gains that clause. |
| C3 | **A `deny` at this gate does not suppress output.** Nothing in §V4 anticipated a disposition other than the redaction. Rendering deny as `block` alone is a fail-open; it must carry a replacing `updatedToolOutput` too. New watch-for. |
| C4 | **"New entries in S1" understates the change.** *Rewritten by Revision R1 — the hardcoded-field-names half landed with PR #10's review.* What remains: S1's `decisions` is one block shared by all hooks, and three gates require every decision to declare a `permissionDecision` that `PostToolUse` does not have. The block becomes per-hook. Recorded under Scope added. |
| C8 | **A clean `PostToolUse` allow renders nothing, and two fail-open guards are gate-specific because of it.** New during this revision — see the Revision section. `renderDecision`'s empty-output refusal and the shim's missing-wrapper refusal are both correct at `PreToolUse`, where "no decision" means the call proceeds ungoverned, and both are wrong at a gate where the tool has already run. The `allow` entry declares one conditional field (`additionalContext` from `reasoning`), so an observe-only allow reaches the transcript (R1.2) and a plain one renders `{}`. |
| C9 | **The demo sentence dropped "reliably" in four places — the exact overclaim R4.4 exists to prevent, and Global Constraint 2 names the resulting string as forbidden.** Found by the final whole-slice review. "AGT's own package documents that Claude Code cannot redact tool output" asserts an inability AGT never claimed; what AGT wrote is "cannot **reliably**" and "does not **claim** parity" — a scoping statement about their package, and V4's own evidence is *why that wording is right*. Commit `56d49da` wrote the correct form in the Slice Summary and the incorrect one in §V4's demo **in the same commit**, and Tasks 9–10 propagated the incorrect one into three more documents; `v4-runbook.md` committed it at line 5 while forbidding it at line 31. Fixed at all four sites, each now also carrying "does not *claim* parity" and naming the shape condition as what AGT's wording was scoping around. **The lesson is the one this slice keeps relearning: a sentence labelled "verbatim" is not a quotation unless someone diffs it against the source.** |
| C5 | **ACS's result payload carries no tool arguments.** `tool-call-result.json` requires `tool`, `exit_status`, `outputs` only. A policy that wants both the call and its result cannot get the call from this wire — correlation runs through `request_id_ref`, which is V6's session chain. A V7 cell, not a V4 gap. |
| C6 | **`modifications.modified_content` has no applicable target on this host at either gate.** V3 recorded it for `updatedInput` (an arguments object). Evidence 2 shows the result gate refuses it for the same reason. That upgrades V3's note from "this adapter has no mapping" to "this host has no target", which is a stronger V7 statement. |
| C7 | **`validateDecision` rejects array descent**, so `/outputs/0/value` — the natural ACS redaction path for a result — is rejected today. Extended in Task 5. |

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| `U3` — rewritten tool output in transcript | Task 8 (runbook capture), Task 7 (live path) | The demo's visible payoff |
| "New entries in **S1** for `PostToolUse` → `steps/toolCallResult`" | Tasks 2, 3, 6 | Split: envelope side (2), render side (3), wiring (6) |
| "New entries in **S8** for the `redact` rules" | Task 1 | Ships as its own config, per Evidence 6 |
| **F1** blocker | Resolved in planning | Evidence 1–3; slices doc amended (C1) |
| Framing discipline (R4.3) | Global Constraint 1 | Quoted verbatim; binds every task that writes prose |
| `R3.8` — capability frozen out of one host module, reachable through the contract | Tasks 7, 8 | The claim the slice exists to make |
| `R4.4` — AGT described accurately | Global Constraint 2, Task 8 | The README quote is pinned, with its heading |
| `R1.6` — a modify is satisfied by the rewrite landing | Tasks 5, 6, 7 | Evidence 2 is why this is not automatic |
| `R3.2` — adapter carries no runtime vocabulary | Task 4 + new grep gate | Widened to host vocabulary too |
| Risk row 1 (`updatedToolOutput` misbehaves) | Retired | Replaced by two sharper rows |
| Parked items | none | §V4 defers nothing |

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 4 — `decisions` becomes per-hook | V5 (`N12` "same module as `N3`") | **Half of this row is now history** (Revision R1): the field-name generalization it argued for landed with PR #10's review, on this same reasoning. What is left is still cross-slice for the same reason — `decisions` is one block shared by all hooks, and three gates require every decision to carry a permission field. `PostToolUse` has none, so V4 is where a **second hook** forces the per-hook split a second **host** would have forced anyway. V5 inherits a renderer that is already right rather than discovering it is wrong. |
| Task 5 — array-index descent in `validateDecision` | arguably V6/V7 | Not deferrable: `/outputs/0/value` is *the* redaction path for a result payload, and today it is rejected. Without it V4 has no legal ACS shape to carry its own redaction. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| S1's `decisions` block becomes **per-hook** | `PostToolUse` has no `permissionDecision`, and three gates require every decision to declare one. The field names are **already** data in the shipped `output:` map (Revision R1/R2) — `set`/`from`/`top_level` never shipped and is not built. | C4 (rewritten), Scope-added row in §V4 |
| A **fourth invariant gate**: `packages/host-adapter/src` carries zero Claude Code field names | **Already exists and passes** with four of five terms (Revision R4). V4 widens it by `updatedToolOutput` and mutation-tests that term specifically. This project's precedent is that architectural claims become grep gates (R3.2/R3.3/R5.1/R5.2), not prose. | §V4 row corrected from "new gate" to "widened" |
| Array-index descent in `validateDecision` (`/outputs/0/value`), editing arrays in place | See Cross-slice table. | C7 |
| The Guardian's `assembleSnapshot` gains a `post_tool_call` branch synthesizing `tool_call: { name }` | Evidence 5: without it AGT fails closed on every result-gate call. | New row in §V4's table |
| `redact` ships in `policy/lib/data.json`, and `policy/manifest.yaml` gains a `post_tool_call` point | Evidence 6: a second *config* would mean a second *bundle*, i.e. a fork of the pinned `.rego` — the one thing R2.2/R2.3 forbid. Both edits are additive and the full suite is unchanged by them. | New Scope-added row in §V4; amends V3's runbook, which called this rule temporary |

---

## Global Constraints

These bind every task. Task reviewers get them verbatim.

1. **Framing discipline, quoted from §V4 (R4.3):** *"The claim is that per-host modules freeze capability at the moment they are written, while one contract picks up new host capability for every runtime at once. It is not that AGT got something wrong. Their README was accurate when written."* No task's code, comment, commit message, or doc may describe AGT as deficient, mistaken, or behind. The finding is about integration surface, never about quality.

2. **AGT is described exactly (R4.4).** The README sentence is quoted in full, with its `## Important parity gaps` heading and its file:line at the pinned ref. Never paraphrased into "AGT can't redact output" — the actual claim is "cannot **reliably**" and "does not **claim** parity", and Evidence 2 and 3 show that wording is correct. Dropping "reliably" would be the overclaim R4.4 exists to prevent.

3. **Zero Rego authored (R2.1/R2.3).** `policy/lib/*.rego` stays byte-identical. Redaction is driven by `data.agt.defaults.config.redact` and nothing else. `bun run verify:pin` passes at the end of the slice.

4. **`policy/lib/*.rego` is not edited; `policy/lib/data.json` and `policy/manifest.yaml` are, additively.** Evidence 6. `data.json` gains a `redact` block (data, not policy — R2.1 holds), and `manifest.yaml` gains a `post_tool_call` intervention point, which is purely additive: nothing evaluates it until a `steps/toolCallResult` envelope arrives, and `pre_tool_call` evaluation is byte-for-byte unaffected (verified — Evidence 5's run used a manifest carrying both points and `pre_tool_call` behaved identically). A second bundle directory is **forbidden**: it would fork the pinned `.rego` files.

5. **A redaction that does not land is a failure, not a partial success.** Evidence 2 is the slice's central hazard: Claude Code silently restores the original output on a shape mismatch. Any path that reports `modify` while the host keeps the original is a fail-open of the same family as the nine this project has already closed. Where the adapter cannot produce a shape-preserving replacement, it fails **closed** — never "applied" with nothing applied.

6. **A `deny` at the result gate withholds the output.** Evidence 3. `block` alone is a reason with no suppression. Deny renders as `block` **and** a replacing `updatedToolOutput`.

7. **The host adapter names no host field.** After Task 4, `packages/host-adapter/src` contains none of `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `updatedToolOutput`, `hookSpecificOutput` in code. Enforced by the new gate, not by review.

8. **The audit sink and the envelope tap stay total.** Unchanged from V2/V3: never throw, never delay a decision, never change one. §6.4's MUST — every step that proceeds without a decision is recorded — continues to govern; V3's Global Constraint 3 ruling stands.

9. **Two failure domains stay separate.** An AGT *evaluation* failure is a `deny` decision honoured regardless of posture; a *delivery* failure applies the negotiated `on_decision_failure`. V4 adds a second method to the wire and must not merge them.

10. **Exit codes are unchanged.** The shim has two: 0 with a decision on stdout, 2 for a blocking configuration error. There is no exit-1 tier, because Claude Code reads exit 1 as a non-blocking error and **proceeds**.

11. **Mutation-test every gate.** For each new invariant, reintroduce the fault, watch the specific test fail with the expected message, then restore byte-identically. A gate nobody has watched fail is not known to be a gate.

12. **No control characters in any file.** V2 and V3 plans both shipped raw NUL/ESC bytes that truncated extracted task briefs mid-literal. Escape sequences are written as their source form -- backslash-x-1b, backslash-x-00 -- never as raw bytes. This very constraint shipped two raw ones in its first draft, which is exactly how the previous two plans did it.

---

## Tasks

Ten tasks. Each ends in an independently testable deliverable and commits with `Slice: #5`.

### The wire shape, decided once here so every task agrees

Claude Code's `PostToolUse` payload, ACS's `toolCallResult` payload, and Claude Code's `updatedToolOutput` are three different shapes. The path between them is fixed as follows, and no task may invent a different one.

```
Claude Code PostToolUse payload           ACS steps/toolCallResult payload
  tool_name: "Bash"                  →      tool: { name: "Bash" }
  tool_response:                     →      exit_status: "success"   (literal — see below)
    stdout: "TOKEN=ghp_ABCDEF123456" →      outputs: [ { value: "TOKEN=ghp_ABCDEF123456" } ]
    stderr: ""
    interrupted: false                      ← the rest of tool_response is NOT on the wire
    isImage: false
    noOutputExpected: false
```

The Guardian redacts and answers with a §6.3 structured edit addressing the ACS payload:

```json
{ "decision": "modify",
  "reason_codes": ["redaction_applied"],
  "modifications": { "redactions": [
      { "path": "/outputs/0/value", "replacement": "TOKEN=[REDACTED]" } ] } }
```

The host adapter applies that **back through the same hookmap path it read from**, into a clone of the original `tool_response`, so what reaches `updatedToolOutput` preserves every sibling field:

```json
{ "stdout": "TOKEN=[REDACTED]", "stderr": "", "interrupted": false,
  "isImage": false, "noOutputExpected": false }
```

That symmetry is the whole answer to Evidence 2: the shape is preserved because the adapter never constructs a new output object, it patches the one the host gave it, at a path the hookmap named. **`exit_status` is a hookmap literal `success`.** Claude Code fires a separate `PostToolUseFailure` event for the failing case (present in 2.1.227's hook schema, not wired in this slice), so `PostToolUse` genuinely means success here — recorded as a known gap rather than derived from a field that does not carry it.

---

### Task 1: ship the `redact` rules and the `post_tool_call` point · slice #5 · S8

**Files:**
- Modify: `policy/lib/data.json` (add a `redact` block beside `patterns`)
- Modify: `policy/manifest.yaml` (add a `post_tool_call` intervention point)
- Create: `test/redaction.test.ts`

**Interfaces:**
- Consumes: `createBridge(manifestPath)` from `packages/agt-bridge/src/index.ts`, returning `{ evaluate(point, snapshot): Promise<BridgeResult> }` where `BridgeResult = { verdict, inputIdentity?, enforcedIdentity?, transformedPolicyTarget? }`.
- Produces: the shipped config and manifest every later task's live path depends on. `policy_target` for `post_tool_call` is exactly `"$.tool_result.outputs[0].value"`; `policy_target_kind` is `tool_result`.

- [ ] **Step 1: Write the failing test** — `test/redaction.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createBridge } from "agt-bridge";

const MANIFEST = fileURLToPath(new URL("../policy/manifest.yaml", import.meta.url));
const budgets = { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } };

describe("the shipped bundle redacts at the result gate", () => {
  it("returns a transform carrying the fully substituted output", async () => {
    const bridge = createBridge(MANIFEST);
    const result = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    });
    expect(result.verdict).toEqual({
      decision: "transform",
      reason: "redaction_applied",
      transform: { path: "$policy_target", value: "TOKEN=[REDACTED]" },
    });
  });

  // Evidence 5. AGT resolves `tool_name_from` before policy runs, so a
  // snapshot with no `tool_call` fails CLOSED rather than evaluating with a
  // missing name. Pinned because the Guardian synthesizes that member from
  // the ACS payload (Task 3) and nothing else would notice if it stopped.
  it("fails closed when the snapshot carries no tool_call", async () => {
    const bridge = createBridge(MANIFEST);
    const result = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    });
    expect(result.verdict.decision).toBe("deny");
    expect(result.verdict.reason).toBe("runtime_error:path_missing");
  });

  it("leaves output with nothing to redact as a clean allow", async () => {
    const bridge = createBridge(MANIFEST);
    const result = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "hello world" }] },
    });
    expect(result.verdict).toEqual({ decision: "allow" });
  });

  // The pre-tool gate must be untouched by adding a point below it in the
  // manifest. This is the assertion that would catch an additive manifest
  // edit turning out not to be additive.
  it("leaves the pre-tool deny exactly as it was", async () => {
    const bridge = createBridge(MANIFEST);
    const result = await bridge.evaluate("pre_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash", args: { command: "rm -rf / " } },
    });
    expect(result.verdict.decision).toBe("deny");
    expect(result.verdict.reason).toBe("destructive_shell_command_blocked");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/redaction.test.ts`. Expected: the first test fails with `{"decision":"allow"}` (no `redact` block in config yet); the second fails because `post_tool_call` is not a declared intervention point at all.

- [ ] **Step 3: Minimal implementation.** In `policy/lib/data.json`, beside `patterns`:

```json
"redact": {
  "patterns": ["ghp_[A-Za-z0-9]{6,}", "AKIA[0-9A-Z]{16}"],
  "replacement": "[REDACTED]"
}
```

In `policy/manifest.yaml`, after the `pre_tool_call` block, at the same indentation:

```yaml
  # V4 (slice #5). Additive: nothing evaluates this point until a
  # steps/toolCallResult envelope arrives, and pre_tool_call above is
  # unaffected -- pinned by this task's fourth test.
  #
  # The target indexes into the ACS payload's own `outputs` array, which
  # AGT's JSONPath supports directly (verified). `tool_name_from` is
  # load-bearing here and not decoration: without a `tool_call.name` in the
  # snapshot AGT fails closed with runtime_error:path_missing before any
  # rule runs, so assembleSnapshot (N23) synthesizes it from the payload's
  # `tool.name`.
  post_tool_call:
    policy_target: "$.tool_result.outputs[0].value"
    policy_target_kind: tool_result
    tool_name_from: "$.tool_call.name"
    policy:
      id: agt_stock
```

- [ ] **Step 4: Run it, expect PASS** — `bun test test/redaction.test.ts`, then `bun test`, then `bun run verify:pin` (every `.rego` still byte-identical; only `data.json` changed, which is data).

  **Re-measure, do not renumber.** Planning verified that shipping `redact` left the suite unchanged at **347 pass / 1 skip / 0 fail**; the redistribution has since taken the baseline to **396 pass / 1 skip / 0 fail (397 tests, 29 files)**. Those 49 added tests were written after that measurement, so "unchanged" has to be re-established, not assumed: run `bun test` before the `data.json` edit and after, and report both. Any test that changes verdict is a finding — report it rather than accepting it, because the whole claim of Evidence 6 is that this edit is behaviour-preserving at the pre-tool gate.

- [ ] **Step 5: Commit** — `Ship the redact rules and the post-tool gate` / body explaining that config is data (R2.1) and the manifest edit is additive / `Slice: #5`.

---

### Task 2: `buildEnvelope` learns the result payload · slice #5 · N2, S1

**Files:**
- Modify: `hosts/claude-code/claude-code.hookmap.yaml` (add a `PostToolUse` hook entry)
- Modify: `packages/host-adapter/src/build-envelope.ts` (payload construction, currently `steps/toolCallRequest`-only around lines 137–230)
- Test: `packages/host-adapter/test/build-envelope.test.ts`

**Interfaces:**
- Consumes: `buildEnvelope(event: string, payload: Record<string, unknown>, hookmap: Hookmap): AcsRequestEnvelope`, and the existing `$.`-path resolver in the same module.
- Produces: for `PostToolUse`, an envelope whose `params.payload` is `{ tool: { name }, exit_status: "success", outputs: [{ value }] }` — validated by the Guardian against `hooks/tool-call-result.json`, which requires exactly `tool`, `exit_status`, `outputs`.
- Produces: the hookmap keys later tasks read — `outputs.from` (the leaf that becomes `outputs[0].value`) and `outputs.within` (the object cloned and patched on the way back, Task 7).

- [ ] **Step 1: Write the failing test** — append to `packages/host-adapter/test/build-envelope.test.ts`:

```ts
describe("PostToolUse -> steps/toolCallResult", () => {
  const payload = {
    session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
    // The real shape, captured from Claude Code 2.1.227 (Evidence 2).
    tool_response: {
      stdout: "TOKEN=ghp_ABCDEF123456",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
  };

  it("builds the result payload the ACS schema requires", () => {
    const envelope = buildEnvelope("PostToolUse", payload, hookmap);
    expect(envelope.method).toBe("steps/toolCallResult");
    expect(envelope.params.payload).toEqual({
      tool: { name: "Bash" },
      exit_status: "success",
      outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }],
    });
  });

  // The request payload wraps arguments as {value, provenance?}; the result
  // payload wraps outputs the same way but is a different member entirely.
  // Asserted so a refactor cannot quietly reuse the request path here.
  it("carries no `arguments` member -- the result schema has none", () => {
    const envelope = buildEnvelope("PostToolUse", payload, hookmap);
    expect("arguments" in (envelope.params.payload as object)).toBe(false);
  });

  it("still builds the request payload unchanged for PreToolUse", () => {
    const envelope = buildEnvelope(
      "PreToolUse",
      { session_id: payload.session_id, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      hookmap,
    );
    expect(envelope.method).toBe("steps/toolCallRequest");
    expect(envelope.params.payload.arguments).toEqual({ command: { value: "ls" } });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/host-adapter/test/build-envelope.test.ts`. Expected: throws on the unknown hook `PostToolUse` (no hookmap entry).

- [ ] **Step 3: Minimal implementation.** Hookmap, under `hooks:`:

```yaml
  # V4 (slice #5). The result gate. `outputs.from` is the leaf that becomes
  # the ACS payload's outputs[0].value; `outputs.within` is the object a
  # `modify` decision is applied back into (renderDecision, Task 7), so the
  # replacement handed to the host preserves every sibling field. Claude
  # Code silently restores the ORIGINAL output when the replacement does
  # not match the tool's own output shape -- so `within` is not a
  # convenience, it is the difference between a redaction and an
  # unredacted delivery with a log line (Evidence 2).
  PostToolUse:
    acs_method: steps/toolCallResult
    tool_name: $.tool_name
    outputs:
      from: $.tool_response.stdout
      within: $.tool_response
    # Claude Code fires a SEPARATE PostToolUseFailure event for the failing
    # case (present in 2.1.227's hook schema, not wired in this slice), so
    # this event genuinely means success. A literal, not a field read: the
    # payload carries no exit code for this to be derived from, and deriving
    # one from `interrupted` would be inventing a value the host never sent.
    exit_status: { literal: success }
```

In `build-envelope.ts`, branch payload construction on the hookmap entry's shape rather than on the method string — an entry with `arguments` builds a request payload, one with `outputs` builds a result payload — and throw if an entry declares both or neither, naming the hook.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/host-adapter/test/build-envelope.test.ts && bun test`.

- [ ] **Step 5: Commit** — `Build the result envelope from a PostToolUse payload` / `Slice: #5`.

---

### Task 3: the Guardian accepts and assembles the result step · slice #5 · N21, N23

**Files:**
- Modify: `packages/guardian/src/validate-envelope.ts` (accept `steps/toolCallResult` and its payload schema)
- Modify: `packages/guardian/src/assemble-snapshot.ts` (currently `pre_tool_call`-only, 21–49)
- Test: `packages/guardian/test/assemble-snapshot.test.ts`, `packages/guardian/test/server.test.ts`

**Interfaces:**
- Consumes: `validate-envelope.ts`'s `AcsRequestEnvelope` plus its narrowing predicate `isToolCallRequest(envelope): envelope is ToolCallRequestEnvelope`. `mapping.yaml` **already** declares `post_tool_call: { acs_method: "steps/toolCallResult" }`, and `resolveInterventionPoint(acsMethod, mapping)` **already** resolves it and is **already** called from `server.ts` — that half of this task landed with PR #10's review. Do not add a second lookup and do not hardcode the point.
- Produces: a **sibling** predicate `isToolCallResult` and a **sibling** assembler, returning `{ envelope: { budgets: {…zeros} }, tool_call: { name }, tool_result: { outputs } }`.

**A ruling from PR #10's review that governs this task's shape.** `assemble-snapshot.ts` now takes the narrow `ToolCallRequestEnvelope`, reachable only through `isToolCallRequest`, and its own doc states the consequence: *"A later slice's `post_tool_call` snapshot is a sibling type beside this one, not a widening of it."* So `AgtPreToolCallSnapshot` is **not** widened with optional members, and `assembleSnapshot`'s signature is **not** loosened back to accepting any request envelope — that would undo the review finding this branch's parent just landed. The result path gets `ToolCallResultEnvelope`, `isToolCallResult`, `AgtPostToolCallSnapshot` and its own assembler; the dispatch between them lives at the one caller that already knows the method, beside the `resolveInterventionPoint` call.

Two shapes, two predicates, two assemblers, and a caller that chooses — because the two snapshots share no member but `envelope.budgets`, and a single function reading `payload.arguments` OR `payload.outputs` would be back to the union type the narrowing exists to prevent.

- [ ] **Step 1: Write the failing test:**

```ts
it("assembles the post-tool snapshot, synthesizing tool_call.name", () => {
  const snapshot = assembleSnapshot({
    jsonrpc: "2.0", method: "steps/toolCallResult", id: "r1",
    params: {
      acs_version: "0.1.0", request_id: "6ba59b01-1493-4f4c-af22-8a36eeca4651",
      timestamp: "2026-08-11T00:00:00Z", metadata: { session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5" },
      payload: { tool: { name: "Bash" }, exit_status: "success",
                 outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    },
  } as never);

  // tool_call.name is synthesized from payload.tool.name. ACS's result
  // payload has no tool_call member of its own, and AGT resolves
  // tool_name_from BEFORE policy runs -- without this the whole gate fails
  // closed on every call (Evidence 5).
  expect(snapshot).toEqual({
    envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
    tool_call: { name: "Bash" },
    tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
  });
});

// C5. The wire cannot supply the arguments at this step, and pretending
// otherwise (by carrying the request's args forward) would be inventing
// state this slice does not have. Correlation via request_id_ref is V6's.
it("carries no tool_call.args -- the result payload has none to carry", () => {
  const snapshot = assembleSnapshot(resultEnvelope) as { tool_call: Record<string, unknown> };
  expect("args" in snapshot.tool_call).toBe(false);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/guardian/test/assemble-snapshot.test.ts`. Expected: the result envelope is rejected by `validateEnvelope` before assembly (its payload schema is `steps/toolCallRequest`-only), and the new assembler does not exist yet. Note the test above must call the **new** assembler by its own name, not `assembleSnapshot`; a result envelope no longer typechecks against `assembleSnapshot`'s parameter, which is why the `as never` casts in the sketch above must be replaced with a real `isToolCallResult` narrowing.

- [ ] **Step 3: Minimal implementation.** In `validate-envelope.ts`, add the result payload's schema check and the `isToolCallResult` predicate beside `isToolCallRequest`, symmetrically — `tool`, `exit_status`, `outputs` and nothing else, per `hooks/tool-call-result.json`. In `assemble-snapshot.ts`, add `AgtPostToolCallSnapshot` and its assembler as siblings. At the caller, choose between them on **the predicate that narrowed the envelope** — never on the resolved intervention point, and never on the method string (see the paragraph below, which governs). Keep `envelope.budgets` zeros in both — `budgets.rego` fails closed on a present-but-wrong-typed counter (V1's C-note), and that hazard is not specific to the request gate.

  **One predicate per assembler, and no method reaches the wrong one.** `server.ts` today has exactly one assembling branch, gated by `isToolCallRequest`; every other well-formed method falls past it to `METHOD_NOT_DISPATCHED_CODE`. V4 adds a **second** gated branch beside it and changes neither the gate on the first nor the fall-through. What must not appear is a branch that assembles from `envelope.method` alone or from the resolved point alone: `mapping.yaml` declares six methods with points and this Guardian assembles two, so a point-driven branch would hand a `steps/sessionStart` envelope to whichever assembler came first and return a verdict that looks perfectly well-formed while having evaluated the wrong policy against the wrong shape.

  Assert both directions, because a predicate that answers `true` too readily is invisible otherwise: a result envelope is not answered by the pre-tool branch, a request envelope is not answered by the result branch, and `steps/sessionStart` still gets method-not-dispatched rather than either. That last one is the assertion that fails if someone replaces the two predicates with a method switch.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/guardian`.

- [ ] **Step 5: Commit** — `Assemble the post-tool snapshot from a result envelope` / `Slice: #5`.

---

### Task 4: `decisions` becomes per-hook · slice #5 · N3, S1

**Read the Revision section first — R1, R2 and C8 rewrite this task.** The generalization this task was written to perform **already landed** with PR #10's review: `renderDecision` names no host field, the rule shape is a dotted-path `output:` map, and `test/invariants.test.ts:123` gates it. The `set`/`from`/`top_level` shape below **never shipped and must not be built** — a dotless path already renders top-level.

What is left is one structural change and the three gates that block it. **This task changes `PreToolUse`'s entries too** — every existing render must stay byte-identical, and that is what its first test asserts.

**Files:**
- Modify: `hosts/claude-code/claude-code.hookmap.yaml` (`decisions` moves under each hook; add `hooks.PostToolUse.decisions`)
- Modify: `packages/host-adapter/src/render-decision.ts` (select the block by hook name; the field-walking loop is unchanged)
- Modify: `packages/host-adapter/src/build-envelope.ts` (`assertRenderableDecisions` becomes per-hook, and the stale doc comment at 68–70 is corrected — see the Revision section)
- Modify: `hosts/claude-code/acs-hook.ts` (`assertHostAcceptsEveryDecision` and `asClaudeCodeOutput` both become per-hook)
- Modify: `docs/shaping/acs-reference-impl-shaping.md` (**`N3`'s affordance row, line 253**, pins the signature `renderDecision(decision, hookmap)`; this task adds a parameter to it)
- Test: `packages/host-adapter/test/render-decision.test.ts`, `packages/host-adapter/test/build-envelope.test.ts`, `hosts/claude-code/test/hook.test.ts`

**The affordance table moves with the signature, in this task's own commit.** `N3`'s row is how a reader gets from an affordance ID to the code, so a row naming a signature that no longer exists is the defect PR #11 filed against `N26` and PR #10's review filed against four more rows — all fixed on `slice/v1` this week. Do not leave it for Task 10: the table is the source of truth and it is edited **before** anything rendered from it. The mermaid at line 327 renders `renderDecision()` without a signature and needs no change; check that this is still true rather than assuming it.

**Interfaces:**
- Produces: `renderDecision(hookEventName: string, decision: AcsDecision, hookmap: Hookmap): HostOutput` — one added leading parameter. The return type does **not** change: it is still one flat `HostOutput` whose dotted paths already place fields inside or outside the wrapper. There is no `{ hookSpecificOutput, topLevel }` pair; the shim keeps wrapping exactly as it does now.
- Produces: the rule shape unchanged from what ships today, moved one level down:

```yaml
hooks:
  <hookName>:
    acs_method: steps/<...>
    decisions:
      <acs-decision>:
        output:
          <dotted.host.path>: { value: <literal> }
          <dotted.host.path>: { from: <decisionField>, type: <typeof> }
          <dotlessHostPath>:  { value: <literal> }      # top-level, alongside the wrapper
```

- Consumes: nothing new. `place()`, `RESERVED_SEGMENTS`, the collision checks and the `type` guard all stay as they are.

**The three gates, and what each becomes.** None of them is relaxed; each learns the hook.

1. `renderDecision` reads `hookmap.hooks[hookEventName].decisions`, and throws naming the hook when that block is absent — the fourth test below.
2. `assertRenderableDecisions` (load time) iterates **every** hook's block and applies the existing `allow`+`deny` minimum **per hook**. Both gates can receive a posture-produced allow or deny, so a hook missing either is a hookmap that cannot answer a delivery failure at that gate.
3. `assertHostAcceptsEveryDecision` (the shim) keeps checking a declared literal against Claude Code's own enum, but only for hooks that **have** a permission field. `PostToolUse` gets its own check in the same loop: its `deny` must declare both the top-level `decision: block` **and** a replacing output path, because `block` alone reports a suppression that did not happen (Evidence 3, Global Constraint 6). A hook in the hookmap that the shim has no expectation for is a **throw**, not a skip — an unchecked hook is an unchecked fail-open, which is the whole reason this gate exists.

**And `asClaudeCodeOutput`'s wrapper refusal becomes per-hook (C8).** A `PostToolUse` allow legitimately renders `{}`, and refusing an output with no wrapper would exit 2 on **every clean tool result**. The refusal stays exactly as it is for a hook whose decisions declare fields under the wrapper, and a hook whose clean answer is genuinely "nothing" writes `{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}` — which at this gate means "deliver the output unchanged", not "no decision".

- [ ] **Step 1: Write the failing test** — the first one is the safety net for the rewrite:

```ts
// The move's whole risk is a silent change to what PreToolUse renders.
// These are the exact outputs V1/V3 pinned, restated against the per-hook
// lookup: if moving the block changes any of them, this fails first.
// renderDecision returns one flat object -- a dotted path lands under the
// wrapper, a dotless one beside it -- and the shim adds `hookEventName`, so
// it is absent here.
it.each([
  ["allow",  { decision: "allow" },                       { permissionDecision: "allow" }],
  ["deny",   { decision: "deny", reasoning: "nope" },      { permissionDecision: "deny", permissionDecisionReason: "nope" }],
  ["ask",    { decision: "ask", reasoning: "confirm?" },   { permissionDecision: "ask", permissionDecisionReason: "confirm?" }],
  ["modify", { decision: "modify", reasoning: "rewritten", applied_input: { command: "echo [REDACTED]" } },
             { permissionDecision: "allow", permissionDecisionReason: "rewritten", updatedInput: { command: "echo [REDACTED]" } }],
])("renders PreToolUse %s exactly as before", (_name, result, expected) => {
  expect(renderDecision("PreToolUse", result as never, hookmap)).toEqual({ hookSpecificOutput: expected });
});

it("renders a PostToolUse modify as updatedToolOutput, with no permissionDecision", () => {
  const output = renderDecision(
    "PostToolUse",
    { decision: "modify", reasoning: "redacted", applied_output: { stdout: "TOKEN=[REDACTED]", stderr: "" } } as never,
    hookmap,
  );
  expect(output).toEqual({
    hookSpecificOutput: { updatedToolOutput: { stdout: "TOKEN=[REDACTED]", stderr: "" } },
  });
});

// Evidence 3: `block` alone does not suppress anything. Deny at this gate
// must ALSO replace the output, or it reports a suppression that did not
// happen -- the same "reported but never took effect" shape V3 found. The
// dotless `decision`/`reason` paths are what put those two beside the
// wrapper rather than inside it.
it("renders a PostToolUse deny as block AND a replacing output", () => {
  expect(
    renderDecision(
      "PostToolUse",
      { decision: "deny", reasoning: "secret in output", applied_output: { stdout: "[OUTPUT WITHHELD BY POLICY]" } } as never,
      hookmap,
    ),
  ).toEqual({
    decision: "block",
    reason: "secret in output",
    hookSpecificOutput: { updatedToolOutput: { stdout: "[OUTPUT WITHHELD BY POLICY]" } },
  });
});

// C8. The clean result: nothing to change, so nothing is rendered. The
// `allow` entry declares one conditional field, so the RULE is non-empty
// (which assertRenderableDecisions still requires) while the OUTPUT is
// empty -- and an empty output at this gate means "deliver it unchanged",
// which is the honest answer once the tool has already run.
it("renders a plain PostToolUse allow as nothing at all", () => {
  expect(renderDecision("PostToolUse", { decision: "allow" } as never, hookmap)).toEqual({});
});

// R1.2, and the symmetry with what V3 fixed for PreToolUse's allow: an
// observe-only allow (AGT `warn`) carries a synthesized reasoning, and it
// has to reach the transcript a human reads. `additionalContext` is the
// PostToolUse field for it (present in 2.1.227's schema, Evidence 1).
it("renders an observe-only PostToolUse allow as additionalContext", () => {
  expect(
    renderDecision("PostToolUse", { decision: "allow", reasoning: "token pattern seen, not blocked" } as never, hookmap),
  ).toEqual({ hookSpecificOutput: { additionalContext: "token pattern seen, not blocked" } });
});

it("throws naming the hook when that hook declares no decisions block", () => {
  expect(() =>
    renderDecision("PostToolUse", { decision: "allow" } as never, { host: "x", hooks: { PostToolUse: {} } } as never),
  ).toThrow(/PostToolUse/);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/host-adapter/test/render-decision.test.ts`. Expected: `renderDecision` takes two arguments, so the calls do not typecheck, and it reads the top-level `hookmap.decisions`.

- [ ] **Step 3: Minimal implementation.** `render-decision.ts` selects `hookmap.hooks[hookEventName]?.decisions` instead of `hookmap.decisions` and throws naming the hook when it is absent. **The field-walking loop, `place()`, the collision checks and the `type` guard are untouched** — this is a lookup change, not a rewrite, and any diff inside the loop is a behaviour change that Step 4's first test should catch. Move the existing `decisions` block under `hooks.PreToolUse` **verbatim**, then add `hooks.PostToolUse.decisions`. Update the three gates and the wrapper refusal per the Interfaces section above.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/host-adapter && bun test hosts/claude-code`, then `bun test`. `hosts/claude-code/test/wire-shape.test.ts` must be **byte-identical** afterwards: it pins every `PreToolUse` output as a literal, so an untouched pin is the evidence this task changed no existing rendering. If it needs editing, stop and report — that is a behaviour change, not a move.

- [ ] **Step 5: Commit** — `Give each hook its own decisions block` / body naming V5's `N12` and the three gates that assumed one hook / `Slice: #5`.

---

### Task 5: array-index descent in `validateDecision` · slice #5 · N7

**Files:**
- Modify: `packages/host-adapter/src/modifications.ts` (the array rejection at **114–127**, and `setAtPath`)
- Test: `packages/host-adapter/test/modifications.test.ts`

**Revision R3:** this task was planned against `validate-decision.ts` lines 128–142. PR #12's `governStep` wave extracted `applyModifications` and its path machinery into `modifications.ts`, so the rejection, its comment, and the tests are all one module over from where this plan says. Same rejection for the same reason — a naive `setAtPath` rewrites `[a, b]` as `{"0": a, "1": b}` — and `validate-decision.ts` now calls into it rather than owning it.

**Interfaces:**
- Consumes: existing `ModificationsInvalidError`, `pointerSegments`, `assertNoReservedSegments`, `segmentsOverlap` — all in `modifications.ts` now. Confirm the exact exported names before writing the test; do not assume this list is current.
- Produces: `/outputs/0/value` resolving and applying, arrays edited **in place** (copied, index replaced) rather than rewritten as objects.

- [ ] **Step 1: Write the failing test:**

```ts
it("applies a redaction addressing an array element", () => {
  const applied = applyModifications(
    { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    { redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }] },
  );
  expect(applied).toEqual({ outputs: [{ value: "TOKEN=[REDACTED]" }] });
  expect(Array.isArray((applied as { outputs: unknown }).outputs)).toBe(true);
});

// The reason array descent was rejected in V3: a naive setAtPath rewrites
// the array as {"0": …}. That is not the edit that was asked for, and it
// would reach the host as an object where it expects a list.
it("keeps an array an array, and leaves its siblings alone", () => {
  const applied = applyModifications(
    { outputs: [{ value: "a" }, { value: "b" }] },
    { redactions: [{ path: "/outputs/1/value", replacement: "[REDACTED]" }] },
  );
  expect(applied).toEqual({ outputs: [{ value: "a" }, { value: "[REDACTED]" }] });
});

it("rejects an index past the end rather than growing the array", () => {
  expect(() =>
    applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/7/value" }] }),
  ).toThrow(/addresses no field/);
});

it("rejects a non-numeric segment into an array", () => {
  expect(() =>
    applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/value" }] }),
  ).toThrow(/addresses no field/);
});

// "-" is RFC 6901's append token. Appending is not redacting.
it("rejects the JSON-pointer append token", () => {
  expect(() =>
    applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/-/value" }] }),
  ).toThrow(/addresses no field/);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/host-adapter/test/modifications.test.ts`. Expected: `descends through the array at "/outputs"`.

- [ ] **Step 3: Minimal implementation.** Replace the blanket array rejection with: a segment addressing an array must be all digits, with no leading zero unless it is exactly `"0"`, and must be `< length`. `setAtPath` copies the array with `slice()` and assigns the index. Every other guard stays — reserved segments, absent targets, disjointness.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/host-adapter`.

- [ ] **Step 5: Mutation-test, then commit.** Restore the blanket rejection, watch the first test fail naming the array; restore byte-identically. Commit `Let a redaction address an array element` / `Slice: #5`.

---

### Task 6: `mapVerdict` synthesizes the result-side modification · slice #5 · N24, S10

**Files:**
- Modify: `mapping.yaml` (`field_synthesis.modifications` becomes per-intervention-point)
- Modify: `packages/guardian/src/map-verdict.ts`
- Test: `packages/guardian/test/map-verdict.test.ts`

**Interfaces:**
- Consumes: `AgtVerdict.transform = { path: "$policy_target", value }`, and `transformedPolicyTarget`.
- Produces: for `post_tool_call`, `modifications.redactions = [{ path: "/outputs/0/value", replacement: <value> }]`; `pre_tool_call` keeps producing `parameter_overrides` unchanged.

- [ ] **Step 1: Write the failing test:**

```ts
it("maps a post-tool transform to a redaction on the output path", () => {
  const decision = mapVerdict(
    { decision: "transform", reason: "redaction_applied", transform: { path: "$policy_target", value: "TOKEN=[REDACTED]" } },
    mapping, "post_tool_call",
  );
  expect(decision.decision).toBe("modify");
  expect(decision.modifications).toEqual({
    redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }],
  });
});

it("still maps a pre-tool transform to parameter_overrides", () => {
  const decision = mapVerdict(
    { decision: "transform", reason: "redaction_applied", transform: { path: "$policy_target", value: "echo [REDACTED]" } },
    mapping, "pre_tool_call",
  );
  expect(decision.modifications).toEqual({ parameter_overrides: { command: "echo [REDACTED]" } });
});

// §6.3's oneOf: the two shapes never combine. A synthesis producing both
// would be rejected by the Guardian's own response validation.
it("never emits both shapes at once", () => {
  for (const point of ["pre_tool_call", "post_tool_call"]) {
    const mods = mapVerdict(transformVerdict, mapping, point).modifications as Record<string, unknown>;
    expect(["redactions", "parameter_overrides"].filter((k) => k in mods)).toHaveLength(1);
    expect("modified_content" in mods).toBe(false);
  }
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/guardian/test/map-verdict.test.ts`. Expected: `mapVerdict` takes two arguments and always synthesizes `parameter_overrides`.

- [ ] **Step 3: Minimal implementation.** In `mapping.yaml`, move `field_synthesis.modifications` under each intervention point:

```yaml
    post_tool_call:
      acs_method: "steps/toolCallResult"
      # AGT's redact rule returns the FULLY substituted text (verified), so
      # `replacement` carries the finished string, not a marker the host
      # would have to interpret. The path indexes the ACS result payload's
      # own outputs array -- the same leaf policy_target addressed.
      modifications:
        # `from` names the transform OBJECT, not its `value` -- an earlier draft
        # of this stanza said `verdict.transform.value`, which would have made
        # the "is absent" throw name a field one level too deep. `rule.from`
        # never resolves the value; it appears only in two error messages, and
        # the second of them (`${rule.from}.value is ${typeof ...}`) appends
        # `.value` itself -- which is the clearest reason the declaration must
        # not already carry it. The value is read from `transform.value` in
        # code, once `transform` is known to be present.
        from: verdict.transform
        when_path: "$policy_target"
        into: redactions
        redaction_path: "/outputs/0/value"
```

`mapVerdict` gains the point as a third parameter and reads the synthesis from that point's entry, with a runtime guard on `into` (the V3 precedent: a single-member union widened only by a checked value, never a cast).

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/guardian`.

- [ ] **Step 5: Commit** — `Synthesize a redaction for the result gate` / `Slice: #5`.

---

### Task 7: the shim wires the result gate end to end · slice #5 · N1, U3

**Files:**
- Modify: `hosts/claude-code/acs-hook.ts`
- Modify: `packages/host-adapter/src/render-decision.ts` (apply back through `outputs.within`)
- Test: `hosts/claude-code/test/post-tool-use.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `outputs.from` / `outputs.within`, Task 4's render shape, Task 5's array descent, Task 6's redactions.
- Produces: `applied_output` on the decision result — a **clone of the object at `outputs.within`** with the leaf at `outputs.from` replaced by the redacted value. Never a freshly constructed object.

- [ ] **Step 1: Write the failing test** — against a real Guardian, the V3 precedent for host tests:

```ts
it("redacts a secret out of tool output, preserving every sibling field", async () => {
  const guardian = await startGuardian({ manifestPath: MANIFEST, port: 0 });
  const out = await runHook({
    session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_input: { command: "cat .env" },
    tool_response: { stdout: "TOKEN=ghp_ABCDEF123456", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
  }, guardian.url);

  expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
  // Every sibling survives. This is the assertion that stands between a
  // redaction and Claude Code silently restoring the original (Evidence 2).
  expect(JSON.parse(out.stdout).hookSpecificOutput.updatedToolOutput).toEqual({
    stdout: "TOKEN=[REDACTED]", stderr: "", interrupted: false, isImage: false, noOutputExpected: false,
  });
});

it("leaves clean output alone, with no updatedToolOutput at all", async () => {
  // An allow must not emit an updatedToolOutput key: an unnecessary
  // replacement is a chance to get the shape wrong for no benefit.
  const out = await runHook({ ...base, tool_response: { ...resp, stdout: "hello world" } }, guardian.url);
  expect("updatedToolOutput" in JSON.parse(out.stdout).hookSpecificOutput).toBe(false);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test hosts/claude-code/test/post-tool-use.test.ts`. Expected: the shim rejects the unknown hook, exit 2.

- [ ] **Step 3: Minimal implementation.** The shim treats `PostToolUse` like any other hook — the hookmap already names its method and its render rule; the only new code is applying the modification back through `outputs.within` before rendering.

- [ ] **Step 4: Run it, expect PASS** — `bun test`.

- [ ] **Step 5: Commit** — `Redact tool output end to end` / `Slice: #5`.

---

### Task 8: fail closed when the shape cannot be preserved · slice #5 · N7, Global Constraint 5

**Files:**
- Modify: `packages/host-adapter/src/validate-decision.ts`
- Test: `hosts/claude-code/test/post-tool-use.test.ts`, `packages/host-adapter/test/validate-decision.test.ts`

**Interfaces:**
- Produces: a `modify` the adapter cannot apply shape-preservingly becomes a **deny that withholds the output**, never an "applied" that applied nothing.

- [ ] **Step 1: Write the failing test:**

```ts
// C6. `modified_content` is legal §6.3 and has no target on this host at
// EITHER gate: updatedInput is an arguments object, updatedToolOutput must
// match the tool's own output shape. Refused, not reported-as-applied.
it("refuses a modified_content result modification as a withholding deny", async () => {
  const out = await runHook(postToolPayload, guardianReturning({
    decision: "modify", modifications: { modified_content: "wholesale replacement" },
  }));
  const rendered = JSON.parse(out.stdout);
  expect(rendered.decision).toBe("block");
  expect(rendered.hookSpecificOutput.updatedToolOutput.stdout).not.toContain("ghp_");
});

// The hazard in its purest form: a redaction path that resolves in the ACS
// payload but names a leaf the hookmap cannot map back into the host's
// output object. Reporting `modify` here would hand Claude Code a shape it
// rejects, and Claude Code would deliver the ORIGINAL, secret and all.
it("refuses a redaction whose path has no host-side target", async () => {
  const out = await runHook(postToolPayload, guardianReturning({
    decision: "modify", modifications: { redactions: [{ path: "/exit_status" }] },
  }));
  expect(JSON.parse(out.stdout).decision).toBe("block");
});
```

- [ ] **Step 2: Run it, expect FAIL** — the modification is reported as applied while the original output is handed back.

- [ ] **Step 3: Minimal implementation.** Where a result-gate `modify` cannot be expressed in the host's output shape, throw the existing `ModificationsInvalidError`, which the shim already turns into a deny — and let the deny render through Task 4's rule, so it withholds.

- [ ] **Step 4: Run it, expect PASS** — `bun test`.

- [ ] **Step 5: Mutation-test, then commit.** Make the refusal a silent pass-through, watch the first test deliver `ghp_` to the model; restore. Commit `Refuse a result modification this host cannot apply` / `Slice: #5`.

---

### Task 9: the runbook, the slice README, and V3's stale sentence · slice #5 · U3

**Files:**
- Create: `docs/demos/v4-runbook.md`
- Modify: `slices/v4/README.md`
- Modify: `docs/demos/v3-runbook.md` (the `redact` rule is no longer "reverted after")
- Modify: `README.md` (the result gate, and any new env var)

**Interfaces:** consumes the live path from Task 7. **Every capture is real output**, pasted from an actual run — the V1/V2/V3 rule. No hand-derived JSON.

- [ ] **Step 1: Capture** — run the full demo and save the real transcript, the real envelope pair from `.acs/envelopes.jsonl`, and the real `updatedToolOutput`.
- [ ] **Step 2: Write the runbook** around those captures, including the F1 finding as its own section: the string form is silently discarded, with Claude Code's exact error text, and the shape-preserving form works.
- [ ] **Step 3: Amend V3's runbook** — the `redact` rule now ships in `policy/lib/data.json`; the "edited … reverted after" sentence is corrected in place with a pointer to §V4.
- [ ] **Step 4: Verify** every quoted path, file:line and command by running it.
- [ ] **Step 5: Commit** — `Say what the result gate does, and correct V3's temporary edit` / `Slice: #5`.

---

### Task 10: widen the fourth gate, and the whole-slice check · slice #5

**Revision R4 — this task is much smaller than planned.** The gate it was written to create already exists at `test/invariants.test.ts:123`, landed by PR #10's review, and already passes with four of its five terms: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `hookSpecificOutput`. The slices-doc amendments (C1–C7, the Scope-added rows, the retired and added risk rows, F1 struck through) **already landed in `56d49da`** — this plan's own commit. What remains is one term, its mutation test, and the whole-slice verification.

**Files:**
- Modify: `test/invariants.test.ts`
- Modify: `docs/shaping/acs-reference-impl-slices.md` (only the rows the Revision section corrects — see below)

**Interfaces:** consumes Task 4's per-hook move and Task 7's `updatedToolOutput` path. `updatedToolOutput` must appear in the hookmap and **nowhere** under `packages/host-adapter/src` — the gate is only worth adding once there is code that could have got it wrong.

- [ ] **Step 1: Add the missing term** to the existing `assertNoVocabulary("packages/host-adapter/src", [...])` call, and extend its doc comment to say that the result gate's field is covered too. The gate's terms are the five host output field names V4 touches; adding one to a passing gate is the cheap half, and Step 2 is what makes it real.

- [ ] **Step 2: Mutation-test the new term specifically.** Reintroduce `updatedToolOutput` into `render-decision.ts` (a comment does not count — the gate strips comments, deliberately, so a doc-comment mention is legal), watch the gate fail naming the file and the term, then restore byte-identically and confirm with `sha256sum`. A term added to a gate nobody watched fail is not known to be gated — and this one in particular, because the four existing terms would pass whether or not the fifth is in the array.

- [ ] **Step 3: Correct the slices-doc rows the redistribution invalidated** — not a fresh amendment pass; §V4's corrections are already in. Exactly the rows the Revision section names: the `renderDecision` correction (it no longer "hardcodes three Claude Code field names", and `set`/`from`/`top_level` never shipped), the Scope-added row for the per-hook `decisions` block, the fourth-gate row (widened, not new), the array-descent row (the rejection lives in `N7`'s extracted `modifications.ts`), the stale `347 pass` measurement, and a new watch-for for C8. A row naming a shape that never existed is the same defect PR #11 filed against `N26`, and this branch is where it gets fixed rather than inherited by V5.

- [ ] **Step 4: Full verification** — `bun test`, `bun run typecheck`, `bun run verify:pin` with network, and confirm `policy/lib/*.rego` is byte-untouched (`git diff --stat policy/lib` shows `data.json` only). Report the final counts against the 396/1/0 baseline this plan's Revision section records.

- [ ] **Step 5: Commit** — `Gate the adapter against the result gate's field too` / `Slice: #5`.

---

## Risks

| # | Risk | Handling |
|---|---|---|
| 1 | A redaction reported as applied that Claude Code silently discards, delivering the secret | Evidence 2 is the whole reason Global Constraint 5 exists. Task 7 asserts every sibling field survives; Task 8 fails closed where the shape cannot be preserved; both mutation-tested |
| 2 | Task 4's move silently changes what `PreToolUse` renders | Its first test restates V1/V3's exact outputs against the per-hook lookup before the move starts, and `wire-shape.test.ts` must come out byte-identical — an edited pin means behaviour changed |
| 3 | `redact` in the shipped config changes an existing demo | Measured during planning at **347 pass, 1 skip, 0 fail** — unchanged, but that was 49 tests ago. Task 1 Step 4 re-measures against the 396/1/0 baseline rather than trusting it; Task 1's fourth test pins the pre-tool deny specifically |
| 4 | Array descent re-opens the `__proto__`/prototype hazard V3 closed | Task 5 keeps every existing guard and adds index validation; the reserved-segment check is untouched |
| 5 | `exit_status` is a literal, so a failed tool would be reported `success` | Real, and recorded rather than papered over: Claude Code fires `PostToolUseFailure` separately and this slice does not wire it. Named in the hookmap comment, the slice README, and V7's matrix |

