# V1 demo runbook: one host, one hook, a real AGT decision

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md`):

> In Claude Code, ask for a destructive shell command. AGT's stock policy denies it; the deny reason appears in the transcript.

**Framing correction (R4.4) — read before you narrate this.** The AGT stock bundle ships **no** shell or command patterns of its own — `patterns.rego` carries generic PII regexes only. What is stock is the *deciding module* (`agt.patterns`) and the priority chain in `agt_default.rego`; the destructive-command regex list this demo denies against is this project's own configuration, supplied as data (`policy/lib/data.json`), not authored Rego. Narrate this as "AGT's stock policy engine, configured" — never as "Microsoft ships an `rm -rf` deny-list." R2.1 still holds exactly: zero Rego authored, behaviour driven only through `data.agt.defaults.config`.

## What a viewer should watch for

1. You ask Claude Code to run a destructive shell command.
2. Claude Code's transcript shows the tool call **blocked**, with a human-readable deny reason — not a generic "permission denied," but the actual text the policy engine produced (something like *"matched pattern `(?i)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/(?:\s|$)` at offset 0"*).
3. That reason did not come from Claude Code, and it did not come from a hardcoded string in the hook shim — it travelled from the AGT bridge's Rego evaluation, through the Guardian's `POST /acs` endpoint, over HTTP, through `guardianClient.post` → `renderDecision`, and into `permissionDecisionReason`. The payoff is that this text is real, not stubbed.
4. Ask for something harmless (e.g. `ls -la`) in the same session and it runs normally — the hook only interrupts what the policy actually denies.

## Prerequisites

- `bun` installed.
- This repo cloned with its submodule: `git clone --recurse-submodules ...` (or `git submodule update --init` after a plain clone).
- `bun install` run once at the repo root.
- The [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI installed and on your `PATH` (`claude`).

## Step 1 — start the Guardian

From the repo root, in its own terminal:

```bash
bun run guardian
```

This starts the Guardian's `POST /acs` JSON-RPC endpoint (`packages/guardian/src/main.ts`), constructing the AGT bridge once at boot against the pinned stock bundle (`policy/lib`, per `agt.lock`) and `policy/manifest.yaml`. It prints the URL it's listening on:

```
Guardian listening at http://localhost:8787/acs
```

Leave this running for the rest of the demo. `hosts/claude-code/acs-hook.ts` defaults to exactly this URL (`http://localhost:8787/acs`); set `ACS_GUARDIAN_URL` if you need the Guardian on a different port.

**What happens if you skip this step, or the Guardian dies mid-demo:** V1 does not implement a considered fail-open/fail-closed posture for an unreachable Guardian (that negotiation is N6/N7, slice V3). The hook shim writes an error to stderr and exits 1 — Claude Code's "non-blocking error" — with nothing on stdout, so the tool call proceeds **ungoverned**, exactly as if the hook had never fired. If the demo's `rm -rf /` unexpectedly seems to go through unblocked, this is the first thing to check.

## Step 2 — wire the hook into Claude Code

`hosts/claude-code/settings.json` registers the shim against `PreToolUse` for the `Bash` tool only (matching `policy/manifest.yaml`'s registered tools — this is the "one hook" of V1's name, not a general-purpose interception of every tool call). Install it as this repo's project-level Claude Code settings:

```bash
mkdir -p .claude
cp hosts/claude-code/settings.json .claude/settings.json
```

(If you already have a `.claude/settings.json` here, merge the `hooks.PreToolUse` block in rather than overwriting.)

The registered command is:

```
bun run "$CLAUDE_PROJECT_DIR/hosts/claude-code/acs-hook.ts"
```

`$CLAUDE_PROJECT_DIR` is Claude Code's own substitution for the project root, so the hook resolves correctly regardless of what directory you're in when you launch `claude`.

## Step 3 — launch Claude Code and ask for the destructive command

From the repo root:

```bash
claude
```

Then ask directly, so Claude actually issues the Bash tool call rather than declining on its own judgment before any hook runs — e.g.:

> Use the Bash tool to run exactly this command: `rm -rf /`

## Step 4 — watch the deny land in the transcript

Claude Code will show the tool call as blocked, with `permissionDecisionReason` surfaced in the transcript UI. It should read close to:

```
matched pattern (?i)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/(?:\s|$) at offset 0
```

This is `data.json`'s `destructive_shell_command_blocked` pattern rule, evaluated for real — not a canned response. (The exact offset/pattern text will track whatever `policy/lib/data.json` configures; the point to watch is that *some* real, specific reasoning text arrives, not a placeholder.)

## Step 5 — contrast with an allowed command

Ask Claude Code to run something harmless with the Bash tool, e.g. `ls -la`. It runs normally with no interruption — the hook fired, the Guardian returned `allow`, and `renderDecision` rendered a plain allow with no reason attached (there is nothing to show, by design — an allow is not a warning).

## Verifying the pieces independently

If the live demo doesn't behave as expected, each layer can be checked in isolation:

```bash
# Guardian reachable and evaluating for real (id and request_id must be
# schema-valid uuids -- the Guardian rejects "1" with a schema error):
curl -s -X POST http://localhost:8787/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"steps/toolCallRequest","id":"22222222-2222-2222-2222-222222222222","params":{"acs_version":"0.1.0","request_id":"22222222-2222-2222-2222-222222222222","timestamp":"2026-01-01T00:00:00Z","metadata":{"agent_id":"claude-code","session_id":"11111111-1111-1111-1111-111111111111"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"rm -rf /"}}}}}'

# The shim itself, fed a real PreToolUse payload directly on stdin:
echo '{"session_id":"demo","transcript_path":"/tmp/t.jsonl","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

The second command is exactly what `hosts/claude-code/test/hook.test.ts` automates: it spawns `acs-hook.ts` as a real subprocess against a real (test-instance) Guardian and asserts `permissionDecision: "deny"` with a non-empty, policy-sourced `permissionDecisionReason` for `rm -rf /`, and `permissionDecision: "allow"` for `ls -la` — both exiting 0.
