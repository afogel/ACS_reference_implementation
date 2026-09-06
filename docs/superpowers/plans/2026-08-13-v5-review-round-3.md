# V5 review round 3 — PR #14 (slice/v5) review responses

Six tasks answering the nine open threads on PR #14 ("Sandi Metz review — V5
(second host) + five-slice stack"). Every finding was verified against the code
before this plan was written; none is being taken on the reviewer's word alone.

Branch: `slice/v5`. The stack above it (`slice/v6`..`slice/v8`) is scaffold-only
and gets rebased after this plan lands.

## Context

`hosts/opencode/` is host #2, added by V5. `packages/host-adapter/` is the
package BOTH hosts run. `hosts/claude-code/` is host #1 and is `+0/-0` across
V5 — the claim slice V5 rests on (R3.4: whatever moved, moved once, in code
both hosts share, rather than being forked per host). **Every task in this plan
must preserve that: do not modify `hosts/claude-code/acs-hook.ts` or
`hosts/claude-code/claude-code.hookmap.yaml`.** Additive test files under
`hosts/claude-code/test/` are permitted, as V5 already does.

`scripts/verify-zero-diff.sh` mechanically checks the `+0/-0` claim. Run it.

## Global Constraints

1. **R3.2 — the adapter names no host field.** `test/invariants.test.ts`'s
   "the host adapter's source names no host output field" gate fails if any of
   `permissionDecision`, `permissionDecisionReason`, `updatedInput`,
   `updatedToolOutput`, `hookSpecificOutput`, or **`refuse`** appears in
   non-test `.ts` under `packages/host-adapter/src` (comments stripped, so a
   doc comment may still explain the boundary). Any rule about which host key
   means "refusal" stays in `hosts/opencode/`.
2. **R3.4 — no per-host fork.** Shared behaviour lands in
   `packages/host-adapter/src`, never in a host-specific copy.
3. **Global Constraint 1 (from V5) still binds:** `packages/guardian/src`,
   `packages/agt-bridge/src`, `policy/lib/`, `agt.lock`, `mapping.yaml`, and
   `hosts/claude-code/` are frozen. The adapter is not on that list.
4. **`hosts/opencode/acs-plugin.ts` exports exactly one symbol** (`AcsPlugin`).
   `test/invariants.test.ts` pins this: OpenCode's plugin loader calls every
   export as a candidate factory, and a single non-function export makes the
   real factory never run at all. A new module beside it is the way to add code,
   not a second export.
5. **Load-time over posture-time.** A fault that is decidable from the hookmap
   file alone must throw at load, not from a payload path — a throw reached from
   `buildEnvelope`/`governStep` is caught by `governStep` and answered by the
   deployment's NEGOTIATED delivery posture, and a negotiated `proceed` there is
   an ungoverned step. This slice has hit that seam five times; do not add a
   sixth.
6. **Comment discipline.** This repo's comments state measured facts and retract
   claims that stop being true. When a task invalidates an existing comment
   (including this plan's own quoted text, `docs/shaping/`, `slices/v5/README.md`,
   `docs/demos/v5-runbook.md`, and the hookmap YAML headers), update it in the
   same commit. Do not leave a comment describing the code as it was.
7. **Verification:** `bun test` (baseline: 618 pass, 1 skip, 0 fail) and
   `bun run typecheck` (baseline: clean) must both pass at the end of every task.
8. **Mutation-test each new gate.** This repo's convention: after adding a check,
   reintroduce the fault it refuses and confirm the new test fails naming the
   file and the term. Record that in the report.

---

## Task 1 — `loadHookmap` returns a normalised hookmap; rename the request-gate assert

Answers threads 3773262492 (Important · tell, don't ask) and 3773262465
(Important · intention-revealing names).

**File:** `packages/host-adapter/src/build-envelope.ts` (plus its tests).

### 1a. Normalise `tools`

`assertToolsWellFormed` treats YAML `null` as absent, but only inside its own
local variable (`const rawTools = (entry as {tools?: unknown}).tools ?? undefined`).
The `Hookmap` object `loadHookmap` returns still carries `tools: null` on that
entry, so every consumer must repeat the `?? undefined` dance —
`hosts/opencode/acs-plugin.ts`'s `isGovernedTool` does exactly that today, and
its doc comment records the `TypeError: null is not an object` crash that
happened when it did not.

Make `loadHookmap` return a **normalised** `Hookmap`: an entry whose `tools` key
is present-but-`null` comes back with the key **omitted**, so callers read a
well-formed role rather than a YAML parse tree.

- Do the normalisation without mutating the parsed object in a way that hides
  the original from the other load-time checks that run after it — pick the
  ordering that keeps every existing check seeing what it already sees.
- `tools: null` must still mean "every tool", exactly as `undefined` does; this
  is a representation change, not a semantic one.
- A malformed `tools` (not a non-empty list of non-empty strings) still throws,
  unchanged.

### 1b. Rename `assertRequestGateUnscopable`

After V5's Task 5 reversal the function no longer asserts unscopability — the
shipped request gate **is** scoped (`tools: [bash]`), and the function only
refuses `arguments` + `outputs`. The name now teaches a reader that the adapter
forbids scoping a request gate, and that reader will delete `tools: [bash]` from
the shipped hookmap or skip the tool check.

Rename to **`assertRequestGateDeclaresNoOutputs`**. Update its own doc comment,
`loadHookmap`'s doc comment (which lists it by name), and every other place the
old name appears in prose (`hosts/opencode/acs-plugin.ts`'s header names it, and
so may `docs/` and `slices/v5/README.md` — grep for it).

### Verification for Task 1

- A test that a hookmap entry with a bare `tools:` key loads and comes back with
  `tools` absent — not `null`.
- A test that `tools: null` and no `tools` key at all are indistinguishable to a
  consumer.
- The existing malformed-`tools` throw tests still pass unchanged.
- Mutation-test the normalisation: remove it and confirm a test fails.

---

## Task 2 — the adapter enacts `tools`; both shims inherit the skip

Answers threads 3773262471 (Important · depend on roles) and 3773262477
(Important · companion). Depends on Task 1.

**The finding:** `tools` is shared hookmap vocabulary, shape-checked by the
adapter, but **honoured only by the OpenCode shim**. Claude Code never reads it
(its matcher lives in `settings.json`). `HookmapHookEntryCommon.tools`'s own doc
comment says the quiet part: "Whether a given invocation's tool is actually IN
this list is the host shim's concern (each gate honouring it), never this
module's." A third host copied from `acs-hook.ts` will load `tools: […]` and
govern every tool anyway, and the fault that follows is answered by the
negotiated posture — the fail-open shape this slice has hit repeatedly.

Contrast `mirrors`, which the adapter both shape-checks (`build-envelope.ts`)
and *uses* (`result-output.ts`). `tools` should have the same division.

### What to build

Move the **decision** into `packages/host-adapter/src`, as a named role both
hosts depend on rather than a rule one host remembered:

1. An exported predicate on the adapter's barrel that answers "does this gate
   govern this tool?" from the hookmap — the single implementation of the rule
   that `undefined` (and, after Task 1, an omitted key) means "every tool".
   `hosts/opencode/acs-plugin.ts`'s `isGovernedTool` is **deleted** and its call
   sites call the adapter's predicate instead. Carry the parts of
   `isGovernedTool`'s doc comment that are still true onto the adapter function
   — what the skip costs, and why it is right anyway — since that reasoning is
   now the adapter's to state.
2. **`governStep` honours it too**, before envelope construction: a step whose
   tool this gate's `tools` list does not name returns an empty `HostOutput`
   without building an envelope, without contacting the Guardian, and without
   writing an audit entry. This is the safety net that makes a third host
   inherit the skip instead of copy it.

### The property you must not regress

The OpenCode shim's early return currently happens **before**
`assertUsableSessionId` and **before** `resolveSessionConfig` — so an
out-of-scope tool costs no session validation and no handshake round trip. That
ordering is deliberate and documented. Keep the shim's early return (now calling
the adapter's predicate) so that property survives; `governStep`'s own check is
belt-and-braces for a shim that forgets, not a replacement for the shim's.

Both checks calling one adapter function is the point. Two copies of the rule is
the thing this task removes.

### What must not change

- Claude Code's hookmap declares **no** `tools` key (verified: zero matches), so
  this task is a no-op for host #1 and `hosts/claude-code/` stays `+0/-0`. Run
  `scripts/verify-zero-diff.sh` and report its output.
- An ungoverned tool must remain **unaudited and silent** at both gates, exactly
  as it is today — do not start writing audit entries for skipped steps.
- `assertUsableTool` still runs BEFORE the tool check in the shim: a malformed
  `tool` is unreadable, not out of scope, and `Array.prototype.includes` answers
  a silent `false` for one. That ordering, and its doc comment, stay.

### Verification for Task 2

- A test at the adapter level that `governStep` returns an empty `HostOutput`,
  contacts no Guardian, and writes no audit entry for a tool outside a gate's
  `tools` list.
- A test that a gate declaring no `tools` governs every tool (host #1's case).
- The existing OpenCode request-gate and result-gate skip tests still pass.
- Mutation-test `governStep`'s check: remove it and confirm a test fails.

---

## Task 3 — one reserved-segment guard, on the adapter's barrel

Answers thread 3773262486 (Important · duplication vs wrong abstraction).

**The finding:** `hosts/opencode/apply-host-output.ts` carries the **fourth**
copy of `RESERVED_SEGMENTS` (`__proto__`, `constructor`, `prototype`) — the
others are in `packages/host-adapter/src/hookmap-path.ts`,
`packages/host-adapter/src/render-decision.ts`, and
`packages/host-adapter/src/modifications.ts` — because the adapter keeps them
all module-private. Worse, `modifications.ts`'s own doc comment *names this
OpenCode file* as where the value-side half of the guard lives: a shared package
pointing at one host's source for a security invariant.

A security invariant that must not drift should be one exported thing the shim
depends on as a message.

### What to build

Export from `packages/host-adapter`'s public surface:

- the reserved-segment **names** (one definition), and
- the **value-tree walker** that refuses a rendered value owning one of those
  keys at any depth — the job `assertNoReservedSegments` does in both
  `modifications.ts` and `apply-host-output.ts` today.

`hosts/opencode/apply-host-output.ts` deletes its copies and imports them.
`modifications.ts` uses the shared definition and its doc comment stops pointing
at `hosts/opencode/`.

### The distinction you must preserve

There are **two different jobs** wearing the same three names, and this task
must not merge them:

- **Path segments** — refusing a hookmap *path* whose segment names prototype
  machinery. `hookmap-path.ts` (a reader of the JSONPath-lite notation) and
  `render-decision.ts`'s `place` (a WRITER over dotted output paths that creates
  levels) do this. PR #13's review response deliberately kept `render-decision.ts`'s
  copy separate on the grounds that folding it in "would have merged two path
  languages rather than de-duplicating one". **That ruling stands** — do not
  fold `render-decision.ts`'s path-segment check into the value-side walker.
- **Value trees** — refusing a rendered *value* that owns such a key.
  `modifications.ts` and `apply-host-output.ts` do this. These two, plus the
  shared name list, are what this task unifies.

Sharing the three *names* across both jobs is fine and desirable; sharing the
*checks* is not, because they check different things.

### Constraint check

The three names are JavaScript prototype machinery, not any host's field names,
so putting them on the adapter's barrel does not touch R3.2's vocabulary gate.
Confirm by running the suite.

### Verification for Task 3

- The existing prototype-pollution tests on both sides of the seam
  (`hosts/opencode/test/apply-host-output.test.ts` and
  `packages/host-adapter/test/modifications.test.ts`) pass unchanged.
- A test that the shim's refusal now comes from the shared guard.
- Mutation-test: remove a name from the shared list and confirm tests on **both**
  sides fail.

---

## Task 4 — the applier names its host, and reads its own keys

Answers threads 3773262481 (Important · naming symmetry) and 3773262488
(Important · messages over data). Both are in
`hosts/opencode/apply-host-output.ts`; do them together.

### 4a. Name the host (thread 3773262481)

Delivery is the one piece each host owns. Host #1 names itself:
`asClaudeCodeOutput`. This one is called `applyHostOutput` — a generic name —
while knowing four OpenCode keys (`refuse`, `reason`, `args`, `result`), and it
prefixes every error `acs-plugin:` from a *different* file. A later reader will
try to move it into `packages/host-adapter/`, which R3.2 forbids.

Rename to **`applyOpenCodeOutput`**, the twin of `asClaudeCodeOutput`. Fix the
error prefixes to name this module rather than `acs-plugin`. Update
`test/invariants.test.ts` where it names the old symbol (grep — it appears in
both prose and a fixture string), `hosts/opencode/test/apply-host-output.test.ts`,
and every comment naming it across `hosts/`, `docs/`, and `slices/v5/README.md`.

### 4b. Two gates, two messages (thread 3773262488)

`LiveHookObjects = { args?: …; result?: … }` stuffs two gates into one optional
bag, and pass 1 still *asks* `live.args !== undefined` / `live.result !== undefined`
— a **prototype-chain read**, which is the exact class of gap pass 3 already
closed for `output` by moving to `Object.hasOwn`. Pass 1 checking one basis while
pass 3 checks another is the inconsistency; a polluted `Object.prototype.args`
is the hazard the fix already acknowledges.

Reshape to a discriminated union — `{ gate: "request"; args } | { gate: "result"; result }`
— so a gate is *told* which live object it has rather than the applier asking a
bag. If the union genuinely does not fit the two call sites, the fallback the
reviewer offers is two functions (`applyToArgs` / `applyToResult`); either way,
**every remaining presence check on `live` must use `Object.hasOwn`**, matching
pass 1's `Object.keys` basis and pass 3's existing `Object.hasOwn(output, …)`.

The all-or-nothing guarantee — pass 1 validates everything before pass 3 assigns
anything — is load-bearing and must survive the reshape intact. So must the
"a key at a gate that was not handed the live half it targets throws rather than
being skipped" behaviour.

### Verification for Task 4

- Existing `apply-host-output.test.ts` cases pass (renamed as needed).
- A test that a polluted `Object.prototype.args` cannot make the request-gate
  path read a live object it was not handed — the `live`-side twin of the
  existing pass-3 test.
- A test that a `result` key rendered at the request gate still throws naming the
  key.
- Mutation-test the `Object.hasOwn` change on `live`.

---

## Task 5 — CRITICAL: refuse the class of hookmap whose result-gate deny cannot withhold

Answers thread 3773262461 (**Critical** · naming symmetry / SRP). Depends on
Task 4's rename.

### The finding, verified

`assertRefusalRendersUnconditionally` (`hosts/opencode/acs-plugin.ts`) is only
the **request-gate half** of Claude's `assertHostAcceptsEveryDecision`. It skips
any entry without `arguments` (`isRequestGate`), so `tool.execute.after` is never
asked whether `deny` can actually withhold.

Upstream, `assertRenderableDecisions` (the adapter's own load-time check) requires
only a non-empty `output` block. So a result-gate `deny` declaring only
`reason.text` **loads clean**. At runtime the applier's pass 1 skips `reason`,
pass 2a finds no `refuse`, pass 2b writes an `ACS_DEBUG` stderr line at most, and
pass 3 has no `result` to merge: **it applies nothing and throws nothing**, and
the tool's output — the leaf *and* its `metadata.output` mirror — is delivered.

That is the empty-render fail-open closed at the request gate (V5 fix round 1,
Critical 1), one seam later, **on the gate that holds the secret**. The shipped
`opencode.hookmap.yaml` is fine — its result-gate `deny` and `modify` both
declare `result: { from: applied_output }` — but the *class of hookmap* is not
refused at load.

The code's current defence for skipping the result gate is its own doc comment:
"the result gate's own `deny`/`modify` are protected a different way, by
construction (`withResultOutput`, result-output.ts, host-agnostic)". That
guarantee is about the **decision message** carrying a non-empty `applied_output`.
It says nothing about the **hookmap** declaring an output path that lands it. The
comment is wrong and must be corrected, not merely worked around.

### What to build

One per-host table, the same role Claude's `HOOK_EXPECTATIONS` plays, named
**`assertHostHonoursEveryDecision`** — replacing `assertRefusalRendersUnconditionally`:

- **request gate** (an entry declaring `arguments`): `deny`, `ask`, and `defer`
  must each declare an unconditional (`value:`) output field whose **leading
  path segment is `refuse`**. This is the existing check; preserve it exactly,
  including the reasoning in its doc comment about *which key* the unconditional
  field sits under — an unconditional field at `reason.text` or `args.…` renders
  a non-empty block without making the decision a refusal.
- **result gate** (an entry declaring `outputs`): `deny` and `modify` must each
  declare a `result` output field — the only key at that gate that withholds,
  because `applyOpenCodeOutput` merges `result` onto the live object and a throw
  there does not scrub OpenCode's session record.
- A hook the table has no entry for is a **throw, not a skip** — the same rule
  Claude's `expectationFor` states, and for the same reason: an unchecked hook is
  an unchecked fail-open.
- A decision the hookmap does not declare at all is still not this check's
  business (`ask`/`defer` are optional; `assertRenderableDecisions` requires only
  `allow` and `deny`).

Keep the function in `hosts/opencode/` — it is host #2's rule about host #2's
keys, and Global Constraint 1 forbids `refuse`/`result` semantics in the adapter.
The error message must name the hookmap path, the hook, the decision, and what to
add, in the style the existing one already uses.

### Correct the comments this invalidates

At minimum: `assertRefusalRendersUnconditionally`'s own doc comment and
`MUST_RENDER_UNCONDITIONALLY`'s, the "FOUR THINGS EVERY GATE TASK MUST DO" third
bullet in `acs-plugin.ts`'s header (which asserts the result gate needs no
equivalent check), `apply-host-output.ts`'s doc comment on the `refuse` key, and
`opencode.hookmap.yaml`'s own header. Grep for the claim; it is repeated.

### Verification for Task 5

- **A test that the fail-open is real before the gate exists** — a fixture
  hookmap whose result-gate `deny` declares only `reason.text`, driven through
  the applier, showing nothing applied and nothing thrown. This is the test that
  proves the finding rather than assuming it.
- A test that `loadHookmap` + the new gate refuses that same fixture at load.
- A test that the shipped `opencode.hookmap.yaml` passes the gate unchanged.
- A test that a hook the table has no entry for throws.
- Mutation-test: restore the request-gate-only scoping and confirm the new
  result-gate test fails naming the file and the decision.

---

## Task 6 — one exchange, two hook methods

Answers thread 3773262484 (Important · duplication). Do this **last** — it
restructures the code Tasks 4 and 5 touch.

**The finding:** `"tool.execute.before"` and `"tool.execute.after"` in
`hosts/opencode/acs-plugin.ts` perform the same seven moves — validate `tool`,
honour `tools`, validate `sessionID`, assemble the payload, `resolveSessionConfig`,
`governStep`, apply the rendered output. OpenCode's `Plugin` type needs two method
names; it does not need two copies of the exchange. Host #1 already has the better
shape: one `main()`, with the event name read from the payload.

### What to build

One internal `async function handle(hookEventName, payload, live)` (name it as
fits) called from both methods, carrying the seven shared moves. **Payload
assembly stays at the edge** — the two gates genuinely differ there:

- request gate: `args` comes off the mutable `output` object (the only place
  OpenCode puts it at that gate);
- result gate: `args` comes off `input` directly, and `result` is the whole live
  `{title, output, metadata, attachments}` object.

Constraint 4 still binds: `acs-plugin.ts` exports exactly one symbol. `handle`
is module-private, or lives in a new non-exported-from-`acs-plugin.ts` module.

### What must survive verbatim

The two hook methods' doc comments carry measured facts that are **not**
duplication and must not be collapsed away:

- why a throw at `tool.execute.after` does not mean what it means at the request
  gate (OpenCode discards the plugin's mutations and rebuilds `metadata` from its
  own pre-hook copy, so a secret scrubbed by a throw does not stay scrubbed on
  disk);
- why the result gate is scoped `tools: [bash]` (`metadata` is per-tool, measured
  across four tools on OpenCode 1.18.15);
- the missing-`metadata.exit` posture-proceed analysis;
- the two `sessionId` forms (raw for the audit entry, uuid for
  `resolveSessionConfig`) and why mixing them is the bug class the note exists to
  prevent.

Relocate them to where they still describe their subject. Losing one of these to
a refactor would be a worse outcome than the duplication this task removes.

### Verification for Task 6

- Every existing test under `hosts/opencode/test/` passes unchanged.
- The ordering assertions still hold: `assertUsableTool` → tool check →
  `assertUsableSessionId` → payload → session → `governStep` → apply.
- `test/invariants.test.ts`'s one-export gate still passes.
