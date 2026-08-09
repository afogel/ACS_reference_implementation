---
shaping: true
---

# Spike: AGT integration surface

Investigation for `acs-reference-impl-shaping.md`. Resolves S1–S4, which blocked shape selection.

Everything below is read from `microsoft/agent-governance-toolkit` at `main` and from current host documentation. Quotes are verbatim.

---

## S1: How is AGT's policy engine invoked unforked?

### Context
All three shapes share an AGT bridge whose invocation path was unverified. That single flag failed R0, R1 and R2 across the board.

### Findings

**Library-only, in-process. There is no HTTP or gRPC server anywhere in the module.**

| Fact | Detail |
|---|---|
| Core crate | `agent_control_specification_core` v`0.3.1-beta.0`, `crate-type = ["lib", "cdylib"]` |
| Workspace members | `core`, `sdk/python`, `sdk/rust`, `sdk/node`, `integrations/{rig,openai,mcp,annotators,otel}` |
| SDK bindings | Python (PyO3/maturin), Node (napi-rs), .NET (P/Invoke over the cdylib), Rust (direct), Go (added M4) |
| Construction | `AgentControl.from_path("manifest.yaml")` |
| Evaluation | `evaluate_intervention_point(point, snapshot)` — snapshot is a plain JSON object |
| Fail-closed | "Runtime validation, missing paths, dispatcher failure, malformed policy output, and invalid transforms fail closed." |

**The Kubernetes "sidecar reference" is not an ACS sidecar.** Its README states plainly: *"ACS is not a sidecar in this topology. It is not a tested cluster recipe and it is not CI verified."* The sidecars are OPA and Envoy; *"ACS enforcement is inside the app process."*

**Policy types available in the manifest** (`manifest.schema.json` `$defs.policy`):

| Type | Binding | External dependency |
|---|---|---|
| `rego` | `bundle` (local path) or `bundle_url` (https, with `sha256` or `integrity`), plus `query`, `data_paths`, `data` | **Requires the `opa` CLI on PATH** |
| `cedar` | `policy_set` or `policy_path`, plus `entities_path`, `schema_path` | None — built in via the `cedar-policy` crate |
| `test` | — | None |
| `custom` | host-supplied `adapter` | Host's problem |

The `opa` dependency is explicit in `core/Cargo.toml`: *"The OPA dispatcher only shells out to the `opa` CLI and therefore carries no Rust build deps."* Both `opa` and `cedar` are default features.

### Consequence for the shape
The ACS Guardian is our process. It embeds one AGT SDK and calls `evaluate_intervention_point` as a stateless decision function per hook. AGT stays a library that stores nothing; the Guardian holds SessionContext, Intent, and provenance. That is exactly the R6 split, and it requires no change to AGT source (R2.3).

**Flag cleared** on A4 / B4 / C4.

---

## S2: Which ACS dispositions can Claude Code hooks express?

### Findings

`PreToolUse` returns `hookSpecificOutput.permissionDecision` with values `allow`, `deny`, `ask`, `defer` — and `updatedInput` to rewrite the tool call. All five ACS dispositions are expressible at the tool boundary, and `defer` maps by name.

| ACS disposition | Claude Code mechanism |
|---|---|
| `allow` | `permissionDecision: "allow"` |
| `deny` | `permissionDecision: "deny"` + `permissionDecisionReason` |
| `ask` | `permissionDecision: "ask"` |
| `defer` | `permissionDecision: "defer"` |
| `modify` | `updatedInput` (PreToolUse), `updatedToolOutput` (PostToolUse) |

Other control surfaces:

| Hook | Control |
|---|---|
| `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`, `PostToolUse` | `decision: "block"` + `reason` |
| `PostToolUse` | `updatedToolOutput` rewrites the result before the model sees it; `additionalContext` |
| `SessionStart` | `additionalContext` injection, no blocking |
| `SessionEnd`, `PostCompact` | no decision control — observe-only |

Exit code 2 blocks; exit code 1 does not.

**Flag cleared** on A1.1.

---

## S3: Same question for host #2

### Findings — this is the most consequential result of the spike

AGT ships four host packages, and **each one has a different architecture**. They are not one integration parameterized four ways.

| Package | Architecture | Loading |
|---|---|---|
| `agent-governance-copilot-cli` | Copilot CLI **extension**, in-process | Installs to `~/.copilot/extensions/agt-global-policy`; policy at `~/.copilot/agt/policy.json`; needs `experimental: true` + `experimental_flags: ["EXTENSIONS"]`; docs are PowerShell/Windows-first |
| `agent-governance-claude-code` | Claude Code plugin, **subprocess command hooks** + bundled MCP server + TS SDK | `claude --plugin-dir ./agent-governance-claude-code` |
| `agent-governance-antigravity-cli` | subprocess hooks | — |
| `agent-governance-opencode` | OpenCode **in-process TS plugin** + stdio MCP server + TS SDK | workspace `.opencode/plugins/`, or npm `@microsoft/agent-governance-opencode` |

**Microsoft documents the resulting capability divergence themselves.** From `agent-governance-claude-code/README.md`, under a heading literally titled "Important parity gaps":

> `PostToolUse` in Claude cannot reliably redact tool output after the tool has already executed, so this package does not claim Copilot-style output suppression parity.

and it describes itself as *"an experimental parity layer for the existing Copilot CLI governance work"* and *"not a guarantee of full Copilot CLI feature parity."*

From `agent-governance-opencode/README.md`:

> Unlike Claude Code (subprocess hooks) and Antigravity (subprocess hooks), OpenCode loads plugins **in-process** […] That means this package can […] **redact** secrets from `tool.execute.after` output before the model sees it (a parity win over Claude Code, which cannot rewrite tool output)

OpenCode's enforced scope: `session.start`, `event` (prompt scan), `tool.execute.before` (allow/review/deny), `tool.execute.after` (redact), `tool.execute.error`.

### The finding that matters

The same AGT policy produces **different enforcement** depending on which host module runs it, and Microsoft says so in their own READMEs. Each module re-derives governance against a different host contract, and capability gaps get frozen into each module independently. This is the M×N cost made concrete, in Microsoft's words, with no adversarial framing required.

### A likely-stale claim worth confirming by hand

AGT's Claude Code README says Claude Code "cannot rewrite tool output." Current Claude Code documentation lists `hookSpecificOutput.updatedToolOutput` on `PostToolUse`, which *"replaces the tool's result before Claude sees it."* If that holds in practice, an ACS host adapter can deliver Claude Code output redaction — using AGT's own stock `redact` policy — that AGT's own Claude Code package documents as out of reach.

That is the demo beat, and it stays non-adversarial: the point is not that AGT got it wrong, it is that per-host modules freeze capability at the moment they were written, while one contract picks up new host capability for every runtime at once. **Needs hands-on confirmation before it is claimed anywhere.**

### Consequence: host #2 should be OpenCode, not Copilot CLI

| Axis | Copilot CLI | OpenCode |
|---|---|---|
| AGT already supports it | ✅ | ✅ |
| Architecturally distinct from Claude Code | ✅ extension | ✅ in-process plugin vs subprocess hooks |
| Local load friction (R7.1) | ❌ experimental flags, mutates `~/.copilot`, Windows-first docs | ✅ drop into `.opencode/plugins/` |
| Documented divergence vs Claude Code | ✅ | ✅ named explicitly, in both directions |
| Control surface documented | ❌ not found | ✅ five plugin hooks enumerated |

**Residual flag** on A1.2 until an OpenCode adapter is confirmed to express deny and modify. Lower risk than Copilot CLI.

---

## S4: What ships in AGT's stock policy bundle?

### Findings

Two parallel libraries with parity, each module paired with tests.

| Library | Modules |
|---|---|
| `policy/lib/` (Rego) | `agt_default`, `agt_ifc`, `ifc`, `approval`, `budgets`, `confidence`, `content_hash`, `drift`, `egress`, `patterns`, `redact` |
| `policy/cedar-lib/` (Cedar) | `agt_default`, `approval`, `budgets`, `confidence`, `content_hash`, `drift`, `egress`, `ifc`, `patterns`, `redact` |

`agt_default.rego` is the canonical entry point. Its header: *"Hosts that do not author Rego of their own bind their manifest's `rego` policy to `data.agt.defaults.verdict`."* It imports every stock helper and evaluates in a fixed priority order:

> IFC deny > confidence deny > budget deny > content_hash deny > egress deny > pattern deny > drift warn > allow

Configuration travels through `data.agt.defaults.config` *"so a manifest only has to set thresholds, allowlists, and pattern lists in YAML without touching Rego."* We can drive the entire stock policy set from a config document and author no Rego at all — which is what R2.1 asks for.

`drift` emits `warn`, so the `warn` → ACS `allow` + `policy_references` mapping is exercised in practice, not just in theory.

### The IFC finding

`verdict.schema.json` defines `result_labels`:

> Policy supplied information-flow labels for the data produced at this sink. The core returns them verbatim; the host persists them with the produced data and re-supplies them as `input.ifc.source_labels` (AGT-SNAPSHOT §2.2) on later evaluations. **The core stores and propagates nothing.**

AGT's stock IFC policy is only as strong as the host's label propagation — and AGT deliberately leaves that to the host without standardizing it. Every host module re-invents label carriage, and labels do not survive a change of host or vendor.

ACS provenance (`origin`, `derived_from`, transitive lineage) is exactly that carrier, standardized on the wire. This is headroom AGT's own spec invites rather than a gap we are attacking — the best possible shape for R8.

---

## Acceptance

Met. We can now describe: how the engine is invoked and what it depends on, which dispositions each candidate host can express, what the stock policy bundle contains and how it is configured, and where ACS adds carriage that AGT explicitly delegates to the host.

## Follow-ups

| # | Item |
|---|------|
| F1 | Confirm by hand that Claude Code `PostToolUse.updatedToolOutput` rewrites tool results as documented |
| F2 | Confirm an OpenCode plugin can express deny and modify through `tool.execute.before` / `.after` |
| F3 | Decide Rego (canonical, needs `opa` CLI) versus Cedar (zero extra binary) for the demo bundle |
