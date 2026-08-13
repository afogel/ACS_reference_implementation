# V5: Second host, zero AGT changes

**Demo:** Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`, and an unregistered name fails AGT's evaluation closed before any rule runs. `bun run verify:zero-diff` is what proves that claim mechanically rather than by inspection — see [`scripts/verify-zero-diff.sh`](../../scripts/verify-zero-diff.sh).

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V5 — authoritative for this slice's scope.

**Affordances:** U10-U12, N10-N16, S2, S15, S16 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## What this slice delivers

OpenCode 1.18.15 is governed by exactly the same Guardian, the same pinned AGT bundle, and the
same policy configuration as Claude Code, through `packages/host-adapter`, **unchanged**. Two new
artifacts — `hosts/opencode/acs-plugin.ts` (a plugin shim, N10) and `hosts/opencode/opencode.hookmap.yaml`
(S2, this host's own hookmap) — against zero changed lines anywhere else that matters:
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
`renderDecision` pipeline is **applied** here (`applyHostOutput`, this file's own novel piece)
instead of printed — mutating `{args}` at the request gate or `{title, output, metadata,
attachments}` at the result gate, or throwing. That difference in mechanism is exactly what
proves the claim: nothing about `buildEnvelope`, `renderDecision`, `governStep`, the hookmap
format, or any load-time check changed to make it work.

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
  data the shim honours before building any envelope, not a change to the adapter.
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

The implementation plan this slice followed, task by task, is
[`docs/superpowers/plans/2026-08-12-v5-second-host.md`](../../docs/superpowers/plans/2026-08-12-v5-second-host.md).
