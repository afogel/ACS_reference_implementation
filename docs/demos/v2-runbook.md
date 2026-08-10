# V2 demo runbook: the Envelope Inspector

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md`):

> Watch the ACS request and response JSON stream live while you work in Claude Code.

This runbook is written from a real run against this tree. Every block below marked
"captured" is pasted from the actual terminal, not reconstructed.

## What a viewer should watch for

1. A third terminal, beside the Guardian and the agent host, prints every ACS envelope
   as it crosses the wire — request and response, both directions, one entry each.
2. The rendered JSON is the envelope the Guardian parsed, printed unmodified and
   re-indented. The sink strips no field, redacts nothing, and reorders nothing it
   controls. It is not a byte-for-byte replay — see *S6 carries raw tool arguments*
   below for what the JSON parse normalises before the sink ever sees it.
3. The decision badge makes the outcome legible without reading the JSON: `● DENY` or
   `○ ALLOW`, with `reason_codes` and `policy_references` beside it. A response that
   carried no decision renders as `✖ ERROR` on the same line — deliberately not a
   decision badge, because in this slice a schema failure is an error and not a `deny`
   (see *the honest boundary* below).
4. Nothing in the Inspector knows what produced the decision. It imports nothing from
   the Guardian and names neither AGT nor any host — enforced by two gates in
   [`test/invariants.test.ts`](../../test/invariants.test.ts), not left to inspection.
   That is what makes R5.2 ("an ACS-first reader can trace one action end to end
   without reading AGT source") a property of the code rather than a claim in prose.

**Read the V1 runbook's two framing notes first.** [`docs/demos/v1-runbook.md`](v1-runbook.md)
records that the destructive-command pattern list is this project's own configuration
supplied as data, not something AGT ships, and that the handshake declares rather than
negotiates. Both still hold here; V2 changes neither.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- This repo cloned with its submodule.
- For the last section only: the [Claude Code](https://docs.claude.com/en/docs/claude-code)
  CLI on your `PATH` (`claude`).

## The three terminals, in order

### Terminal 1 — the Guardian, first

```bash
bun run guardian
```

Captured:

```
Guardian listening at http://localhost:8787/acs
Envelope log (S6): .acs/envelopes.jsonl
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

**Why this one starts first: it creates `.acs/`.** The sink calls
`mkdirSync(dirname(path), { recursive: true })` when the Guardian constructs it at boot
(`packages/guardian/src/envelope-log-sink.ts`), so the directory exists from the moment the
Guardian is up. The log file itself does not appear until the first envelope is written
— after the Guardian booted, `.acs/` existed and was empty.

The Inspector tolerates a file that does not exist yet (`sizeOf` returns 0 for a missing
path), so starting them out of order does not break anything. Guardian-first is still
the order to teach, because it is the order in which the two artifacts come into
existence.

The sink is opt-in at the library level and on by default in the CLI: `startGuardian`
records only when `envelopeLogPath` is passed, and `packages/guardian/src/main.ts` passes
it. Override the location with `ACS_ENVELOPE_LOG`.

### Terminal 2 — the Inspector

```bash
bun run inspector
```

Captured:

```
Envelope Inspector — tailing .acs/envelopes.jsonl
Ctrl-C to stop.
```

It follows the log the way `tail -f` does: it starts at the current end and prints what
arrives from now on. `ACS_ENVELOPE_LOG` and `--envelope-log <file>` both point it elsewhere; the
default matches the Guardian's default, so neither hardcodes the other's value.

Output is coloured when stdout is a TTY and `NO_COLOR` is unset. Every capture in this
runbook was taken with stdout redirected to a file, which is why the pasted bytes carry
no ANSI escapes; on a TTY the badge lines carry colour (red, green, and yellow, per the
constants in `packages/inspector/src/render.ts` — read from the source, not captured
here).

### Terminal 3 — drive a tool call

The shim reads a Claude Code `PreToolUse` payload on stdin and writes the hook result on
stdout. It never executes the command; it only asks the Guardian for a decision, which
is why piping `rm -rf /` into it is safe.

```bash
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

Captured, from terminal 3:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0"}}
```

## The deny, as the Inspector rendered it

Captured, from terminal 2, verbatim:

```
── #1  20:44:32.555  → REQUEST   steps/toolCallRequest  id=e491180d-60a8-4982-b693-e63771c00e2d
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "id": "e491180d-60a8-4982-b693-e63771c00e2d",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "e491180d-60a8-4982-b693-e63771c00e2d",
    "timestamp": "2026-08-09T20:44:32.535Z",
    "metadata": {
      "agent_id": "claude-code",
      "session_id": "6ccc72b8-a167-5573-b3ea-a310262ea93f"
    },
    "payload": {
      "tool": {
        "name": "Bash"
      },
      "arguments": {
        "command": {
          "value": "rm -rf /"
        }
      }
    }
  }
}

── #2  20:44:33.130  ← RESPONSE  steps/toolCallRequest  id=e491180d-60a8-4982-b693-e63771c00e2d
● DENY  reason_codes=[destructive_shell_command_blocked]  policy_references=[agt_stock#destructive_shell_command_blocked]
{
  "jsonrpc": "2.0",
  "id": "e491180d-60a8-4982-b693-e63771c00e2d",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "e491180d-60a8-4982-b693-e63771c00e2d",
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

The header line is `── #seq  time  direction  method  id=<rpc id>`. `seq` is a counter
scoped to the Guardian process. The `id` is the JSON-RPC id, which is what pairs the two
entries — it is the only identifier present in both directions, so pairing survives two
hooks in flight at once.

## The allow, for contrast

```bash
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

Captured, from terminal 3:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```

Captured, from terminal 2, verbatim:

```
── #3  20:44:41.150  → REQUEST   steps/toolCallRequest  id=0781250c-0f99-43ab-bc66-e79e5fead2d9
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "id": "0781250c-0f99-43ab-bc66-e79e5fead2d9",
  "params": {
    "acs_version": "0.1.0",
    "request_id": "0781250c-0f99-43ab-bc66-e79e5fead2d9",
    "timestamp": "2026-08-09T20:44:41.139Z",
    "metadata": {
      "agent_id": "claude-code",
      "session_id": "6ccc72b8-a167-5573-b3ea-a310262ea93f"
    },
    "payload": {
      "tool": {
        "name": "Bash"
      },
      "arguments": {
        "command": {
          "value": "ls -la"
        }
      }
    }
  }
}

── #4  20:44:41.203  ← RESPONSE  steps/toolCallRequest  id=0781250c-0f99-43ab-bc66-e79e5fead2d9
○ ALLOW
{
  "jsonrpc": "2.0",
  "id": "0781250c-0f99-43ab-bc66-e79e5fead2d9",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "0781250c-0f99-43ab-bc66-e79e5fead2d9",
    "decision": "allow"
  }
}
```

A clean allow carries no `reasoning`, no `reason_codes`, and no `policy_references`, so
the badge is bare. That absence is the signal: a policy that fired but let the action
proceed arrives as `allow` with a **non-empty** `policy_references`, and the badge
renders that case differently — `◐ ALLOW (policy fired)` — because rendering the two
identically is exactly what U21 exists to prevent. No policy-fired allow occurred in
this run; the rendering above is the deny and the clean allow, which are what the pinned
configuration actually produced.

The label used to end `— ACS "warn"`, and it was retired by PR #11's review: ACS has no
`warn` disposition, so the badge was teaching one. The Inspector is an ACS-first reader
and R5.2 keeps it clear of policy-runtime vocabulary; a string on screen carries that
vocabulary further than an identifier does. The badge now says only what ACS says
happened — a policy fired, and the action was allowed.

## The honest boundary: a schema-invalid steps/* envelope is a deny decision

The request is recorded **before** validation, so an envelope that fails the schema is
visible rather than swallowed. What comes back is now an honoured ACS **`deny`**
decision — `N27 denyOnInvalidEnvelope()` (slice V3, defined in
[`docs/shaping/acs-reference-impl-slices.md`](../shaping/acs-reference-impl-slices.md)
§V3) turns a Guardian-side failure (a schema mismatch, or evaluation itself throwing)
into a decision the host's decision path honours regardless of its negotiated failure
posture, instead of a bare JSON-RPC error a fail-open posture could otherwise let
through unnoticed.

```bash
curl -s -X POST http://localhost:8787/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"steps/toolCallRequest","id":"1","params":{"acs_version":"0.1.0"}}'
```

Captured, from terminal 2, verbatim (re-run against this branch on a freshly restarted
Guardian, which is why its `seq` starts at `#1`):

```
── #1  09:55:58.247  → REQUEST   steps/toolCallRequest  id=1
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "id": "1",
  "params": {
    "acs_version": "0.1.0"
  }
}

── #2  09:55:58.291  ← RESPONSE  steps/toolCallRequest  id=1
● DENY  reason_codes=[envelope_invalid]
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "1",
    "decision": "deny",
    "reasoning": "ACS envelope failed schema validation at /params/request_id: must have required property 'request_id'",
    "reason_codes": [
      "envelope_invalid"
    ],
    "policy_references": []
  }
}
```

**The bare badge line, explained.** No `policy_references=[...]` segment appears beside
`● DENY` because `policy_references` is empty — deliberately: R1.2 makes a *non-empty*
`policy_references` the marker of a policy that actually fired (AGT's "warn," rendered
as `deny`'s allow-with-a-fired-policy cousin). A Guardian-side failure fired no policy at
all, so `denyOnInvalidEnvelope` leaves the array empty rather than inventing a reference
for it. `request_id` echoes `"1"` — the envelope carried no `params.request_id` of its
own (that is exactly what failed validation), so the deny decision falls back to the
JSON-RPC `id`, per the addressability rule: `params.request_id` when it is usable,
otherwise the JSON-RPC `id`, otherwise the response stays a bare JSON-RPC error rather
than invent one. The two cases below are where that "otherwise" still applies.

**Unaddressable stays an error (constraint 10).** An envelope naming neither a usable
`params.request_id` nor a JSON-RPC `id` gives `denyOnInvalidEnvelope` nothing to address
a decision to, so it reports back that the envelope is unaddressable and the Guardian
answers with a bare JSON-RPC error instead of inventing an id. Captured, from terminal 2,
verbatim, on a freshly restarted Guardian:

```bash
curl -s -X POST http://localhost:8787/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"steps/toolCallRequest","params":{"acs_version":"0.1.0"}}'
```

```
── #1  09:57:16.188  → REQUEST   steps/toolCallRequest  (unpaired)
{
  "jsonrpc": "2.0",
  "method": "steps/toolCallRequest",
  "params": {
    "acs_version": "0.1.0"
  }
}

── #2  09:57:16.243  ← RESPONSE  steps/toolCallRequest  (unpaired)
✖ ERROR -32010  ACS envelope failed schema validation at /id: must have required property 'id'
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32010,
    "message": "ACS envelope failed schema validation at /id: must have required property 'id'",
    "data": {
      "pointer": "/id"
    }
  }
}
```

This envelope has no top-level `id` at all (also, itself, a schema failure — `id` is
required by `request-envelope.json`), so both lines show `(unpaired)` even though the
method name is known on both: `(unpaired)` is what the renderer prints whenever
`rpc_id: null`, independently of whether `method` is known.

**No envelope at all stays an error too — there is nothing to decide about.** A body
that will not parse as JSON goes further still: there is no request entry to pair with,
because there was never a parseable request. The Inspector renders the lone response
rather than hiding it. Captured from `curl -d 'this is not json'`, verbatim — this one
was taken against a freshly restarted Guardian, which is why its `seq` is `#1` rather
than continuing the run above:

```
── #1  20:51:47.882  ← RESPONSE  (no method)  (unpaired)
✖ ERROR -32700  Parse error
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32700,
    "message": "Parse error"
  }
}
```

`(no method)` is what the renderer prints for `method: null` — there is no envelope to
read a method name out of at all, which is the one respect in which this case is even
less known than the unaddressable one above.

## S6 carries raw tool arguments

`.acs/envelopes.jsonl` records the JSON value the Guardian parsed, unmodified: no field
stripping, no redaction, no reordering of anything we control. Pretty-printing happens at
render time only. An inspector that showed something other than what was sent would be
worse than no inspector at all.

**One honest qualifier, added by the whole-branch review.** "Unmodified" is a claim about
what *we* do, not a claim of byte identity. The sink is handed `await req.json()`, so a
JSON parse has already happened: duplicate keys are collapsed to the last one, number
literals are canonicalised (`1.0` renders as `1`, `1e2` as `100`), and integer-like
object keys are hoisted ahead of the rest and sorted. Tool argument names come from the
host, so an `arguments` object containing both `"0"` and `"a"` is a real possibility
rather than a contrived one — and it would render with `"0"` first regardless of send
order. If you need the literal bytes a host sent, capture them at the transport; S6 is
the parsed envelope. What S6 does guarantee is that nothing between the parse and the
file removed, rewrote, or hid any part of it — with two named exceptions, both on the
*stringify* side rather than the parse side, since a stringify happens every time S6's
line is written and again every time the Inspector pretty-prints it. A number literal
too large for a JS `double` (`1e400`) parses fine, as `Infinity`, but `JSON.stringify`
writes `Infinity` as `null` — the field survives; its value does not. `-0` survives the
parse with its sign intact and loses it the same way: `JSON.stringify(-0)` is `"0"`.
Neither is something this project decided; both are `JSON.stringify`'s own behaviour,
wherever it runs.

The consequence is direct: **the log contains whatever your tool calls contained** —
file paths, command lines, and anything else that rode along in `arguments`. That is why
`.acs/` is in [`.gitignore`](../../.gitignore) and why it is never committed. It is a
local demo artifact. Treat it the way you would treat a shell history file.

It also grows without bound. V2 builds no rotation; that is recorded as an accepted
limitation in the slices doc.

## Clearing the log mid-demo

```bash
: > .acs/envelopes.jsonl
```

Truncate in place. The Inspector picks up cleanly afterwards without a restart, because
`tailEnvelopeLog` compares the file size against its read offset on every poll and, when
the size comes out smaller, resets the offset to 0 and drops its partial-line buffer.

Verified in this run: the log was truncated with `: >` while the Inspector was running,
a further tool call was driven through the shim, and the Inspector rendered it normally
as `── #7` and `── #8`. Note that the sequence numbers **kept counting** — `seq` is
scoped to the Guardian process, not to the file, so truncating the log does not restart
it at `#1`.

## Replaying a session already recorded

```bash
bun run inspector -- --from-start
```

Instead of starting at the current end, this replays everything already in the file and
then follows. Captured after the truncation above, showing the two entries the file then
held — the request's JSON body is elided at the `...` for length; everything else is
verbatim:

```
Envelope Inspector — tailing .acs/envelopes.jsonl (from the start)
Ctrl-C to stop.

── #7  20:45:19.619  → REQUEST   steps/toolCallRequest  id=5c50a105-3981-44ac-9622-87b13fd0622c
...
── #8  20:45:20.181  ← RESPONSE  steps/toolCallRequest  id=5c50a105-3981-44ac-9622-87b13fd0622c
○ ALLOW
```

Note the `--` before the flag: `bun run inspector` is a package script, so `--` is what
separates bun's own arguments from the Inspector's.

## The same thing through a real Claude Code session

Wire the hook in as V1's quickstart describes:

```bash
mkdir -p .claude
cp hosts/claude-code/settings.json .claude/settings.json
```

**What was actually run to write this section, stated precisely:** this was verified
through the real `claude` CLI in **headless mode** (`claude -p '<prompt>' --allowedTools Bash`),
not through an interactive TUI session. The interactive session was not run, so nothing
here describes the TUI's rendering of the block. What the headless run does exercise is
the identical hook path — Claude Code loading `.claude/settings.json`, spawning
`acs-hook.ts` as a real `PreToolUse` subprocess, and honouring the returned decision.

The payload used was `echo rm -rf /`, not `rm -rf /`. The configured pattern is matched
against the raw command string with no argv parse, so `echo rm -rf /` is denied by the
same rule — at offset 5 instead of offset 0 — while being inert if it ever did execute.
That is the payload to use for any unattended run of this demo: an unattended `rm -rf /`
is only safe for as long as the hook works, which is the thing under test.

Captured, from terminal 2, verbatim:

```
── #12  20:47:42.255  ← RESPONSE  steps/toolCallRequest  id=f36f4b0e-0711-4673-aad0-dd7b38781f39
● DENY  reason_codes=[destructive_shell_command_blocked]  policy_references=[agt_stock#destructive_shell_command_blocked]
{
  "jsonrpc": "2.0",
  "id": "f36f4b0e-0711-4673-aad0-dd7b38781f39",
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "f36f4b0e-0711-4673-aad0-dd7b38781f39",
    "decision": "deny",
    "reasoning": "matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 5",
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

A second headless invocation asking for `ls -la` produced `── #13` / `── #14  ○ ALLOW`,
and the command ran normally — the CLI printed the directory listing. (It was a separate
`claude -p` invocation, so a separate `session_id`, not a second turn in the same
session.)

**Two things the real CLI shows that the piped payload does not.**

First, the real `tool_input` carries more than `command`. The request envelope from the
live session included a second argument the hand-written payload never has:

```
      "arguments": {
        "command": {
          "value": "echo rm -rf /"
        },
        "description": {
          "value": "Print the literal string \"rm -rf /\""
        }
      }
```

The hookmap maps every key of `tool_input` into `arguments`, so whatever Claude Code
sends is what appears on the wire. Watching the Inspector is the cheapest way to find
out what a host actually sends, as opposed to what its docs say it sends.

Second, and worth knowing before you demo this live: **the agent may decline before any
hook fires.** On the first attempt the model refused to issue the Bash tool call at all,
reasoning about the payload on its own. The envelope log stayed at zero bytes — no hook,
no envelope, nothing for the Inspector to show. This is the same trap V1's runbook warns
about when it says to ask directly. Give the model the context that a governance hook is
under test and that the deny is the expected outcome, and it issues the call. If the
Inspector shows nothing at all during a live demo, check this before you check the wiring.

## If the Inspector shows nothing

- **The Guardian is not running, or is on another port.** The shim writes an error to
  stderr and exits 1, and no envelope is ever written. V1's runbook covers this failure
  in full; V2 does not change it. `N6`/`N7`, the considered fail-open/fail-closed
  posture, are V3.
- **The agent never issued the tool call.** See the section above. Check the log's size:
  `wc -c .acs/envelopes.jsonl`.
- **The Inspector started after the entries were written.** It starts at the current end
  by default. Use `--from-start`.
- **The Guardian was constructed without a sink.** Only `packages/guardian/src/main.ts`
  passes `envelopeLogPath`; a Guardian started in-process by a test does not record unless
  it asks to.
- **The sink disabled itself.** A write failure disables the sink for the process lifetime
  and reports once on stderr — `envelope log sink disabled after failure (<path>): <reason>`.
  It never propagates and never alters a decision: the sink is total by construction, and
  the end-to-end test asserts `rm -rf /` is still denied when every sink write fails.

## Cleaning up

`.acs/` and `.claude/settings.json` are local artifacts. This repo never deletes
recursively:

```bash
rm .claude/settings.json && rmdir .claude
rm .acs/envelopes.jsonl && rmdir .acs
```
