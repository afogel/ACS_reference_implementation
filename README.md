# ACS Reference Implementation

One wire contract between agent hosts and policy runtimes, so governance integration stops being M×N.

Today every policy vendor writes a module per agent, and every agent waits for a module per vendor. Microsoft's [Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) ships four host packages with four different architectures — a Copilot CLI extension, subprocess hooks for Claude Code and Antigravity, an in-process plugin for OpenCode — and documents the capability divergence between them in its own READMEs.

This repository shows the other shape. A host implements [ACS](https://github.com/Agent-Control-Standard/ACS) once and is governable by any conformant runtime. A runtime implements ACS once and governs any conformant host. V1 wires one host — Claude Code — to AGT's policy engine running unforked, its stock Rego bundle deciding, entirely over the ACS wire. V2 makes that wire visible: every envelope crossing it is tapped to a log and rendered live by `bun run inspector`.

## What this proves

**Delivered in V1** — true of this tree today; verifiable by running the commands in Quickstart below.

| Claim | How it is demonstrated |
|---|---|
| AGT's policy engine runs unforked, over the ACS wire | AGT's published policy library decides, used as shipped, at a pinned upstream commit, with no source changes (`agt.lock`, [`test/pin.test.ts`](test/pin.test.ts)) |
| The collapse is structural, not incidental | The host adapter contains no AGT-specific code and the AGT bridge contains no host-specific code — verifiable by reading the file list, and enforced by [`test/invariants.test.ts`](test/invariants.test.ts) |

**Delivered in V2** — the Envelope Inspector.

| Claim | How it is demonstrated |
|---|---|
| R5.1 — every hook firing is inspectable as an ACS envelope, in both directions, including envelopes that fail validation | The Guardian taps every envelope crossing its wire to `.acs/envelopes.jsonl` before validation, and `bun run inspector` renders it live ([`test/envelope-tap-roundtrip.test.ts`](test/envelope-tap-roundtrip.test.ts), [`packages/guardian/test/envelope-tap-wiring.test.ts`](packages/guardian/test/envelope-tap-wiring.test.ts)) |
| R5.2 — an ACS-first reader can trace one action end to end without reading AGT source | The Inspector imports nothing from the Guardian or the AGT bridge and names neither AGT nor any host — enforced by two gates in [`test/invariants.test.ts`](test/invariants.test.ts) |

**Planned, not yet built** — the rest of the claim this project is working toward. None of the following exists yet, and there is no CI in this repository at all.

| Claim | Slice |
|---|---|
| AGT is completely expressible in ACS: a machine-checked mapping of all eight intervention points and five verdicts, with a round-trip conformance case per cell | V7 |
| The same policy governs two structurally different coding agents, with the second host costing zero added AGT code | V5 |
| A scheduled harness run against AGT `main` catches upstream drift automatically | V8 |

## Layout

```
docs/shaping/     Shaping doc, slice plan, and the AGT integration spike
spec/acs/         The ACS specification, pinned as a submodule
```

The shaping doc is authoritative for requirements, shapes, and the breadboard. The slices doc is authoritative for slice definitions. GitHub issues point at them and never restate them.

## Clone

```bash
git clone --recurse-submodules https://github.com/afogel/ACS_reference_implementation
```

## Quickstart (R7.1 — starts with one command on a laptop)

Requires [`bun`](https://bun.sh) and the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`) on your `PATH`.

**1. Install.**

```bash
bun install
```

**2. Start the Guardian.** In its own terminal, from the repo root:

```bash
bun run guardian
```

This constructs the AGT bridge once, against the pinned stock policy bundle (`policy/lib`, per `agt.lock`), and serves ACS's `POST /acs` JSON-RPC endpoint:

```
Guardian listening at http://localhost:8787/acs
Envelope log (S6): .acs/envelopes.jsonl
```

Leave it running. `hosts/claude-code/acs-hook.ts` defaults to exactly this URL; override with `ACS_GUARDIAN_URL` if it's listening elsewhere.

**3. Start the Envelope Inspector.** In a second terminal, after the Guardian (which is what creates `.acs/`):

```bash
bun run inspector
```

```
Envelope Inspector — tailing .acs/envelopes.jsonl
Ctrl-C to stop.
```

Every ACS envelope crossing the Guardian's wire is printed here as it happens — request and response, with a decision badge on responses:

```
── #2  20:44:33.130  ← RESPONSE  steps/toolCallRequest  id=e491180d-60a8-4982-b693-e63771c00e2d
● DENY  reason_codes=[destructive_shell_command_blocked]  policy_references=[agt_stock#destructive_shell_command_blocked]
```

`bun run inspector -- --from-start` replays a session already recorded. **`.acs/envelopes.jsonl` records each envelope the Guardian parsed, unmodified: nothing stripped, nothing redacted. So it carries raw tool arguments** — it is gitignored for that reason and never committed. Full walkthrough, with the real captured output for a deny, an allow, and a schema-invalid envelope: [`docs/demos/v2-runbook.md`](docs/demos/v2-runbook.md).

**4. Wire the hook into Claude Code.**

```bash
mkdir -p .claude
cp hosts/claude-code/settings.json .claude/settings.json
```

This registers `hosts/claude-code/acs-hook.ts` as a `PreToolUse` hook for the `Bash` tool — the "one hook" of V1's name.

**5. Run Claude Code with the hook.**

```bash
claude
```

Ask it to run a destructive shell command, e.g. *"Use the Bash tool to run exactly this command: `rm -rf /`"*. The tool call is blocked, with the real policy-engine reasoning surfaced in the transcript — not a canned string, the actual text AGT's stock policy engine produces when it evaluates the pattern it matched. That pattern list is this project's own configuration (`policy/lib/data.json`), not something AGT ships — the stock bundle carries no shell/command patterns of its own, only generic PII regexes; what's stock is the *deciding module* (`agt.patterns`) and the priority chain that consults it, per R2.1 (zero Rego authored). See the framing note in [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md) before narrating this demo. Ask for something harmless (`ls -la`) in the same session and it runs normally. Full walkthrough and what to watch for: [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md); with the Inspector running you also see both envelopes as they cross the wire.

Watch the Inspector, not just the transcript, if the deny does not appear: the model may decline to issue the tool call at all on its own judgment, in which case no hook fires and the envelope log stays empty. And if you are scripting this rather than watching it, use `echo rm -rf /` as the payload — it matches the same pattern at offset 5 and is inert if it ever did execute, whereas an unattended `rm -rf /` is only safe for as long as the hook works, which is the thing under test.

**What was actually run against this tree to write this quickstart.** Steps 1–3 were run end to end: `bun install` completes clean, `bun run guardian` prints both lines above, and `bun run inspector` rendered every envelope quoted here — the badge line above is pasted from that run, not composed. Steps 4–5 were run twice, two different ways.

First, by piping a Claude Code–shaped `PreToolUse` payload on stdin straight into the hook shim against a running Guardian — the same way the project's own tests verify it. The shim never executes the command; it only asks the Guardian for a decision:

```bash
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0"}}
```

Second, through the real `claude` CLI with `.claude/settings.json` installed — Claude Code spawning `acs-hook.ts` as an actual `PreToolUse` subprocess and honouring the decision. That run was **headless** (`claude -p '<prompt>' --allowedTools Bash`), not an interactive TUI session, and the payload was `echo rm -rf /` rather than `rm -rf /`: the configured pattern matches the raw command string with no argv parse, so it is denied by the same rule at offset 5 while being inert if it ever did execute. An unattended `rm -rf /` is only safe for as long as the hook works, which is the thing under test. The interactive TUI session was not run, so nothing here describes how the TUI renders the block. See [`docs/demos/v2-runbook.md`](docs/demos/v2-runbook.md) for the full captured output of both.

### Verify

```bash
bun test          # 134 tests across 16 files (133 pass, 1 skip), including the R3.2/R3.3
                  # and R5.1/R5.2 gates below
                  # the skip is the byte-identity check, which needs UPSTREAM_BUNDLE — see verify:pin
bun run typecheck # whole-workspace strict TypeScript check, zero errors
```

`bun run verify:pin` additionally re-clones AGT at the pinned ref and byte-diffs the vendored bundle against it (R2.2/R2.3) — it needs network access to GitHub, so it isn't part of the offline quickstart above.

## Status

V1 ("one host, one hook") is implemented: a Claude Code `PreToolUse` hook, a Guardian process serving ACS over HTTP, and AGT's unforked stock policy bundle deciding behind it — see the quickstart above and [`slices/v1/README.md`](slices/v1/README.md).

V2 ("Envelope Inspector") is implemented: the Guardian taps every ACS envelope crossing its wire to `.acs/envelopes.jsonl`, and `bun run inspector` tails and renders it live — see [`slices/v2/README.md`](slices/v2/README.md) and [`docs/demos/v2-runbook.md`](docs/demos/v2-runbook.md). One boundary worth stating up front: a schema-invalid envelope surfaces as a JSON-RPC **error**, not a `deny` decision. `N27 denyOnInvalidEnvelope()`, which turns Guardian-side failures into honoured ACS decisions, is V3.

Four of this project's architectural claims are enforced by [`test/invariants.test.ts`](test/invariants.test.ts) rather than left to inspection: R3.2 and R3.3 (no AGT vocabulary in the host adapter, no host *output* vocabulary in it either, and no host vocabulary in the AGT bridge), and R5.1 and R5.2 (the Inspector imports nothing from the Guardian or the AGT bridge, and names neither AGT nor any host).

Slices V3–V8 are shaped and sliced but not started; they are tracked as issues on the project board, each with a stacked pull request.

## License

MIT
