# V5 demo runbook: a second host, governed by the same Guardian, bundle, and policy

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md` §V5,
and `slices/v5/README.md`):

> Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines
> changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest
> `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`,
> and an unregistered name fails AGT's evaluation closed before any rule runs.

This runbook is written from real runs against this tree, driving the actual **OpenCode 1.18.15**
CLI, `hosts/opencode/acs-plugin.ts` exactly as committed, and a live Guardian — nothing here is
composed or hand-derived. Every JSON block below is pasted from an actual `opencode run
--format json` capture, an `.acs/envelopes.jsonl` line, or a query against OpenCode's own
persisted session database, and every triple of capture, envelope pair, and SQLite row for a given
exchange comes from **one** `opencode run` invocation, never assembled from more than one — an
earlier draft of this file broke that rule once (mixed a `tool_use` block from one run with an
envelope pair and a SQLite row from another) and review caught it; see the opening of "The secret
redacted at the result gate" below for exactly what was wrong and how this version is built instead.
Where a capture needed a short script rather than a real model, that is stated plainly, the same
rule V3's and V4's runbooks set.

## Read this first — no real model was used to produce anything in this file

OpenCode needs a model to decide which tool to call; this project has no paid model account to
give it, and using one would make every capture below non-deterministic and unreproducible from
a clean checkout. So every run in this file points OpenCode at a **local, offline, deterministic
OpenAI-compatible stub** — a ~50-line `Bun.serve` HTTP endpoint (quoted in full below) that always
answers with the same one canned tool call, read from an environment variable. It is not a mock
of OpenCode: OpenCode's own model-calling code, its own tool-execution loop, and its own plugin
hook dispatch all run for real and unmodified. The only thing stubbed is the judgment a real
model would apply to decide *what* to call — which is not what this slice is about. **Nowhere in
this file was a real language model consulted, and nowhere in this file did the demo need one.**
The stub is what makes every capture below reproducible offline, for the price of the model
always making the one choice this runbook needs it to make.

## Read this second (R4.3-style framing, this slice's own)

**The manifest edit is the whole deployment-side change, and it is additive.** OpenCode reports
its shell tool as `bash` (lowercase); Claude Code reports `Bash`. AGT resolves
`policy/manifest.yaml`'s fixed `pre_tool_call.policy_target` (`$.tool_call.args.command`)
**before any authored rule runs**, and a `tool_call.name` the manifest has not registered fails
that resolution closed — `runtime_error:tool_unknown` for `bash` itself, `runtime_error:path_missing`
for every other tool OpenCode can call. So `policy/manifest.yaml` and `policy/manifest.drift.yaml`
each gained one `tools:` entry, `bash`, beside the existing `Bash`/`run_shell` — nothing removed,
nothing rewritten. What survives untouched is the entire claim the manifest edit is *about*: zero
Rego authored, `policy/lib` byte-identical under `bun run verify:pin`, `data.agt.defaults.config`
unchanged, and zero lines changed in the Guardian, the bridge, or AGT — `bun run verify:zero-diff`
proves that mechanically, captured near the end of this file.

**Both gates are scoped `tools: [bash]`, which makes the two hosts symmetric rather than
asymmetric.** Host #1 is `Bash`-only at both its hooks too, via the anchored `^Bash$` matcher in
`hosts/claude-code/settings.json`. An earlier note in this project's own planning claimed the
*request* gate needed no such list, because its hookmap paths (`$.tool`, `$.args`) resolve
whatever tool ran — true, and irrelevant: the manifest's policy target is checked independently of
the hookmap, and an unscoped request gate would not govern every tool, it would **deny every tool
call OpenCode can make** on a configuration mismatch it cannot express, and call that governance.
That claim was retracted during execution; both gates carry the scope for the reason above.

## What a viewer should watch for

1. **The request gate's only deny channel is a throw**, and the thrown message is the Guardian's
   own reasoning text, not a placeholder. `output.status = "deny"` and `output.decision = "deny"`
   are both measured **accepted and silently ignored** by OpenCode — the tool still runs. Throwing
   out of `tool.execute.before` is the one thing that actually stops it, and OpenCode surfaces that
   thrown message as the tool call's own `error` field, visible in the capture below.
2. **The result gate's deny/modify is a replacement, never a throw**, and this is the opposite
   mechanism from the request gate for a related reason. Throwing out of `tool.execute.after` does
   stop the model from seeing the output — better than Claude Code, where a `block` still delivers
   the real `stdout` beside the reason (§V4) — but OpenCode **discards the plugin's mutations on
   that throw path** and rebuilds `metadata` from its own pre-hook copy, so a secret scrubbed by a
   throw does not stay scrubbed in OpenCode's own session record. So this gate withholds by
   **replacing** the whole live `{title, output, metadata, attachments}` object instead.
3. **A redaction has to land in two places, not one, or it is not a redaction.** `tool.execute.after`
   hands the plugin a `metadata` object that carries its **own copy** of the output. §V4's whole
   safety property — "every sibling field survives because the replacement is a patched clone of
   the object the host handed over" — inverts here: one sibling (`metadata.output`) *duplicates*
   the leaf, so preserving it preserves the secret. `outputs.mirrors` in `opencode.hookmap.yaml`
   is what closes this; the capture below shows both fields redacted together.
4. **No audit entry is written for either capture in this file.** A real decision arrived from the
   Guardian both times, so the negotiated failure posture (`proceed`, this deployment's default)
   was never consulted — an audit line only appears when it *is*. Absence of `.acs/audit.jsonl`
   (or, below, of a redirected scratch equivalent) is itself part of the evidence.
5. **`reason.text` is declared-inert on this host, unconditionally** — `opencode.hookmap.yaml`'s
   own header says so. OpenCode's hooks return `void` and expose no field this host reads an
   explanation back from; the only channel that delivers text *to OpenCode, or to the model* is the
   thrown message on a request-gate deny (watch-for 1). A second channel exists but does not deliver
   anywhere a user or the model would see it: `applyOpenCodeOutput` writes `reason.text` to **this
   process's own stderr**, labelled undelivered, when `ACS_DEBUG` is set — a diagnostic for whoever
   runs the plugin, not a delivery mechanism (see "The `ACS_DEBUG` stderr channel, captured" below).
   Neither capture in this runbook triggers it: the deny throws before that code ever runs, and the
   redaction below carries no `reasoning` for it to read. So even where the Guardian's decision
   *does* carry `reasoning`, as it does for the redaction below, nothing on this host delivers it to
   the model or the transcript — a stronger, host-specific version of §V4's "the redaction reaches
   the model unexplained".

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- The [OpenCode](https://opencode.ai) CLI, pinned in this project to **1.18.15**
  (`hosts/opencode/package.json`'s own `@opencode-ai/plugin` dependency) — `opencode --version`
  should print exactly that. No API key, no model subscription, and no network access to any
  model provider are needed; see "Read this first" above.
- `curl` is **not** needed for this runbook, unlike V1's and V4's — every capture below drives the
  real `opencode` CLI rather than a hook shim's stdin.

## Setup common to every section

One Guardian, started the normal way, with the envelope log pointed at its own file so the
sequence numbers below line up with a fresh run:

```bash
ACS_ENVELOPE_LOG=.acs/v5-runbook.jsonl bun run guardian
```

```
Guardian listening at http://localhost:8787/acs
Envelope log (S6): .acs/v5-runbook.jsonl
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

A scratch OpenCode project directory (anywhere outside this repo is fine; nothing below needs to
run from the repo root except the Guardian above) containing two files. First, `opencode.json`,
pointing the plugin at this repo's own `hosts/opencode/acs-plugin.ts` — the committed file,
unmodified — and the model at the stub:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "stub/model-1",
  "plugin": ["/absolute/path/to/ACS_reference_implementation/hosts/opencode/acs-plugin.ts"],
  "permission": { "bash": "allow" },
  "provider": {
    "stub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Stub",
      "options": { "baseURL": "http://127.0.0.1:8899/v1", "apiKey": "unused" },
      "models": { "model-1": { "id": "model-1", "tool_call": true, "limit": { "context": 32768, "output": 4096 } } }
    }
  }
}
```

`permission.bash: "allow"` is **OpenCode's own**, separate permission system, not ACS's — it
exists only so OpenCode does not stop to ask a human before the tool call ever reaches the plugin
hooks under test. Every decision in this runbook is ACS's Guardian, downstream of that, deciding
independently.

Second, `secret.txt`, holding an obviously fake, well-known placeholder pair — GitHub's own
example token shape and AWS's own published example access key ID, the same pair V4's runbook
used, never a real credential:

```
GITHUB_TOKEN=ghp_ABCDEF123456 and AKIAIOSFODNN7EXAMPLE
```

The stub model itself — a plain HTTP server, no OpenCode dependency, run with `bun run
stub-model.ts` — quoted in full, as run. It answers turn 1 with a `bash` tool call built from
`STUB_COMMAND`, and turn 2 with plain text so the session ends:

```ts
// A minimal OpenAI-compatible /v1/chat/completions endpoint. Turn 1 emits a
// tool call to "bash" with a command taken from STUB_COMMAND; turn 2 emits a
// plain-text reply so the session ends. Nothing here decides anything -- the
// question under test is what OpenCode's own plugin hooks do to a real tool
// call, not what a model would choose to run.
const PORT = Number(process.env.STUB_PORT ?? 8899);
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "stub-1", object: "model" }] });
    }
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });

    const body = (await req.json()) as { messages: Array<{ role: string }> };
    const alreadyCalled = body.messages.some((m) => m.role === "tool");
    const id = "chatcmpl-stub", created = 1700000000, model = "stub-1";

    const chunks: unknown[] = alreadyCalled
      ? [
          { id, created, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "STUB_DONE" }, finish_reason: null }] },
          { id, created, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
      : [
          {
            id, created, model, object: "chat.completion.chunk",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0, id: "call_stub_1", type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command: process.env.STUB_COMMAND ?? "echo hi", description: "demo" }) },
                }],
              },
              finish_reason: null,
            }],
          },
          { id, created, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(sse(c)));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`stub model listening on :${PORT}`);
```

`ACS_AUDIT_LOG` is redirected to a scratch path for every run below — the same precaution
`hosts/opencode/test/request-gate.test.ts` and `hosts/claude-code/test/hook.test.ts` take, because
a redirect failure mid-run would otherwise append raw tool arguments (a destructive command, a
secret) to this developer's own real `.acs/audit.jsonl`, the file `.gitignore` exists to keep
uncommitted. `XDG_DATA_HOME` is likewise pointed at a scratch directory for each run, so OpenCode's
own SQLite session database is small, isolated to this demo, and query-able below without wading
through every other OpenCode session on the machine that produced these captures.

## The destructive command denied at the request gate

The message text passed to `opencode run` is irrelevant — the stub ignores it and always emits
its one canned tool call, here `echo rm -rf /` (V1's own trick: it matches the same destructive
pattern at offset 5 while being inert if it ever ran, which it does not, because this call is
denied before OpenCode's shell ever sees it):

```bash
STUB_COMMAND='echo rm -rf /' bun run stub-model.ts &

XDG_DATA_HOME=<scratch> \
ACS_GUARDIAN_URL=http://localhost:8787/acs \
ACS_AUDIT_LOG=<scratch>/audit.jsonl \
opencode run "run the bash tool" --dir <scratch-project> -m stub/model-1 --format json
```

Captured, verbatim, from that run's own `--format json` stream (the one `tool_use` event; the rest
of the stream is `step_start`/`step_finish` bookkeeping and the model's own final text, omitted for
length — and see "One export was a hazard, not a convenience" below for what `--print-logs`
produces on this exact run, which is nothing beyond ordinary `INFO`/`WARN` bootstrap noise):

```json
{"type":"tool_use","timestamp":1786596133697,"sessionID":"ses_006928896ffe0HvJQLi58Ohydd","part":{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"error","input":{"command":"echo rm -rf /","description":"demo"},"error":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 5","time":{"start":1786596132948,"end":1786596133679}},"id":"prt_ff96d884f001TieMapjTFknP2d","sessionID":"ses_006928896ffe0HvJQLi58Ohydd","messageID":"msg_ff96d7960001xMVUvT89AbOqLr"}}
```

**`"error"` is the policy's own pattern text, not a generic string** — `matched pattern
(?i)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/(?:\s|$) at offset 5`, byte-identical to
`policy/lib/data.json`'s own `patterns.patterns[0]`, the same rule V1's and V2's runbooks deny
against on Claude Code. `state.status: "error"` and the absent `output`/`metadata` fields are
OpenCode's own report that the tool call never produced anything — the command genuinely did not
run.

The envelope pair behind it, from `.acs/v5-runbook.jsonl`, pretty-printed from the raw log line —
the same run: `sessionID` above (`ses_006928896ffe0HvJQLi58Ohydd`) is `host-adapter`'s own
`toSessionUuid` input for `metadata.session_id` below (`17f8297d-…`), verified by calling
`toSessionUuid` directly rather than by inspection. The one timestamp below
(`2026-08-13T04:42:13.002Z`) sits **695 ms before** the `tool_use` event's own `1786596133697` —
coherently, not by coincidence: it is 54 ms *after* that same event's `state.time.start`
(`1786596132948`), i.e. taken at the head of the call, before the tool ran and well before the
event carrying its outcome was ever recorded:

```json
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "id": "b540e247-368e-4f17-b6e4-3c5f35ac5774",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "b540e247-368e-4f17-b6e4-3c5f35ac5774",
    "timestamp": "2026-08-13T04:42:13.002Z",
    "metadata": { "agent_id": "opencode", "session_id": "17f8297d-52a7-59e7-a385-ffd412a9135e" },
    "payload": {
      "tool": { "name": "bash" },
      "arguments": { "command": { "value": "echo rm -rf /" }, "description": { "value": "demo" } }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "b540e247-368e-4f17-b6e4-3c5f35ac5774",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "b540e247-368e-4f17-b6e4-3c5f35ac5774",
    "decision": "deny",
    "reasoning": "matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 5",
    "reason_codes": ["destructive_shell_command_blocked"],
    "policy_references": [{ "policy_id": "agt_stock", "rule_id": "destructive_shell_command_blocked" }]
  }
}
```

`payload.tool.name` is `"bash"`, not `"Bash"` — the wire is honest about which host and which tool
name actually asked, which is the whole reason the manifest needed the additive entry described
above. `renderDecision` turns this `deny` into `opencode.hookmap.yaml`'s `refuse.denied: {value:
true}` plus `refuse.reason: {from: reasoning}`; `applyOpenCodeOutput` reads `refuse` and **throws**
`reasoning`'s exact text, before touching the live `{args}` object at all — which is the thrown
message the capture above shows OpenCode reporting back as `state.error`. Only 4 envelopes total
for this session (a `handshake/hello` pair precedes this pair, seq 1–2 in the log): the tool never
ran, so `tool.execute.after` never fired and no result-gate exchange exists — the identical shape
V1's Claude Code deny has.

Only one bash call happened, and OpenCode's own permission log (from `--print-logs`, not shown
above) confirms nothing beyond that: this deny is genuinely ACS's Guardian, not OpenCode's own
`permission.bash: "allow"` doing anything — that setting only means OpenCode does not pause for a
human before the plugin hook runs.

## The secret redacted at the result gate, leaf and mirror together

Same Guardian, same stub, `STUB_COMMAND='cat secret.txt'` this time — a command with no secret in
its own text, so anything the model or the session record retains had to come from the tool's
output, not from echoing the command back:

```bash
STUB_COMMAND='cat secret.txt' bun run stub-model.ts &

XDG_DATA_HOME=<scratch> \
ACS_GUARDIAN_URL=http://localhost:8787/acs \
ACS_AUDIT_LOG=<scratch>/audit.jsonl \
opencode run "run the bash tool" --dir <scratch-project> -m stub/model-1 --format json
```

The `tool_use` event, captured verbatim, from the same run as every artifact below it — a
requirement stated plainly here because an earlier draft of this runbook violated it: it pasted a
`tool_use` block from one run under an envelope pair and a SQLite row from a *different* run,
labelled "captured verbatim" in a file that opens "nothing here is composed or hand-derived". That
was caught in review — the two runs' `sessionID`s differed, and the wrapper's `time.end` sat over a
minute before the envelope it was placed beside, both signs invisible unless a reader checked. Every
value in it was still individually true and reproduced, but the *presentation* was composed, which
is exactly the failure this file exists to be free of. What follows is one `opencode run` invocation,
top to bottom:

```json
{"type":"tool_use","timestamp":1786596163409,"sessionID":"ses_00692095effeEXxALzYtyqn5R1","part":{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"completed","input":{"command":"cat secret.txt","description":"demo"},"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","metadata":{"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","exit":0,"truncated":false},"title":"cat secret.txt","time":{"start":1786596163324,"end":1786596163397}},"id":"prt_ff96dfc3d001VI8hoiW1JM3K0s","sessionID":"ses_00692095effeEXxALzYtyqn5R1","messageID":"msg_ff96df878001u2UeBsFHhUeqDZ"}}
```

**Both `state.output` and `state.metadata.output` are redacted — the leaf and its mirror,
together, in one merge.** `exit: 0` and `truncated: false` — the two fields this gate does not
govern — survive untouched, the same "everything not named comes through exactly as handed in"
property V4 established for Claude Code, now proven on a host where the mirror is the interesting
part rather than an afterthought. A capture showing only `output` redacted, with `metadata.output`
left alone, is exactly the leak `opencode.hookmap.yaml`'s `outputs.mirrors: [$.result.metadata.output]`
exists to prevent — see watch-for 3 above. Note what this `part` object does **not** carry: no
`attachments` key at all, at any level. This session's `bash` call never produced one, so this
capture says nothing about what happens to that field when one is present — see "What was not
verified" below.

Three envelopes matter here (a `handshake/hello` pair precedes them, seq 5–6, same log, same run —
`sessionID` above derives to `metadata.session_id` below the same way the deny capture's does).
First, the request gate — a clean **allow**, because `cat secret.txt` carries no secret in the
*command* itself, only in what it prints:

```json
{
  "jsonrpc": "2.0",
  "id": "9ba0e7cd-2a8c-41dc-b335-b1753d8a23af",
  "result": { "type": "final", "acs_version": "0.1.0", "request_id": "9ba0e7cd-2a8c-41dc-b335-b1753d8a23af", "decision": "allow" }
}
```

Then the result gate, carrying what the command actually printed:

```json
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallResult",
  "id": "790575ca-3b04-4578-94c6-aa4d00cfd717",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "790575ca-3b04-4578-94c6-aa4d00cfd717",
    "timestamp": "2026-08-13T04:42:43.328Z",
    "metadata": { "agent_id": "opencode", "session_id": "07d4d43a-a59f-58bb-837d-39970f750b3d" },
    "payload": {
      "tool": { "name": "bash" },
      "exit_status": "success",
      "outputs": [{ "value": "GITHUB_TOKEN=ghp_ABCDEF123456 and AKIAIOSFODNN7EXAMPLE\n" }]
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "790575ca-3b04-4578-94c6-aa4d00cfd717",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "790575ca-3b04-4578-94c6-aa4d00cfd717",
    "decision": "modify",
    "reason_codes": ["redaction_applied"],
    "policy_references": [{ "policy_id": "agt_stock", "rule_id": "redaction_applied" }],
    "modifications": { "redactions": [{ "path": "/outputs/0/value", "replacement": "GITHUB_TOKEN=[REDACTED] and [REDACTED]\n" }] }
  }
}
```

`exit_status: "success"` is a **real field read** (`$.result.metadata.exit`), not V4's hookmap
literal — OpenCode's own `metadata.exit` supplies one, where Claude Code's `PostToolUse` payload
has no exit code at all. And **no `reasoning` key is present** in this decision, the identical AGT
finding V4's runbook made: `policy/lib/redact.rego` builds `{decision, reason, transform}` with no
`message`, so `mapping.yaml`'s `reasoning: {from: verdict.message}` has nothing to source. Combined
with watch-for 5 — this host's `reason.text` is declared-inert regardless — the redaction reaches
neither the model nor the transcript with any explanation, for two independent reasons stacked on
top of each other rather than one.

`renderDecision` turns this `modify` into `opencode.hookmap.yaml`'s `result: {from:
applied_output}` — **the whole `{title, output, metadata, attachments}` container**, not
`result.output` alone (naming the leaf would assign that whole container into a field that is a
plain string on this host, and bury the mirror's own patched copy one level too deep for OpenCode
to ever apply — the exact critical finding this slice's own review caught and fixed). `applied_output`
already carries the leaf and the mirror patched together (`result-output.ts`'s `replacingOutput`),
so `applyOpenCodeOutput`'s in-place merge lands both at once, and `title`/`metadata.exit`/
`metadata.truncated` — the fields the render does not name and that this capture actually carries —
come through unchanged. `attachments` is part of the container's declared shape (this file's own
header: `{title, output, metadata, attachments}`, measured present at runtime on 1.18.15 though
absent from its own published type) but is not part of *this* capture — this `bash` call produced
none, so nothing here demonstrates what happens to one; see "What was not verified" below.

**The persisted session record, not only the live stream.** OpenCode writes every tool-call part
to its own SQLite database (`XDG_DATA_HOME/opencode/opencode.db`, isolated to **this run alone** by
the `XDG_DATA_HOME` redirect above — no other OpenCode session shares this database, which is what
makes matching on the command text below sufficient rather than a coincidence); querying it
directly, after the session ended, is what Task 8's own capture instructions call "the persisted
session record", queried after the process that produced it had already exited:

```bash
sqlite3 "$XDG_DATA_HOME/opencode/opencode.db" \
  "SELECT data FROM part WHERE data LIKE '%cat secret.txt%' ORDER BY rowid DESC LIMIT 1;"
```

```json
{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"completed","input":{"command":"cat secret.txt","description":"demo"},"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","metadata":{"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","exit":0,"truncated":false},"title":"cat secret.txt","time":{"start":1786596163324,"end":1786596163397}}}
```

**Not byte-identical to the `tool_use` event's `part` field above — say precisely what matches and
what does not.** OpenCode's own persisted schema for a `part` row is narrower than the live-stream
shape: this row carries `{type, tool, callID, state}` and omits `id`, `sessionID`, and `messageID`,
all three of which the stream event's `part` carries alongside the same four fields — confirmed
against an independently reproduced database, so this is a property of what OpenCode persists, not
an artifact of this run. What the row *does* prove, exactly: `state.time` — `{start:
1786596163324, end: 1786596163397}` — is byte-equal to the live event's own `state.time`, and so is
every other field inside `state`, including both redacted strings. That identity, not a `sessionID`
match the row has no field to make, is what ties this row to the exact call captured above rather
than to some other run that happened to `cat` a file also named `secret.txt`.

The redaction is on disk, in both fields, not merely in-flight. A second query against the same
database, across both the `part` and `message` tables, for the raw secret text (`ghp_ABCDEF123456`
or `AKIAIOSFODNN7EXAMPLE`) returns **zero rows in either** — the plaintext was never persisted
anywhere OpenCode keeps a session, and never reached anything the model's own context (the
`message` table) carries either.

No audit entry was written for this exchange either — `<scratch>/audit.jsonl` does not exist after
the run, the same as the deny capture above: a real decision arrived from the Guardian both times,
so the negotiated `proceed` posture was never consulted.

## The `ACS_DEBUG` stderr channel, captured

Watch-for 5 names a second, opt-in text channel neither capture above triggers. Demonstrating it
needs a decision that carries `reasoning` on something other than a request-gate deny — the pinned
bundle's redaction sends no `reasoning`, and a deny always throws in `applyOpenCodeOutput`'s pass 2a
before its pass 2b (the stderr write) ever runs. So, the same "short script rather than
`bun run guardian`" precedent [`docs/demos/v4-runbook.md`](v4-runbook.md)'s F1 section sets and
names explicitly: a scratch HTTP server standing in for the Guardian, answering `steps/toolCallRequest`
with a real `modify` decision that carries `reasoning`, driving the **real, unmodified** `AcsPlugin`
and `applyOpenCodeOutput` against it with `ACS_DEBUG=1`:

```ts
// Only the Guardian's answer is stubbed -- AcsPlugin, applyOpenCodeOutput, and
// the hookmap are the real, committed modules.
process.env.ACS_DEBUG = "1";
process.env.ACS_GUARDIAN_URL = "http://127.0.0.1:8798/acs";
Bun.serve({
  port: 8798,
  async fetch(req) {
    const rpc = await req.json();
    if (rpc.method === "handshake/hello") {
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { negotiated_version: "0.1.0", methods_evaluated: ["steps/toolCallRequest"], selected_transport: "http", timeout_config: { default_ms: 5000 }, on_decision_failure: "proceed" } });
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { type: "final", acs_version: "0.1.0", request_id: rpc.id, decision: "modify", reasoning: "DEBUG_CHANNEL_PROBE_TEXT", modifications: { parameter_overrides: { command: "echo safe" } } } });
  },
});
const { AcsPlugin } = await import("./hosts/opencode/acs-plugin.ts");
const hooks = await AcsPlugin({});
const output = { args: { command: "echo original" } };
await hooks["tool.execute.before"]({ tool: "bash", sessionID: "debug-channel-probe", callID: "c1" }, output);
```

Captured verbatim, on stderr:

```
acs-plugin: reason.text is declared-inert on this host (opencode.hookmap.yaml) and was not delivered to OpenCode -- reasoning: "DEBUG_CHANNEL_PROBE_TEXT"
```

The rewrite still lands (`output.args.command` became `"echo safe"`) — `ACS_DEBUG` changes nothing
about governance, only about what this process tells whoever is running it. Off by default (unset,
`""`, or `"0"` all count as off), so a deployment sees nothing extra on any of the captures above.

## One export was a hazard, not a convenience — found, fixed, and one thing still open

An earlier draft of this runbook ran `opencode run --print-logs` against the tree as it stood after
Task 7 and got one `ERROR`-level line on every single run, before either capture above. Full line, no
fields elided, exactly as captured:

```
timestamp=2026-08-13T03:48:36.457Z level=ERROR run=30258ebf message="failed to load plugin" path=file:///Users/arielfogel/Pillar/ACS_reference_implementation/hosts/opencode/acs-plugin.ts error="acs-plugin: cannot apply rendered key \"client\" at this gate -- opencode.hookmap.yaml declares an output field this applier has no live object to land it in"
```

That draft called this "harmless" and explained it as a caught, non-fatal artifact of OpenCode's own
plugin-loading convention — measured accurately (OpenCode's plugin loader calls **every exported
function** from a plugin module as a candidate factory, not only the one shaped like `Plugin`, and
`acs-plugin.ts` exported a second symbol, `applyOpenCodeOutput` (named `applyHostOutput` at the
time; renamed in §V5 review round 3, Task 4), for no reason but its own unit test's
convenience) — but review found the framing itself was the defect. **Two things make "harmless" the
wrong word for what a reader should take from that line:**

1. **A single non-function export beside a working factory disables governance entirely, silently.**
   `Array.isArray`, a string, a number — anything OpenCode's loader cannot call — produces
   `error="Plugin export is not a function"`, and **the working factory next to it is never called at
   all**. `applyOpenCodeOutput` happened to be a function, so it merely threw instead; a hookmap change,
   a refactor, or a copy-paste that replaced it with a constant would have turned "logged and
   harmless" into "the whole session is ungoverned and nothing says so any louder than the case that
   wasn't."
2. **A genuinely broken plugin produces the byte-identical line shape.** Same `level=ERROR`, same
   `message="failed to load plugin"`, same `path=`. Only the `error=` payload differs — and telling
   "a second export got mis-invoked, harmless" from "the plugin never registered, and every tool call
   this session makes from here on is completely ungoverned" means reading that payload character by
   character. A runbook section whose purpose was "so a reader does not mistake this for a defect"
   was training a reader to discount the one line that would ever announce total governance loss.

**The fix is structural, closes point 1 completely, and is captured below closing it.**
`applyOpenCodeOutput`, and every private helper it alone needs, moved out of `acs-plugin.ts` into its own
module, `hosts/opencode/apply-host-output.ts` (imported back into `acs-plugin.ts`, tested directly by
`hosts/opencode/test/apply-host-output.test.ts`) — so `acs-plugin.ts` exports exactly one symbol,
`AcsPlugin`, and OpenCode's loader has no second export to find. `test/invariants.test.ts` pins that
mechanically now, and the pin was mutation-tested: temporarily re-adding a second export to
`acs-plugin.ts` and re-running the suite fails exactly that one new test, naming the spurious export;
reverting passes it again.

**Captured, against the fixed file.** Both real captures above were run with `--print-logs` added
to the same command shown in each section, output redirected to a file, and that file grepped
afterward — the deny run's file first, the redaction run's file second:

```bash
$ grep -c "failed to load plugin" run-deny.out
0
$ grep -c "failed to load plugin" run-redaction.out
0
```

Zero, both times — the spurious line is gone from the exact two runs quoted above, not merely
explained in the abstract.

**Point 2 is real, is not this task's to fix, and this section does not paper over it.** A genuinely
broken plugin still produces the same line shape, because the mechanism is OpenCode's, not this
project's: it catches whatever a plugin module's factory throws during registration, logs it, and
continues the session **without that plugin** — never refusing to start, the way Claude Code's shim
refuses at exit 2 for the equivalent "broken deployment, not a policy question" case. Reproduced
directly: a scratch copy of `opencode.hookmap.yaml` with every `refuse.denied: { value: true }` line
removed (the exact fault `assertRefusalRendersUnconditionally` exists to catch — the tracked file is
never touched), pointed at with `ACS_HOOKMAP_PATH`, run against the same destructive-command probe.
The whole diff, four lines removed, nothing else:

```diff
49d48
<       # `refuse.denied: { value: true }` (§V5 review, fix round 1, Critical 1):
68d66
<           refuse.denied: { value: true }
75d72
<           refuse.denied: { value: true }
79d75
<           refuse.denied: { value: true }
```

```
timestamp=2026-08-13T04:43:20.332Z level=ERROR run=cb6f0a9f message="failed to load plugin" path=file:///Users/arielfogel/Pillar/ACS_reference_implementation/hosts/opencode/acs-plugin.ts error="acs-plugin: /…/broken-hookmap.yaml's \"hooks.tool.execute.before.decisions.deny\" declares no unconditional \"value:\" output field under \"refuse\" -- applyHostOutput (apply-host-output.ts) refuses only on the \"refuse\" key; an unconditional field declared under any other key (e.g. \"reason.text\" or \"args...\") renders a non-empty output block without making this a refusal, and \"refuse.reason\" alone is a \"from:\" field that renders NOTHING when the arriving decision does not carry that source field, or carries it as the wrong type (render-decision.ts). This host's applier would then apply nothing and throw nothing, and the tool would proceed -- a deny indistinguishable from a clean allow. Add a literal sibling under \"refuse\", e.g. \"refuse.denied: { value: true }\", so this decision always renders a refusal."
```

(This capture predates §V5 review round 3, Task 4's rename — reproduced verbatim from the run that
produced it, unedited, per this file's own rule for dated captures. The live message this same
hookmap fault produces today names `applyOpenCodeOutput`, not `applyHostOutput`; a reader reproducing
this exact run against the current tree will see the new name, not a mismatch to debug.)

Same `level=ERROR`, same `message`, same `path` — and this time the `error=` payload names a real,
load-time-decidable hookmap fault rather than a stray export. What happened next, from the same run's
own `--format json` stream:

```json
{"type":"tool_use","timestamp":1786596204884,"sessionID":"ses_006917011ffeyzqsxqf1GqsZ6J","part":{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"completed","input":{"command":"echo BROKEN_HOOKMAP_PROBE_MARKER","description":"demo"},"output":"BROKEN_HOOKMAP_PROBE_MARKER\n","metadata":{"output":"BROKEN_HOOKMAP_PROBE_MARKER\n","exit":0,"truncated":false},"title":"echo BROKEN_HOOKMAP_PROBE_MARKER","time":{"start":1786596204866,"end":1786596204871}},"id":"prt_ff96ea0ef0011gbkunnB59ctT3","sessionID":"ses_006917011ffeyzqsxqf1GqsZ6J","messageID":"msg_ff96e91e5001kz1GfRZ4E6LQzb"}}
```

`status: "completed"` — the probe marker, a stand-in for a real destructive command, ran to
completion with no interception at all. `.acs/v5-runbook.jsonl` gained **zero new lines** for this
session (still 10, exactly the two pairs of pairs from the two real captures above): no
`handshake/hello`, no `steps/toolCallRequest`, nothing — because `AcsPlugin`'s factory threw before
any hook was ever registered, so `tool.execute.before` never fired, no envelope was ever built, and
the Guardian was never asked. Every tool call for the rest of that session would have run exactly
this way. **This is real, measured, and not repaired here** — a fix would mean either OpenCode
refusing to start a session when a plugin fails to load, or this project shipping a wrapper OpenCode
itself would have to call instead of the plugin API it defines, and neither is a change this slice's
files can make. It belongs in `docs/shaping/acs-reference-impl-slices.md`'s docs of record, not in
this runbook, and not edited by this task.

## Verify

Full suite, typecheck, and both project-specific gates, run against this tree as it stands at the
end of this slice:

```bash
$ bun test
```

```
bun test v1.3.14 (0d9b296a)

 616 pass
 1 skip
 0 fail
 1741 expect() calls
Ran 617 tests across 39 files. [9.40s]
```

Eleven more than the baseline this task started from (605 pass, 1 skip) — all eleven are
`test/invariants.test.ts`'s new eighth gate and its own self-tests, added across this task's fix
rounds (see "One export was a hazard, not a convenience" above): the gate itself, five self-tests
proving `exportedNames` distinguishes one export from two, and five more added in a second fix round
after review found the named-export **list** form (`export { a, b }`) went unmatched — the reviewer's
own reproduction, `const spurious = 1; export { spurious };`, passed 21/21 with the hazard live. Both
shapes are now mutation-tested against the real file: temporarily reintroducing a second export as a
plain declaration, and separately as an export list, each fails exactly the one new test that names
the spurious export; reverting either passes the whole suite again.

```bash
$ bun run typecheck
```

```
$ tsc -p tsconfig.json --noEmit
```

(No output after the command line is the successful case — zero type errors, whole workspace,
strict mode.)

**`bun run verify:zero-diff` is what proves the headline claim mechanically** — that adding a
second host cost zero changed lines under the Guardian, the bridge, `policy/lib`, `agt.lock`,
`mapping.yaml`, or host #1's own wire contract:

```bash
$ bun run verify:zero-diff
```

```
$ bash scripts/verify-zero-diff.sh
verify-zero-diff: zero changed lines under the Guardian, the bridge, or AGT (vs slice/v4, committed and working tree)
```

**`bun run verify:pin` is what proves the pinned bundle is still byte-identical to AGT upstream**
— it re-clones AGT at the ref `agt.lock` names and diffs `policy/lib` against it, which needs
network access and is why it is a separate command from `bun test` rather than part of it:

```bash
$ bun run verify:pin
```

```
$ bash scripts/verify-pin.sh
bun test v1.3.14 (0d9b296a)

 5 pass
 0 fail
 37 expect() calls
Ran 5 tests across 1 file. [27.00ms]
```

Together, `verify:zero-diff` and `verify:pin` are the two commands this slice's headline rests
on: the first says nothing shared changed to add the second host, the second says what did not
change is still exactly what AGT publishes.

## What this slice found and did not fix

Each of these is measured and recorded at the row it governs in `docs/shaping/acs-reference-impl-slices.md`
§V5, and none of it is implied to be fixed by anything captured above.

- **`modifications.modified_content` has an obvious target here, and it is still not built.**
  §V4 predicted a step "whose payload is an opaque body would have an obvious target" for a
  wholesale replacement; OpenCode's `tool.execute.after` hands the plugin `output.output` as
  exactly that — an opaque string. V7's matrix carries `modified_content` as red for Claude Code
  and green for OpenCode rather than red outright. This slice does not build it: `mapVerdict`
  learning to emit `modified_content` is a **Guardian** change, and Global Constraint 1 forbids
  one here.
- **`permission.ask` is not wired as a real ACS `ask`.** OpenCode has a genuine three-valued
  permission surface, but it fires on a different event than every tool call, and wiring it means
  a second envelope source and a second hookmap gate. This slice maps ACS `ask` (and `defer`) to a
  refusal — the same throw the deny above uses — fail-closed, and records the mapping rather than
  building the real thing. A host with a native ask deserves its own slice.
- **`tool.execute.error` is not a hook in 1.18.15.** A failing tool call is ungoverned at the
  result gate on this host — measured, not assumed — the same shape as V4's un-wired
  `PostToolUseFailure` on Claude Code.
- **The per-modification landing check V4 parked stays parked, and this slice's own claim makes it
  worse.** The shared adapter code both hosts now run through is inherited unchanged; inheriting
  it unchanged inherits the gap too, and it is no longer one host's problem.
- **Session state and provenance carriage** is unchanged — V6's scope, not this slice's.
- **No OpenCode-specific Inspector view was built, or needed.** `bun run inspector` is already
  host-agnostic and tails whatever `.acs/envelopes.jsonl` any host's Guardian writes to, which is
  exactly what produced the envelope pairs above.
- **A result payload missing `metadata.exit` posture-proceeds, delivering the unredacted output —
  correct by this branch's own rule, and not reachable through `bash`, the only tool this gate
  governs.** `exitStatusOf` throws when `$.result.metadata.exit` resolves to nothing; that throw
  lands at `governStep`'s stage `"request"` and is answered by the negotiated posture, which under
  `proceed` delivers the tool's own output — secret included, in both the leaf and the mirror —
  audited as `host_configuration`. Measured, both paths a `bash` call can take: a succeeding one
  carries `exit: 0` (this runbook's own redaction capture, above), and a failing one carries `exit:
  1` with the error text in `metadata.output`. So the governed tool always supplies the field, and
  this residual is unreachable through the shipped config rather than unreachable outright — the
  same class as V4's identity over-refusal. An invalid tool call is not a counter-example: it
  reports itself as tool `invalid`, which `tools: [bash]` skips before any envelope naming
  `metadata.exit` is ever built.
- **The posture-answered seam this slice put three checks on (`mirrors`, the `exit_status`
  both-forms refusal, request-gate scopability) already carried six more, pre-existing, and none of
  them is this slice's to repair.** Every one is decidable from the hookmap alone, with no payload
  needed — a missing `exit_status.literal`/`.from`, an empty or missing `outputs.from`, an empty or
  missing `outputs.within`, a `from` not inside `within`, a non-string `arguments`, and an entry
  declaring neither `arguments` nor `outputs` — and all six are answered today by
  `applyFailurePosture` rather than refused at `loadHookmap`, so under `proceed` a hookmap carrying
  any of them runs the step ungoverned rather than failing to load. The rule they violate is one
  sentence, stated in `govern-step.ts` for a different pair already: a fault decidable from the
  hookmap alone belongs at load time; only a fault needing the invocation's payload belongs where a
  posture can answer it. Neither shipped hookmap reaches any of the six (both are pinned by tests
  that load them), and the repair is a single sweep of one module — `exitStatusOf` and `buildPayload`
  are two different functions, but both live in `build-envelope.ts` — not six edits across six files,
  so it is recorded rather than fixed here, the same reasoning V4 gave for parking its own landing
  check rather than doing it twice by gate.
- **The Inspector's tail tests gate on wall-clock sleeps, and one transient failure surfaced during
  this slice — pre-existing, and V2's rail to repair, not this slice's.** 58 assertions across 22
  bare `await Bun.sleep(…)` waits of 30–80 ms, in a suite that concurrently spawns real subprocesses
  and port-0 Guardians; observed once in four runs, not captured before it self-resolved, and clean
  across sixteen consecutive runs afterward. Nothing in this slice's own diff can cause
  intermittency — the tasks that saw it added a synchronous file scan, a bash script that never runs
  under `bun test`, and one `package.json` line — so the likeliest source is structural rather than
  anything V5 touched. The repair is event-driven waits (await the next emission rather than a
  duration) against `packages/inspector/test/tail-audit-log.test.ts` and `tail-envelope-log.test.ts`.

## What was not verified

- **No interactive OpenCode TUI session appears in this runbook.** Every capture drives `opencode
  run` (the headless, one-shot CLI mode) against a local stub model, the same precedent V1's and
  V2's runbooks set for Claude Code's headless mode. Nothing here describes how OpenCode's TUI
  renders a denied or redacted tool call.
- **OpenCode's version.** Every claim in this file about the plugin API's hook names, argument
  shapes, and mutation semantics was measured against **1.18.15**, matching
  `hosts/opencode/package.json`'s own pin exactly — `opencode --version` on the machine that
  produced these captures printed the identical string.
- **`attachments` is never exercised.** It is part of the result gate's live object by this file's
  own header (`{title, output, metadata, attachments}`, measured present at runtime on 1.18.15,
  absent from the published type), and `mergeInPlace`'s own contract (an array replaces wholesale
  rather than merging element-wise) covers it by construction — but no capture in this runbook drove
  a `bash` call that produced one, so nothing here shows it surviving a merge, only that the code
  path that would touch it is the same one proven for `title`/`metadata.exit`/`metadata.truncated`.
- **Why OpenCode's plugin loader calls every export, rather than only one shaped like `Plugin`, was
  first diagnosed with a one-line print added to a scratch copy of `acs-plugin.ts` (never the
  committed file), before the fix existed.** That diagnostic explained the *mechanism*; every claim
  built on it since is a capture against the real, unmodified tree: the grep counts of `0` against
  the two real runs above, the mutation test against the real `test/invariants.test.ts` gate, and the
  broken-hookmap reproduction against the real, unmodified `hosts/opencode/acs-plugin.ts` with only
  `ACS_HOOKMAP_PATH` repointed at a scratch YAML file — the same env-var override this project's own
  tests use throughout, never a second copy of the plugin.
- **Timestamps, request ids, and session ids above are real** — genuine UUIDs and wall-clock times
  from the actual runs — and will not match a re-run's. What should match on a re-run is every
  `decision`, `reason_codes`, `policy_references`, `modifications`, and tool-output value.
