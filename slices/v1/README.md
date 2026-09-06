# V1: One host, one hook, a real AGT decision

**Demo:** Ask Claude Code for a destructive shell command. AGT's stock policy denies it, and the reason lands in the transcript.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V1 — authoritative for this slice's scope.

**Affordances:** U1, U2, N1-N5, N20, N21, N23, N24, N28, N30, N31, S1, S7-S11, S13 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## What this slice delivers

A single Claude Code `PreToolUse` hook (`hosts/claude-code/acs-hook.ts`) that speaks ACS over the wire to a Guardian process (`packages/guardian`), which evaluates every `steps/toolCallRequest` through AGT's unforked stock policy engine (`packages/agt-bridge`, `policy/lib`) and returns a real decision. The demo above is not staged: `docs/demos/v1-runbook.md` walks through starting the Guardian, wiring the hook into a real `claude` session, and watching a destructive shell command get denied with the policy engine's own reasoning text in the transcript — then contrasts it with a harmless command running normally.

Only `pre_tool_call` is wired; there is no session state, no envelope log, and no second host in this slice (see the watch-for and parked-items rows in the slices doc §V1). The implementation plan this slice followed, task by task, is `docs/superpowers/plans/2026-08-09-v1-one-host-one-hook.md`.
