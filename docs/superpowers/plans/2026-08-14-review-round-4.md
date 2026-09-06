# Review round 4 — V5 twin names, one adapter seam, and three scaffold name freezes

Source: Sandi Metz re-review, 2026-08-13T18:27Z. Nine unanswered inline threads
(PR #14 ×5, #15 ×1, #16 ×1, #17 ×2) plus one residual stated in PR #14's review
body.

Verdict quoted on #14: *"Metz-ready to stack V6 with three names still to
freeze."* Nothing in this round is a fail-open. Four are twin-role naming, one
is an adapter seam (`tell, don't ask`), one is a store factory wearing its
parent's name, and three are naming commitments to freeze in scaffold READMEs
**before** any implementation exists to invent names at.

## Global Constraints

These bind every task. A task that cannot meet one stops and reports rather
than loosening it.

1. **Host #1's shipped source is +0/−0 for this whole stack.**
   `scripts/verify-zero-diff.sh` pins `hosts/claude-code/[^/]+\.(ts|yaml)$`
   (deliberately excluding `hosts/claude-code/test/`). It must stay clean.
   Any adapter signature change must therefore be backward compatible with
   `acs-hook.ts:662`'s existing call.
2. **Frozen paths**: `packages/guardian/src/`, `packages/agt-bridge/src/`,
   `policy/lib/`, `agt.lock`, `mapping.yaml`, `hosts/claude-code/`.
3. **R3.2 — the adapter names no host output field.** The vocabulary gate in
   `test/invariants.test.ts` bans `permissionDecision`,
   `permissionDecisionReason`, `updatedInput`, `updatedToolOutput`,
   `hookSpecificOutput`, `refuse` in non-test `.ts` under
   `packages/host-adapter/src`.
4. **A rename is not done until every comment naming the old symbol is
   updated.** This codebase's doc comments are load-bearing prose that other
   comments cite by name. `git grep` the old name after the edit; zero hits
   outside `docs/superpowers/` is the bar.
5. **Comments state measured facts.** No line counts, file counts, or diff
   stats — three went stale in three consecutive commits last round, twice
   inside the commit correcting them. A claim that outlived what it described
   is a defect, not cosmetics.
6. **Green bar**: `bun test` (baseline 740 pass / 1 skip / 0 fail — never
   fewer passing), `bun run typecheck`, `bun run verify:zero-diff`,
   `bun run verify:pin`. Use `bun`, never `npm`.
7. **Docs**: each `slices/vN/README.md` declares
   `docs/shaping/acs-reference-impl-slices.md` §VN *authoritative for this
   slice's scope*. A README commitment that contradicts the master doc is a
   contradiction to fix in **both**, and `docs/shaping/acs-reference-impl-shaping.md`
   Detail C (the affordance table and its mermaid graph) must stay in sync.

## Branch layout

Tasks 1–4 land on `slice/v5` (PR #14). Tasks 5, 6, 7 land on `slice/v6`,
`slice/v7`, `slice/v8` respectively. The upper three are rebased onto the new
`slice/v5` tip **after** Task 4 completes and before Task 5 starts.

---

## Task 1 — take Claude's stem for the twin, and name the extracted exchange

Branch: `slice/v5`. Files: `hosts/opencode/acs-plugin.ts` (+ any test naming
these symbols).

Two Important findings, one file, both pure renames.

**1a — `assertHostHonoursEveryDecision` → `assertHostAcceptsEveryDecision`**
(thread `3778055507`, `acs-plugin.ts:1351`).

> The twins now split the verb (`Accepts` vs `Honours`) on a shared
> `assertHost*EveryDecision` stem. A third host will invent a third. Claude is
> frozen +0/−0, so this shim should take Claude's stem. Mechanism difference
> stays in `HOOK_EXPECTATIONS`.

Host #1's `hosts/claude-code/acs-hook.ts:563` already owns
`assertHostAcceptsEveryDecision` and is frozen — so host #2 moves, and the two
hosts end up with same-named functions in two files. That is the intent: one
name for one role, mechanism difference expressed in data
(`HOOK_EXPECTATIONS` on host #1, `CARRIED_AT_REQUEST_GATE` /
`CARRIED_AT_RESULT_GATE` on host #2), not in the verb.

Comments in `acs-plugin.ts` currently distinguish the two by *name* in at
least these places: 64, 169, 189, 260, 912, 1350, 1421, 1706, 1735, plus
`apply-host-output.ts:29` and `:54`. Every one that used the difference in
verb to mean "the other host's" must now say which file it means.

**1b — `handle` → `runExchange`** (thread `3778055513`,
`acs-plugin.ts:1638`).

> The comment is the name: "the one exchange both gates run." `handle` says a
> callback fired. Claude's twin is `main()` — a process entry, correctly
> named. This extracted function is not a program entry. Rename:
> `runExchange` / `governExchange`. Leave `main` on Claude.

Use `runExchange`. Call sites: 1776, 1876.

**Verification**: `bun test`, `bun run typecheck`, `bun run verify:zero-diff`.
`git grep -n 'assertHostHonoursEveryDecision\|function handle\|handle('
hosts/ packages/ test/` returns nothing naming the retired symbols.

---

## Task 2 — one noun per role, and a file named for what it holds

Branch: `slice/v5`. Files: `hosts/opencode/apply-host-output.ts` (renamed),
`hosts/opencode/acs-plugin.ts`, `hosts/opencode/test/apply-host-output.test.ts`
(renamed).

Two Minor findings. Both are naming; neither changes behaviour.

**2a — `LiveHalf` is a second name for `LiveHookObjects`** (thread
`3778055520`, `acs-plugin.ts:1574`).

`acs-plugin.ts:1574` currently reads
`type LiveHalf = Parameters<typeof applyOpenCodeOutput>[1];` — a structural
alias for a type the applier already names. Export `LiveHookObjects` from the
applier (`apply-host-output.ts:226`, currently module-private) and use it
directly at `acs-plugin.ts:1588`. Delete `LiveHalf`.

The doc comment at `acs-plugin.ts:1564-1573` explains *why* the alias existed
(the applier's type was module-private). That reason is gone; the comment goes
with it rather than being reworded to describe a type that is now simply
imported.

**2b — the file is still the generic "host"** (thread `3778055527`,
`apply-host-output.ts:458`).

> Function is now `applyOpenCodeOutput` (twin of `asClaudeCodeOutput`). The
> file is still `apply-host-output.ts` — the generic "host" that invited
> moving this into the adapter. Rename: `apply-opencode-output.ts`.

`git mv hosts/opencode/apply-host-output.ts hosts/opencode/apply-opencode-output.ts`
and `git mv hosts/opencode/test/apply-host-output.test.ts
hosts/opencode/test/apply-opencode-output.test.ts`. Update every import and
every comment citing the path by name (`git grep -n 'apply-host-output'`).

**Verification**: `bun test`, `bun run typecheck`, `bun run verify:zero-diff`.
`git grep -n 'apply-host-output\|LiveHalf'` returns nothing outside
`docs/superpowers/`.

---

## Task 3 — `governStep` is told the tool it was already scoped on

Branch: `slice/v5`. Files: `packages/host-adapter/src/govern-step.ts`,
`hosts/opencode/acs-plugin.ts`, tests.

Thread `3778055539`, `govern-step.ts:339`. Important, `tell, don't ask`, and
the only task in this round with a design decision in it.

> The `tools` rule is in the adapter now — the prior finding is paid.
> Residual: the shim still asks `governsTool` with OpenCode's `input.tool`,
> then `governStep` asks again with whatever `tool_name` resolves. Two
> questions, two sources. The early shim ask is justified (skip handshake).
> The divergence is not: a hookmap that pointed `tool_name` elsewhere used to
> proceed in the shim and return `ungoverned` here. `assertEntryMatchesGate`
> closed that for `$.tool`; a third host copying the two-ask pattern will
> re-open it unless `governStep` is *told* the already-checked tool.

### What is there now

`governStep` (`govern-step.ts:422`) derives the tool itself:

```ts
const scopedTool = toolNameFor(hookmap.hooks[hookEventName], payload);
if (scopedTool !== undefined && !governsTool(hookmap, hookEventName, scopedTool)) {
  return { output: {}, decision: null, stage: "ungoverned" };
}
```

`governsTool`'s own doc comment (`:305-322`) argues *for* the two-source
shape — "ONE RULE, BUT NOT ONE ARGUMENT" — and records the measured fail-open
it produced: with `tool_name: $.args.command` beside `tools: [bash]`, the shim
answered TRUE on `input.tool` and proceeded, `governStep` resolved a different
name, answered FALSE, and returned `ungoverned` — no Guardian request, no
decision, no audit entry, `rm -rf /` through. Today that specific hookmap is
refused at load by host #2's `assertEntryMatchesGate`. The finding is that the
refusal lives in one host's shim, and the pattern that needs it lives in the
adapter.

### The rule to implement

**When the caller has already scoped the step, `governStep` scopes on what it
was told and does not ask a second source.**

1. Add an optional field to `GovernStepInput` (`govern-step.ts:147`) naming
   the tool the caller already checked. `scopedTool` is the suggested name —
   it matches the existing local and the verb `governsTool` uses. Rename the
   local if that collides.
2. When the field is present, that value is what `governsTool` is asked
   about. `toolNameFor` is not consulted for the scoping question. A
   divergence between it and `tool_name` is then no longer a silent skip: the
   step is governed, the envelope is built from `tool_name` as before, and the
   Guardian is asked and audited. A wrong envelope is a different defect,
   already owned by `buildEnvelope` and the hosts' load gates; a silent
   unaudited skip is the one this closes.
3. **When the entry declares a `tools` list and the caller did not tell,
   refuse.** This is what makes the fix structural instead of optional: a
   third host copying the two-ask pattern gets a loud failure rather than the
   old divergence. The fault is decidable from the hookmap entry and the call
   arguments with no payload, so **the throw must not be answerable by the
   negotiated posture** — verify it sits outside the `try` that
   `resolveByPosture` catches, the way the existing hook-entry guard at
   `:459` does. Under `proceed`, a posture-answered throw is an ungoverned
   step, which would make this fix a fail-open of its own.
4. Host #1 declares no `tools` at either gate, so it never reaches (3) and its
   call at `acs-hook.ts:662` stays valid unchanged. That is why the field is
   optional rather than required. `verify-zero-diff` proves it.
5. Host #2's two shim call sites pass `input.tool` through to `governStep`.
6. **`assertEntryMatchesGate` stays.** A load-time refusal beats a runtime
   one, and it still says something this change does not: that host #2's
   hookmap must read the field host #2 feeds. Say so in a comment rather than
   deleting it as now-redundant.

### Measure before you write the rule

Reproduce the fail-open the existing comment records — `tool_name:
$.args.command` beside `tools: [bash]`, driven through `governStep` directly
(bypassing host #2's load gate, which refuses that hookmap) — and record what
`stage`, Guardian call count, and audit event count it produces before and
after. The report states both.

Then update `governsTool`'s doc comment: the "ONE RULE, BUT NOT ONE ARGUMENT"
paragraph and "Nothing here can detect that divergence" are now describing
code that no longer exists. Same for `acs-plugin.ts:283-303` and
`:837`/`:877`/`:1054`.

**Verification**: `bun test`, `bun run typecheck`, `bun run verify:zero-diff`,
`bun run verify:pin`. New tests pin (a) told-tool scoping, (b) the refusal in
(3), (c) that the refusal is not posture-answerable, (d) host #1's untold path
unchanged.

---

## Task 4 — the memory store stops wearing the parent's name

Branch: `slice/v5`. File: `packages/host-adapter/src/session-config.ts` and
its importers.

From PR #14's review body:

> **Residual (body — `session-config.ts` is not in this stacked diff):**
> `createSessionConfigStore` is still the memory factory wearing the parent
> name. Twin of `createFileSessionConfigStore`. Rename
> `createMemorySessionConfigStore`.

`session-config.ts:46` is `createSessionConfigStore` (in-memory);
`session-config.ts:151` is `createFileSessionConfigStore`. The bare name reads
as the general factory and is not.

Rename to `createMemorySessionConfigStore`. Update the barrel
(`packages/host-adapter/src/index.ts:60`) and every importer:
`hosts/opencode/acs-plugin.ts`, `hosts/opencode/test/request-gate.test.ts`,
`hosts/opencode/test/result-gate.test.ts`,
`packages/host-adapter/test/client.test.ts`,
`packages/host-adapter/test/session-config.test.ts`,
`test/handshake-declares-what-it-evaluates.test.ts`.

**`hosts/claude-code/acs-hook.ts` imports `createFileSessionConfigStore` and
the `SessionConfigStore` type — not this symbol.** Confirm that with
`git grep` before editing, and confirm it after with `verify-zero-diff`: this
rename must not touch host #1.

**Where it lands.** The symbol was introduced in `603882b`, on `slice/v1`. It
is not renamed there: rewriting four PRs currently under review to carry a
rename their reviews did not ask for costs more than it buys, and this stack's
own precedent is that an upstack fix is the answer (PR #13's two threads were
answered by V5 commits). It lands on `slice/v5`, where the review that found
it lives, and the reply says so.

**Verification**: `bun test`, `bun run typecheck`, `bun run verify:zero-diff`.
`git grep -n 'createSessionConfigStore'` returns only the new
`createMemorySessionConfigStore` (and nothing outside `docs/superpowers/`).

---

## Task 5 — freeze V6's session vocabulary before a fourth `Session*` object exists

Branch: `slice/v6` (rebased onto the new `slice/v5` tip first). Files:
`slices/v6/README.md`, `docs/shaping/acs-reference-impl-slices.md` §V6 +
index row, `docs/shaping/acs-reference-impl-shaping.md` Detail C rows and
mermaid nodes.

Thread `3778055787`, Important, `public API vocabulary`. Three collisions and
a set of twins, all to be written down before any V6 code exists.

1. **`SessionContext` (ACS hash chain) beside shipped `SessionConfig`
   (handshake store).** Both spec names stay. Neither is ever shortened to
   "session". `SessionContext` does **not** go in `@acs/host-adapter` — it is
   Guardian-side state (R6.2, A3). A prior review already spent a round making
   `SessionConfig` ≠ `ServerHello`; this is the same hazard one object along.
2. **"Carried by ACS provenance" gives AGT's IFC tags the job of ACS
   `Provenance`.** `result_labels` → `input.ifc.source_labels` is an IFC label
   store; ACS `Provenance` is `origin` / `derived_from` and already exists on
   arguments and outputs. Name the label store (`IfcLabels` / `source_labels`).
   If the labels ride a `Provenance` field, the README says so **as a field**,
   not as the store.
3. **`persistResultLabels` (N25) will be heard as "result-gate labels."**
   Rename to `persistIfcLabels`, twinned with `supplySourceLabels` — the two
   halves of the round trip the demo sentence describes.
4. **Twins before code**: `loadSessionContext` ∥ `appendContextEntry`. N22 is
   `appendSessionEntry()` in both shaping docs today, which is asymmetric with
   any `SessionContext` reader; move it to `appendContextEntry()`.
5. **Session state is injected into *both* `assemblePreToolCallSnapshot` and
   `assemblePostToolCallSnapshot`.** Do not reopen N23 as one function that
   asks which point it is.

N22 and N25 appear in `acs-reference-impl-slices.md` (:338, :339),
`acs-reference-impl-shaping.md` (:267, :270) and the mermaid node labels
(:356, :359). All move together — Global Constraint 7.

Add a **"Names frozen before implementation"** section to `slices/v6/README.md`
carrying 1–5, each as a sentence a future implementer can be held to. The
README's `Implementation goes here.` line stays.

---

## Task 6 — V7 says what the master doc already corrected, and names three different things three ways

Branch: `slice/v7` (rebased onto the new `slice/v6` tip). Files:
`slices/v7/README.md`, `docs/shaping/acs-reference-impl-slices.md` §V7 +
index row, `docs/shaping/acs-reference-impl-shaping.md` Detail C.

Thread `3778055923`, Important, `intention-revealing names`.

**6a — the demo sentence reverts a retraction.** `slices/v7/README.md:3` says
*"Eight intervention points by five verdicts, all green."* The master doc
already retracted that, in its own words:

> **⚠️ Demo corrected (was "all green").** … A matrix that must be all green
> to count is a matrix under pressure to redefine the claim, which is the
> opposite of what C2 is for. The demo now asks for every cell *resolved*.

The README is the stale copy. Take the master doc's sentence: *"Eight
intervention points by five AGT verdicts, every cell resolved — green where
ACS v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the
Trace pillar, measured as an explicit non-claim."* Fix the index row at
`acs-reference-impl-slices.md:23` the same way if it still carries the old
sentence.

**6b — "five verdicts" without "AGT".** The columns are AGT
`allow|warn|deny|escalate|transform`, not ACS's five dispositions. Both docs
say "five verdicts"; qualify to "five AGT verdicts" everywhere the 8×5 is
described, and name the enum once in the README.

**6c — the affordance list is short two entries.** The README lists
`U30, U32, N40-N44, N47, N48`. Detail C also carries **U33** (trace-pillar row)
and **N49** (trace-pillar check), both of which the master doc's §V7 body
depends on — "N49 is what turns that table into measured cells rather than this
prose, and U33 renders it." Add both.

**6d — freeze Mapping vs Matrix vs Trace.**
- `Mapping` = S10 data (`mapping.yaml`).
- `MappingTable` = U32's rendering.
- `CoverageMatrix` = U30's measurements.
- The 8×5 is never called a mapping.

**6e — split `renderMatrix`.** N47 is currently one function wired to U30, U31
*and* U33 — coverage cells, upstream diffs, and trace rows are three renderings
of three different measurements. Split into `renderCoverageMatrix` (→ U30),
`renderTraceRows` (→ U33), `renderUpstreamDiff` (→ U31). This contradicts
Detail C's `N47 | renderMatrix()`, so N47's row and the mermaid edges
(`acs-reference-impl-shaping.md:499-501`, `acs-reference-impl-slices.md:367`)
move with it — Global Constraint 7. V8's `diffSurfaces` (N46) then wires to
`renderUpstreamDiff`, not to a shared `renderMatrix`.

Add the same **"Names frozen before implementation"** section to
`slices/v7/README.md`.

---

## Task 7 — `drift` is taken; V8 watches the upstream contract

Branch: `slice/v8` (rebased onto the new `slice/v7` tip). Files:
`slices/v8/README.md`, `docs/shaping/acs-reference-impl-slices.md` §V8 +
index row :24, `docs/shaping/acs-reference-impl-shaping.md` C6 row :162 and
Detail C. Plus PR #17's title.

Two threads, `3778056074` and `3778056084`, both Important.

**7a — the stem** (`slices/v8/README.md:1`):

> `drift` is already a live product noun: `manifest.drift.yaml`, AGT
> `drift_score`, the V3 warn gate. A file named `drift.ts` will be read as
> that gate. Stem: **`upstream`** (`UpstreamDiff`, `fetchUpstreamSurfaces` —
> already good). Slice/UI: "upstream contract watch", not "drift watch".

Rename the slice: **"V8: Upstream contract watch"**. That is the README H1,
the master doc §V8 heading and index row, the shaping doc's C6 row, and PR
#17's title. `fetchUpstreamSurfaces` (N45) and `diffSurfaces` (N46) already
carry the right stem and do not move. U31 is "drift detail" in both shaping
docs — it becomes the surface-diff detail, named for what it renders.

Check whether the V3 `drift` uses (`policy/manifest.drift.yaml`,
`input.annotations.drift_score`) are cited anywhere in V8's docs; those are
the *other* noun and must not be renamed with it.

**7b — a schema change is not a V7 cell** (`slices/v8/README.md:3`):

> A schema/enum change is not a V7 coverage cell (point × AGT verdict). It is
> a `SurfaceDiff`. N46 → N47 stuffing diffs into `renderMatrix` is the same
> bag as V7. Twins: `PinnedSurfaces` ∥ `UpstreamSurfaces`. `diffSurfaces` is
> told two snapshots; it does not ask `agt.lock` to check itself out.

- The demo sentence says *"A changed enum turns a cell red and names the
  field."* A cell is V7's (intervention point × AGT verdict). An enum change
  is a `SurfaceDiff`. Restate the demo in V8's own noun in both the README and
  the master doc.
- Freeze `PinnedSurfaces` (from `agt.lock`, S11) ∥ `UpstreamSurfaces` (fetched
  from `main`, S12) as the twin pair `diffSurfaces` takes.
- `diffSurfaces(pinned, upstream)` is **told** two snapshots. It does not read
  `agt.lock` itself. Write that down; it is the same `tell, don't ask` finding
  as Task 3, one slice early enough to be free.
- N46's output renders through `renderUpstreamDiff` (Task 6e), not
  `renderMatrix`.

Add the same **"Names frozen before implementation"** section to
`slices/v8/README.md`.

---

## After the tasks

Rebase is done incrementally (v6 before Task 5, v7 before Task 6, v8 before
Task 7) so each doc task edits a branch already sitting on its final parent.
Force-push all four with `--force-with-lease`, verify the stack is linear and
every PR still reports `MERGEABLE`, retitle PR #17, then reply in each thread
and post a round summary on #14.
