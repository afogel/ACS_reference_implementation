# V3 demo runbook: all five AGT verdicts, live, and both failure postures

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md`,
already corrected there — see that section's own callout for why the original sentence's
promise of a `defer` disposition was wrong):

> One bundle produces allow, deny, ask, and a rewritten tool call, plus a policy-fired
> allow that is AGT's `warn`. Then kill the Guardian mid-flight twice — once under
> `on_decision_failure: proceed`, where the step proceeds and an audit event appears;
> once under `deny`, where it blocks. Same adapter, same policy, posture negotiated at
> handshake.

This runbook is written from a real run against this tree. Every JSON block below is
pasted from an actual `curl`/hook response or `cat`, not composed. Where a step used a
short script instead of `curl` or the CLI (the `warn` section, below, explains why), that
is stated plainly rather than disguised as a `curl` capture.

## Read this framing note first (R4.3, R4.4)

**AGT's stock approval gate is a single global switch — a mechanic of this demo, not a
shortcoming in AGT.** The stock priority chain is `deny > escalate > transform > warn >
allow`, and the escalate gate is `cfg.approval.required`: a global boolean, not a rule
scoped to particular steps. With approval on, every step that isn't denied escalates, so
`allow`, `transform`, and `warn` all become unreachable *in that same config document*.
That is why this runbook edits `policy/lib/data.json` between sections instead of showing
all five verdicts from one static file: covering five verdict classes over one pinned
bundle means five config documents, not one. Zero Rego is authored either way — every
verdict below is driven purely by `data.agt.defaults.config`. AGT's stock library is a
starting default for hosts that author no Rego; a host wanting one deployment to both
auto-allow and require approval writes a rule, which is exactly what the Rego surface is
for.

**`warn` needs a host-supplied score, and that is AGT's own design working as intended,
not a gap in AGT.** AGT's stock drift gate (`policy/lib/drift.rego`) reads
`input.annotations.drift_score`, and `annotations` reaches policy input from exactly one
place: a manifest-declared annotator, dispatched through the SDK's own
`annotatorDispatcher`. AGT's specification puts behaviour-drift detection *outside* the
policy engine on purpose ("Hosts run a behaviour-drift detector outside the policy
engine"), so the score has to come from the deployment — never from the ACS envelope.
That is also a fact about **ACS v0.1.0's** own wire coverage: `steps/toolCallRequest`
carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent`, and
nothing a drift score could honestly be derived from. Neither AGT nor ACS is missing
anything here; a host-originated score is the design.

## What a viewer should watch for

1. Every disposition below is produced by the same pinned, unforked `policy/lib` bundle —
   only `data.agt.defaults.config` (`policy/lib/data.json`) changes between sections.
   `bun run verify:pin` (re-clones AGT at the pinned ref and byte-diffs the vendored
   bundle) is what keeps that claim honest; it is not merely asserted here.
2. `warn` carries no ACS disposition of its own. It arrives as `allow`, and the
   **non-empty** `policy_references` is the *only* thing distinguishing it from a clean
   allow — watch for that field specifically in the `warn` section below.
3. `transform` carries the rewritten argument in `modifications.parameter_overrides`,
   keyed by the argument name `mapping.yaml` declares (`command`). Nothing recomputes the
   substitution on the host side — the AGT rule applies it before the verdict is formed,
   so `verdict.transform.value` is already the finished string and `mapVerdict` only moves
   that value into ACS's shape.
4. The two posture runs at the end both kill a live Guardian mid-session. Watch the
   `permissionDecision` flip between `allow` (proceed) and `deny` (deny) even though
   **nothing about the tool call itself changed** — only the negotiated posture did.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- This repo cloned with its submodule.
- `curl`, and (for the `warn` section only) a way to run a short `.ts` file with `bun
  run` from the repo root.
- For the last section only: the [Claude Code](https://docs.claude.com/en/docs/claude-code)
  CLI is **not** required — this runbook drives `hosts/claude-code/acs-hook.ts` directly,
  the same way `hosts/claude-code/test/posture.test.ts` does, rather than through a live
  `claude` session. See "What was not verified" at the end.

## Setup common to every section

Every capture below uses a Guardian started the normal way:

```bash
ACS_GUARDIAN_PORT=8790 bun run guardian
```

`policy/lib/data.json` is edited **between** sections (never while a Guardian using it is
running — the bridge loads it once, at construction time, so an edit only takes effect
after a restart) and reverted immediately after each capture, so the tracked file is
identical before this task and after it. `git diff -- policy/lib/data.json` is empty at
every point in this narration except where a section is actively showing its own diff.

> **Correction (V4, slice #5) — one of those edits is no longer an edit.** The sentence above
> is what V3's own capture session did, and it stays. But V4 **ships** the `redact` rule in the
> tracked `policy/lib/data.json`, so a reader re-running this runbook today edits that file for
> two sections rather than three: the `transform` section below needs no edit at all. Two
> consequences for the diffs in this file, both verified rather than assumed:
>
> - Every `diff` block below was captured against the pre-V4 file, blob `2530d81`. The tracked
>   file is now blob `7130eed`, so the same edits produce the same *added lines* against a
>   different `index` line and a different hunk header.
> - What the edits *do* is unchanged. The `escalate` section's `approval.required` was re-run
>   against the V4 tracked file and reproduces this file's captured `ask`, `reasoning`,
>   `reason_codes` and `policy_references` exactly; so does the plain `allow`.
>
> See `docs/shaping/acs-reference-impl-slices.md` §V4's "the config ships" amendment for why the
> rule ships rather than living in a second config document, and
> [`docs/demos/v4-runbook.md`](v4-runbook.md) for what shipping it does at both gates.

## allow

No edit needed — this is the tracked `policy/lib/data.json` exactly as committed. When V3 shipped
that meant the destructive-command patterns alone; **since V4 the tracked file also carries a
`redact` block**, of which the one the `transform` section below used to add is a subset — V4
ships a second pattern beside it (`policy/lib/data.json:17-20`). Re-run against it, `ls -la` is still
the clean allow captured here — the redaction patterns match secrets, and this command carries
none.

```bash
curl -s -X POST http://localhost:8790/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"<uuid>","method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"<uuid>","timestamp":"<now>","metadata":{"agent_id":"demo","session_id":"<uuid>"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"ls -la"}}}}}'
```

Captured, verbatim (ids elided to `<uuid>` only in the command above — the response below
is the real response, uuids and all):

```json
{
  "jsonrpc": "2.0",
  "id": "d9cd2169-ea26-46ca-9b04-410795975a1d",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "d9cd2169-ea26-46ca-9b04-410795975a1d",
    "decision": "allow"
  }
}
```

A clean allow carries no `reasoning`, no `reason_codes`, and no `policy_references` —
exactly the absence the `warn` section below contrasts against.

## deny

Same config, no edit. `command` is `rm -rf /` instead of `ls -la`:

Captured, verbatim:

```json
{
  "jsonrpc": "2.0",
  "id": "4840ac82-a897-4bb4-8ac0-317292a4117f",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "4840ac82-a897-4bb4-8ac0-317292a4117f",
    "decision": "deny",
    "reasoning": "matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0",
    "reason_codes": [
      "destructive_shell_command_blocked"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "destructive_shell_command_blocked"
      }
    ]
  }
}
```

Same real deny this project's V1 and V2 runbooks already show — included here for
completeness, since this is the first of the five verdicts that section 1 above.

## escalate (arrives as ACS `ask`)

The Guardian was stopped, `policy/lib/data.json` was edited to add `approval.required`,
the Guardian was restarted, and it was reverted again immediately after this section's
captures. Diff, captured with `git diff` — against the pre-V4 file, blob `2530d81`; **the same
edit against today's tracked file adds the same six lines under a different hunk header, because
V4 ships a `redact` block in between** (re-run and re-verified, verdict unchanged; see the
correction in "Setup common to every section" above):

```diff
diff --git a/policy/lib/data.json b/policy/lib/data.json
index 2530d81..95828ad 100644
--- a/policy/lib/data.json
+++ b/policy/lib/data.json
@@ -8,6 +8,12 @@
             "(?i)rm\\s+-[a-z]*f[a-z]*r[a-z]*\\s+/(?:\\s|$)"
           ],
           "reason": "destructive_shell_command_blocked"
+        },
+        "approval": {
+          "required": true,
+          "approvers": [
+            "security-team"
+          ]
         }
       }
     }
```

`command` is `ls -la` — under the plain config above it was a clean allow; under this one
it escalates, because approval is a global switch, not a rule scoped to particular
commands (see the framing note at the top). Captured, verbatim:

```json
{
  "jsonrpc": "2.0",
  "id": "7d2c7d18-9754-4f15-b8e3-71cbb30f4744",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "7d2c7d18-9754-4f15-b8e3-71cbb30f4744",
    "decision": "ask",
    "reasoning": "requires approval from [\"security-team\"]",
    "reason_codes": [
      "approval_required"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "approval_required"
      }
    ]
  }
}
```

**The mechanic this task's plan calls P3, recorded live, not only in `test/dispositions.test.ts`:**
deny still outranks escalate under this exact same config. `rm -rf /`, same Guardian, same
`data.json`:

```json
{
  "jsonrpc": "2.0",
  "id": "08797be8-bdae-456f-89f6-97c55886ee7c",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "08797be8-bdae-456f-89f6-97c55886ee7c",
    "decision": "deny",
    "reasoning": "matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0",
    "reason_codes": [
      "destructive_shell_command_blocked"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "destructive_shell_command_blocked"
      }
    ]
  }
}
```

## transform (arrives as ACS `modify`, carrying the rewritten argument — R1.6)

**This section is the one V4 changed, and the change is that there is nothing left to do.** When
V3 shipped: Guardian stopped, `data.json` edited to add a `redact` rule, restarted, reverted
after — the diff below is that edit, exactly as it was captured. **Since V4 (slice #5) the rule
ships in the tracked file**, so re-running this section today needs no edit, no restart and no
revert: the capture below comes straight out of `policy/lib/data.json` as committed. Re-verified
against the V4 tracked file, the decision is byte-for-byte the one recorded here.

That also means the rule is live at *every* intervention point, not just this one, which is what
V4's own demo turns on — see [`docs/demos/v4-runbook.md`](v4-runbook.md), and
`docs/shaping/acs-reference-impl-slices.md` §V4 for why a second config document was rejected.
The diff, as V3 captured it (against blob `2530d81`; V4's tracked file is `7130eed`, and the
`redact` block below is **a subset of what ships** there — V4 added a second pattern,
`AKIA[0-9A-Z]{16}`, beside this one and put the array on a single line, so the tracked block is
neither this text nor this formatting. Read the diff as the edit V3 actually made, not as a
quotation of the current file; `policy/lib/data.json:17-20` is the current file):

```diff
diff --git a/policy/lib/data.json b/policy/lib/data.json
index 2530d81..40fc006 100644
--- a/policy/lib/data.json
+++ b/policy/lib/data.json
@@ -8,6 +8,12 @@
             "(?i)rm\\s+-[a-z]*f[a-z]*r[a-z]*\\s+/(?:\\s|$)"
           ],
           "reason": "destructive_shell_command_blocked"
+        },
+        "redact": {
+          "patterns": [
+            "ghp_[A-Za-z0-9]{6,}"
+          ],
+          "replacement": "[REDACTED]"
         }
       }
     }
```

`command` is `echo ghp_ABCDEF123456` — a fake token shaped like a real GitHub PAT.
Captured, verbatim:

```json
{
  "jsonrpc": "2.0",
  "id": "6ba59b01-1493-4f4c-af22-8a36eeca4651",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "6ba59b01-1493-4f4c-af22-8a36eeca4651",
    "decision": "modify",
    "reason_codes": [
      "redaction_applied"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "redaction_applied"
      }
    ],
    "modifications": {
      "parameter_overrides": {
        "command": "echo [REDACTED]"
      }
    }
  }
}
```

`modifications.parameter_overrides.command` is the value a host actually applies in place
of the original argument (`applyModifications`, N7, `packages/host-adapter/src/modifications.ts`)
— this is not a suggestion the host has to interpret, it is the literal replacement
string, already computed by AGT's own rule and carried on `verdict.transform.value`, only
moved into ACS's shape by `mapVerdict`.

## warn (arrives as ACS `allow`, with **non-empty** `policy_references` — R1.2's load-bearing half)

**This section used a short script, not `curl` against the plain CLI, and that is stated
here rather than disguised.** `packages/guardian/src/main.ts` (the `bun run guardian` CLI
entrypoint) takes no annotator argument — a JS callback cannot cross an environment
variable — so producing a live `warn` needs a few lines calling `startGuardian` directly
with the same `annotator` option `test/dispositions.test.ts`'s own "warn" case exercises.
This is real code, run for real, against the real pinned bundle and the real
`policy/manifest.drift.yaml`:

```ts
import { startGuardian } from "guardian";

const guardian = await startGuardian({
  port: 8790,
  manifestPath: "policy/manifest.drift.yaml",
  envelopeLogPath: ".acs/runbook-demo.jsonl",
  // Stands in for a real behaviour-drift detector, which AGT's own design
  // runs outside the policy engine (see policy/manifest.drift.yaml's header).
  // A fixed score makes the wiring visible without building one.
  annotator: () => 0.9,
});
console.log(`Guardian listening at ${guardian.url}`);
```

`policy/manifest.drift.yaml` is tracked and points at the same pinned `policy/lib` bundle
(`bundle: lib`) as `policy/manifest.yaml` — it only adds the `annotators` and
`pre_tool_call.annotations` blocks that make `warn` reachable at all (see that file's own
header). `policy/lib/data.json` was edited to add a `drift.warn_threshold`, same
stop/edit/restart/revert pattern as the other sections. Diff:

```diff
diff --git a/policy/lib/data.json b/policy/lib/data.json
index 2530d81..10eaa45 100644
--- a/policy/lib/data.json
+++ b/policy/lib/data.json
@@ -8,6 +8,9 @@
             "(?i)rm\\s+-[a-z]*f[a-z]*r[a-z]*\\s+/(?:\\s|$)"
           ],
           "reason": "destructive_shell_command_blocked"
+        },
+        "drift": {
+          "warn_threshold": 0.5
         }
       }
     }
```

`command` is `ls -la` — the same command section 1 above showed as a clean allow.
Captured, verbatim, with the annotator returning `0.9` (above the `0.5` threshold):

```json
{
  "jsonrpc": "2.0",
  "id": "64144466-0a20-4564-8e26-92c76e13a597",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "64144466-0a20-4564-8e26-92c76e13a597",
    "decision": "allow",
    "reasoning": "drift_score 0.9 reached threshold 0.5",
    "reason_codes": [
      "drift_detected"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "drift_detected"
      }
    ]
  }
}
```

**The contrast that makes R1.2's point concrete.** Same Guardian, same manifest, same
`data.json` — only the annotator's return value changed, to `0.1` (below the `0.5`
threshold). Captured, verbatim:

```json
{
  "jsonrpc": "2.0",
  "id": "dc421afd-7daa-4fd1-a099-4ec62cee6d20",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "dc421afd-7daa-4fd1-a099-4ec62cee6d20",
    "decision": "allow"
  }
}
```

Both responses are `"decision": "allow"`. The **only** difference is that the first
carries a non-empty `policy_references` and the second carries none at all — that
presence/absence is the entire signal that a policy fired versus stayed silent, per R1.2
and `mapping.yaml`'s `warn: { decision: allow, require_policy_references: true }`.

> **Re-run (V9, slice #28) — the verdict is unchanged, and one field of the capture is not.**
> V9 moved `policy/manifest.drift.yaml`'s `policy_target` — and its annotation's `from` — off
> `$.tool_call.args.command` and onto the shared normalised leaf, because a target naming one
> tool's own argument denies every call by a tool that has no such argument. The drift gate reads
> an annotation rather than the target, so the verdict *should* be unaffected; "should be" is not
> this repository's standard, so it was re-run rather than reasoned about.
>
> Same script above with its port changed to `8792`, same `drift.warn_threshold: 0.5` edit to
> `policy/lib/data.json`, same `ls -la`, and the `request_id` deliberately set to this section's
> own so the two blocks are comparable. The JSON-RPC `id` is the client's own and was not matched;
> it is `1` below and this section's `request_id` above. Captured against commit `16a3ab0`:
>
> ```json
> {
>   "jsonrpc": "2.0",
>   "id": 1,
>   "result": {
>     "type": "final",
>     "acs_version": "0.1.0",
>     "request_id": "64144466-0a20-4564-8e26-92c76e13a597",
>     "decision": "allow",
>     "reasoning": "This step was allowed, but flagged: the agent's behaviour drifted from its baseline. Policy: drift_detected, from AGT's stock bundle (agt_stock). AGT reported: drift_score 0.9 reached threshold 0.5.",
>     "reason_codes": [
>       "drift_detected"
>     ],
>     "policy_references": [
>       {
>         "policy_id": "agt_stock",
>         "rule_id": "drift_detected"
>       }
>     ]
>   }
> }
> ```
>
> `decision`, `reason_codes` and `policy_references` are identical to the capture above, which is
> the whole of what the moved target could have broken. `reasoning` is not, and the cause is not
> V9: `mapping.yaml` no longer sources that field from `verdict.message` verbatim but composes it
> through `field_synthesis.reasoning`'s template and per-rule summaries. AGT's own sentence is
> still in there, at the end, word for word. That change landed after V8 and before V9 (commit
> `1534a59`); every `reasoning` string captured in this file predates it.
>
> The `ls -la` envelope also now carries `raw_command`, which V9 put on the wire. It changes
> nothing here — this manifest declares a `drift_score` annotator, not an `egress` one — and it is
> mentioned so the re-run's envelope is not mistaken for this section's original.

## Both failure postures, live: kill the Guardian mid-session

This drives `hosts/claude-code/acs-hook.ts` directly on stdin, the same mechanism
`hosts/claude-code/test/posture.test.ts` automates — not a live `claude` session (see
"What was not verified" below). Two independent scratch session/audit directories were
used, one per posture, so the two runs cannot interfere with each other.

### `proceed` (the default)

Guardian started normally (`bun run guardian`, no `ACS_ON_DECISION_FAILURE` set). First
hook call negotiates the posture and writes it to the session file:

```bash
echo '{"session_id":"demo-proceed","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | ACS_GUARDIAN_URL=http://localhost:8790/acs \
    ACS_SESSION_DIR=/tmp/acs-runbook-posture-proceed/sessions \
    ACS_AUDIT_LOG=/tmp/acs-runbook-posture-proceed/audit.jsonl \
    bun run hosts/claude-code/acs-hook.ts
```

Captured:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```

The negotiated session file it wrote:

```json
{"negotiated_version":"0.1.0","methods_evaluated":["steps/toolCallRequest"],"selected_transport":"http","timeout_config":{"default_ms":5000},"on_decision_failure":"proceed"}
```

> **Correction (V4, slice #5) — `methods_evaluated` has a second entry now.** This capture and
> the `deny` one below are V3's, and they stay: a re-run today writes
> `["steps/toolCallRequest","steps/toolCallResult"]`, because V4 added the result gate and
> corrected both sides of the handshake to declare it (they had gone on naming the request
> method alone). Nothing else in these two files changes, and `on_decision_failure` — the field
> this section is about — is unaffected. See `slices/v4/README.md` and
> [`docs/demos/v4-runbook.md`](v4-runbook.md).

**The Guardian is killed here.** A second hook call, same session, same command changed
to `rm -rf /` to make the point that the posture — not the command — decides the outcome
once the Guardian is gone:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"no decision arrived from the guardian for steps/toolCallRequest (transport: Unable to connect. Is the computer able to access the url?); the session's negotiated posture applies -- on_decision_failure=proceed, so this step was proceeded."}}
```

The step proceeded — `rm -rf /` would run — but it is not silent: the audit sink (S14)
recorded it, exit code 0:

```json
{
  "seq": 1,
  "recorded_at": "2026-08-10T12:59:38.208Z",
  "session_id": "demo-proceed",
  "method": "steps/toolCallRequest",
  "rpc_id": "6ba422ff-4930-4963-8d4d-f3336d1331cb",
  "posture": "proceed",
  "posture_source": "negotiated",
  "outcome": "proceeded",
  "failure": {
    "kind": "transport",
    "message": "Unable to connect. Is the computer able to access the url?"
  }
}
```

### `deny`

A fresh Guardian, started with `ACS_ON_DECISION_FAILURE=deny`, a fresh scratch
session/audit directory, and session id `demo-deny` (so it cannot collide with the
`proceed` run above). First hook call negotiates:

> **A session file outlives the Guardian that wrote it, so tightening the posture does
> not take effect until the session turns over.** The "fresh scratch session directory"
> above is not incidental to this demo — it is load-bearing, and this is the reason.
>
> `on_decision_failure` is negotiated once per session and cached at
> `$ACS_SESSION_DIR/<session_id>.json`, which is what lets a fresh hook subprocess find
> the posture without re-handshaking. Nothing invalidates that file: not restarting the
> Guardian, not changing `ACS_ON_DECISION_FAILURE`. So a deployment that **tightens**
> its posture from `proceed` to `deny` keeps failing *open* for every session already on
> disk, for as long as those sessions keep firing hooks — which is the one direction of
> change where being stale actually costs something. Loosening (`deny` → `proceed`) is
> stale in the harmless direction.
>
> The mitigations available today are both operational: delete the session files
> (`rm .acs/sessions/*.json`, or the scratch directory this runbook uses per posture),
> or use a new session. There is no cache invalidation and no TTL in this slice; the
> nearest fix — the Guardian being able to attach to or renegotiate a session already in
> flight — is undefined in ACS v0.1 (§4.1 defers it to v0.2 alongside
> `system/handshake_renegotiate`), so this is a wire-contract gap as much as an
> implementation one. Recorded in [`slices/v3/README.md`](../../slices/v3/README.md)'s
> "not in this slice" list.

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```

```json
{"negotiated_version":"0.1.0","methods_evaluated":["steps/toolCallRequest"],"selected_transport":"http","timeout_config":{"default_ms":5000},"on_decision_failure":"deny"}
```

**The Guardian is killed here too.** Second hook call, same session, same harmless `ls
-la` this time — the point is that even a benign command blocks once delivery itself
fails under this posture:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no decision arrived from the guardian for steps/toolCallRequest (transport: Unable to connect. Is the computer able to access the url?); the session's negotiated posture applies -- on_decision_failure=deny, so this step was blocked."}}
```

Audit entry:

```json
{
  "seq": 1,
  "recorded_at": "2026-08-10T13:00:14.381Z",
  "session_id": "demo-deny",
  "method": "steps/toolCallRequest",
  "rpc_id": "c3c7bb1c-4cac-476b-9f1e-91b610331c35",
  "posture": "deny",
  "posture_source": "negotiated",
  "outcome": "blocked",
  "failure": {
    "kind": "transport",
    "message": "Unable to connect. Is the computer able to access the url?"
  }
}
```

Same failure (`kind: "transport"`, same message — Bun's `fetch` refusing a dead
connection), same command family, opposite outcome. Only the negotiated posture differed.

## What was not verified

- **No live `claude` CLI session appears in this runbook.** Every capture above drives
  the Guardian directly over HTTP (`curl`) or drives `hosts/claude-code/acs-hook.ts`
  directly on stdin — the same two mechanisms V1's and V2's runbooks already used for
  their own lower-level captures, and exactly what
  `hosts/claude-code/test/posture.test.ts` and `test/dispositions.test.ts` automate. V1's
  and V2's runbooks each include one section run through the real `claude` CLI in
  headless mode; this runbook does not repeat that for V3, since none of this task's new
  affordances (N6, N7, N27, N51, S13/S14, the annotator wiring) change what the CLI
  session itself renders — they change what happens on the wire and in the audit log,
  both of which this runbook's captures show directly.
- **The `warn` section used a short script instead of the `bun run guardian` CLI**,
  because `packages/guardian/src/main.ts` takes no annotator argument. That script is
  quoted in full above; it calls the same `startGuardian` function the CLI does, with one
  additional option, against the same tracked manifest and the same pinned bundle. It was
  not added to the repository as a permanent script — the runbook exists so a reader can
  reproduce it by hand.
- **The annotator here is a fixed stub (`() => 0.9`), not a real behaviour-drift
  detector.** That is deliberate scope, not a shortcut this task hid: AGT's own design
  puts drift detection outside the policy engine, and building a real detector is not
  this project's claim. What is verified is that the wiring from a host-supplied score to
  a policy-driven `warn`/`allow` decision actually works, end to end, over the real ACS
  wire.
- **`policy/lib/data.json` was edited and reverted by hand during this capture session**,
  never left in an intermediate state. `git diff -- policy/lib/data.json` is empty at the
  end of this runbook's own preparation — verified, not assumed — and the diffs shown
  above are exact, captured with `git diff` at the moment each edit was live. **They are exact
  as of V3**: they were taken against blob `2530d81`, and V4 changed the tracked file, so a
  re-run today produces the same added lines under different hunk headers and needs no edit at
  all for the `transform` section. See the correction under "Setup common to every section".
- **Timestamps, request ids, and session ids above are real** — genuine UUIDs generated
  per request and genuine wall-clock times from the actual runs — but they will not match
  a re-run's own ids or times. What should match on a re-run is every `decision`,
  `reason_codes`, `policy_references`, and `modifications` value.
