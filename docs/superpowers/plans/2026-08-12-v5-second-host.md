# V5: Second host, zero AGT changes

## Slice Contract

| Field | Value |
|---|---|
| **Slice ID** | [#6](https://github.com/../../issues/6) — "V5: Second host, zero AGT changes" |
| **Slices doc** | [`docs/shaping/acs-reference-impl-slices.md`](../../shaping/acs-reference-impl-slices.md) **§V5, line 235** — authoritative for this slice's scope |
| **Demo** | *"Same Guardian, same manifest, same bundle. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT."* |
| **Components** | **U10** opencode prompt input · **U11** opencode tool decision surface · **U12** opencode redacted tool output · **N10** acs-plugin shim · **N11** `buildEnvelope()` (same module as N2) · **N12** `renderDecision()` (same module as N3) · **N13** `createGuardianClient().requestDecision()` (same module as N4) · **N14** `negotiateSessionConfig()` (same module as N5) · **N15** `applyFailurePosture()` (same module as N6) · **N16** `validateDecision()` (same module as N7) · **S2** `opencode.hookmap.yaml` · **S15** negotiated session config · **S16** audit sink |
| **Parked items** | V5 defers nothing of its own. It **absorbs** V4's parked item (§V4 line 223 → §V5 line 259) |
| **Watch-for notes** | §V5's one ⚠️ — *"Inherited from V4 — one per-modification landing check, and it is scope this slice absorbs"* (line 259), including its closing two paragraphs on where the added lines may land (line 261) |
| **Corrections** | The same ⚠️ at line 259 is §V5's only correction marker. This plan adds six more — see *Corrections this plan makes to the slices doc* |
| **Requirements** | **R3.1** two structurally different hook surfaces under one AGT policy set · **R3.2** host adapter has zero AGT-specific code · **R3.3** bridge has zero host-specific code · **R3.4** adding the second host requires zero new AGT code · **R3.6** OpenCode is host #2 (🟡 *leaning yes* → this plan confirms it) · **R1.6** `transform`'s bound survives as ACS `modify` (the inherited landing check) · **R7.1** one command on a laptop |
| **Blocking follow-up** | **F2** — *"confirm an OpenCode plugin can express deny and modify through `tool.execute.before` / `.after`"*. **Resolved during planning; see Evidence.** |
| **Open decision** | **D1** — *"Confirm OpenCode as host #2"*, blocking V5. **Closed during planning; see Evidence.** |

---

## Evidence

Every finding below was produced by **running OpenCode 1.18.15**, the version installed on
this machine, against a plugin that mutates what the hooks hand it — never by reading its
documentation. That is V1–V4's standard and it is what produced ten, then five, then six
corrections in those slices.

**The harness, and why it is offline.** OpenCode drives tool calls from a model, so exercising
`tool.execute.before/after` needs something that emits a tool call. Rather than spend a real
model, the probe pointed OpenCode at a **local OpenAI-compatible endpoint** that returns a
canned `bash` tool call on turn 1 and a plain answer on turn 2. Deterministic, free, and it
exercises OpenCode's genuine tool path — the plugin hooks fire exactly as they would in a real
session. The plugin logged every hook argument to JSONL, and the persisted session record was
read back out of OpenCode's own SQLite store (`~/.local/share/opencode/opencode.db`).

### 1. The hook surface — **two of the four hooks §V5 names do not exist**

`@opencode-ai/plugin@1.18.15`'s `Hooks` interface, confirmed against runtime dispatch:

```ts
"tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string },
                          output: { args: any }) => Promise<void>;
"tool.execute.after"?:  (input: { tool: string; sessionID: string; callID: string; args: any },
                          output: { title: string; output: string; metadata: any }) => Promise<void>;
event?: (input: { event: Event }) => Promise<void>;
"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>;
```

There is **no `session.start`** and **no `tool.execute.error`**. §V5's `N10` row names both.
The observed event stream is `session.created` → `session.updated` → `message.*` →
`session.status` → `session.idle`; a declared `tool.execute.error` hook was never dispatched,
including on the run where the tool failed.

**Consequence for the shim:** session identity does not need `event` at all — `sessionID`
is on *both* tool hooks, so the shim reads it there and the generic `event` hook is not wired.

### 2. Both hooks are **mutation** hooks — they return `void`

Neither hook returns a decision. Both are handed an `output` object and the only channel is
**mutating it in place**. This is the single most consequential difference from Claude Code,
whose shim *prints a JSON document*. `governStep` returns a rendered `HostOutput` document
either way; on this host the shim **applies** that document instead of writing it.

### 3. Request-gate **modify** — ✅ mutate `output.args`

`output.args.command = "echo REWRITTEN_BY_PLUGIN"` → the transcript shows
`$ echo REWRITTEN_BY_PLUGIN` and the original command never ran.

### 4. Request-gate **deny** — ✅ **only by throwing**. There is no decision field

Writing `output.status = "deny"` and `output.decision = "deny"` was *accepted* — no throw, the
keys were present afterwards — and **ignored**: the tool ran anyway. Throwing works:

```
✗ echo TOKEN=ghp_PROBESECRET123 failed
Error: ACS_PROBE_DENY: policy denied this tool call
```

The command did not run, and the reason reached the transcript and the model. So **risk row 2
is backwards** — see the corrections below.

### 5. Result-gate **modify** — ✅ mutate `output.output`, which is a **string**

`output.output = "[REDACTED BY ACS PROBE]"` reached the model. Confirmed the secret did *not*:
the `message` table has **0** rows containing it.

`output.output` being an **opaque string** matters beyond this slice — see correction 5.

### 6. **The central hazard: a sibling that duplicates the leaf** 🔴

The runtime `output` object is `{title, metadata, output, attachments}` — and `metadata`
carries **its own copy of the output**. Isolated with a command whose *text* holds no secret
(`cat secret.txt`), after a redaction that the model correctly never saw:

```json
{"type":"tool","tool":"bash","state":{"status":"completed",
 "input":{"command":"cat secret.txt"},
 "output":"[REDACTED BY ACS PROBE]",
 "metadata":{"output":"TOKEN=ghp_ONLYINOUTPUT999\n","exit":0,"truncated":false},
 "title":"cat secret.txt"}}
```

**This inverts V4's central safety property.** `result-output.ts` withholds by patching a
*clone of the object the host handed it*, so "every sibling field survives by construction".
On Claude Code the siblings are `stderr`, `interrupted`, `isImage` — preserving them is exactly
right. Here one sibling **mirrors the leaf**, so preserving it preserves the secret. The
property that makes V4 safe is the property that leaks here, and it leaks *silently*: nothing
is malformed, nothing warns, and the model genuinely sees the redaction.

It is **closeable on the modify path** — also mutating `output.metadata.output` produced a
record redacted in both places.

### 7. Result-gate **deny** — ✅ withholds from the model, and ❌ **cannot scrub the sibling**

Throwing in `tool.execute.after` genuinely withholds, which is *better* than Claude Code (V4
measured that `decision: block` there delivers the real stdout alongside the reason). The
persisted state becomes `status: "error"` with **no `output` field at all**.

But the secret still persists, and **scrubbing first does not help**:

```jsonl
{"what":"after.scrubbed-then-throwing","metadata":{"output":"[WITHHELD]","exit":0,"truncated":false}}
```
```json
{"state":{"status":"error","error":"ACS_PROBE_DENY_AFTER2: policy denied this result",
 "metadata":{"output":"TOKEN=ghp_ONLYINOUTPUT999\n"}}}
```

The plugin's own view of `metadata` at the moment of the throw was `[WITHHELD]`; the record
kept the secret. OpenCode **discards the plugin's mutations on the throw path** and
reconstructs metadata from its own pre-hook copy — note the reconstructed object also lost
`exit` and `truncated`, which is what proves it is a different object rather than the mutated one.

**So a result-gate deny must be expressed as a mutation, not as a throw.** Withholding by
replacing `output.output` *and* its mirror scrubs both; throwing withholds from the model and
leaves the secret on disk. This is the exact mirror of V4's finding at the same gate — there,
deny could not be a bare `block` and had to go *through* the modify mechanism; here, deny
cannot be a throw and has to go through the same mechanism. Same conclusion, opposite host
mechanism, both measured.

### 8. This gate carries a **real** exit status, and the call's arguments

`metadata` is `{output, exit, truncated}` and `input.args` is present on `tool.execute.after`.
V4 had to ship `exit_status: {literal: success}` because Claude Code's `PostToolUse` payload
carries no exit code (§V4's scope note, and V7 gets the cell). **OpenCode supplies one.**

### 9. `output.attachments` exists at runtime and is **absent from the 1.18.15 type**

Observed `outputKeys: ["title","metadata","output","attachments"]`; the published `Hooks` type
declares `{title, output, metadata}`. Harmless here — the clone-and-patch discipline preserves
a field nobody declared — and worth recording as a type/runtime divergence for V8's drift watch.

### 10. The plugin is a **long-lived in-process object**

`plugin.init` fired once; every hook fired later in the same process against the same closure.
That is what makes **S15 in-memory** correct, exactly as V3 predicted when it split the session
store into two implementations ("file-backed for subprocess hosts, in-memory for V5's
in-process plugin"). `createSessionConfigStore()` already exists, is already exported, and has
no caller on any real path today.

---

## Corrections this plan makes to the slices doc

All six land in V5's PR, edited into `docs/shaping/acs-reference-impl-slices.md` at the rows
they govern.

1. **`N10`'s affordance row names two hooks that do not exist.** It reads
   "`session.start`, `event`, `tool.execute.before/after/error`". There is no `session.start`
   and no `tool.execute.error` in 1.18.15, and `event` is not needed because `sessionID` is on
   both tool hooks. The row becomes `tool.execute.before`, `tool.execute.after`.

2. **Risk row 2 is backwards.** It reads *"OpenCode plugin cannot express modify … Falls back
   to deny-only, weakening but not breaking V5"*. Measured, **modify is the straightforward
   one** at both gates, and **deny is the awkward one**: there is no decision field anywhere in
   the tool hooks, so a request-gate deny is a *throw*, and a result-gate deny must be a
   *mutation* rather than a throw or it leaves the secret in the session record. The fallback
   the row anticipated — "deny-only" — is the one posture this host is worst at.

3. **A new watch-for, and it is V5's central hazard.** `tool.execute.after`'s `metadata.output`
   duplicates the leaf, so V4's clone-and-preserve-every-sibling discipline preserves the
   secret. Closeable on the modify path by declaring the mirror; **not** closeable on the throw
   path at all.

4. **`exit_status` is not a literal on this host.** V4 recorded a known gap and V7 gets a cell;
   OpenCode's `metadata.exit` supplies a real one. The gap is Claude-Code-specific, not ACS's.

5. **V4's "`modified_content` has no target on this host at *either* gate" gains its
   counter-example.** §V4 said the refusal is "a fact about the payload shapes the two gates
   govern … a step whose payload *is* an opaque body would have an obvious target for it."
   OpenCode's result gate **is** that step: `output.output` is an opaque string, so
   `modifications.modified_content` has an obvious, well-typed target here. V7's matrix should
   carry `modified_content` as **red for Claude Code, green for OpenCode** rather than red
   outright. *This slice does not build it* — see *What is explicitly not in this slice* — but
   the matrix claim changes, and the reason is now measured rather than predicted.

6. **D1 closes and R3.6 confirms.** OpenCode is host #2: the plugin API expresses both gates and
   all of ACS's reachable dispositions, against an unchanged adapter. F2 resolves with the two
   conditions in corrections 2 and 3 attached.

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U10 opencode prompt input | Task 8 (runbook) | The host's own UI; nothing to build |
| U11 opencode tool decision surface | Task 5 | Deny reason reaches the transcript via the throw message |
| U12 opencode redacted tool output | Task 6 | The redaction the model reads |
| N10 acs-plugin shim | Tasks 4, 5, 6 | Skeleton, then each gate |
| N11 `buildEnvelope()` — same module as N2 | Tasks 5, 6 | **Reused unchanged.** No edit to `build-envelope.ts` except S2's `mirrors` key (Task 2) |
| N12 `renderDecision()` — same module as N3 | Tasks 5, 6 | **Reused unchanged.** V4 made this literally true by moving `decisions` under the hook |
| N13 `createGuardianClient()` — same module as N4 | Task 4 | **Reused unchanged** |
| N14 `negotiateSessionConfig()` — same module as N5 | Task 4 | **Reused unchanged**, through `resolveSessionConfig` |
| N15 `applyFailurePosture()` — same module as N6 | Task 4 | **Reused unchanged**, through `governStep` |
| N16 `validateDecision()` — same module as N7 | Tasks 1, 6 | Reused; Task 1 is the inherited landing check inside its apply step |
| S2 `opencode.hookmap.yaml` | Task 3 | |
| S15 negotiated session config | Task 4 | `createSessionConfigStore()` — the in-memory half V3 built for this slice |
| S16 audit sink | Task 4 | `createAuditSink()` — reused unchanged |
| **Watch-for / correction:** inherited per-modification landing check | **Task 1** | Closes both holes V4 measured; un-pins V4's four `(recorded, not closed)` tests |
| ⚠️ "requires a ruling on what a legitimately no-change modification *means*" | Task 1 | Ruled: refused, on V4's own precedent |
| ⚠️ "the added lines land where both hosts already share code" | Tasks 1, 2 | Both land in `packages/host-adapter`; Task 7 proves the diff |
| R3.1 two hook surfaces, one policy set | Task 7 | |
| R3.2 adapter has zero AGT-specific code | Task 7 | Existing gate, re-run |
| R3.3 bridge has zero host-specific code | Task 7 | Existing gate, re-run |
| R3.4 second host costs zero AGT code | Task 7 | **The demo.** The zero-diff proof |
| R3.6 OpenCode is host #2 | Resolved in planning | Evidence §1–§10 |
| R1.6 rewrite survives as `modify` | Task 1 | |
| R7.1 one command on a laptop | Task 8 | |

---

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 1 — per-modification landing check | V4 parked it **to V5** (§V4 line 223, §V5 line 259) | Not cross-slice work smuggled in: the slices doc assigns it here, with the reason that V5's own claim ("the shared apply step is inherited unchanged") makes the request-gate half worse. It is V5's by the doc of record |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| **`outputs.mirrors` on the hookmap, and a refusal when a mirror survives** (Task 2) | Without it, V5's redaction demo leaves the secret in OpenCode's session record while reporting a clean redaction. The slice's own claim is that the shared adapter is reused unchanged — so the *adapter* has to learn that a leaf can have mirrors, because a shim-local workaround would be exactly the per-host fork R3.4 forbids | New watch-for at §V5, correction 3 |
| **Result-gate deny renders as a mutation, not a throw** (Task 6) | Measured: a throw leaves the secret on disk and the mutation channel is discarded. A deny that reports withholding while the record keeps the secret is this branch's own recurring defect | Correction 2 at risk row 2, plus the new watch-for |
| **`exit_status` read from `metadata.exit`** (Task 3) | The hookmap must express a real field read where V4 could only express a literal | Correction 4 |

Nothing else. The ratio is honest: of eight tasks, six trace directly to §V5's own components, one is the item §V5 explicitly absorbs, and one is documentation.

---

## Global Constraints

1. **Zero lines change in the Guardian, the bridge, or AGT.** Task 7 proves it mechanically.
   `packages/guardian/src`, `packages/agt-bridge/src`, `policy/`, `agt.lock` and `mapping.yaml`
   are untouched by every task below.
2. **No new fail-open.** Twelve are recorded in `govern-step.ts`'s header. Every refusal added
   here fails **closed**, and the header's count is updated once, in Task 2, or not at all.
3. **The adapter never names an OpenCode field.** `packages/host-adapter/src` may not contain
   `tool.execute`, `sessionID`, `callID`, `metadata`, or `attachments`. Task 7 gates it, and
   mutation-tests the terms this slice could get wrong.
4. **The shim is the only host-specific code**, and it is thin the way `acs-hook.ts` is thin:
   it holds no decision logic, branches on no disposition, and calls `governStep`.
5. **Every fail-open proceed is audited** (§6.4), through `governStep` — unchanged.
6. **`bun run verify:pin` passes**, so no fixture forked the pinned bundle.

---

## Tasks

### The applier, decided once here so every task agrees

`governStep` returns `HostOutput` — a plain nested object built from the hookmap's dotted
paths. Claude Code's shim wraps it and prints it. **OpenCode's shim applies it**, and this is
the one piece of host semantics the shim owns:

| `HostOutput` key | Applied as |
|---|---|
| `args.<name>` | assign into the live `output.args` |
| `result.output` | assign into the live `output.output` |
| `result.metadata.output` | assign into the live `output.metadata.output` (the mirror) |
| `refuse.reason` | **throw** `new Error(reason)` |

So the hookmap — pure data, S2 — decides which disposition throws and which mutates, and the
adapter still names nothing. A request-gate `deny` declares `refuse.reason`; a result-gate
`deny` declares `result.output` **and** the mirror, and no `refuse` key, because Evidence §7
showed a throw there cannot scrub the mirror.

**The applier is all-or-nothing.** It validates every key it is handed *before* assigning any
of them, because a half-applied mutation is the one outcome worse than a refusal — the same
rule `govern-step.ts` states for writing half an output.

---

### Task 1: every modification lands at its own target · slice #6 · N16, R1.6

Closes both holes V4 measured and parked here.

> **⚠️ Amended during execution, and the amendment is a correction to this plan's own
> reasoning.** This task was written on §V4's claim that *one* check closes both holes.
> Building it disproved that: run against V4's three recorded bundle fixtures, a per-target
> "did this change" comparison passes **all three**, because every declared target genuinely
> moves (`/exit_status` `"success"`→`"failure"`, `/tool/name` `"Bash"`→`"[REDACTED]"`, the
> `outputs` override growing to two elements). The Step 1 test below used
> `replacement: "success"` against `exit_status: "success"` — a *no-op*, which is a different
> and easier case than the ones V4 actually recorded.
>
> The two holes ask different questions. The **request-gate** one is about **value**: a target
> left exactly as found — caught by the per-target comparison in `applyModifications`, which
> stays gate-agnostic. The **result-gate bundle** one is about **observability**: its non-leaf
> half changes the ACS document legitimately, and is a false report only because nothing but
> `outputs[0].value` is ever projected onto the host — which needs leaf knowledge
> `modifications.ts` deliberately lacks. So it is **two** checks, each in the file that already
> holds what it needs, the second being a comparison in `projectAppliedOutput` asking whether
> the applied document differs from the original anywhere **but** the projected leaf.
> §V4 and §V5 are amended in this PR.

**Files:**
- Modify: `packages/host-adapter/src/modifications.ts` (`applyModifications`, lines 463–494)
- Test: `packages/host-adapter/test/modifications.test.ts`
- Modify: `packages/host-adapter/test/validate-decision.test.ts` — the four
  `(recorded, not closed)` cases invert from "reports applied" to "denies"
- Modify: `packages/host-adapter/src/validate-decision.ts` — the `resolveModify` note that
  records the request-gate hole is now stale
- Modify: `packages/host-adapter/src/result-output.ts` — `projectAppliedOutput`'s
  "WHAT THIS THEREFORE DOES NOT ASK" paragraph is now wrong

**Interfaces:**
- Consumes: `applyModifications(modificationDocument, modifications) → Record<string, unknown>`;
  `ModificationsInvalidError`; `pointerSegments(path) → string[]`; `resolveSegments(container, segments) → unknown`
- Produces: no signature change. `applyModifications` gains a post-condition and one more
  throw route, so every caller that already turns its throw into `deny(modifications_invalid)`
  gets the new refusal free.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/modifications.test.ts
describe("every modification has to land at its own target", () => {
  it("denies a parameter_override that rewrites a value to itself", () => {
    expect(() =>
      applyModifications({ command: "cat .env" }, { parameter_overrides: { command: "cat .env" } }),
    ).toThrow(ModificationsInvalidError);
  });

  it("denies a bundle whose non-leaf half changes nothing", () => {
    const document = { outputs: [{ value: "SECRET" }], exit_status: "success" };
    expect(() =>
      applyModifications(document, {
        redactions: [
          { path: "/outputs/0/value", replacement: "[REDACTED]" },
          { path: "/exit_status", replacement: "success" },
        ],
      }),
    ).toThrow(ModificationsInvalidError);
  });

  it("still applies a bundle where every modification changes its own target", () => {
    const document = { outputs: [{ value: "SECRET" }], exit_status: "success" };
    expect(
      applyModifications(document, {
        redactions: [
          { path: "/outputs/0/value", replacement: "[REDACTED]" },
          { path: "/exit_status", replacement: "failure" },
        ],
      }),
    ).toEqual({ outputs: [{ value: "[REDACTED]" }], exit_status: "failure" });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

`bun test packages/host-adapter/test/modifications.test.ts` — the first two cases return a
document instead of throwing.

- [ ] **Step 3: Minimal implementation**

Record each modification's target as it is applied, then ask the one question per target:

```ts
export function applyModifications(
  modificationDocument: Record<string, unknown>,
  modifications: unknown,
): Record<string, unknown> {
  const mods = assertValidModifications(modifications, modificationDocument);

  let result: Record<string, unknown> = { ...modificationDocument };
  // Each modification's own target, in declaration order, so the check below
  // asks about the target the policy author named rather than about a leaf this
  // gate happens to carry. V4 shipped the leaf-shaped question and recorded
  // both holes it leaves (§V4); this is the honest form of it, and closing it
  // here closes the result gate's bundle and the request gate's no-change
  // rewrite together -- which is the argument for one check rather than two.
  const targets: string[][] = [];

  if (mods.parameter_overrides) {
    for (const [key, value] of Object.entries(mods.parameter_overrides)) {
      result = setAtPath(result, [key], value) as Record<string, unknown>;
      targets.push([key]);
    }
  }

  if (mods.redactions) {
    for (const redaction of mods.redactions) {
      const segments = pointerSegments(redaction.path);
      result = setAtPath(result, segments, redaction.replacement ?? "[REDACTED]") as Record<string, unknown>;
      targets.push(segments);
    }
  }

  // THE POST-CONDITION. A `modify` claims the document was rewritten; a
  // modification that left its own target as it found it did not rewrite it,
  // and reporting the whole `modify` applied is a false audit and transcript
  // record -- this branch's own recurring defect, reached from the apply step.
  //
  // Structural comparison, not `===`: a target may hold an object, where `===`
  // is reference equality and a structurally identical replacement would read
  // as a change. Both documents are built by spreads from the same source, so
  // key order is preserved and the serialisation is stable.
  //
  // A replacement EQUAL to the value already there is refused too. That is the
  // ruling §V5 asks for on "what a legitimately no-change modification means",
  // and it is V4's own precedent (`projectAppliedOutput` refuses the same case
  // at the result gate): a Guardian wanting the document delivered as produced
  // has `allow` for exactly that, and a `modify` this gate cannot tell apart
  // from one is not a rewrite it can report as applied. An over-refusal, on the
  // safe side, and the same side as every other refusal in this module.
  for (const segments of targets) {
    const before = resolveSegments(modificationDocument, segments);
    const after = resolveSegments(result, segments);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      throw new ModificationsInvalidError(
        `modifications: the modification targeting ${JSON.stringify("/" + segments.join("/"))} left that ` +
          `target exactly as it found it, so the rewrite it reports is one that nothing carried out`,
      );
    }
  }

  return result;
}
```

- [ ] **Step 4: Run it, expect PASS**

`bun test packages/host-adapter/test/modifications.test.ts`, then the whole suite. V4's four
`(recorded, not closed)` cases in `validate-decision.test.ts` **will fail** — that is their
stated purpose. Invert each to assert `deny` with `modifications_invalid`, and rename them from
`(recorded, not closed)` to `(closed by V5)`. Update the two now-wrong prose blocks named under
**Files**.

- [ ] **Step 5: Commit** — `Slice: #6`, affordances `N16`.

---

### Task 2: a leaf can have mirrors, and a surviving mirror is a refusal · slice #6 · N12, S2

**Files:**
- Modify: `packages/host-adapter/src/build-envelope.ts` — `HookmapOutputs` gains `mirrors?: string[]`
- Modify: `packages/host-adapter/src/result-output.ts` — `replacingOutput` patches mirrors and refuses a survivor
- Test: `packages/host-adapter/test/result-output.test.ts` (new file)

**Interfaces:**
- Consumes: `HookmapOutputs {from, within}`; `replacingOutput(location, replacement)`;
  `patchedClone(container, segments, replacement, path)`
- Produces: `HookmapOutputs {from, within, mirrors?: string[]}` — every existing hookmap stays
  valid, because `mirrors` is optional and Claude Code declares none.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/result-output.test.ts
const location = {
  payload: { result: { output: "SECRET", metadata: { output: "SECRET", exit: 0 } } },
  outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.result.metadata.output"] },
};

it("patches every declared mirror as well as the leaf", () => {
  expect(replacingOutput(location, "[REDACTED]")).toEqual({
    output: "[REDACTED]",
    metadata: { output: "[REDACTED]", exit: 0 },
  });
});

it("refuses when a mirror is left holding what the leaf held", () => {
  const undeclared = { ...location, outputs: { from: "$.result.output", within: "$.result" } };
  expect(() => replacingOutput(undeclared, "[REDACTED]")).toThrow(/still holds/);
});

// The degenerate case the substring form got wrong. A tool that produced no
// output must still be replaceable -- otherwise every empty result is withheld.
it("does not refuse an empty leaf just because the empty string is everywhere", () => {
  const empty = {
    payload: { result: { output: "", metadata: { output: "", exit: 0 } } },
    outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.result.metadata.output"] },
  };
  expect(replacingOutput(empty, "[REDACTED]")).toEqual({
    output: "[REDACTED]",
    metadata: { output: "[REDACTED]", exit: 0 },
  });
});
```

`holdsValue(container, value)` is a small recursive walk in this module: true when
any leaf of `container` is structurally equal to `value`. Whole values, never substrings.

- [ ] **Step 2: Run it, expect FAIL** — `mirrors` is not a member of `HookmapOutputs`, so the
  first case leaves `metadata.output` at `"SECRET"` and the second does not throw.

- [ ] **Step 3: Minimal implementation**

In `build-envelope.ts`, extend the type with the reason attached:

```ts
export type HookmapOutputs = {
  from: string;
  within: string;
  /**
   * Further paths inside `within` that hold their OWN COPY of the leaf, and
   * must receive the same replacement.
   *
   * V4's discipline is to patch a clone so every sibling survives, and on a host
   * whose siblings are unrelated fields that is exactly right. Measured on host
   * #2: one sibling MIRRORS the leaf, so preserving it preserves the secret --
   * a redaction that is clean, warns about nothing, is genuinely invisible to
   * the model, and leaves the plaintext in the host's own session record. The
   * property that makes the clone safe is the property that leaks, so the
   * hookmap has to say where the copies are; nothing here could infer it.
   */
  mirrors?: string[];
};
```

In `result-output.ts`, after the leaf patch inside `replacingOutput`:

```ts
  let replacement = patchedClone(container, segments, value, outputs.from);

  for (const mirror of outputs.mirrors ?? []) {
    const mirrorSegments = pathSegments(mirror);
    if (!withinSegments.every((segment, index) => mirrorSegments[index] === segment)) {
      throw new Error(
        `result-output: hookmap mirror ${JSON.stringify(mirror)} is not inside ` +
          `${JSON.stringify(outputs.within)}, so it names no field of the object a replacement is patched into`,
      );
    }
    replacement = patchedClone(replacement, mirrorSegments.slice(withinSegments.length), value, mirror);
  }

  // THE POST-CONDITION, and the reason `mirrors` is declared rather than
  // inferred. An undeclared mirror is indistinguishable from a sibling that
  // legitimately holds the same text, so this cannot guess -- but it CAN refuse
  // to hand back a replacement in which the value being withheld survives. Fails
  // closed: the caller turns this into a withholding deny, exactly as it does
  // for every other way a replacement cannot be built.
  //
  // WHOLE-VALUE EQUALITY, NEVER A SUBSTRING SCAN. An earlier draft of this
  // check serialised the replacement and asked whether it CONTAINED the
  // original's serialisation. That is wrong in both directions and one of them
  // is catastrophic: an empty-string leaf serialises to `""`, whose interior is
  // the empty string, and every replacement contains that -- so a tool that
  // produced no output would have every result withheld. Comparing whole values
  // has no such degenerate case, and it is the same equality the leaf's own
  // landing check uses.
  if (holdsValue(replacement, original)) {
    throw new Error(
      `result-output: the replacement still holds the value being replaced -- some field beside ` +
        `${JSON.stringify(outputs.from)} carries its own copy, and withholding a leaf while a sibling keeps ` +
        `it withholds nothing. Declare that field in this hook's "mirrors" so it is replaced too`,
    );
  }

  return replacement;
```

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/host-adapter/test/result-output.test.ts`,
  then the full suite; Claude Code's hookmap declares no `mirrors` and must be unaffected.

- [ ] **Step 5: Commit** — `Slice: #6`, affordances `N12, S2`.

---

### Task 3: `opencode.hookmap.yaml` — S2 · slice #6 · S2

**Files:**
- Create: `hosts/opencode/opencode.hookmap.yaml`
- Create: `hosts/opencode/package.json` (workspace member, mirroring `hosts/claude-code/package.json`)
- Test: `hosts/opencode/test/hookmap.test.ts`

**Interfaces:**
- Consumes: `loadHookmap(path) → Hookmap`; `assertRenderableDecisions` (via `loadHookmap`)
- Produces: `hosts/opencode/opencode.hookmap.yaml` — the path Task 4's shim defaults to.

- [ ] **Step 1: Write the failing test**

```ts
// hosts/opencode/test/hookmap.test.ts
const HOOKMAP = fileURLToPath(new URL("../opencode.hookmap.yaml", import.meta.url));

it("loads, and maps both gates", () => {
  const hookmap = loadHookmap(HOOKMAP);
  expect(hookmap.host).toBe("opencode");
  expect(hookmap.hooks["tool.execute.before"]?.acs_method).toBe("steps/toolCallRequest");
  expect(hookmap.hooks["tool.execute.after"]?.acs_method).toBe("steps/toolCallResult");
});

it("declares the metadata mirror at the result gate", () => {
  const after = loadHookmap(HOOKMAP).hooks["tool.execute.after"];
  expect(after?.outputs?.mirrors).toEqual(["$.result.metadata.output"]);
});

it("expresses a request-gate deny as a refusal and a result-gate deny as a replacement", () => {
  const hooks = loadHookmap(HOOKMAP).hooks;
  expect(Object.keys(hooks["tool.execute.before"]!.decisions.deny.output)).toContain("refuse.reason");
  // Measured: a throw at the result gate discards the mutation channel, so the
  // mirror keeps the secret. Deny there withholds by replacing, never by throwing.
  const resultDeny = Object.keys(hooks["tool.execute.after"]!.decisions.deny.output);
  expect(resultDeny).toContain("result.output");
  expect(resultDeny).not.toContain("refuse.reason");
});
```

- [ ] **Step 2: Run it, expect FAIL** — the file does not exist.

- [ ] **Step 3: Minimal implementation**

```yaml
# S2 -- the ONLY per-host artifact besides the plugin shim (N10).
#
# Same shape as claude-code.hookmap.yaml, against the same adapter. What differs
# is entirely data, which is the slice's whole claim.
host: opencode
hooks:
  # The request gate. OpenCode hands the plugin `{tool, sessionID, callID}` and a
  # mutable `{args}`; the shim assembles those into one payload object so these
  # paths have something to resolve against.
  tool.execute.before:
    acs_method: steps/toolCallRequest
    tool_name: $.tool
    arguments: $.args
    decisions:
      # `refuse.reason` is this host's deny channel and there is no other:
      # measured, `output.status = "deny"` and `output.decision = "deny"` are
      # both ACCEPTED and IGNORED, and the tool runs. Throwing is what stops it.
      allow:
        output:
          reason.text: { from: reasoning, type: string }
      deny:
        output:
          refuse.reason: { from: reasoning, type: string }
      # No native "ask" at this hook -- `permission.ask` is a different event
      # this slice does not wire -- so ask fails CLOSED, the same least-wrong
      # mapping V1 made for Claude Code's absent `defer`.
      ask:
        output:
          refuse.reason: { from: reasoning, type: string }
      defer:
        output:
          refuse.reason: { from: reasoning, type: string }
      modify:
        output:
          args: { from: applied_input }
          reason.text: { from: reasoning, type: string }
  # The result gate.
  tool.execute.after:
    acs_method: steps/toolCallResult
    tool_name: $.tool
    outputs:
      from: $.result.output
      within: $.result
      # THE MIRROR. `metadata` carries its own copy of the output; a redaction
      # that patches only the leaf leaves the plaintext in OpenCode's session
      # record while the model correctly sees the redaction. Measured.
      mirrors:
        - $.result.metadata.output
    # A REAL field read, not a literal. Claude Code's PostToolUse payload carries
    # no exit code, so V4 shipped `{literal: success}` and recorded the gap;
    # OpenCode's `metadata.exit` supplies one.
    exit_status: { from: $.result.metadata.exit }
    decisions:
      allow:
        output:
          reason.text: { from: reasoning, type: string }
      # Deny WITHHOLDS BY REPLACING, and deliberately does not throw. A throw
      # here does withhold from the model -- better than Claude Code, where
      # `block` delivers the real stdout -- but OpenCode DISCARDS the plugin's
      # mutations on the throw path and rebuilds `metadata` from its own pre-hook
      # copy, so the secret survives on disk however early it is scrubbed.
      # Measured both ways.
      deny:
        output:
          result.output: { from: applied_output }
          reason.text: { from: reasoning, type: string }
      modify:
        output:
          result.output: { from: applied_output }
          reason.text: { from: reasoning, type: string }
```

- [ ] **Step 4: `exit_status` learns the field-read form**

A **new hookmap form**: V4's `exit_status` type is `HookmapLiteral` only, and this hookmap
declares `{from: $.result.metadata.exit}`. Its own failing test first, in
`packages/host-adapter/test/build-envelope.test.ts`:

```ts
it("reads exit_status from the payload when the hookmap names a path", () => {
  const envelope = buildEnvelope("tool.execute.after", 
    { tool: "bash", result: { output: "x", metadata: { exit: 0 } } }, hookmapWithFieldRead);
  expect(envelope.params.payload.exit_status).toBe("success");
});

it("maps a non-zero exit to failure", () => { /* metadata.exit = 1 -> "failure" */ });

it("still accepts the literal form", () => { /* Claude Code's hookmap is unchanged */ });
```

Then, in `build-envelope.ts`:

```ts
/** An exit status read from the payload rather than fixed by the hookmap. */
export type HookmapFieldRead = { from: string };

/**
 * `success` / `failure`, per ACS's own enum. A host that reports a numeric exit
 * code is mapped here rather than in the hookmap, because the hookmap is data
 * and "0 means success" is a fact about process exit codes, not a per-host
 * choice. A host whose gate genuinely cannot fail keeps V4's literal form.
 */
function exitStatusOf(entry: HookmapResultHookEntry, payload: Record<string, unknown>): string {
  if ("literal" in entry.exit_status) return entry.exit_status.literal;
  const raw = resolvePath(payload, entry.exit_status.from);
  if (raw === undefined) {
    throw new Error(
      `build-envelope: hookmap path ${JSON.stringify(entry.exit_status.from)} for "exit_status" resolves to ` +
        `no value in this payload, so this gate cannot say whether the step succeeded`,
    );
  }
  return raw === 0 || raw === "0" || raw === "success" ? "success" : "failure";
}
```

`HookmapResultHookEntry.exit_status` becomes `HookmapLiteral | HookmapFieldRead`. Claude Code's
hookmap declares the literal and is untouched.

- [ ] **Step 5: Run it, expect PASS** — `bun test hosts/opencode/test/hookmap.test.ts packages/host-adapter/test/build-envelope.test.ts`, then the full suite.
- [ ] **Step 6: Commit** — `Slice: #6`, affordance `S2`.

---

### Task 4: the plugin shim and its stores · slice #6 · N10, N13, N14, S15, S16

**Files:**
- Create: `hosts/opencode/acs-plugin.ts`
- Test: `hosts/opencode/test/apply-host-output.test.ts`

**Interfaces:**
- Consumes: `loadHookmap`, `createGuardianClient`, `createSessionConfigStore`, `createAuditSink`,
  `resolveSessionConfig`, `toSessionUuid`, `governStep`, `type HostOutput`
- Produces: `applyHostOutput(output: HostOutput, live: {args?, result?}) → void` — the applier,
  exported for test; `AcsPlugin` — the OpenCode `Plugin` export.

- [ ] **Step 1: Write the failing test** — the applier, in isolation from OpenCode.

```ts
it("assigns args and result fields onto the live objects", () => {
  const live = { args: { command: "cat .env" }, result: { output: "SECRET", metadata: { output: "SECRET" } } };
  applyHostOutput({ args: { command: "echo safe" }, result: { output: "[REDACTED]", metadata: { output: "[REDACTED]" } } }, live);
  expect(live.args.command).toBe("echo safe");
  expect(live.result.metadata.output).toBe("[REDACTED]");
});

it("throws the declared refusal, and assigns nothing first", () => {
  const live = { args: { command: "cat .env" } };
  expect(() => applyHostOutput({ refuse: { reason: "denied by policy" }, args: { command: "x" } }, live))
    .toThrow("denied by policy");
  expect(live.args.command).toBe("cat .env");
});

it("refuses a key it cannot apply rather than applying the rest", () => {
  const live = { args: {} };
  expect(() => applyHostOutput({ unknown_channel: {} } as never, live)).toThrow(/cannot apply/);
});
```

- [ ] **Step 2: Run it, expect FAIL** — the module does not exist.

- [ ] **Step 3: Minimal implementation** — the shim, thin the way `acs-hook.ts` is thin.

```ts
const HOOKMAP_PATH = process.env.ACS_HOOKMAP_PATH ?? fileURLToPath(new URL("./opencode.hookmap.yaml", import.meta.url));

/**
 * Applies what `governStep` rendered onto the objects OpenCode handed us.
 *
 * The one piece of host semantics this slice owns. Claude Code's shim WRITES the
 * rendered document to stdout; this host has no document -- its hooks return
 * void and the only channel is mutating what they were handed, or throwing. So
 * the same `HostOutput`, from the same `renderDecision`, is applied instead of
 * printed, and the hookmap still decides which disposition does which.
 *
 * VALIDATED WHOLE, THEN APPLIED WHOLE. A half-applied mutation is the one
 * outcome worse than a refusal -- an argument rewritten while the redaction it
 * came with was dropped -- which is the rule govern-step.ts states for writing
 * half an output, at the seam that writes it for this host.
 */
export function applyHostOutput(output: HostOutput, live: { args?: Record<string, unknown>; result?: Record<string, unknown> }): void {
  for (const key of Object.keys(output)) {
    if (key === "refuse" || key === "reason") continue;
    if (key === "args" && live.args !== undefined) continue;
    if (key === "result" && live.result !== undefined) continue;
    throw new Error(`acs-plugin: cannot apply rendered key ${JSON.stringify(key)} at this gate`);
  }

  const refusal = output.refuse as { reason?: unknown } | undefined;
  if (refusal !== undefined) {
    throw new Error(typeof refusal.reason === "string" ? refusal.reason : "denied by policy");
  }

  if (output.args !== undefined && live.args !== undefined) Object.assign(live.args, output.args);
  if (output.result !== undefined && live.result !== undefined) assignDeep(live.result, output.result as Record<string, unknown>);
}

export const AcsPlugin: Plugin = async () => {
  const hookmap = loadHookmap(HOOKMAP_PATH);
  const guardian = createGuardianClient(process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL);
  const audit = createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" });
  // S15 -- IN MEMORY, and this is the half V3 built for exactly this host. The
  // Claude Code shim is a fresh subprocess per hook so its store is file-backed;
  // this plugin is one long-lived object for the whole session (measured:
  // plugin init fires once, every hook fires later against this closure), so the
  // negotiated config survives in a variable and the second hook skips the round
  // trip. One interface, two implementations, and the adapter stops caring how
  // the host runs -- R3.4.
  const store = createSessionConfigStore();
  return { /* the two gates -- Tasks 5 and 6 */ };
};
```

- [ ] **Step 4: Run it, expect PASS** — `bun test hosts/opencode/test/apply-host-output.test.ts`.
- [ ] **Step 5: Commit** — `Slice: #6`, affordances `N10, N13, N14, S15, S16`.

---

### Task 5: the request gate, end to end · slice #6 · N11, N16, U11

**Files:**
- Modify: `hosts/opencode/acs-plugin.ts` — the `tool.execute.before` hook
- Test: `hosts/opencode/test/request-gate.test.ts` — against a **live Guardian**, as
  `hosts/claude-code/test/hook.test.ts` does

**Interfaces:**
- Consumes: `governStep({hookEventName, payload, hookmap, guardian, session, sessionId, audit}) → GovernedStep`;
  `applyHostOutput`; `resolveSessionConfig`
- Produces: the `"tool.execute.before"` hook member of `AcsPlugin`'s returned `Hooks`.

- [ ] **Step 1: Write the failing test** — a destructive command is denied by throwing, and the
  reason is the Guardian's own; a `transform` rewrites `output.args` in place.

A **live Guardian**, exactly as `hosts/claude-code/test/hook.test.ts:84` does it — the plugin
reads `ACS_GUARDIAN_URL` when it is constructed, so the port has to be set before `AcsPlugin` runs:

```ts
let guardian: StartedGuardian;
beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  process.env.ACS_GUARDIAN_URL = guardian.url;
});
afterAll(async () => { await guardian.stop(); });

it("denies a destructive command by throwing, with the policy's reason", async () => {
  const hooks = await AcsPlugin({} as never);
  const output = { args: { command: "rm -rf /" } };
  await expect(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, output))
    .rejects.toThrow(/policy/i);
  expect(output.args.command).toBe("rm -rf /"); // nothing half-applied
});

it("applies a rewrite to the live args", async () => { /* transform config, asserts output.args.command changed */ });
```

- [ ] **Step 2: Run it, expect FAIL** — the hook is not wired.

- [ ] **Step 3: Minimal implementation**

```ts
"tool.execute.before": async (input, output) => {
  // ONE payload object so the hookmap's paths have a single thing to resolve
  // against. OpenCode splits what Claude Code sends as one JSON blob across two
  // arguments; assembling them is the shim's job, and it is the only reshaping
  // that happens on this side of the seam.
  const payload = { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args };
  const session = await resolveSessionConfig(
    { guardian, agentId: AGENT_ID, sessionId: toSessionUuid(input.sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
    store,
  );
  const governed = await governStep({
    hookEventName: "tool.execute.before",
    payload, hookmap, guardian, session, sessionId: input.sessionID, audit,
  });
  applyHostOutput(governed.output, { args: output.args });
},
```

- [ ] **Step 4: Run it, expect PASS** — `bun test hosts/opencode/test/request-gate.test.ts`.
- [ ] **Step 5: Commit** — `Slice: #6`, affordances `N11, N16, U11`.

---

### Task 6: the result gate, end to end · slice #6 · N12, U12

**Files:**
- Modify: `hosts/opencode/acs-plugin.ts` — the `tool.execute.after` hook
- Test: `hosts/opencode/test/result-gate.test.ts`

**Interfaces:**
- Consumes: as Task 5, plus `HookmapOutputs.mirrors` (Task 2)
- Produces: the `"tool.execute.after"` hook member.

- [ ] **Step 1: Write the failing test** — the mirror is the point.

```ts
it("redacts the leaf AND its metadata mirror", async () => {
  const hooks = await AcsPlugin({} as never);
  const output = { title: "cat .env", output: "TOKEN=ghp_SECRET", metadata: { output: "TOKEN=ghp_SECRET", exit: 0 }, attachments: [] };
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: {} }, output);
  expect(output.output).not.toContain("ghp_SECRET");
  // The whole reason this slice touched the shared adapter.
  expect(output.metadata.output).not.toContain("ghp_SECRET");
});

it("preserves a sibling it was never told about", async () => {
  /* asserts `attachments` and `metadata.exit` survive -- V4's clone discipline,
     which is right for every sibling that is not a mirror */
});

it("withholds a denied result by replacing rather than throwing", async () => {
  /* asserts the hook RESOLVES, output.output is the withheld marker, and
     metadata.output carries no secret -- because a throw here cannot scrub it */
});
```

- [ ] **Step 2: Run it, expect FAIL** — the hook is not wired.

- [ ] **Step 3: Minimal implementation** — the same six lines as Task 5, with `result` in the
  payload and in the applier's live object:

```ts
"tool.execute.after": async (input, output) => {
  const payload = { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args, result: output };
  const session = await resolveSessionConfig({ /* as above */ }, store);
  const governed = await governStep({ hookEventName: "tool.execute.after", payload, hookmap, guardian, session, sessionId: input.sessionID, audit });
  applyHostOutput(governed.output, { result: output as unknown as Record<string, unknown> });
},
```

- [ ] **Step 4: Run it, expect PASS** — `bun test hosts/opencode/test/result-gate.test.ts`.
- [ ] **Step 5: Commit** — `Slice: #6`, affordances `N12, U12`.

---

### Task 7: the invariant gates, and the zero-diff proof · slice #6 · R3.1–R3.4

**This task is the demo.** The slice's deliverable is the diff.

**Files:**
- Modify: `test/invariants.test.ts` — the fifth grep gate
- Create: `scripts/verify-zero-diff.sh` — the zero-diff proof
- Modify: `package.json` — `"verify:zero-diff": "bash scripts/verify-zero-diff.sh"`

**Interfaces:**
- Consumes: the existing gate helpers in `test/invariants.test.ts`
- Produces: one new gate, and `bun run verify:zero-diff`.

**Why the zero-diff proof is a script, not a `bun test` case.** It needs git history and a base
ref, which is exactly the shape of `verify:pin` — the repo's existing precedent for a check that
depends on something outside the working tree (there, a network clone). No test in this repo
shells out to git, and one that did would fail for anyone whose checkout lacks the base branch,
and permanently once the stack merges and `slice/v4` is deleted. As a script it takes the base
as an argument, defaults to the stack's parent, and says what it compared.

- [ ] **Step 1: Write the failing test**

```ts
it("the adapter names no OpenCode field", () => {
  // Fifth gate, same shape as the four before it. `attachments` is the term
  // this slice could most plausibly get wrong: it is the field OpenCode has at
  // runtime and does not declare in its own type, so a shortcut in
  // `result-output.ts` naming it explicitly is the mistake to catch.
  for (const term of ["tool.execute", "callID", "attachments"]) {
    expect(sourceFilesUnder("packages/host-adapter/src").filter((f) => namesTerm(f, term))).toEqual([]);
  }
});
```

**Two terms are deliberately NOT in that list, and the reason is the gate's own validity.**
`namesTerm` is case-insensitive (`test/invariants.test.ts:68`), and the adapter legitimately
uses both:

- **`sessionID`** case-insensitively matches `sessionId`, which six adapter files use — it is
  **ACS's** own `metadata.session_id`, not OpenCode's field. Gating it would fail on day one.
- **`metadata`** appears in `build-envelope.ts` and `handshake.ts` as the **ACS envelope's own
  `metadata` block**. Same collision.

Listing either would produce a gate that fails for the wrong reason, and "loosen the gate until
it passes" is how a gate stops meaning anything. What protects R3.2 for those two is that they
are ACS vocabulary the adapter is *supposed* to speak.

- [ ] **Step 2: Run it, expect FAIL** — mutation-test the fifth gate by adding `attachments` to
  a comment in `result-output.ts`, confirm it fails, remove it. The other two terms pass whether
  or not it is in the list, which is why it is the one to prove.

  **Keep `result-output.ts`'s prose host-neutral anyway.** It now discusses the mirror at
  length, and although `metadata` cannot be gated, the module's own header claims it "names no
  host field". Say "a sibling that duplicates the leaf", not the host's field name — the gate
  cannot enforce this one, so the discipline has to.

- [ ] **Step 3: Minimal implementation** — the script:

```bash
#!/usr/bin/env bash
# R3.4, mechanically. The second host must cost zero lines in the Guardian, the
# bridge, or AGT -- the slice's demo IS this diff. Same shape as verify-pin.sh:
# a check that needs git history, so it is a script rather than a bun test.
set -euo pipefail
base="${1:-slice/v4}"
frozen='^(packages/guardian/src/|packages/agt-bridge/src/|policy/|agt\.lock$|mapping\.yaml$)'
changed="$(git diff --name-only "$base"...HEAD | grep -E "$frozen" || true)"
if [ -n "$changed" ]; then
  echo "verify-zero-diff: R3.4 violated -- these are frozen for this slice:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "verify-zero-diff: zero changed lines under the Guardian, the bridge, or AGT (vs $base)"
```

- [ ] **Step 4: Run it, expect PASS** — `bun test test/invariants.test.ts`, then
  `bun test`, `bun run typecheck`, `bun run verify:pin`, `bun run verify:zero-diff`.
  Mutation-test the script too: touch a comment in `packages/guardian/src/server.ts`, confirm it
  exits 1, revert.

- [ ] **Step 5: Commit** — `Slice: #6`.

---

### Task 8: the runbook, the slice README, and the slices-doc amendments · slice #6 · U10, R7.1

**Files:**
- Create: `docs/demos/v5-runbook.md` — real captured output, as v3's and v4's carry
- Modify: `slices/v5/README.md` — replace the scaffold stub
- Modify: `docs/shaping/acs-reference-impl-slices.md` — **all six corrections**
- Modify: `README.md` — OpenCode in the setup path (R7.1)

- [ ] **Step 1: Write the failing test** — the runbook's claims are captured from a real
  session, so the "test" is the capture: run the Guardian, run OpenCode against a
  secret-bearing command, and record the transcript, the envelope pair from
  `.acs/envelopes.jsonl`, and the **persisted session record** showing the mirror redacted.

- [ ] **Step 2: Run it, expect FAIL** — before Tasks 1–7, the capture shows the secret in
  `metadata.output`. That capture is what the runbook contrasts against.

- [ ] **Step 3: Minimal implementation** — write the three documents. The slices-doc edits are
  the six corrections listed above, each at the row it governs: `N10`'s hook names, risk row 2's
  inversion, the new mirror watch-for, `exit_status`, V4's `modified_content` counter-example,
  and D1/R3.6 closing. Add a **V5 planning correction-log paragraph** beside V1–V4's.

- [ ] **Step 4: Run it, expect PASS** — `bun test`, `bun run typecheck`, `bun run verify:pin`,
  and re-read every claim in the runbook against its capture.

- [ ] **Step 5: Commit** — `Slice: #6`, affordances `U10`.

---

## What is explicitly not in this slice

- **`permission.ask` as a real ACS `ask`.** OpenCode has a genuine three-valued decision surface
  (`{status: "ask" | "deny" | "allow"}`) — but it is a *different event*, fired on permission
  requests rather than on every tool call, and wiring it means a second envelope source and a
  second hookmap gate. This slice maps `ask` to a refusal, fail-closed, and records the
  mapping. A host with a native ask deserves it; that is its own slice.
- **`modifications.modified_content` at OpenCode's result gate.** Evidence §5 establishes the
  target exists — the output is an opaque string, which is precisely the case §V4 said "would
  have an obvious target for it". Building it means `mapVerdict` learning to emit
  `modified_content`, which is a **Guardian** change, and Global Constraint 1 forbids one here.
  V7's matrix carries the cell with the measured reason.
- **`tool.execute.error`.** Not a hook in 1.18.15. A failing tool is ungoverned at the result
  gate on this host, the same shape as V4's un-wired `PostToolUseFailure`.
- **Session state and provenance carriage** — V6, unchanged.
- **An OpenCode Inspector view.** S6 is host-agnostic and `bun run inspector` already tails it;
  nothing host-specific is needed, and R5.2's gate would forbid it.

---

## Risks

| # | Risk | Handling |
|---|------|----------|
| 1 | ~~The `mirrors` post-condition's substring test could refuse a legitimate replacement that happens to contain the original text~~ **Retired — the risk was real and twice as large as this row guessed** | Two corrections, both to this plan's own design. The **substring** form was caught pre-flight: an empty leaf serialises to `""`, whose interior is the empty string, so it would have withheld *every* empty result. The **whole-value** form that replaced it was caught in review, having broken the shipped host a different way — `stdout` and `stderr` are both `""` for any silent command, so `stderr` read as an undeclared mirror and `touch` / `mkdir` / `git add` became blocking stops with no audit entry. Both share one root error: the check tried to infer *"is a copy of the leaf"* from *"holds the same value"*, and no payload distinguishes them. What ships is two questions — every **declared** mirror received the replacement, and (only when mirrors are declared at all) no other field still holds the original. **The root error is narrowed, not removed**, and this row said "removed" until the re-review measured otherwise: the second question is the same inference, so on a host that *does* declare mirrors — host #2, this slice's subject — an unrelated sibling coincidentally equal to the leaf is still refused as a blocking stop. Pinned as a deliberate over-refusal rather than claimed away. Three residuals, all the hookmap author's: that over-refusal; a duplicate kept **outside** `outputs.within`, which the scan never walks; and an undeclared mirror on a host declaring **none**. V7's matrix carries the cells |
| 2 | OpenCode 1.18.15's plugin API is unstable — `attachments` already diverges from its own published type | V8's drift watch is the answer; this slice pins the version in the runbook and in `hosts/opencode/package.json` |
| 3 | Task 1 inverts four tests V4 wrote as `(recorded, not closed)` | Intended and stated: those tests exist to fail when this lands. The **request-gate** half has no test pinning it, so Task 1 adds the first one |
| 4 | The zero-diff gate compares against `slice/v4`, so it moves if the stack is rebased | Acceptable in a stacked-PR workflow; the gate names the base explicitly rather than assuming `main` |
