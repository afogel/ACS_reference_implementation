# V4: Output redaction on Claude Code

## Slice Contract

| Field | Value |
|---|---|
| **Slice ID** | **#5** (`gh issue view 5`) — not the PR (#13), not a bare "V4" |
| **Slices doc** | [`docs/shaping/acs-reference-impl-slices.md`](../../shaping/acs-reference-impl-slices.md) §V4, **line 165** |
| **Demo** (verbatim) | "AGT's own Claude Code package documents that it cannot redact tool output. Here is a tool result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput`." |
| **Components** | `U3` — P1, claude-code, *rewritten tool output in transcript*, render. Plus the slice's own sentence: "New entries in **S1** for `PostToolUse` → `steps/toolCallResult`, and in **S8** for the `redact` rules." |
| **Parked items** | §V4 defers nothing to a later slice. |
| **Watch-for notes** | §V4 carries none. Its nearest equivalent is the **Framing discipline** paragraph, quoted verbatim under Global Constraint 1. |
| **Corrections** | §V4 carries no ⚠️ markers. **This plan adds seven** (below), each amended into the slices doc in this PR. |
| **Requirements** | `R3.8` (the slice's own: a capability frozen out of one AGT host module is reachable through the contract), `R4.3` (framing is integration-surface reduction, never deficiency), `R4.4` (AGT's modules described accurately). Carried in from the track: `R1.6` (a `modify` is satisfied by the rewrite *landing*), `R1.2`, `R3.2`, `R3.4`, `R5.1`. |
| **Blocker** | **F1** — "Confirm by hand that Claude Code `PostToolUse.updatedToolOutput` rewrites tool results as documented." **✅ Resolved during planning** — see Evidence 1–3. Risk row 1 retires with it. |
| **Slices doc says Parts** | `C3` (Slice Summary, line 20). |

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

All seven land in §V4 in this PR (Step 5).

| # | Correction |
|---|---|
| C1 | **F1 resolved, and risk row 1 retires.** §V4 says "Blocked on follow-up F1 … If it does not, this slice drops and R3.8 moves to another capability." It does, so the slice proceeds — with the two conditions in C2 and C3 attached. |
| C2 | **The demo sentence is incomplete as written.** "delivered through `updatedToolOutput`" is true but omits the condition that makes it work: the replacement must preserve the tool's own output shape, or Claude Code delivers the original. The demo gains that clause. |
| C3 | **A `deny` at this gate does not suppress output.** Nothing in §V4 anticipated a disposition other than the redaction. Rendering deny as `block` alone is a fail-open; it must carry a replacing `updatedToolOutput` too. New watch-for. |
| C4 | **"New entries in S1" understates the change.** `renderDecision` requires a `permissionDecision` and hardcodes three Claude Code field names, none of which exist on `PostToolUse`. S1's `decisions` block becomes per-hook and declares host field names as data. Recorded under Scope added. |
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
| Task 4 — `renderDecision` stops naming host fields | V5 (`N12` "same module as `N3`") | V5's whole claim is that a second host costs a shim and a hookmap. That is false today: `renderDecision` hardcodes `permissionDecision`/`permissionDecisionReason`/`updatedInput`, so OpenCode would have to patch the shared module. V4 is where a **second hook** forces the same generalization a second host would, and it cannot ship without it — `PostToolUse` has none of those three fields. Doing it here means V5 inherits a renderer that is already right, rather than discovering it is wrong. |
| Task 5 — array-index descent in `validateDecision` | arguably V6/V7 | Not deferrable: `/outputs/0/value` is *the* redaction path for a result payload, and today it is rejected. Without it V4 has no legal ACS shape to carry its own redaction. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| S1's `decisions` block becomes **per-hook**, declaring host output field names as data (`set` / `from` / `top_level`) | `PostToolUse` has no `permissionDecision`; the current render rule requires one. Chosen over a minimal three-more-named-fields extension so V5 inherits a renderer that needs no patching. | C4, new Scope-added row in §V4 |
| A **fourth invariant gate**: `packages/host-adapter/src` carries zero Claude Code field names | The generalization above is only real if something fails when it regresses. This project's precedent is that architectural claims become grep gates (R3.2/R3.3/R5.1/R5.2), not prose. | New Scope-added row in §V4 |
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

- [ ] **Step 4: Run it, expect PASS** — `bun test test/redaction.test.ts`, then `bun test` (all 347 prior tests must still pass — verified during planning that they do), then `bun run verify:pin` (every `.rego` still byte-identical; only `data.json` changed, which is data).

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
- Consumes: the envelope type from `validate-envelope.ts`; `mapping.yaml`'s `intervention_points`, which **already** declares `post_tool_call: { acs_method: "steps/toolCallResult" }` — the point is looked up there, never hardcoded.
- Produces: `assembleSnapshot(envelope)` returning, for a result envelope, `{ envelope: { budgets: {…zeros} }, tool_call: { name }, tool_result: { outputs } }`.

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

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/guardian/test/assemble-snapshot.test.ts`. Expected: the result envelope is rejected by `validateEnvelope` before assembly, or assembly reads `payload.arguments` and throws.

- [ ] **Step 3: Minimal implementation.** Dispatch on `envelope.method` through `mapping.yaml`'s `intervention_points` table (the ACS method → AGT point direction), and add the result branch. Keep `envelope.budgets` zeros in both branches — `budgets.rego` fails closed on a present-but-wrong-typed counter (V1's C-note), and that hazard is not specific to the request gate.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/guardian`.

- [ ] **Step 5: Commit** — `Assemble the post-tool snapshot from a result envelope` / `Slice: #5`.

---

### Task 4: `renderDecision` stops naming host fields · slice #5 · N3, S1

The generalization chosen at planning. **This task changes `PreToolUse`'s hookmap entries too** — every existing render must keep rendering byte-identically, and that is what its first test asserts.

**Files:**
- Modify: `packages/host-adapter/src/render-decision.ts` (whole rule shape, 40–101)
- Modify: `hosts/claude-code/claude-code.hookmap.yaml` (`decisions` moves under each hook)
- Modify: `hosts/claude-code/acs-hook.ts` (the hookmap validation added by V3's fix wave reads the old rule shape)
- Test: `packages/host-adapter/test/render-decision.test.ts`

**Interfaces:**
- Produces: `renderDecision(hookEventName, decisionResult, hookmap)` returning `{ hookSpecificOutput?, topLevel? }` — the shim merges `topLevel` into the JSON it writes to stdout. The render rule shape is:

```yaml
decisions:
  <acs-decision>:
    set:  { <hostField>: <literal> }        # into hookSpecificOutput
    from: { <hostField>: <decisionField> }  # into hookSpecificOutput, copied if present
    top_level:
      set:  { <hostField>: <literal> }      # outside hookSpecificOutput
      from: { <hostField>: <decisionField> }
```

- [ ] **Step 1: Write the failing test** — the first one is the safety net for the rewrite:

```ts
// The rewrite's whole risk is a silent change to what PreToolUse renders.
// These are the exact outputs V1/V3 pinned, restated against the new rule
// shape: if the generalization changes any of them, this fails first.
it.each([
  ["allow",  { decision: "allow" },                       { permissionDecision: "allow" }],
  ["deny",   { decision: "deny", reasoning: "nope" },      { permissionDecision: "deny", permissionDecisionReason: "nope" }],
  ["ask",    { decision: "ask", reasoning: "confirm?" },   { permissionDecision: "ask", permissionDecisionReason: "confirm?" }],
  ["modify", { decision: "modify", reasoning: "rewritten", applied_input: { command: "echo [REDACTED]" } },
             { permissionDecision: "allow", permissionDecisionReason: "rewritten", updatedInput: { command: "echo [REDACTED]" } }],
])("renders PreToolUse %s exactly as before", (_name, result, expected) => {
  const { hookSpecificOutput, topLevel } = renderDecision("PreToolUse", result as never, hookmap);
  expect(hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", ...expected });
  expect(topLevel).toBeUndefined();
});

it("renders a PostToolUse modify as updatedToolOutput, with no permissionDecision", () => {
  const { hookSpecificOutput, topLevel } = renderDecision(
    "PostToolUse",
    { decision: "modify", reasoning: "redacted", applied_output: { stdout: "TOKEN=[REDACTED]", stderr: "" } } as never,
    hookmap,
  );
  expect(hookSpecificOutput).toEqual({
    hookEventName: "PostToolUse",
    updatedToolOutput: { stdout: "TOKEN=[REDACTED]", stderr: "" },
  });
  expect("permissionDecision" in hookSpecificOutput!).toBe(false);
  expect(topLevel).toBeUndefined();
});

// Evidence 3: `block` alone does not suppress anything. Deny at this gate
// must ALSO replace the output, or it reports a suppression that did not
// happen -- the same "reported but never took effect" shape V3 found.
it("renders a PostToolUse deny as block AND a replacing output", () => {
  const { hookSpecificOutput, topLevel } = renderDecision(
    "PostToolUse",
    { decision: "deny", reasoning: "secret in output", applied_output: { stdout: "[OUTPUT WITHHELD BY POLICY]" } } as never,
    hookmap,
  );
  expect(topLevel).toEqual({ decision: "block", reason: "secret in output" });
  expect(hookSpecificOutput).toEqual({
    hookEventName: "PostToolUse",
    updatedToolOutput: { stdout: "[OUTPUT WITHHELD BY POLICY]" },
  });
});

it("throws when a hook declares no decisions block", () => {
  expect(() => renderDecision("PostToolUse", { decision: "allow" }, { host: "x", hooks: { PostToolUse: {} } } as never))
    .toThrow(/no decisions block for hook "PostToolUse"/);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/host-adapter/test/render-decision.test.ts`. Expected: `renderDecision` returns `{hookSpecificOutput}` only and reads a top-level `hookmap.decisions`.

- [ ] **Step 3: Minimal implementation.** `render-decision.ts` reads `hookmap.hooks[hookEventName].decisions[decision]`, then walks `set` / `from` / `top_level.set` / `top_level.from` generically. **No Claude Code field name appears in the file** — `hookEventName` is the one host-shaped key that remains, and it is a value passed in, not a field the module names. Move the hookmap's `decisions` block under `hooks.PreToolUse` verbatim in behaviour, expressed in the new shape, and add `hooks.PostToolUse.decisions`.

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/host-adapter && bun test hosts/claude-code`.

- [ ] **Step 5: Commit** — `Render by hookmap-declared field names, never hardcoded ones` / body naming V5's `N12` as the reason this is not gold-plating / `Slice: #5`.

---

### Task 5: array-index descent in `validateDecision` · slice #5 · N7

**Files:**
- Modify: `packages/host-adapter/src/validate-decision.ts` (the array rejection at 128–142, and `setAtPath`)
- Test: `packages/host-adapter/test/validate-decision.test.ts`

**Interfaces:**
- Consumes: existing `ModificationsInvalidError`, `pointerSegments`, `assertNoReservedSegments`, `segmentsOverlap`.
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

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/host-adapter/test/validate-decision.test.ts`. Expected: `descends through the array at "/outputs"`.

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
        from: verdict.transform.value
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

### Task 10: the fourth gate, and the whole-slice check · slice #5

**Files:**
- Modify: `test/invariants.test.ts`
- Modify: `docs/shaping/acs-reference-impl-slices.md` (§V4 amendments — C1–C7, Scope added, risk rows)
- Modify: `docs/shaping/acs-reference-impl-shaping.md` (F1 struck through, resolved)

**Interfaces:** consumes Task 4's generalization — the gate is only truthful after it lands.

- [ ] **Step 1: Write the failing test:**

```ts
/**
 * R3.2 from the host side, and the claim Task 4 exists to make real: the
 * adapter is the module every host shares, so a Claude Code field name in
 * it is a second host's patch waiting to happen. V5's N12 says
 * renderDecision is "the same module as N3" -- this is what makes that
 * literally true rather than aspirationally.
 */
it("the host adapter's source names no host output field", () => {
  assertNoVocabulary("packages/host-adapter/src", [
    "permissionDecision", "permissionDecisionReason",
    "updatedInput", "updatedToolOutput", "hookSpecificOutput",
  ]);
});
```

- [ ] **Step 2: Run it, expect FAIL** before Task 4, PASS after — and mutation-test it now: reintroduce `updatedInput` into `render-decision.ts`, watch it fail naming the file and the term, restore byte-identically.
- [ ] **Step 3: Amend the slices doc** — C1–C7 into §V4, the Scope-added rows, F1 struck through in the shaping doc, and the risk table: retire row 1, add two rows (the shape-mismatch fail-open; deny-at-result not being suppression).
- [ ] **Step 4: Full verification** — `bun test`, `bun run typecheck`, `bun run verify:pin` with network, and confirm `policy/lib/*.rego` is byte-untouched.
- [ ] **Step 5: Commit** — `Gate the adapter against host vocabulary, and amend the slices doc` / `Slice: #5`.

---

## Risks

| # | Risk | Handling |
|---|---|---|
| 1 | A redaction reported as applied that Claude Code silently discards, delivering the secret | Evidence 2 is the whole reason Global Constraint 5 exists. Task 7 asserts every sibling field survives; Task 8 fails closed where the shape cannot be preserved; both mutation-tested |
| 2 | Task 4's rewrite silently changes what `PreToolUse` renders | Its first test restates V1/V3's exact outputs against the new rule shape before the rewrite starts |
| 3 | `redact` in the shipped config changes an existing demo | Measured during planning: 347 pass, 1 skip, 0 fail, unchanged. Task 1's fourth test pins the pre-tool deny specifically |
| 4 | Array descent re-opens the `__proto__`/prototype hazard V3 closed | Task 5 keeps every existing guard and adds index validation; the reserved-segment check is untouched |
| 5 | `exit_status` is a literal, so a failed tool would be reported `success` | Real, and recorded rather than papered over: Claude Code fires `PostToolUseFailure` separately and this slice does not wire it. Named in the hookmap comment, the slice README, and V7's matrix |

