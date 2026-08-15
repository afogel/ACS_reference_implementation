# V6 demo runbook: per-session state, and a first label the wire cannot supply

**The demo, in the slice's own words** (from `docs/shaping/acs-reference-impl-slices.md` §V6,
and `slices/v6/README.md`):

> The SessionContext chain grows per step. AGT emits `result_labels` at one step and gets
> them back as `input.ifc.source_labels` at the next, carried in the `IfcLabels` field of
> the ACS provenance record.

This runbook is written from real runs against this tree — the committed Guardian, the
committed Inspector, and the pinned `policy/lib` bundle with `data.agt.defaults.config`
as it ships. Nothing here is composed or hand-derived: every JSON, JSONL, and terminal
block below is pasted from one actual run, and no block mixes two. Where a capture needed
a short script rather than `curl`, that is stated in the section that uses it, the same
rule V3's, V4's and V5's runbooks set.

## Read this first — no host and no model appears anywhere in this file, and two captures needed a script

V6's subject is state the **Guardian** keeps between steps. Both shipped hosts send the
same envelopes they sent in V4 and V5 — nothing in `hosts/` changed for this slice — so
driving a host would add a transcript and no evidence. Every capture below therefore
speaks to the Guardian directly, over its real HTTP endpoint. **Nowhere in this file was
a language model consulted, and nowhere in this file did the demo need one.** What that
costs is stated plainly under "What was not verified": nothing here shows how a host
renders any of it.

Two sections use a short script instead of `curl`, each for a reason it states again in
place:

- **"The label emitted at one step, arriving at the next"** — the labels never appear on
  the wire. They exist only inside the AGT snapshot and inside AGT's verdict, neither of
  which is an ACS message, so a `curl` capture *cannot* show them (and the S6 capture
  below is that absence, measured). The script starts a real `startGuardian` and passes a
  bridge that **records and delegates** to `createBridge("policy/manifest.yaml")` — every
  decision below is the real bundle's, unchanged.
- **"What the gate does, by label alone"** — six snapshots against the real bridge with no
  Guardian and no envelope at all, because the question there is about AGT, not about ACS.

The first is quoted in full, as run. The second is quoted with four of its six repeated
probe literals elided, marked in place with `…` and described there — every other line of
it is verbatim. Both were scratch files at the repo root, run once and deleted; neither is
committed, and neither modifies anything it drives.

## Read this second — three things about the gate this slice turned on, all measured below

**1. AGT's stock IFC gate is fail-closed on absent labels.** `flow_allowed_with_lattice`
(`policy/lib/agt_ifc.rego`) requires `count(labels) > 0` *before* it consults the lattice:

```rego
flow_allowed_with_lattice(lattice, clearance, labels) if {
	is_string(clearance)
	is_array(labels)
	count(labels) > 0
	sensitivity := max_sensitivity_with_lattice(lattice, labels)
	dominates_with_lattice(lattice, clearance, sensitivity)
}
```

So a snapshot carrying no labels is not a *permitted* flow it happens to say nothing
about — it is a **denied** one, `ifc_clearance_violation`, however permissive the
configured clearance is. AGT's own tests say the same, in two halves:
`test_missing_and_empty_labels_deny_fail_closed` pins that an **empty** array is not an
allowed flow, and `test_source_labels_defaults_to_empty` pins that a **missing** member
reads as that same empty array (`policy/lib/agt_ifc_test.rego`), which is what reduces the
absent case to the empty one.
**This is what makes the deployment-supplied seed mandatory rather than a design
preference**: with the gate on and nothing seeding a first label, a fresh session can do
nothing at all. V6's answer is `["public"]`, the lattice floor, written by
`emptySessionContext` (`packages/guardian/src/session-context.ts`).

And it is the sharpest available statement of the wire gap: a conforming ACS v0.1.0
deployment **cannot obtain a first label from the wire**. `provenance.json`'s properties
are `provenance_id`, `origin`, `source_id`, `derived_from` — no member a sensitivity could
be read from — and that is the object `hooks/tool-call-request.json` `$ref`s from every
argument. A deployment running the full ACS-Provenance profile, with provenance required
on every argument, still has nothing to read a first label out of. The label has to come
from the deployment, exactly as V3's drift score does.

**2. IFC deny outranks every other gate**, per `policy/lib/agt_default.rego`'s own header:

> consults each one in priority order: IFC deny > confidence deny > budget deny >
> content_hash deny > egress deny > pattern deny > drift warn > allow

So a label-free snapshot does not merely lose IFC — it reports `ifc_clearance_violation`
**in place of** whatever the policy would otherwise have said. Measured below: the same
`rm -rf /` reports `destructive_shell_command_blocked` with a label and
`ifc_clearance_violation` without one. Still denied, differently blamed — and a reader of
the second verdict would go looking for a clearance problem that is not the reason the
command is dangerous.

**3. Turning the gate on makes `input.ifc.source_labels` a required member of every
snapshot in the deployment** — including for callers that have no session concept at all.
`packages/agt-bridge/test/bridge.test.ts` builds snapshots by hand, has never known what a
session is, and had to start spreading a `publicLabel` into them; its own comment says
why. That is a real cost of shipping the gate on, and the mutation capture below measures
it rather than asserting it.

## What a viewer should watch for

1. **The chain records the step, not the decision.** `appendContextEntry` fires on arrival,
   before a verdict exists, so the denied step in the first capture is in the chain beside
   the allowed one. A chain that recorded only permitted steps would be a chain an incident
   review cannot use — and nothing in an entry names a verdict, so nothing downstream can
   read a prior decision out of S3, because none is stored.
2. **No label appears anywhere on the wire, in either direction.** The S6 capture is four
   lines with no `ifc`, no `source_labels`, and no `result_labels` in any of them. That is
   not an omission in the capture; it is the finding.
3. **Without a deployment writing one, `public → public` is the only round trip a session
   can ever show**, and the capture below that reaches `confidential` had that label handed
   to it by the deployment. AGT propagates labels it is given and originates none —
   `propagated_labels(labels)` is `[max_sensitivity(labels)]` — so a session seeded at the
   floor stays at the floor for as long as nothing else writes to it.
4. **The chain-break check is per session, and one log holds every session.** The
   Inspector compares an entry's `prev_hash` to the last hash seen *for that
   `session_id`*, not to the line above it.
5. **An absent `result_labels` and an empty one are different answers.** The denied step in
   "The label emitted at one step, arriving at the next" returns no `result_labels` member
   at all — a higher-severity gate answered — and the session keeps the labels it had. An
   explicitly empty set would have cleared them.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- `curl`, for the first capture — which drives the Guardian's own HTTP endpoint directly,
  the same shape V1's runbook uses.
- No host, no model account, and no network access to any model provider. `bun run
  verify:pin` at the end needs network access to GitHub and nothing else does.

## The chain grows across two steps, one of them denied

One Guardian, started the normal way, with both logs pointed at their own files so the
lines below line up with a fresh run, and on its own port so it cannot collide with a
Guardian already serving the default one:

```bash
ACS_ENVELOPE_LOG=.acs/v6-runbook.jsonl \
ACS_SESSION_CONTEXT_LOG=.acs/v6-runbook-session-context.jsonl \
ACS_GUARDIAN_PORT=8791 \
bun run guardian
```

```
Guardian listening at http://localhost:8791/acs
Envelope log (S6): .acs/v6-runbook.jsonl
Session context log (S3): .acs/v6-runbook-session-context.jsonl
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

Two `steps/toolCallRequest` envelopes, **same `session_id`**, different `request_id`s —
the second one destructive. `session_id` and `request_id` are generated UUIDs because
`request-envelope.json` pins `format: "uuid"` on both; a readable literal like `sess-a`
fails validation before the chain is ever touched.

```bash
curl -sS -X POST http://localhost:8791/acs -H 'content-type: application/json' -d '
{"jsonrpc":"2.0","id":1,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"9cd34c31-b734-412b-8586-4839ab3c114c","timestamp":"2026-08-15T10:55:10.000Z","metadata":{"agent_id":"curl","session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"echo hello"}}}}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"type":"final","acs_version":"0.1.0","request_id":"9cd34c31-b734-412b-8586-4839ab3c114c","decision":"allow"}}
```

```bash
curl -sS -X POST http://localhost:8791/acs -H 'content-type: application/json' -d '
{"jsonrpc":"2.0","id":2,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"357b3501-4ab4-495c-82a1-b002a3b353f4","timestamp":"2026-08-15T10:55:10.000Z","metadata":{"agent_id":"curl","session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"rm -rf /"}}}}}'
```

```json
{"jsonrpc":"2.0","id":2,"result":{"type":"final","acs_version":"0.1.0","request_id":"357b3501-4ab4-495c-82a1-b002a3b353f4","decision":"deny","reasoning":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0","reason_codes":["destructive_shell_command_blocked"],"policy_references":[{"policy_id":"agt_stock","rule_id":"destructive_shell_command_blocked"}]}}
```

**`reason_codes` is `destructive_shell_command_blocked`, and that is finding 2 measured
in the affirmative.** IFC ran first and *allowed* this flow — the session's seeded
`public` label is dominated by this deployment's `confidential` clearance — so the pattern
gate got its turn and the deny carries the pattern's own text. The same command with no
label denies for IFC's reason instead; see the gate probe below.

S3, as written, both lines, verbatim from `.acs/v6-runbook-session-context.jsonl`:

```json
{"session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3","seq":1,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","recorded_at":"2026-08-15T11:11:27.442Z","method":"steps/toolCallRequest","request_id":"9cd34c31-b734-412b-8586-4839ab3c114c","tool_name":"Bash","hash":"a578a54aafc74d1661388c4898b1cee3542d71e3a384509cfc6a69884df63c3c"}
{"session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3","seq":2,"prev_hash":"a578a54aafc74d1661388c4898b1cee3542d71e3a384509cfc6a69884df63c3c","recorded_at":"2026-08-15T11:11:28.135Z","method":"steps/toolCallRequest","request_id":"357b3501-4ab4-495c-82a1-b002a3b353f4","tool_name":"Bash","hash":"43fc8603e5179ec28f799e392366b138d8f785d01d3731db09881c03493acd94"}
```

Three things to read off those two lines, none of them inferred:

- **The chain links.** Entry 2's `prev_hash` (`a578a54a…3c3c`) is entry 1's `hash`,
  character for character. Entry 1's `prev_hash` is `GENESIS_HASH`, 64 zeros.
- **The denied step is in the chain**, with its own `request_id`
  (`357b3501-…`) matching the deny response above. Nothing in either entry says
  `allow` or `deny`, because the entry type has no field for one.
- **`seq` is 1 then 2, and it is an index rather than the ordering.** The order is carried
  by `prev_hash`: two entries claiming the same `seq` would still have to agree on a hash
  covering the entry before them. This is why S3 never needed risk row 13's `seq`
  duplicate closed — see §V6 of the slices doc.

## No label is on the wire, in either direction — the S6 capture

Same run, all four lines of `.acs/v6-runbook.jsonl`, verbatim:

```json
{"seq":1,"recorded_at":"2026-08-15T11:11:27.315Z","direction":"request","method":"steps/toolCallRequest","rpc_id":1,"envelope":{"jsonrpc":"2.0","id":1,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"9cd34c31-b734-412b-8586-4839ab3c114c","timestamp":"2026-08-15T10:55:10.000Z","metadata":{"agent_id":"curl","session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"echo hello"}}}}}}
{"seq":2,"recorded_at":"2026-08-15T11:11:28.102Z","direction":"response","method":"steps/toolCallRequest","rpc_id":1,"envelope":{"jsonrpc":"2.0","id":1,"result":{"type":"final","acs_version":"0.1.0","request_id":"9cd34c31-b734-412b-8586-4839ab3c114c","decision":"allow"}}}
{"seq":3,"recorded_at":"2026-08-15T11:11:28.134Z","direction":"request","method":"steps/toolCallRequest","rpc_id":2,"envelope":{"jsonrpc":"2.0","id":2,"method":"steps/toolCallRequest","params":{"acs_version":"0.1.0","request_id":"357b3501-4ab4-495c-82a1-b002a3b353f4","timestamp":"2026-08-15T10:55:10.000Z","metadata":{"agent_id":"curl","session_id":"8186ca06-9db3-41b0-ba1a-ddcc044f3fd3"},"payload":{"tool":{"name":"Bash"},"arguments":{"command":{"value":"rm -rf /"}}}}}}
{"seq":4,"recorded_at":"2026-08-15T11:11:28.451Z","direction":"response","method":"steps/toolCallRequest","rpc_id":2,"envelope":{"jsonrpc":"2.0","id":2,"result":{"type":"final","acs_version":"0.1.0","request_id":"357b3501-4ab4-495c-82a1-b002a3b353f4","decision":"deny","reasoning":"matched pattern (?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$) at offset 0","reason_codes":["destructive_shell_command_blocked"],"policy_references":[{"policy_id":"agt_stock","rule_id":"destructive_shell_command_blocked"}]}}}
```

**Not one of those four lines carries a label, a `source_labels`, a `result_labels`, or
an `ifc` key at all** — and both requests are schema-valid, both responses are honoured
decisions. This is what "the labels are not on the wire" means concretely: a downstream
consumer reading S6, which is exactly what the Inspector does and what R5.1 exists to
make possible, sees the whole exchange and cannot tell what the session's labels were,
what AGT propagated, or that an IFC gate ran. Only the Guardian knows, from state the
contract does not carry.

The corollary matters for the next section: no `curl` capture can show the round trip,
because there is nothing in an ACS message for it to show.

## The label emitted at one step, arriving at the next

The script that makes it visible. **Only the observation is added** — `spy.evaluate` calls
the real `createBridge("policy/manifest.yaml")` and returns its verdict unchanged, so
every decision printed below is the pinned bundle's. `startGuardian`'s `bridge` option is
the one this project's own tests use and its doc comment says is not meant for production;
here it carries an observer around the real bridge rather than a stand-in for it. The
Guardian, the store, the hash chain, the HTTP round trip and the envelope validation are
all the shipped ones.

```ts
// Drives a real Guardian over one session, against the real pinned bundle,
// and prints what crossed the bridge at each step. The ONLY thing added is
// observation: `spy` delegates every call to `createBridge("policy/manifest.yaml")`
// and returns its verdict unchanged. The Guardian, the session store, the
// hash chain, the HTTP wire and every decision are the shipped ones.
import { appendFileSync } from "node:fs";
import { createBridge } from "./packages/agt-bridge/src/index.ts";
import { createMemorySessionContextStore, persistIfcLabels, startGuardian } from "guardian";

const CHAIN_LOG = process.argv[2] ?? ".acs/v6-labels-session-context.jsonl";
const real = createBridge("policy/manifest.yaml");

const spy = {
  async evaluate(point: string, snapshot: unknown) {
    const verdict = await real.evaluate(point as never, snapshot as never);
    const labels = (snapshot as { input: { ifc: { source_labels: string[] } } }).input.ifc.source_labels;
    console.log(
      `${point}  source_labels=${JSON.stringify(labels)}` +
        `  ->  decision=${verdict.decision}` +
        `  reason=${verdict.reason ?? "-"}` +
        `  result_labels=${JSON.stringify(verdict.result_labels)}`,
    );
    return verdict;
  },
};

const store = createMemorySessionContextStore({
  appendLine: (line) => appendFileSync(CHAIN_LOG, `${line}\n`),
});

const guardian = await startGuardian({
  port: 0,
  manifestPath: "policy/manifest.yaml",
  bridge: spy as never,
  sessionContextStore: store,
});

const sessionId = crypto.randomUUID();

async function step(command: string): Promise<void> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "steps/toolCallRequest",
    params: {
      acs_version: "0.1.0",
      request_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      metadata: { agent_id: "v6-capture", session_id: sessionId },
      payload: { tool: { name: "Bash" }, arguments: { command: { value: command } } },
    },
  };
  const res = await fetch(guardian.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { result?: { decision?: string; reason_codes?: string[] } };
  console.log(`   ACS decision=${json.result?.decision}  reason_codes=${JSON.stringify(json.result?.reason_codes)}`);
}

console.log(`session_id=${sessionId}`);
console.log("step 1:");
await step("echo hello");
console.log("step 2:");
await step("echo hello again");

// The deployment supplying a label, because ACS v0.1.0 carries no field one
// could be read from. This is N25's writer, called with a label no envelope
// delivered -- exactly the seam this slice's own record is about.
console.log('deployment supplies ["confidential"] to this session');
persistIfcLabels(store, sessionId, ["confidential"]);

console.log("step 3:");
await step("echo after the deployment-supplied label");
console.log("step 4:");
await step("echo one more");
console.log("step 5:");
await step("rm -rf /");

await guardian.close();
```

```bash
$ bun run v6-capture.ts .acs/v6-labels-session-context.jsonl
```

Captured verbatim:

```
session_id=e217fd19-44ea-4514-956e-7dd4ab5cc4c2
step 1:
pre_tool_call  source_labels=["public"]  ->  decision=allow  reason=-  result_labels=["public"]
   ACS decision=allow  reason_codes=undefined
step 2:
pre_tool_call  source_labels=["public"]  ->  decision=allow  reason=-  result_labels=["public"]
   ACS decision=allow  reason_codes=undefined
deployment supplies ["confidential"] to this session
step 3:
pre_tool_call  source_labels=["confidential"]  ->  decision=allow  reason=-  result_labels=["confidential"]
   ACS decision=allow  reason_codes=undefined
step 4:
pre_tool_call  source_labels=["confidential"]  ->  decision=allow  reason=-  result_labels=["confidential"]
   ACS decision=allow  reason_codes=undefined
step 5:
pre_tool_call  source_labels=["confidential"]  ->  decision=deny  reason=destructive_shell_command_blocked  result_labels=undefined
   ACS decision=deny  reason_codes=["destructive_shell_command_blocked"]
```

**Step 1 → step 2 is the demo sentence, and it is degenerate.** AGT emitted
`result_labels: ["public"]`, `persistIfcLabels` wrote it into S5, and step 2's snapshot
carried `source_labels: ["public"]` — a real emit, a real persist, a real re-supply, and
the value never changes, because it cannot. `propagated_labels(labels)` is
`[max_sensitivity(labels)]`, so what comes back is always the join of what went in, and
what went in was the seed. **Read on its own, step 1 → step 2 is equally consistent with
the labels not being carried at all**, which is exactly why the rest of this capture
exists.

**Step 3 → step 4 is the same round trip with a label the floor cannot reach**, and every
part of it is AGT's except the escalation: the deployment wrote `["confidential"]` into
S5, step 3's snapshot carried it, **AGT** emitted `result_labels: ["confidential"]`, N25
persisted *that*, and step 4's snapshot carried what AGT returned rather than what the
deployment wrote. Step 2's labels came from a verdict too, but they are indistinguishable
from the seed; step 4 is the only step in this file whose `source_labels` both came out of
an AGT verdict *and* differ from what the session started with.

**Step 5 is the `undefined` case, live.** The pattern gate answered, so the verdict has no
`result_labels` member at all — and `persistIfcLabels` returns without touching S5, which
is why step 5's own `source_labels` is still `["confidential"]` and would remain so for a
step 6. An explicitly empty `result_labels` would have cleared them instead. Those two
being different answers is the whole reason `persistIfcLabels` takes
`IfcLabels | undefined` rather than a plain array.

The chain that run wrote, all five lines, verbatim from
`.acs/v6-labels-session-context.jsonl`:

```json
{"session_id":"e217fd19-44ea-4514-956e-7dd4ab5cc4c2","seq":1,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","recorded_at":"2026-08-15T10:56:40.096Z","method":"steps/toolCallRequest","request_id":"46528a23-4786-4f1b-86e1-ae018a752035","tool_name":"Bash","hash":"48e9ff6fc45ac37ec0501c71f03de88317973e801b6164e7bd9cbf5f4a0ccd10"}
{"session_id":"e217fd19-44ea-4514-956e-7dd4ab5cc4c2","seq":2,"prev_hash":"48e9ff6fc45ac37ec0501c71f03de88317973e801b6164e7bd9cbf5f4a0ccd10","recorded_at":"2026-08-15T10:56:40.674Z","method":"steps/toolCallRequest","request_id":"082ffd5b-524f-4c0e-89a7-759d46be3a9b","tool_name":"Bash","hash":"8b59f9ff44fa85bc28c0256984a240a6b1998ad32ec6871e634f0c354c5828ea"}
{"session_id":"e217fd19-44ea-4514-956e-7dd4ab5cc4c2","seq":3,"prev_hash":"8b59f9ff44fa85bc28c0256984a240a6b1998ad32ec6871e634f0c354c5828ea","recorded_at":"2026-08-15T10:56:40.744Z","method":"steps/toolCallRequest","request_id":"849afda5-7b3d-43e1-b910-6025d0d1eeb3","tool_name":"Bash","hash":"2020ca6ebbe5c8ecd7566506e4d95483a1861db7bd3989bbfe298bf3aac9d8cc"}
{"session_id":"e217fd19-44ea-4514-956e-7dd4ab5cc4c2","seq":4,"prev_hash":"2020ca6ebbe5c8ecd7566506e4d95483a1861db7bd3989bbfe298bf3aac9d8cc","recorded_at":"2026-08-15T10:56:40.809Z","method":"steps/toolCallRequest","request_id":"63053d89-0f6c-4485-a365-58e5ee7e014a","tool_name":"Bash","hash":"f7454b4a456e6d575d6c0b18c84f65244a688b33c8556c4993aa3470a0813da3"}
{"session_id":"e217fd19-44ea-4514-956e-7dd4ab5cc4c2","seq":5,"prev_hash":"f7454b4a456e6d575d6c0b18c84f65244a688b33c8556c4993aa3470a0813da3","recorded_at":"2026-08-15T10:56:40.883Z","method":"steps/toolCallRequest","request_id":"a67a8882-463f-4cce-b843-b8bde100433e","tool_name":"Bash","hash":"d37b57bbcfe09c65da86be8955c73041b33fa8bc6835e3a881fa4e4a3b5349b8"}
```

Five entries for five steps, each `prev_hash` the previous line's `hash`, and the denied
step is `seq: 5` — the chain again records the step and not its outcome. The
`deployment supplies` line between steps 2 and 3 wrote no entry, because it is not a step:
`evaluateStep` is the Guardian's only call site for `appendContextEntry`.

## What the gate does, by label alone

Six snapshots, one real bridge, and no Guardian, no envelope and no session at all — the
question here is what AGT does, so nothing between the caller and AGT is in the picture.
The script as run, with four of its six probe literals elided exactly where the `…` marks
them and every other line verbatim — each elided probe is the same object shape as the two
shown, carrying the labels its own `name` states:

```ts
// Six snapshots, one real bridge, no Guardian and no host: what AGT's stock
// IFC gate does to a snapshot depending only on the labels it carries.
import { createBridge } from "./packages/agt-bridge/src/index.ts";

const bridge = createBridge("policy/manifest.yaml");
const budgets = { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } };

const probes: { name: string; snapshot: Record<string, unknown> }[] = [
  {
    name: 'rm -rf /, no `input` member at all',
    snapshot: { envelope: budgets, tool_call: { name: "Bash", args: { command: "rm -rf /" }, id: "p1" } },
  },
  // … four more, identical in shape: `rm -rf /` with `input: { ifc: { source_labels:
  // ["public"] } }`; `ls -la` with no `input` member; `ls -la` with `source_labels: []`;
  // `ls -la` with `source_labels: ["public"]` …
  {
    name: 'ls -la,   source_labels ["secret"]',
    snapshot: {
      envelope: budgets,
      tool_call: { name: "Bash", args: { command: "ls -la" }, id: "p6" },
      input: { ifc: { source_labels: ["secret"] } },
    },
  },
];

for (const probe of probes) {
  const verdict = await bridge.evaluate("pre_tool_call", probe.snapshot as never);
  console.log(
    `${probe.name.padEnd(38)}  ->  ${verdict.decision.padEnd(5)}  ${(verdict.reason ?? "-").padEnd(28)}  result_labels=${JSON.stringify(verdict.result_labels)}`,
  );
}
```

Captured verbatim:

```
rm -rf /, no `input` member at all      ->  deny   ifc_clearance_violation       result_labels=undefined
rm -rf /, source_labels ["public"]      ->  deny   destructive_shell_command_blocked  result_labels=undefined
ls -la,   no `input` member at all      ->  deny   ifc_clearance_violation       result_labels=undefined
ls -la,   source_labels []              ->  deny   ifc_clearance_violation       result_labels=undefined
ls -la,   source_labels ["public"]      ->  allow  -                             result_labels=["public"]
ls -la,   source_labels ["secret"]      ->  deny   ifc_clearance_violation       result_labels=undefined
```

Read row by row, that is all three framing findings at once:

- **Rows 1 and 2 are finding 2.** The same `rm -rf /`, the same bundle, the same config —
  and the reported reason changes with the label. Without one, the reason a reader is
  handed is `ifc_clearance_violation`, which is true and is not why that command is
  dangerous.
- **Rows 3 and 4 are finding 1.** A completely benign `ls -la` is **denied** when it
  carries no labels, and denied identically when it carries an explicitly empty set. A
  session with no seed is a session that can do nothing, and "no labels" is not a quiet
  default — it is the deny.
- **Rows 5 and 6 are the gate doing its actual job.** `confidential` (this deployment's
  `sink_clearance`, `policy/lib/data.json`) dominates `public` and does not dominate
  `secret`. Row 5 is also the only row that returns `result_labels` at all, which is what
  the round trip above carries.

## The cost to a caller that has no session concept — measured, not asserted

`packages/agt-bridge/test/bridge.test.ts` predates every part of this slice, builds its
snapshots by hand, and knows nothing about sessions. Turning the gate on made
`input.ifc.source_labels` a required member of its fixtures too. Measured by deleting the
label from exactly one of its tests — `{ ...snapshotFor(cmd), ...publicLabel }` back to
`{ ...snapshotFor(cmd) }` — and re-running that file:

```bash
$ bun test packages/agt-bridge
```

```
bun test v1.3.14 (0d9b296a)

packages/agt-bridge/test/bridge.test.ts:
43 |     expect(verdict.reason).toBe("destructive_shell_command_blocked");
44 |   });
45 | 
46 |   it("allows benign commands", async () => {
47 |     for (const cmd of ["ls -la", "git status"]) {
48 |       expect((await bridge.evaluate("pre_tool_call", { ...snapshotFor(cmd) })).decision).toBe("allow");
                                                                                              ^
error: expect(received).toBe(expected)

Expected: "allow"
Received: "deny"

      at <anonymous> (/Users/arielfogel/Pillar/ACS_reference_implementation/packages/agt-bridge/test/bridge.test.ts:48:90)
(fail) agt-bridge > allows benign commands [73.76ms]

 8 pass
 1 fail
 16 expect() calls
Ran 9 tests across 1 file. [1155.00ms]
```

The label was put back immediately and that file re-run clean (9 pass, 0 fail); `git diff`
on it is empty, so the tracked file is byte-identical to what is committed. What
the failure shows is the shape of the cost: **`ls -la` and `git status`, denied**, in a
package that has no way to know a session exists. Every snapshot builder in the
deployment inherits that, not only the ones this slice touched.

## U22 reads the chain, and tells a broken one from a whole one

The Inspector, pointed at the first capture's log. Its envelope and audit logs are pointed
at paths that do not exist, so only U22's rows appear — that absence is the Inspector's
own healthy-absence case and is why nothing is reported about them:

```bash
bun run inspector -- --from-start \
  --session-context-log .acs/v6-runbook-session-context.jsonl \
  --envelope-log /tmp/acs-none.jsonl \
  --audit-log /tmp/acs-none-audit.jsonl
```

```
Envelope Inspector — tailing /tmp/acs-none.jsonl, /tmp/acs-none-audit.jsonl, and .acs/v6-runbook-session-context.jsonl (from the start)
Ctrl-C to stop.

last_observed_posture=(none observed)  fail-open proceeds=0

#1  Bash  hash=a578a54aafc7  session=8186ca06-9db3-41b0-ba1a-ddcc044f3fd3

#2  Bash  hash=43fc8603e517  session=8186ca06-9db3-41b0-ba1a-ddcc044f3fd3
```

(One elision in that block and nothing else edited: a tail runs until it is stopped, so
`bun`'s own "terminated by signal SIGTERM" line at the end is dropped. `hash=` is the first
12 characters of the row's own `hash`, which the two JSONL lines above carry in full — the
abbreviation is for a reader, and the check below always compares the full digests.)

**And it is a check, not a decoration.** A *copy* of that log — the tracked run's own file
is never touched — with the second line's `prev_hash` rewritten to a digest that never
existed, which is exactly the shape deleting an entry from the middle of a chain leaves
behind:

```bash
cp .acs/v6-runbook-session-context.jsonl /tmp/tampered.jsonl
bun -e '
const fs = require("node:fs");
const p = process.argv[1];
const lines = fs.readFileSync(p, "utf8").trim().split("\n");
const second = JSON.parse(lines[1]);
second.prev_hash = "0".repeat(63) + "1";
lines[1] = JSON.stringify(second);
fs.writeFileSync(p, lines.join("\n") + "\n");
' /tmp/tampered.jsonl
```

Same Inspector, same flags, pointed at the copy — the banner and posture badge above are
identical to the run before it apart from the path, and only the two rows are shown here:

```
#1  Bash  hash=a578a54aafc7  session=8186ca06-9db3-41b0-ba1a-ddcc044f3fd3

✖ CHAIN BREAK  #2  Bash  hash=43fc8603e517  session=8186ca06-9db3-41b0-ba1a-ddcc044f3fd3
```

Row 1 is unchanged and unmarked — it is the first entry this reader has seen for that
session, so there is nothing recorded yet to compare its `prev_hash` against. Row 2 is
marked, and its own `hash` is unchanged from the untampered run, which is what shows the
break was detected from the link rather than from the row's contents differing.

## Verify

Full suite, typecheck, and the pin gate, against this tree as it stands at the end of this
slice:

```bash
$ bun test
```

```
bun test v1.3.14 (0d9b296a)

packages/guardian/test/server.test.ts:
session context log disabled after failure (/Users/arielfogel/Pillar/ACS_reference_implementation/packages/guardian/tmp-session-log-blocker-b22f9de9-5ec8-4766-8ca1-8b94c0635023.txt/session-context.jsonl): EEXIST: file already exists, mkdir '/Users/arielfogel/Pillar/ACS_reference_implementation/packages/guardian/tmp-session-log-blocker-b22f9de9-5ec8-4766-8ca1-8b94c0635023.txt'

 791 pass
 1 skip
 0 fail
 2259 expect() calls
Ran 792 tests across 46 files. [16.88s]
```

**That stderr line is a test doing its job, not a fault.** `packages/guardian/test/server.test.ts`
points a Guardian's session-context log at a path whose parent is a plain file, so the
projection cannot be created; the appender disables itself, says so once, and the test then
asserts the governed tool call still comes back `allow`. The message is the appender
reporting, and its presence in a green run is part of the evidence that a failing
projection cannot turn a governed step into a denied one.

```bash
$ bun run typecheck
```

```
$ tsc -p tsconfig.json --noEmit
```

(No output after the command line is the successful case — zero type errors, whole
workspace, strict mode.)

**`bun run verify:pin` is what keeps R2.1/R2.2/R2.3 honest for a slice that turned a
policy gate on.** It re-clones AGT at the ref `agt.lock` names and byte-diffs every
`.rego` in `policy/lib` against it, which needs network access and is why it is a separate
command from `bun test`:

```bash
$ bun run verify:pin
```

```
$ bash scripts/verify-pin.sh
bun test v1.3.14 (0d9b296a)

 5 pass
 0 fail
 37 expect() calls
Ran 5 tests across 1 file. [52.00ms]
```

Zero Rego authored: the IFC gate is turned on by one key of `data.agt.defaults.config` in
`policy/lib/data.json` — `ifc.sink_clearance: "confidential"` — and that file is the one
`test/pin.test.ts` allows for by name, asserting the bundle carries no added file except
`data.json`.

## What this slice measured in pieces, and did not measure end to end

**No single test drives a real Guardian over two steps against the real bundle and asserts
the labels.** One test does drive a real Guardian over two steps against the real bundle,
and what it asserts is the *chain* — `seq`, the `prev_hash` link, the two `request_id`s
(`packages/guardian/test/server.test.ts`). The label half of the round trip is covered by
three further measurements, and the seam is worth stating because a reader could otherwise
take the sum for a single end-to-end proof:

- `test/ifc-round-trip.test.ts` drives the **real bundle** through `createBridge` and
  asserts a carried label comes back as `result_labels`, that an empty set denies, that
  the snapshot-root path reads nothing, and that a labelled destructive command still
  denies for the pattern's own reason.
- `packages/guardian/test/ifc-labels.test.ts` asserts the **store** carries labels across
  steps, keeps sessions apart, distinguishes absent from empty, and copies on both reads
  and writes.
- `packages/guardian/test/server.test.ts` drives a **real Guardian over HTTP** and asserts
  that what one step's verdict returned is what the next step's snapshot carries — through
  a stub bridge, because a controlled `result_labels` is the point of that assertion.

The split is defensible rather than merely convenient: a single end-to-end test would today
be able to show only `public → public`, for the reason "The label emitted at one step,
arriving at the next" states in full — and it would pass identically if the labels were not
carried at all. That section is what covers the gap, and it is a capture rather than a
test.

## What was not verified

- **No host appears in this runbook.** Claude Code and OpenCode both send the same
  envelopes they sent in V4 and V5 and neither shim changed for this slice, but nothing
  here measures either one against a Guardian keeping session state, and nothing here
  shows how either renders any of it.
- **No capture above drives the result gate.** Every envelope in this file is a
  `steps/toolCallRequest`. What covers that gate is tests rather than captures:
  `assemblePostToolCallSnapshot` emits `input.ifc.source_labels` the same way its twin does
  (`packages/guardian/test/assemble-snapshot.test.ts`), and `test/redaction.test.ts` drives
  the real bundle at `post_tool_call` and measures a clean allow coming back as
  `{decision: "allow", result_labels: ["public"]}` — so AGT does emit labels there. Nothing
  here shows that crossing a live Guardian.
- **S4 is never exercised by any capture, and has no shipped writer.** `setIntent` keeps
  the first intent a session declares and drops later ones — asserted in
  `packages/guardian/test/session-context.test.ts` — but no code on the Guardian's request
  path calls it, so no run in this file records an intent. ACS's own
  `hooks/tool-call-request.json` does carry an optional `intent` object; wiring it is not
  in this slice.
- **Nothing here is a claim about concurrency.** `seq` and `prev_hash` are assigned inside
  one synchronous `append` in the Guardian's single process, which is why S3 never
  depended on S14's cross-process counter; no capture drives concurrent steps, and none is
  needed for the claim as stated.
- **Every timestamp, id and hash above is real, and only some of them reproduce.** The
  `request_id`s and `session_id` in the first capture are literals in the commands shown, so
  re-running those exact commands reproduces them; the `recorded_at` values will not, and
  neither will any `hash`, because `hashEntry` covers `recorded_at`. The ids in the
  label-carriage capture are generated per run and will differ every time. What should match
  on any re-run is every `decision`, `reason`, `reason_codes`, the labels at each step, the
  `prev_hash`/`hash` linkage within a run, and the chain-break marking.
