# V5: Second host, zero AGT changes

**Demo:** Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`, and an unregistered name fails AGT's evaluation closed before any rule runs. `bun run verify:zero-diff` is what proves that claim mechanically rather than by inspection — see [`scripts/verify-zero-diff.sh`](../../scripts/verify-zero-diff.sh).

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V5 — authoritative for this slice's scope.

**Affordances:** U10-U12, N10-N16, S2, S15, S16 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## What this slice delivers

OpenCode 1.18.15 is governed by exactly the same Guardian, the same pinned AGT bundle, and the
same policy configuration as Claude Code, through `packages/host-adapter` — **shared with host #1,
not forked for this one**. Two new artifacts — `hosts/opencode/acs-plugin.ts` (a plugin shim, N10)
and `hosts/opencode/opencode.hookmap.yaml` (S2, this host's own hookmap) — against zero changed
lines anywhere else that matters:
`bun run verify:zero-diff` checks the Guardian, the bridge, `policy/lib`, `agt.lock`,
`mapping.yaml`, and host #1's own wire contract mechanically, not by inspection. The one
deployment-side edit is additive: `policy/manifest.yaml` and `policy/manifest.drift.yaml` each
register `bash` (OpenCode's real, lowercase tool name) as a tool, beside the existing `Bash`/
`run_shell` entries, because AGT resolves the manifest's fixed policy target before any rule runs
and fails closed on a name it has not registered. [`docs/demos/v5-runbook.md`](../../docs/demos/v5-runbook.md)
has the real captured output for every claim on this page, including the envelope pairs as they
crossed the wire and the persisted session record.

OpenCode's plugin API is a different *shape* of host than Claude Code's subprocess-per-hook shim:
one long-lived plugin object, loaded once, whose hooks return `void` and are handed **live,
mutable objects** rather than reading stdin and writing stdout. So the same `governStep` →
`renderDecision` pipeline is **applied** here (`applyOpenCodeOutput`, in `apply-host-output.ts`,
this host's own novel piece) instead of printed — mutating `{args}` at the request gate or `{title,
output, metadata, attachments}` at the result gate, or throwing.

That difference in mechanism is *not* proof that nothing else moved, and it would be false to say
so. `packages/host-adapter/src` changed to make this host work, named by *what* changed rather
than by how many files did: `loadHookmap` gained four new load-time gates beside its original one
and now returns a normalised hookmap rather than the raw YAML parse tree; `exit_status` gained a
second, `from:` form; `outputs.mirrors` was added and is read by the projection side; the modify
path learned to fail closed on a rewrite it cannot land; and `governStep` gained the `tools` skip
both shims share. (No count of any kind is quoted here. An earlier version of this sentence quoted
an insertion/deletion count and it went stale three times in three consecutive commits during this
slice's own review round; retiring it left a *file* count, which went stale inside the same round
the moment `govern-step.ts` was edited. Nothing pins either. Run `git diff --stat slice/v4 HEAD --
packages/host-adapter/src/` for a current one.) What
*is* true, and is the stronger claim R3.4 actually rests on: none of that landed as a per-host
fork. Every change is in `packages/host-adapter/src`, the package **both** hosts run, not in a
copy specific to OpenCode — and host #1's own source (`hosts/claude-code/acs-hook.ts`,
`hosts/claude-code/claude-code.hookmap.yaml`) is **+0/−0**: host #1 gained only two additive test
files, and nothing in its own shipped source changed to make the second host work. That is what
this slice proves — a second host costs no per-host fork of the adapter, not that the adapter
never moved.

Four things had to be measured, not assumed, before this claim could be made honestly — each one
because OpenCode's real behaviour, run rather than read from its documentation, disagreed with
what a reasonable first guess would be:

- **Deny and modify use opposite mechanisms at opposite gates, and getting this backwards would
  have been the obvious mistake.** At the request gate, `output.status = "deny"` and
  `output.decision = "deny"` are measured **accepted and silently ignored** — the only thing that
  actually stops a tool call is throwing out of `tool.execute.before`. At the result gate, throwing
  out of `tool.execute.after` genuinely withholds the output from the model, but OpenCode
  **discards the plugin's mutations on that path** and rebuilds `metadata` from its own pre-hook
  copy — so a secret scrubbed by a throw does not stay scrubbed in OpenCode's own session record.
  So the result gate's deny/modify **replace** the live object instead; only the request gate's
  deny/ask/defer throw.
- **`metadata` mirrors the output leaf, and that mirror can leak a redaction that landed
  correctly.** `tool.execute.after` hands the plugin its own copy of the output at
  `metadata.output`. §V4's central safety property — "every sibling field survives because the
  replacement patches a clone of what the host handed over" — inverts here: preserving a sibling
  preserves the secret. `outputs.mirrors` (a new hookmap field, host-agnostic in the adapter) is
  what closes this, patching the leaf and every declared mirror together in one merge.
- **`metadata` is per-tool, and this gate needed the same scoping host #1 gets for free from its
  matcher.** Measured across four tools: only `bash`'s `metadata` carries `exit`/`output`; `read`'s
  carries `preview` (a *different* mirror, unmentioned here), `grep`'s carries `matches`. OpenCode
  fires the hook for every tool with no matcher, so both gates declare `tools: [bash]` — additive
  data, honoured before any envelope is built. It *was* the shim alone that honoured it, and that
  turned out to be the defect rather than the design: the adapter shape-checked `tools` and had no
  opinion about what it meant, so a third host copied from a shim would load the list and govern
  every tool anyway. The rule now lives in the adapter (`governsTool`, `govern-step.ts`), which
  `governStep` asks before it builds anything; each shim still asks the same function one call
  earlier, where it is the only check early enough to skip the session handshake too.
- **The request gate needed the identical scope, for a different reason.** `policy/manifest.yaml`'s
  fixed policy target is resolved before any authored rule runs, independent of the hookmap; an
  unscoped request gate does not govern every tool, it **denies every tool OpenCode can call** that
  the manifest cannot express a target for. `tools: [bash]` on both gates makes host #1 and host #2
  symmetric — both are `Bash`/`bash`-only, one by an anchored matcher, one by declared data.

## What is explicitly not in this slice

- **`permission.ask` as a real ACS `ask`.** OpenCode has a genuine three-valued decision surface
  (`{status: "ask" | "deny" | "allow"}`), but it fires on permission requests, a different event
  from every tool call — wiring it means a second envelope source and a second hookmap gate. This
  slice maps ACS `ask`/`defer` to the same refusal `deny` gets, fail-closed, and records the
  mapping. A host with a native ask deserves a slice of its own.
- **`modifications.modified_content` at OpenCode's result gate.** This host's own `output.output`
  is an opaque string — precisely the case §V4 said "would have an obvious target for it" — so V7's
  matrix now carries this cell green for OpenCode where it is red for Claude Code. Still not built:
  `mapVerdict` learning to emit `modified_content` is a **Guardian** change, and Global Constraint 1
  freezes `packages/guardian/src` for this slice.
- **`tool.execute.error`.** Not a hook in OpenCode 1.18.15. A failing tool call is ungoverned at
  the result gate on this host, the same shape as V4's un-wired `PostToolUseFailure`.
- **The per-modification landing check V4 parked.** Both hosts now run through the same shared
  adapter code, unchanged — which is this slice's whole claim — so the gap V4 measured and did not
  fix (a `modify` reported as applied when only part of it landed) is inherited, not repeated, and
  is no longer one host's alone to carry.
- **Session state and provenance carriage** — V6, unchanged.
- **An OpenCode-specific Inspector view.** `bun run inspector` is host-agnostic already and tails
  whatever `.acs/envelopes.jsonl` any host's Guardian writes to; R5.2's own gate would forbid
  naming a host inside it.
- **A mirror scan that tells "holds the same value" apart from "is a copy of the leaf".** The
  survivor scan `outputs.mirrors` runs closes the fail-open Task 2 measured (risk row 17) by asking
  two questions instead of one — every *declared* mirror received the replacement, and no other
  field still holds the original — but the second question is still the same value-equality
  inference, narrowed rather than removed. On a host that declares mirrors at all, which is host
  #2, this slice's own subject, an unrelated sibling inside `outputs.within` that happens to equal
  the leaf's value is refused as a blocking stop, with no audit entry — pinned as a deliberate
  over-refusal on the safe side, not claimed away. Two further limits: the scan walks only the
  clone of `outputs.within`, so a duplicate the host keeps outside that container is invisible
  regardless of how it is declared, and an undeclared mirror on a host declaring none is not
  detectable at all. All three are the hookmap author's to get right; V7's matrix carries the cells.

The implementation plan this slice followed, task by task, is
[`docs/superpowers/plans/2026-08-12-v5-second-host.md`](../../docs/superpowers/plans/2026-08-12-v5-second-host.md).
