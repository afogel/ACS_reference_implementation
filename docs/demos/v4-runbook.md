# V4 demo runbook: a tool result redacted by AGT's stock policy, on Claude Code

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md` §V4):

> AGT's own Claude Code package documents that it cannot redact tool output. Here is a tool
> result redacted by AGT's stock `redact` policy, delivered through `updatedToolOutput`
> **in the tool's own output shape** — which is the condition that makes it work at all.

This runbook is written from a real run against this tree. Every JSON block below is pasted
from an actual hook response, `curl`, or envelope log — not composed, not hand-derived. Where
a step needed a short script rather than the shipped CLI, that is stated plainly rather than
disguised as a capture (V3's runbook set that rule and this one keeps it). What was **not**
run is listed at the end, and one quoted line in the F1 section below is explicitly marked as
inherited from V4's planning rather than re-taken here.

## Read this framing note first (R4.3, R4.4)

**Framing discipline (R4.3).** The claim is that per-host modules freeze capability at the
moment they are written, while one contract picks up new host capability for every runtime at
once. It is **not** that AGT got something wrong. Their README was accurate when written.

**And it is accurate now (R4.4).** Quoted in full from `agent-governance-claude-code/README.md:39`
at the pinned ref (`agt.lock`'s `agt_ref`, `81955d48025c6b11deb3fc9dabf89f74f4145775`), under
its own heading **`## Important parity gaps`** (line 36 of that file):

> `PostToolUse` in Claude cannot reliably redact tool output after the tool has already
> executed, so this package does not claim Copilot-style output suppression parity.

Read it precisely, because the whole framing turns on the exact words. AGT says "cannot
**reliably**" and "does not **claim** parity" — a scoping statement about that package, not an
assertion that the host cannot do it. Never paraphrase it to "AGT can't redact output". And
V4's own evidence is *why* that wording is right rather than a correction of it: the naive
replacement is **silently discarded** and the original delivered (the F1 section below), and
the documented blocking form suppresses **nothing** (§V4's second watch-for). Meeting the
reliability condition is a contract-level job done once for every runtime, not a per-host
module's job redone for each.

*(That quote was verified for this runbook by fetching AGT at the pinned ref and reading the
file — the same fetch `scripts/verify-pin.sh` performs — not copied from this project's
earlier notes.)*

## What a viewer should watch for

1. **Every sibling field survives the replacement.** `Bash`'s output shape is
   `{stdout, stderr, interrupted, isImage, noOutputExpected}`, and a replacement that is not
   that shape is discarded *silently*, with the original delivered. So the interesting part of
   the capture below is not `[REDACTED]` — it is the four fields beside it.
2. **A clean result renders nothing at all.** No `updatedToolOutput` key, no decision field:
   an empty wrapper, and the output reaches the model exactly as the tool produced it.
3. **The redaction arrives with nothing explaining it.** The mechanism for a reason exists and
   is exercised; the pinned bundle sends no text for it to carry. Watch for the *absence* of
   `additionalContext` in the capture, and read "The redaction reaches the model unexplained"
   below before narrating this demo as "the transcript says why".
4. **A refusal withholds.** When a modification cannot be applied, the block is accompanied by
   a replacing output — `decision: block` on its own would report a suppression that never
   happened, because the tool has already run.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- This repo cloned with its submodule.
- `curl`, and (for the two-refusals section only) a way to run a short `.ts` file with
  `bun run` from the repo root.
- The [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI is **not** required.
  This runbook drives `hosts/claude-code/acs-hook.ts` directly on stdin, the same way
  `hosts/claude-code/test/post-tool-use.test.ts` does — see "What was not verified".

## Setup common to every section

**No section of this runbook edits `policy/lib/data.json`.** That is the difference between this
demo and V3's: the `redact` rule V3 added for one capture and reverted afterwards now ships in
the tracked file, so every capture below runs against `policy/lib/data.json` exactly as
committed. (V3's runbook says that rule was "reverted after"; it is corrected in place there,
with a pointer here.) The one edit made while preparing this file was a re-check of V3's
`escalate` section against the V4 tracked config — `approval.required` added, captured,
reverted, `git diff` confirmed empty — and it is reported where it is used, below.

One Guardian, started the normal way, with the envelope log pointed at its own file so the
sequence numbers below line up with a fresh run rather than with whatever a previous session
left in `.acs/envelopes.jsonl`:

```bash
ACS_ENVELOPE_LOG=.acs/v4-runbook.jsonl bun run guardian
```

```
Guardian listening at http://localhost:8787/acs
Envelope log (S6): .acs/v4-runbook.jsonl
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

## The redaction, end to end

Claude Code runs `cat .env`, the command produces a secret, and the `PostToolUse` hook is
asked what to do with it. Both gates are driven here in order, as a live session would fire
them — first the request gate (the tool call is permitted), then the result gate (its output
is redacted).

```bash
echo '{"session_id":"v4-demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```

Then the result gate, carrying what the command printed. `tool_response` is `Bash`'s real
output object, all five fields:

```bash
printf '%s' '{"session_id":"v4-demo","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cat .env"},"tool_response":{"stdout":"GITHUB_TOKEN=ghp_ABCDEF123456 and AKIAIOSFODNN7EXAMPLE","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

Captured, verbatim (the shim writes one line and no trailing newline; exit code 0):

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"GITHUB_TOKEN=[REDACTED] and [REDACTED]","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}}
```

**Both secrets are gone and all four sibling fields are still there.** The GitHub token and the
AWS access key ID matched two different patterns in `data.agt.defaults.config.redact.patterns`
and AGT's stock `redact.rego` substituted both in one pass. `stderr`, `interrupted`, `isImage`
and `noOutputExpected` are present with their original values because the replacement is a
**patched clone of the object the host handed over** (`packages/host-adapter/src/result-output.ts`),
never a fresh object built from the one field policy addressed. That is the whole difference
between a redaction and an unredacted delivery with a warning line: see the F1 section below.

## The two envelopes it crossed

Same run, rendered by the Inspector from the log the Guardian just wrote:

```bash
bun run inspector -- --path .acs/v4-runbook.jsonl --from-start
```

The request, built by the host adapter from the `PostToolUse` payload — a `steps/toolCallResult`
envelope whose `outputs[0].value` is the leaf `claude-code.hookmap.yaml`'s `outputs.from`
(`$.tool_response.stdout`) named:

```
── #5  20:33:52.681  → REQUEST   steps/toolCallResult  id=1598e28b-7db9-4fd8-917b-e713d8ece6b4
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallResult",
  "id": "1598e28b-7db9-4fd8-917b-e713d8ece6b4",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "1598e28b-7db9-4fd8-917b-e713d8ece6b4",
    "timestamp": "2026-08-11T20:33:52.674Z",
    "metadata": {
      "agent_id": "claude-code",
      "session_id": "ef5a5d44-697d-5af2-8b6d-e470605ad020"
    },
    "payload": {
      "tool": {
        "name": "Bash"
      },
      "exit_status": "success",
      "outputs": [
        {
          "value": "GITHUB_TOKEN=ghp_ABCDEF123456 and AKIAIOSFODNN7EXAMPLE"
        }
      ]
    }
  }
}
```

And the decision, which is where AGT's `transform` verdict becomes an ACS `modify`:

```
── #6  20:33:52.730  ← RESPONSE  steps/toolCallResult  id=1598e28b-7db9-4fd8-917b-e713d8ece6b4
◆ MODIFY  reason_codes=[redaction_applied]  policy_references=[agt_stock#redaction_applied]
{
  "jsonrpc": "2.0",
  "id": "1598e28b-7db9-4fd8-917b-e713d8ece6b4",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "1598e28b-7db9-4fd8-917b-e713d8ece6b4",
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
      "redactions": [
        {
          "path": "/outputs/0/value",
          "replacement": "GITHUB_TOKEN=[REDACTED] and [REDACTED]"
        }
      ]
    }
  }
}
```

Three things in that decision are worth naming, because each is a declaration two files have to
agree on:

- **`redactions`, not `parameter_overrides`.** The synthesis is per intervention point since
  V4 (`mapping.yaml`'s `intervention_points.<point>.modifications`): the same AGT `transform`
  becomes a `parameter_overrides` keyed by argument name at the request gate and a `redactions`
  entry at the result gate, because they are editing different documents. A point with no
  `modifications` rule cannot express a transform at all, and `mapVerdict` throws rather than
  answering with a `modify` the host has nothing to apply.
- **`/outputs/0/value`** is `mapping.yaml`'s `redaction_path`, and it addresses the same leaf
  `policy/manifest.yaml:72`'s `policy_target: "$.tool_result.outputs[0].value"` names in AGT's
  own notation. Change one and the other is wrong; nothing in either file can tell.
- **No `reasoning`.** Not an elision — the field is genuinely absent, and that is the gap
  recorded below.

A whole governed `Bash` call is **four** envelopes in a session that has already negotiated:
a `steps/toolCallRequest` and its decision before the command runs, a `steps/toolCallResult`
and its decision after. The first hook call of a session adds the `handshake/hello` pair in
front, which is why the numbering above starts the result pair at `#5`.

## A clean result is left alone

Same Guardian, nothing secret in the output:

```bash
printf '%s' '{"session_id":"v4-demo","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{"stdout":"README.md\n","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}
```

An empty wrapper, exit 0, and **no `updatedToolOutput` key at all** — the tool's own output is
delivered untouched. The decision behind it, from the same log:

```
── #8  20:33:52.802  ← RESPONSE  steps/toolCallResult  id=0061b40c-bf79-401a-9100-578f25d3b2ec
○ ALLOW
{
  "jsonrpc": "2.0",
  "id": "0061b40c-bf79-401a-9100-578f25d3b2ec",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "0061b40c-bf79-401a-9100-578f25d3b2ec",
    "decision": "allow"
  }
}
```

This is why the `allow` entry in the hookmap's `PostToolUse` `decisions` block declares exactly
one **conditional** field (`hookSpecificOutput.additionalContext`, from `reasoning`): the rule
is non-empty, so the gate's load-time and shim-side "every decision must render something"
checks are satisfied, while the rendered output is empty whenever the decision carries no text.
At the request gate an output with no decision in it means the call proceeds ungoverned and is
refused; at a gate where the tool has already run, "nothing to change, deliver it unchanged" is
the honest answer, and refusing it would exit 2 on every clean tool call.

## F1: the shape is the entire finding

The reason this slice exists as a slice, rather than as a one-line hookmap entry, is that the
obvious way to redact output does not work and does not say so loudly.

**The string form is silently discarded and the original is delivered.** A hook answering
`updatedToolOutput: "[REDACTED]"` — a plain string, the natural reading of "redact the
output", and exactly the shape §6.3's `modified_content` provides — produced this on stderr
while the model received the real secret:

```
PostToolUse hook returned updatedToolOutput that does not match Bash's output shape; using original output. [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received string"}]
```

**That line is the one quotation in this runbook that is not from a run performed for it.** It
was captured by hand against Claude Code **2.1.227** during V4's planning, is recorded at
`docs/shaping/acs-reference-impl-slices.md:179` and in
`hosts/claude-code/test/post-tool-use.test.ts`'s header, and reproducing it requires a live
`claude` session answering with a deliberately wrong shape — which this runbook does not run
(see "What was not verified"). It is quoted rather than re-taken, and marked, rather than
rewritten into something that looks like a capture.

**The shape-preserving form works**, and that is what every capture above is. The two facts
together are why AGT's "cannot **reliably**" is the right wording: the capability is reachable,
but only on a condition a host module has to know about, and getting it wrong fails **open**
with a log line rather than closed with an error. So this deployment does not construct a
replacement at all — it clones the object the host handed it and patches the one leaf the
hookmap named, and where it cannot do that it refuses **before asking for a decision at all**.

That refusal is observable. `ACS_HOOKMAP_PATH` repoints the governance mapping, so a copy of the
shipped hookmap with `outputs.from` moved from `$.tool_response.stdout` to
`$.tool_response.interrupted` — a boolean leaf, which no string replacement can land in —
drives the same secret-bearing payload into the preflight:

```bash
sed 's|from: \$\.tool_response\.stdout|from: $.tool_response.interrupted|' \
  hosts/claude-code/claude-code.hookmap.yaml > /tmp/hookmap-nonstring.yaml
printf '%s' '<the secret-bearing PostToolUse payload above>' \
  | ACS_HOOKMAP_PATH=/tmp/hookmap-nonstring.yaml bun run hosts/claude-code/acs-hook.ts
```

A scratch copy: the tracked hookmap is not modified, and `git diff` on it is empty afterwards.
Measured from that run — `EXIT=2`, **0 bytes** on stdout, **0** occurrences of `ghp_` in it —
with this on stderr, captured verbatim:

```
governStep: hook "PostToolUse" is a gate whose output an arriving decision has to be able to replace, and no replacement can be built for the output its hookmap entry names: result-output: the replacement for hookmap path "$.tool_response.interrupted" is a string where this tool produced a boolean -- the host validates a replacement against the tool's own output shape and delivers the ORIGINAL when it does not match, so a replacement of the wrong type withholds nothing and redacts nothing
```

That preflight (`packages/host-adapter/src/govern-step.ts`) sits between building the envelope
and asking the Guardian — nothing is asked and nothing is audited on this route. It is a
deliberate over-block on the safe side: it can turn a would-be **allow** into a block. A payload
that does not *carry* the named leaf at all is a different case and stays posture-answered,
because a host may fire one hook for several tools.

## The two modifications this host cannot apply

Both of these are decisions the pinned bundle does not produce — `mapVerdict` synthesizes
exactly one redaction against the bound `$policy_target` and throws on anything else — so
capturing them needs a Guardian that answers with them. **This section used a short script
rather than `bun run guardian`, and that is stated here rather than disguised.** It is the same
stub shape, and the same `handshake/hello` branch, as the `answering()` helper in
`hosts/claude-code/test/post-tool-use.test.ts`, which exists for the same reason — quoted here
in full, as run:

```ts
// Negotiates a real session, then answers every step call with the decision on argv.
const decision = JSON.parse(process.argv[2] as string);
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8791),
  async fetch(req) {
    const rpc = (await req.json()) as { id: string | number; method: string };
    if (rpc.method === "handshake/hello") {
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          negotiated_version: "0.1.0",
          methods_evaluated: ["steps/toolCallResult"],
          selected_transport: "http",
          timeout_config: { default_ms: 5000 },
          on_decision_failure: "proceed",
        },
      });
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: decision });
  },
});
console.error(`stub listening at ${server.url}`);
```

The payload for these captures is the same `PostToolUse` shape as above with
`stdout: "GITHUB_TOKEN=ghp_ABCDEF123456"`, and each was driven through the real shim with
`ACS_GUARDIAN_URL` pointed at the stub.

**1. A `modified_content` wholesale replacement.** A legal §6.3 shape — it replaces the entire
payload and is exclusive of `redactions`/`parameter_overrides` — with no target on this host at
either gate. Answering
`{"decision":"modify","reasoning":"secret in output","modifications":{"modified_content":"[REDACTED]"}}`:

```json
{"decision":"block","reason":"guardian's modifications could not be applied: modifications cannot be honoured as specified (§6.3): modified_content asks for a wholesale content replacement, and neither structured ACS document a step's modifications can address -- the arguments it was asked to run with, or the outputs it produced -- has a field for an opaque replacement string to land in, so there is no target for it at either gate. Applying nothing while reporting a successful modify is not available","hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"[OUTPUT WITHHELD BY POLICY]","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}}
```

**2. A redaction that lands somewhere this gate cannot carry back.** `/exit_status` is a real
target in the ACS result payload: the pointer resolves, the edit applies exactly as written —
and the one leaf this gate projects back to the host is untouched, so the "replacement" is the
output the host is already holding. Answering
`{"decision":"modify","reasoning":"redaction_applied","modifications":{"redactions":[{"path":"/exit_status","replacement":"[REDACTED]"}]}}`:

```json
{"decision":"block","reason":"guardian's modifications could not be applied: result-output: applying these modifications left \"outputs[0].value\" -- the one leaf of the ACS result payload this gate can carry back to the host -- exactly as the step produced it, so the replacement projected from it is the output the host is already holding. Either the modifications addressed some other part of the result payload, which this gate has no second leaf to project, or they replaced that leaf with the value already there. Both deliver the ORIGINAL output, so a rewrite reported here is one that nothing carried out","hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"[OUTPUT WITHHELD BY POLICY]","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}}
```

**Both are *withholding* denies, and that is the point.** `decision: block` at the top level
says why, and `updatedToolOutput` carrying `[OUTPUT WITHHELD BY POLICY]` — with all four
siblings still in place, so the host accepts it — is the half that actually suppresses
anything. Exit 0 in both cases, and `ghp_` appears nowhere in either line. A `block` alone
would report a withholding that never happened: the tool has already run and its result has
already formed.

A third case, for completeness, is a pointer with no target at all
(`/outputs/9/value`), which is refused one seam earlier with a reason that names the missing
segment rather than the leaf:

```json
{"decision":"block","reason":"guardian's modifications could not be applied: modifications cannot be honoured as specified (§6.3): redaction path \"/outputs/9/value\" addresses \"/outputs/9\", which is not present in the ACS document these pointers address (this step's own request or result payload) -- applying it would add a field and leave the original value in place","hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"[OUTPUT WITHHELD BY POLICY]","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}}
```

## What shipping the rule changed at the *request* gate

`redact` now lives in the tracked config, and AGT's stock priority chain consults its
`redact_verdict` at **every** intervention point — not only the one V4 added. So the same rule
that redacts tool output also rewrites a *command* that carries a secret, at the gate V1
shipped. No edit, tracked `policy/lib/data.json`, `curl` straight at the Guardian:

```bash
curl -s -X POST http://localhost:8787/acs -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"<uuid>","method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"<uuid>","timestamp":"<now>","metadata":{"agent_id":"demo","session_id":"<uuid>"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"echo ghp_ABCDEF123456"}}}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": "784ca96f-6b2e-4f77-aa38-875a10aafe23",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "784ca96f-6b2e-4f77-aa38-875a10aafe23",
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

That is the decision `docs/demos/v3-runbook.md`'s `transform` section captured, identical in
every field but the ids — **which is the point**: V3 had to edit `policy/lib/data.json` to get
it and reverted the edit afterwards, and now the tracked file produces it. Through the shim, the same call renders as
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"echo [REDACTED]"}}}`
— note the **absent** `permissionDecisionReason`, for exactly the reason the next section gives.

Two sections of V3's runbook were re-run against the V4 tracked file to check that shipping the
rule did not disturb them, and both reproduce identically: `ls -la` is still a clean `allow`
with no `reasoning`, no `reason_codes` and no `policy_references`, and under a temporarily added
`approval.required` it still escalates to `ask` with `requires approval from ["security-team"]`.
What did change there is narration, not behaviour, and it is corrected in place in that file.

## The redaction reaches the model unexplained

**Do not narrate this demo as "and the transcript says why".** It does not, and the reason is
worth stating exactly, because the mechanism and the demo diverge here.

The mechanism is closed. `PostToolUse`'s `modify` entry declares
`hookSpecificOutput.additionalContext: { from: reasoning, type: string }`
(`hosts/claude-code/claude-code.hookmap.yaml:183-186`) — this event's own field for text the
model reads — closing at the result gate the same asymmetry V3 closed for `PreToolUse`'s
`modify`. It is exercised end to end, against a Guardian that sends a `reasoning`, by
`hosts/claude-code/test/post-tool-use.test.ts`'s "says why it redacted" case.

The demo is not closed. The field is conditional, and **the pinned bundle's redaction verdict
carries no text for it**:

- `mapping.yaml:103-104` sources ACS `reasoning` from `verdict.message`.
- `policy/lib/redact.rego:40-47` builds its verdict as `{decision, reason, transform}` — there
  is no `message` key in it.

So `reasoning` is absent from the decision (visible in the `◆ MODIFY` capture above, which has
`reason_codes` and `policy_references` and nothing else), `additionalContext` renders nothing,
and the model is handed altered text with nothing saying it was altered — it may read
`[REDACTED]` as the command's real answer. **This is permanent until either the mapping or the
Rego rule changes, and neither is a host-adapter change.** The same absence is why the request
gate's `updatedInput` capture above carries no `permissionDecisionReason`, and why V3's own
`transform` capture had no `reasoning` either: it is a property of the stock rule, not of
V4's gate.

It is recorded here as a gap in the demo rather than in the mechanism, and it is the kind of
cell V7's conformance matrix should carry.

## What this slice found and did not fix

Each of these is measured, recorded in §V4 of the slices doc at the row it governs, and **not
repaired in V4**. None of them is implied to be fixed anywhere above.

- **An audit entry can outlive the decision it claims.** The shim's own wrapper checks exit 2
  and block, but the failure posture has already written an audit line reading
  `outcome: "proceeded"` by then. The durable record says a step proceeded while the process
  blocked it. The repair belongs to the audit sink's contract, not to a result-gate fix round.
  R1.7's distinction, now written down: "every fail-open proceed is audited" holds; "every
  audited proceed happened" does not.
- **The landing check asks "did the leaf change", not "did every modification land".** A
  `modifications` object bundling a leaf redaction with a non-leaf edit passes: the leaf
  changed, the non-leaf edit was silently dropped, and the whole `modify` is reported applied.
  Nothing leaks — the leaf edit did land — so what remains is a false audit and transcript
  record. Pinned as current behaviour by four generated cases in
  `packages/host-adapter/test/validate-decision.test.ts`, so closing it is a visible change.
- **The symmetric hole at the request gate.** A `parameter_overrides` that rewrites a command
  to itself reports as honoured while the original runs. Same family, one gate over — and
  unlike the bundle case above it is recorded in prose only, with no test pinning it. Both
  holes are one per-modification check, parked for V5.
- **The preflight can turn a would-be allow into exit 2**, whenever the hookmap's named leaf is
  present and not a string. A deliberate over-block on the safe side.
- **A replacement equal to the original is refused**, which withholds a legitimate result. This
  is unreachable with the **shipped config** rather than unreachable outright:
  `redact.replacement` is user-editable, and a replacement equal to the matched text yields an
  identical value.

## What was not verified

- **No live `claude` CLI session appears in this runbook.** Every capture drives
  `hosts/claude-code/acs-hook.ts` directly on stdin or the Guardian directly over HTTP — the
  same two mechanisms V3's runbook used, and exactly what `post-tool-use.test.ts` and
  `hook.test.ts` automate. So nothing here describes how the Claude Code TUI renders a
  redacted result, and the `[REDACTED]` text was never observed inside a model's context; what
  is verified is the exact bytes the host is given to do it with. `hosts/claude-code/settings.json`
  registers both gates for a session that wants to try it (see the quickstart in `README.md`).
- **The F1 stderr line was not re-taken** — see the F1 section, which says so at the point of
  quotation. It is the only inherited quotation in this file.
- **Claude Code's version.** Every claim in this repository about the host's hook schema and its
  discard behaviour was measured against **2.1.227**. The CLI installed on the machine that
  produced these captures is **2.1.228**, and nothing here re-verifies the schema against it —
  no capture in this runbook comes from the CLI at all, so the version does not bear on them,
  but it does bear on the inherited stderr line above and on the "present in 2.1.227's schema"
  claims in the hookmap.
- **The handshake still declares only the request method.** The ClientHello sends
  `methods_implemented: ["steps/toolCallRequest"]` (`packages/host-adapter/src/handshake.ts:231`)
  and the ServerHello answers `methods_evaluated: ["steps/toolCallRequest"]`
  (`packages/guardian/src/handshake.ts:49-50`), captured from the same run as every decision
  above — while both sides then go on to send, evaluate and honour `steps/toolCallResult`.
  Nothing in this deployment reads either field, so the demo is unaffected; but
  `spec/acs/specification/v0.1.0/handshake.json:80` says of `methods_evaluated` that "Methods
  listed by the client but absent here are NOT evaluated … Clients MAY still emit them for audit
  but MUST treat them as ALLOW-by-default", so a conformant host that *did* read it would be
  required to skip the very gate this slice adds. Found while writing this runbook, not repaired in it: correcting either
  constant changes what crosses the wire, which is a behaviour change and not a documentation
  one. It belongs on the next whole-branch review's list, and it is a V7 matrix cell.
- **Timestamps, request ids and session ids above are real** — genuine UUIDs and wall-clock
  times from the actual run — and will not match a re-run's. What should match on a re-run is
  every `decision`, `reason_codes`, `policy_references`, `modifications` and
  `updatedToolOutput` value.
