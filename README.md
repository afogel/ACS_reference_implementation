# ACS Reference Implementation

One wire contract between agent hosts and policy runtimes, so governance integration stops being M×N.

Today every policy vendor writes a module per agent, and every agent waits for a module per vendor. Microsoft's [Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) ships four host packages with four different architectures — a Copilot CLI extension, subprocess hooks for Claude Code and Antigravity, an in-process plugin for OpenCode — and documents the capability divergence between them in its own READMEs.

This repository shows the other shape. A host implements [ACS](https://github.com/Agent-Control-Standard/ACS) once and is governable by any conformant runtime. A runtime implements ACS once and governs any conformant host. V1 wires one host — Claude Code — to AGT's policy engine running unforked, its stock Rego bundle deciding, entirely over the ACS wire. V2 makes that wire visible: every envelope crossing it is recorded to a log and rendered live by `bun run inspector`.

## What this proves

**Delivered in V1** — true of this tree today; verifiable by running the commands in Quickstart below.

| Claim | How it is demonstrated |
|---|---|
| AGT's policy engine runs unforked, over the ACS wire | AGT's published policy library decides, used as shipped, at a pinned upstream commit, with no source changes (`agt.lock`, [`test/pin.test.ts`](test/pin.test.ts)) |
| The collapse is structural, not incidental | The host adapter contains no AGT-specific code and the AGT bridge contains no host-specific code — verifiable by reading the file list, and enforced by [`test/invariants.test.ts`](test/invariants.test.ts) |

**Delivered in V2** — the Envelope Inspector.

| Claim | How it is demonstrated |
|---|---|
| R5.1 — every hook firing is inspectable as an ACS envelope, in both directions, including envelopes that fail validation | The Guardian records every envelope crossing its wire to `.acs/envelopes.jsonl` before validation, and `bun run inspector` renders it live ([`test/envelope-log-sink-roundtrip.test.ts`](test/envelope-log-sink-roundtrip.test.ts), [`packages/guardian/test/envelope-log-sink-wiring.test.ts`](packages/guardian/test/envelope-log-sink-wiring.test.ts)) |
| R5.2 — an ACS-first reader can trace one action end to end without reading AGT source | The Inspector imports nothing from the Guardian or the AGT bridge and names neither AGT nor any host — enforced by two gates in [`test/invariants.test.ts`](test/invariants.test.ts) |

**Delivered in V3** — all five AGT verdicts, live over the wire, and both failure postures.

| Claim | How it is demonstrated |
|---|---|
| R1.2 — AGT's five verdicts (`allow`, `deny`, `escalate`, `transform`, `warn`) all arrive over the ACS wire as real decisions, driven only from `data.agt.defaults.config` over the pinned, unforked bundle — including `warn` arriving as `allow` with a **non-empty** `policy_references`, the only thing distinguishing it from a clean allow | [`test/dispositions.test.ts`](test/dispositions.test.ts) drives all five through a live Guardian; [`docs/demos/v3-runbook.md`](docs/demos/v3-runbook.md) has the real captured output for each, with the exact `data.json` diff that produced it |
| R1.6 — a `transform` verdict's rewrite lands as the host's actual rewritten tool argument, not merely a reported one | `mapVerdict` synthesizes `modifications` from AGT's `transform` **per intervention point** — `parameter_overrides` keyed by argument name at the request gate, `redactions` at the result gate V4 added, because the two gates edit different documents (a point with no synthesis rule cannot express a transform at all, and `mapVerdict` throws rather than emitting an empty one); the host adapter's `applyModifications` (N7) applies either ([`packages/guardian/test/map-verdict.test.ts`](packages/guardian/test/map-verdict.test.ts), [`packages/host-adapter/test/modifications.test.ts`](packages/host-adapter/test/modifications.test.ts)) |
| R1.5/§6.4 — an AGT `deny` verdict is always honoured regardless of the negotiated failure posture, and a Guardian-side failure (schema, or evaluation itself throwing) never slips through as a bare, unaudited error | `N27 denyOnInvalidEnvelope()` turns both failure classes into honoured `deny` decisions instead ([`packages/guardian/test/server.test.ts`](packages/guardian/test/server.test.ts), [`packages/guardian/test/deny-on-invalid-envelope.test.ts`](packages/guardian/test/deny-on-invalid-envelope.test.ts)) |
| §6.4's MUST — every fail-open `proceed` taken when no decision arrives at all is audited, and the failure posture is negotiated per session rather than hardcoded | `applyFailurePosture` (N6) + a file-backed, cross-process session store (S13) + the audit sink (S14); `bun run inspector` renders the last posture an audit entry carried and an exact count of audited fail-open proceeds (U23, N51) — [`hosts/claude-code/test/posture.test.ts`](hosts/claude-code/test/posture.test.ts) |

**Delivered in V4** — tool output redacted on a host whose own AGT package scopes that capability out.

| Claim | How it is demonstrated |
|---|---|
| R3.8 — a capability AGT's own Claude Code package does not claim is reachable through the contract: a secret-bearing `Bash` result comes back redacted by AGT's stock `redact` rule, in the tool's own output shape, with every sibling field intact | `PostToolUse` → `steps/toolCallResult` → an AGT `transform` → ACS `modifications.redactions` → `updatedToolOutput`, over the same pinned bundle with zero Rego authored ([`hosts/claude-code/test/post-tool-use.test.ts`](hosts/claude-code/test/post-tool-use.test.ts) drives the real shim against a real Guardian; [`docs/demos/v4-runbook.md`](docs/demos/v4-runbook.md) has the real captured output, the envelope pair, and the AGT sentence quoted in full at the pinned ref) |
| A modification this host cannot apply is refused, and the refusal actually withholds | `modified_content`, and a redaction that never reaches the leaf this gate projects, both become `decision: block` **plus** a shape-preserving `updatedToolOutput` — `block` alone suppresses nothing once the tool has run ([`packages/host-adapter/test/validate-decision.test.ts`](packages/host-adapter/test/validate-decision.test.ts), and the runbook's captures) |
| The handshake declares exactly what the Guardian enforces — so a new gate cannot be added without the wire saying so | A candidate envelope for every method `mapping.yaml` maps is driven through a live Guardian, and the set it does not answer `method_not_dispatched` for must equal the ServerHello's `methods_evaluated` — equality in both directions, since over-declaring claims enforcement that does not exist ([`test/handshake-declares-what-it-evaluates.test.ts`](test/handshake-declares-what-it-evaluates.test.ts)) |

What V4 does **not** deliver, stated here because the demo is easy to over-read: the redaction reaches the model **unexplained**. The hookmap's `modify` entry carries a reason field and it works, but the pinned bundle's redaction verdict sends no text for it — `mapping.yaml` sources `reasoning` from `verdict.message` and `policy/lib/redact.rego` emits none. Four more findings V4 measured and recorded rather than fixed are listed in [`slices/v4/README.md`](slices/v4/README.md).

**Planned, not yet built** — the rest of the claim this project is working toward. None of the following exists yet, and there is no CI in this repository at all.

| Claim | Slice |
|---|---|
| A machine-checked mapping of all eight intervention points and five verdicts, with a round-trip conformance case per cell — every cell resolved, green where ACS v0.1.0 expresses AGT and red with a named reason where it does not. Four are already known red: the two model-call points have no v0.1.0 hook, and two attributes the Trace pillar marks required have no source on the wire | V7 |
| Which ACS profiles and pillars this implementation claims, and which it does not — the matrix is the declaration. Trace is a measured non-claim, not a silence | V7 |
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
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
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

This registers `hosts/claude-code/acs-hook.ts` against **two** of Claude Code's hook events, both running the same command: `PreToolUse` — the "one hook" of V1's name, which decides whether the call runs — and `PostToolUse` (added by V4), which sees what the call produced and can redact it before the model does.

Both entries are scoped to the `Bash` tool, and the matcher is written **anchored**: `^Bash$`, not `Bash`. That scopes the hook to a tool `policy/manifest.yaml` registers rather than intercepting every tool call. The anchor is load-bearing, and what it buys is that a question nobody here has verified stops mattering: `matcher` is a regular expression, so whether a bare `Bash` would *also* select `BashOutput` and `KillShell` depends on matching semantics this project has not measured — and `^Bash$` selects exactly one tool either way, `Bash`. Precisely, because the sentence before it names the file: `policy/manifest.yaml` registers **two** tools, `Bash` and `run_shell`, and only the first is a name Claude Code ever sends. `run_shell` is AGT's own stock example name, kept for the bridge and Guardian fixtures written against it — the manifest says so at `policy/manifest.yaml:82-91`. [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md) Step 2 states what the unanchored form would have exposed, and what the second entry changes about a live session.

**5. Run Claude Code with the hook.**

```bash
claude
```

Ask it to run a destructive shell command, e.g. *"Use the Bash tool to run exactly this command: `rm -rf /`"*. The tool call is blocked, with the real policy-engine reasoning surfaced in the transcript — not a canned string, the actual text AGT's stock policy engine produces when it evaluates the pattern it matched. That pattern list is this project's own configuration (`policy/lib/data.json`), not something AGT ships — the stock bundle carries no shell/command patterns of its own, only generic PII regexes; what's stock is the *deciding module* (`agt.patterns`) and the priority chain that consults it, per R2.1 (zero Rego authored). See the framing note in [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md) before narrating this demo. Ask for something harmless (`ls -la`) in the same session and it runs normally. Full walkthrough and what to watch for: [`docs/demos/v1-runbook.md`](docs/demos/v1-runbook.md); with the Inspector running you also see the envelopes as they cross the wire. Since V4 registered the result gate, an **allowed** `Bash` call produces four of them — a `steps/toolCallRequest` and its decision before the command runs, then a `steps/toolCallResult` and its decision after — while a denied one produces the first pair only, because the command never runs.

Watch the Inspector, not just the transcript, if the deny does not appear: the model may decline to issue the tool call at all on its own judgment, in which case no hook fires and the envelope log stays empty. And if you are scripting this rather than watching it, use `echo rm -rf /` as the payload — it matches the same pattern at offset 5 and is inert if it ever did execute, whereas an unattended `rm -rf /` is only safe for as long as the hook works, which is the thing under test.

**What was actually run against this tree to write this quickstart.** Steps 1–3 were run end to end: `bun install` completes clean, `bun run guardian` prints all three lines above, and `bun run inspector` rendered every envelope quoted here — the badge line above is pasted from that run, not composed. Steps 4–5 were run twice, two different ways. (The Guardian's third startup line and the `PreToolUse` capture below were re-taken during V4; the third line arrived with V3's negotiated posture and this paragraph had gone on claiming two.)

First, by piping a Claude Code–shaped `PreToolUse` payload on stdin straight into the hook shim against a running Guardian — the same way the project's own tests verify it. The shim never executes the command; it only asks the Guardian for a decision:

```bash
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0"}}
```

Second, through the real `claude` CLI with `.claude/settings.json` installed — Claude Code spawning `acs-hook.ts` as an actual `PreToolUse` subprocess and honouring the decision. That run was **headless** (`claude -p '<prompt>' --allowedTools Bash`), not an interactive TUI session, and the payload was `echo rm -rf /` rather than `rm -rf /`: the configured pattern matches the raw command string with no argv parse, so it is denied by the same rule at offset 5 while being inert if it ever did execute. An unattended `rm -rf /` is only safe for as long as the hook works, which is the thing under test. The interactive TUI session was not run, so nothing here describes how the TUI renders the block. See [`docs/demos/v2-runbook.md`](docs/demos/v2-runbook.md) for the full captured output of both.

### Configuration

Everything above runs with no configuration at all. These are the environment
variables the three processes read, each with the default it falls back to —
the quickstart uses every default.

**The host shim** (`hosts/claude-code/acs-hook.ts`, run by Claude Code as a
subprocess per hook):

| Variable | Default | What it does |
|---|---|---|
| `ACS_GUARDIAN_URL` | `http://localhost:8787/acs` | Where the shim POSTs its ACS envelopes. Matches the Guardian's own default port, so neither hardcodes the other |
| `ACS_SESSION_DIR` | `.acs/sessions` | Where the negotiated ServerHello (S13) is filed, one JSON file per host `session_id`, so a fresh hook subprocess finds the posture a previous one negotiated |
| `ACS_AUDIT_LOG` | `.acs/audit.jsonl` | Where the audit sink (S14) appends every fail-open proceed and every posture-driven block — §6.4's MUST |
| `ACS_HOOKMAP_PATH` | `hosts/claude-code/claude-code.hookmap.yaml` | **Repoints the governance mapping itself.** The hookmap decides which ACS method each hook fires and how each ACS decision renders as a Claude Code `permissionDecision`, so this variable changes what governance *means* for this host, not merely where a file lives. It exists for tests that need a deliberately broken hookmap; a deployment should leave it unset |

**The Guardian** (`bun run guardian`):

| Variable | Default | What it does |
|---|---|---|
| `ACS_ON_DECISION_FAILURE` | `proceed` | The failure posture this deployment declares in its ServerHello — what a host should do when *no decision arrives at all*. `proceed` is the ACS default (R1.7, `handshake.json`'s own `default`); `deny` fails closed. Any other value **throws at startup** rather than falling back, because guessing which posture a typo meant is the silent bypass this project exists to remove |
| `ACS_GUARDIAN_PORT` | `8787` | Port for the `POST /acs` JSON-RPC endpoint |
| `ACS_MANIFEST_PATH` | `policy/manifest.yaml` | The AGT manifest, which names the policy bundle and any annotators. `policy/manifest.drift.yaml` is the second one V3 added to make `warn` reachable |
| `ACS_ENVELOPE_LOG` | `.acs/envelopes.jsonl` | Where the envelope log sink (S6) records every envelope crossing the wire, in both directions, before validation |

**The Inspector** (`bun run inspector`): reads `ACS_ENVELOPE_LOG` and
`ACS_AUDIT_LOG` with the same defaults, and both are overridable on the
command line (`--envelope-log`, `--audit-log`), which takes precedence. It also
honours the conventional `NO_COLOR`, and colours nothing when stdout is not
a TTY.

### Verify

```bash
bun test          # 606 tests across 39 files (605 pass, 1 skip), including the R3.2/R3.3
                  # and R5.1/R5.2 gates below
                  # the skip is the byte-identity check, which needs UPSTREAM_BUNDLE — see verify:pin
bun run typecheck # whole-workspace strict TypeScript check, zero errors
```

`bun run verify:pin` additionally re-clones AGT at the pinned ref and byte-diffs the vendored bundle against it (R2.2/R2.3) — it needs network access to GitHub, so it isn't part of the offline quickstart above.

`bun run verify:zero-diff` proves R3.4 mechanically: adding V5's second host cost zero changed lines under the Guardian, the AGT bridge, `policy/lib` (the pinned bundle), `agt.lock`, `mapping.yaml`, or host #1's own wire contract (`hosts/claude-code/acs-hook.ts`, `hosts/claude-code/claude-code.hookmap.yaml`) — checked against both the committed diff and the working tree, against a base ref that defaults to `slice/v4` (pass one explicitly once that branch is gone). See [`scripts/verify-zero-diff.sh`](scripts/verify-zero-diff.sh) and [`slices/v5/README.md`](slices/v5/README.md) for what it proves and why it's a script rather than a `bun test`.

## Status

V1 ("one host, one hook") is implemented: a Claude Code `PreToolUse` hook, a Guardian process serving ACS over HTTP, and AGT's unforked stock policy bundle deciding behind it — see the quickstart above and [`slices/v1/README.md`](slices/v1/README.md).

V2 ("Envelope Inspector") is implemented: the Guardian records every ACS envelope crossing its wire to `.acs/envelopes.jsonl`, and `bun run inspector` tails and renders it live — see [`slices/v2/README.md`](slices/v2/README.md) and [`docs/demos/v2-runbook.md`](docs/demos/v2-runbook.md). One boundary worth stating up front: a schema-invalid `steps/*` envelope now surfaces as an honoured `deny` **decision**, not a bare JSON-RPC error — `N27 denyOnInvalidEnvelope()` (V3) turns a Guardian-side failure (bad schema, or evaluation itself throwing) into a decision the host's decision path honours regardless of its negotiated failure posture. That boundary still has real edges, though: a JSON parse failure and an envelope that names neither a `params.request_id` nor a usable JSON-RPC `id` stay bare JSON-RPC errors, since there is no envelope, or no request to address a decision to, either way.

**Seven** of this project's architectural claims are enforced by [`test/invariants.test.ts`](test/invariants.test.ts) rather than left to inspection: R3.2 and R3.3 (no AGT vocabulary in the host adapter, no host *output* vocabulary in it either, and no host vocabulary in the AGT bridge), R5.1 and R5.2 (the Inspector imports nothing from the Guardian, the AGT bridge, or the host adapter, and names neither AGT nor any host), R3.2 from the host's own side (a host shim imports the adapter only), and R3.2 once more from host #2's own side (the adapter names no OpenCode field either — V5's gate). That is the whole suite as it stands, not the subset that existed when this paragraph was first written — the gates are one file, and the paragraph after V3 below says which of the seven that slice contributed.

V3 ("all five dispositions, and both failure postures") is implemented: AGT's five verdicts (`allow`, `deny`, `escalate`, `transform`, `warn`) all arrive over the ACS wire as real decisions, driven only from `data.agt.defaults.config` over the same pinned, unforked bundle — see [`slices/v3/README.md`](slices/v3/README.md) and [`docs/demos/v3-runbook.md`](docs/demos/v3-runbook.md) for the real captured output, one section per verdict, with the exact `data.json` diff behind each. `escalate` and `transform` needed only configuration (`data.agt.defaults.config`) against V1's own manifest, unchanged; `warn` needed one more thing — a manifest-declared annotator, dispatched through the SDK's `annotatorDispatcher` — because `input.annotations` never reaches policy input from the ACS snapshot itself. That annotator lives in a second, separate manifest ([`policy/manifest.drift.yaml`](policy/manifest.drift.yaml)); `policy/manifest.yaml` is untouched, so nothing about V1's or V2's existing behaviour changed. Also delivered: a negotiated, file-backed failure posture (`applyFailurePosture`, N6) that resolves what happens when no decision arrives at all — Guardian silent, transport dead, no usable response — auditing every fail-open `proceed` (S14), kept structurally separate from an AGT `deny` verdict, which is always honoured regardless of posture (R1.5).

`.acs/` now holds three kinds of local artifact, all gitignored and none ever committed: the envelope log (`envelopes.jsonl`, S6, V2), the audit sink (`audit.jsonl`, S14, V3) recording every fail-open proceed and every posture-driven block, and the negotiated per-session config (`sessions/<session_id>.json`, S13, V3) that lets a fresh hook subprocess find the posture a previous one negotiated. `bun run inspector` tails **two** of them — the envelope log and the audit log — and derives its posture badge (U23, N51) from the second: the last posture an audit entry carried, plus a running count of audited fail-open proceeds. Nothing opens `.acs/sessions/`.

**The two logs cannot be joined on `session_id`.** The audit log records the host's own raw session identifier — the same key the session config is filed under — while an envelope carries `metadata.session_id`, which ACS's schemas constrain to `format: uuid`, so a host session id that is not already a UUID has one derived from it on the way out. The Inspector labels the audit value `audit_session=` for exactly that reason, and never correlates the two. Making them joinable is V6's work, not this slice's.

The sixth of the gates counted above is V3's, and it is the one V5's whole claim rests on: R3.2 from the host's own side — a host shim imports the adapter only, never the AGT bridge, never the Guardian, which is what makes a second host cost zero AGT code. The Inspector's own import gate grew a **third** specifier in the same slice, `host-adapter` beside `guardian` and `agt-bridge`, because N51 gave the Inspector a host-side artifact to tail and it declares its own `AuditEntry` rather than importing the adapter's.

V4 ("output redaction on Claude Code") is implemented: `PostToolUse` is registered as a second gate beside V1's `PreToolUse`, mapped to ACS `steps/toolCallResult`, and an AGT `transform` at that point becomes an ACS `modify` carrying `modifications.redactions` which the adapter applies as `updatedToolOutput` — so a secret-bearing `Bash` result reaches the model redacted, in the tool's own output shape, with every sibling field intact. See [`slices/v4/README.md`](slices/v4/README.md) and [`docs/demos/v4-runbook.md`](docs/demos/v4-runbook.md) for the real captured output. Three boundaries worth stating up front. **The shape is the mechanism:** Claude Code validates a replacement against the tool's own output schema and silently delivers the **original** when it does not match, so the adapter patches a clone of the object the host handed it rather than constructing one, and refuses before asking for a decision where it cannot — which is also why AGT's own package says `PostToolUse` "cannot **reliably** redact tool output", wording this slice's evidence supports rather than corrects. **A deny here withholds or it does nothing:** `decision: block` alone injects a reason and suppresses nothing once the tool has run, so a result-gate deny renders `block` **and** a replacing output. And **the redaction reaches the model unexplained** — the hookmap's reason field works, but the pinned bundle's redaction verdict carries no text for it, permanently until the mapping or the Rego rule changes. `redact` and a `post_tool_call` intervention point now ship in the tracked config (`policy/lib/data.json`, `policy/manifest.yaml`), both additive; because AGT's stock priority chain consults that rule at every point, it also rewrites a *command* carrying a secret at V1's gate. **The handshake declares the new gate**, which it did not at first: both sides went on naming `steps/toolCallRequest` alone while evaluating result envelopes for real, and `handshake.json` tells a client to treat a method absent from `methods_evaluated` as ALLOW-by-default — so a conformant host was being told to ignore this slice's gate. Both declarations now name both methods, and a test derives the truth from a live Guardian rather than restating the literal.

Slices V5–V8 are shaped and sliced but not started; they are tracked as issues on the project board, each with a stacked pull request.

## License

MIT
