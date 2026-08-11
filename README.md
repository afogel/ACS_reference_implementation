# ACS Reference Implementation

One wire contract between agent hosts and policy runtimes, so governance integration stops being M×N.

Today every policy vendor writes a module per agent, and every agent waits for a module per vendor. Microsoft's [Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) ships four host packages with four different architectures — a Copilot CLI extension, subprocess hooks for Claude Code and Antigravity, an in-process plugin for OpenCode — and documents the capability divergence between them in its own READMEs.

This repository shows the other shape. A host implements [ACS](https://github.com/Agent-Control-Standard/ACS) once and is governable by any conformant runtime. A runtime implements ACS once and governs any conformant host. This slice (V1) wires one host — Claude Code — to AGT's policy engine running unforked, its stock Rego bundle deciding, entirely over the ACS wire.

## What this proves

**Delivered in V1** — true of this tree today; verifiable by running the commands in Quickstart below.

| Claim | How it is demonstrated |
|---|---|
| AGT's policy engine runs unforked, over the ACS wire | AGT's published policy library decides, used as shipped, at a pinned upstream commit, with no source changes (`agt.lock`, [`test/pin.test.ts`](test/pin.test.ts)) |
| The collapse is structural, not incidental | The host adapter contains no AGT-specific code and the AGT bridge contains no host-specific code — verifiable by reading the file list, and enforced by [`test/invariants.test.ts`](test/invariants.test.ts) |

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

## Quickstart (R7.1 — one command on a laptop)

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
```

Leave it running. `hosts/claude-code/acs-hook.ts` defaults to exactly this URL; override with `ACS_GUARDIAN_URL` if it's listening elsewhere.

**3. Wire the hook into Claude Code.**

```bash
mkdir -p .claude
cp hosts/claude-code/settings.json .claude/settings.json
```

This registers `hosts/claude-code/acs-hook.ts` as a `PreToolUse` hook for the `Bash` tool — the "one hook" of this slice's name.

**4. Run Claude Code with the hook.**

```bash
claude
```

Ask it to run a destructive shell command, e.g. *"Use the Bash tool to run exactly this command: `rm -rf /`"*. The tool call is blocked, with the real policy-engine reasoning surfaced in the transcript — not a canned string, the actual text AGT's stock policy engine produces when it evaluates the pattern it matched. That pattern list is this project's own configuration (`policy/lib/data.json`), not something AGT ships — the stock bundle carries no shell/command patterns of its own, only generic PII regexes; what's stock is the *deciding module* (`agt.patterns`) and the priority chain that consults it, per R2.1 (zero Rego authored). See the framing note in [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md) before narrating this demo. Ask for something harmless (`ls -la`) in the same session and it runs normally. Full walkthrough and what to watch for: [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md).

Steps 1–2 were run against this exact tree to write this README: `bun install` completes clean, and `bun run guardian` prints the line above. Steps 3–4 were verified the same way the project's own tests verify them — piping a Claude Code–shaped `PreToolUse` payload on stdin straight into the hook shim against a running Guardian:

```bash
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"matched pattern ... at offset 0"}}
```

which is exactly the JSON Claude Code's own hook protocol sends and expects back; running `claude` interactively for step 4 exercises the identical path through the real CLI.

### Verify

```bash
bun test          # 76 tests across 12 files (75 pass, 1 skip), including the R3.2/R3.3 gates below
                  # the skip is the byte-identity check, which needs UPSTREAM_BUNDLE — see verify:pin
bun run typecheck # whole-workspace strict TypeScript check, zero errors
```

`bun run verify:pin` additionally re-clones AGT at the pinned ref and byte-diffs the vendored bundle against it (R2.2/R2.3) — it needs network access to GitHub, so it isn't part of the offline quickstart above.

## Status

V1 ("one host, one hook") is implemented: a Claude Code `PreToolUse` hook, a Guardian process serving ACS over HTTP, and AGT's unforked stock policy bundle deciding behind it — see the quickstart above and [`slices/v1/README.md`](slices/v1/README.md). R3.2 and R3.3 (no AGT vocabulary in the host adapter, no host vocabulary in the AGT bridge) are enforced by [`test/invariants.test.ts`](test/invariants.test.ts), not left to inspection. Slices V2–V8 are shaped and sliced but not started; they are tracked as issues on the project board, each with a stacked pull request.

## License

MIT
