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
persisted session database. Where a capture needed a short script rather than a real model, that
is stated plainly, the same rule V3's and V4's runbooks set.

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
   explanation back from; the only channel that carries text anywhere is the thrown message on a
   request-gate deny (watch-for 1). So even where the Guardian's decision *does* carry `reasoning`,
   as it does for the redaction below, nothing on this host delivers it to the model or the
   transcript — a stronger, host-specific version of §V4's "the redaction reaches the model
   unexplained".

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
length):

```json
{"type":"tool_use","timestamp":1786592921246,"sessionID":"ses_006c38bd0ffepNkpp7cGhWAShF","part":{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"error","input":{"command":"echo rm -rf /","description":"demo"},"error":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 5","time":{"start":1786592920578,"end":1786592921238}},"id":"prt_ff93c8400001GQGWRmUCZClZO8","sessionID":"ses_006c38bd0ffepNkpp7cGhWAShF","messageID":"msg_ff93c75b9001B6uImWcyKl67nZ"}}
```

**`"error"` is the policy's own pattern text, not a generic string** — `matched pattern
(?i)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/(?:\s|$) at offset 5`, byte-identical to
`policy/lib/data.json`'s own `patterns.patterns[0]`, the same rule V1's and V2's runbooks deny
against on Claude Code. `state.status: "error"` and the absent `output`/`metadata` fields are
OpenCode's own report that the tool call never produced anything — the command genuinely did not
run.

The envelope pair behind it, from `.acs/v5-runbook.jsonl`, pretty-printed from the raw log line:

```json
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "id": "9da03ec4-ef1e-46a0-9945-929512521f9c",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "9da03ec4-ef1e-46a0-9945-929512521f9c",
    "timestamp": "2026-08-13T03:48:40.619Z",
    "metadata": { "agent_id": "opencode", "session_id": "1c0e7a5d-9a47-56b4-b8fd-6e870d8af164" },
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
  "id": "9da03ec4-ef1e-46a0-9945-929512521f9c",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "9da03ec4-ef1e-46a0-9945-929512521f9c",
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
true}` plus `refuse.reason: {from: reasoning}`; `applyHostOutput` reads `refuse` and **throws**
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

The `tool_use` event, captured verbatim:

```json
{"type":"tool_use","timestamp":1786592938087,"sessionID":"ses_006c33f3fffeoSBZYUBB8CLFQm","part":{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"completed","input":{"command":"cat secret.txt","description":"demo"},"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","metadata":{"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","exit":0,"truncated":false},"title":"cat secret.txt","time":{"start":1786592875293,"end":1786592875342}},"id":"prt_ff93bd0d9001aQob8X1EMPUUvG","sessionID":"ses_006c43387ffe7PvbFUkDD6kmiW","messageID":"msg_ff93bcdc0001vN059pYy0EAcjx"}}
```

**Both `state.output` and `state.metadata.output` are redacted — the leaf and its mirror,
together, in one merge.** `exit: 0` and `truncated: false` — the two fields this gate does not
govern — survive untouched, the same "everything not named comes through exactly as handed in"
property V4 established for Claude Code, now proven on a host where the mirror is the interesting
part rather than an afterthought. A capture showing only `output` redacted, with `metadata.output`
left alone, is exactly the leak `opencode.hookmap.yaml`'s `outputs.mirrors: [$.result.metadata.output]`
exists to prevent — see watch-for 3 above.

Three envelopes matter here (a `handshake/hello` pair precedes them, seq 5–6). First, the request
gate — a clean **allow**, because `cat secret.txt` carries no secret in the *command* itself, only
in what it prints:

```json
{
  "jsonrpc": "2.0",
  "id": "7f4ec18c-06b8-404b-87a1-1d2673898467",
  "result": { "type": "final", "acs_version": "0.1.0", "request_id": "7f4ec18c-06b8-404b-87a1-1d2673898467", "decision": "allow" }
}
```

Then the result gate, carrying what the command actually printed:

```json
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallResult",
  "id": "dbc63c79-ff0b-4e39-983e-106810e2c2e1",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "dbc63c79-ff0b-4e39-983e-106810e2c2e1",
    "timestamp": "2026-08-13T03:48:58.027Z",
    "metadata": { "agent_id": "opencode", "session_id": "311c21c7-227b-5711-9691-475500c8ae7b" },
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
  "id": "dbc63c79-ff0b-4e39-983e-106810e2c2e1",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "dbc63c79-ff0b-4e39-983e-106810e2c2e1",
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
so `applyHostOutput`'s in-place merge lands both at once, and `title`/`attachments`/`metadata.exit`/
`metadata.truncated` — everything the render does not name — come through unchanged.

**The persisted session record, not only the live stream.** OpenCode writes every tool-call part
to its own SQLite database (`XDG_DATA_HOME/opencode/opencode.db`, isolated to this run by the
redirect above); querying it directly, after the session ended, is what Task 8's own capture
instructions call "the persisted session record":

```bash
sqlite3 "$XDG_DATA_HOME/opencode/opencode.db" \
  "SELECT data FROM part WHERE data LIKE '%cat secret.txt%' ORDER BY rowid DESC LIMIT 1;"
```

```json
{"type":"tool","tool":"bash","callID":"call_stub_1","state":{"status":"completed","input":{"command":"cat secret.txt","description":"demo"},"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","metadata":{"output":"GITHUB_TOKEN=[REDACTED] and [REDACTED]\n","exit":0,"truncated":false},"title":"cat secret.txt","time":{"start":1786592875293,"end":1786592875342}}}
```

The redaction is on disk, in both fields, not merely in-flight. A second query against the same
database, across both the `part` and `message` tables, for the raw secret text (`ghp_ABCDEF123456`
or `AKIAIOSFODNN7EXAMPLE`) returns **zero rows in either** — the plaintext was never persisted
anywhere OpenCode keeps a session, and never reached anything the model's own context (the
`message` table) carries either.

No audit entry was written for this exchange either — `<scratch>/audit.jsonl` does not exist after
the run, the same as the deny capture above: a real decision arrived from the Guardian both times,
so the negotiated `proceed` posture was never consulted.

## A harmless quirk in the raw capture, measured and explained

Running `opencode run` with `--print-logs` against this exact, unmodified `acs-plugin.ts` produces
one `ERROR`-level line during plugin registration, before either capture above:

```
level=ERROR message="failed to load plugin" path=file:///.../hosts/opencode/acs-plugin.ts error="acs-plugin: cannot apply rendered key \"client\" at this gate -- opencode.hookmap.yaml declares an output field this applier has no live object to land it in"
```

This is real and reproduces on every run, but it is **not** a governance failure, and both
captures above show that: `AcsPlugin`'s own hooks register and fire correctly regardless.
Measured, with a one-line diagnostic added to a scratch copy of the file (never the committed
one): OpenCode's plugin loader calls **every exported function** from a plugin module as a
candidate plugin factory, not only the one shaped like `Plugin`. `acs-plugin.ts` exports two
symbols — `AcsPlugin` (the real plugin) and `applyHostOutput` (exported only so
`hosts/opencode/test/apply-host-output.test.ts` can import and test it directly). OpenCode calls
`applyHostOutput` too, with its own plugin-registration context object (`{client, project,
worktree, directory, experimental_workspace, serverUrl, $}`) standing in for `applyHostOutput`'s
first parameter — and that object's first key, `"client"`, is not `"refuse"`, `"reason"`,
`"args"`, or `"result"`, so pass 1 of `applyHostOutput`'s own validation throws immediately,
naming that key. OpenCode's loader catches the throw, logs it at `ERROR`, and moves on to the
module's other export, which registers cleanly — exactly what both captures above demonstrate.
Recorded here so a reader re-running this file with `--print-logs` does not mistake a logged,
caught, non-fatal artifact of OpenCode's own plugin-loading convention for a defect in the
governance path.

## Verify

Full suite, typecheck, and both project-specific gates, run against this tree as it stands at the
end of this slice:

```bash
$ bun test
```

```
bun test v1.3.14 (0d9b296a)

 605 pass
 1 skip
 0 fail
 1726 expect() calls
Ran 606 tests across 39 files. [7.07s]
```

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

## What was not verified

- **No interactive OpenCode TUI session appears in this runbook.** Every capture drives `opencode
  run` (the headless, one-shot CLI mode) against a local stub model, the same precedent V1's and
  V2's runbooks set for Claude Code's headless mode. Nothing here describes how OpenCode's TUI
  renders a denied or redacted tool call.
- **OpenCode's version.** Every claim in this file about the plugin API's hook names, argument
  shapes, and mutation semantics was measured against **1.18.15**, matching
  `hosts/opencode/package.json`'s own pin exactly — `opencode --version` on the machine that
  produced these captures printed the identical string.
- **The "failed to load plugin" mechanism** was diagnosed with a one-line diagnostic added to a
  **scratch copy** of `acs-plugin.ts`, never the committed file — see the section above for exactly
  what was added and why the conclusion still describes the shipped file's real behaviour.
- **Timestamps, request ids, and session ids above are real** — genuine UUIDs and wall-clock times
  from the actual runs — and will not match a re-run's. What should match on a re-run is every
  `decision`, `reason_codes`, `policy_references`, `modifications`, and tool-output value.
