# V3: All five dispositions, and both failure postures

## Slice Contract

| Field | Value |
|---|---|
| Slice ID | [#4](https://github.com/afogel/ACS_reference_implementation/issues/4) |
| Slices doc | `docs/shaping/acs-reference-impl-slices.md` §V3, **line 112** |
| Demo | *(as written at planning time — **corrected by this plan**, see Corrections)* "One bundle produces allow, deny, ask, defer, and a rewritten tool call. Then kill the Guardian mid-flight twice — once under `on_decision_failure: proceed`, where the step proceeds and an audit event appears; once under `deny`, where it blocks. Same adapter, same policy, posture negotiated at handshake." |
| Components | **U23** inspector posture badge (negotiated `on_decision_failure` + count of audited fail-open proceeds) · **N6** `applyFailurePosture()` · **N7** `validateDecision()` · **N27** `denyOnInvalidEnvelope()` · **N51** `tailAuditSinks()` · **S14** audit sink |
| Parked items | Nothing is deferred *out* of §V3. §V3 is itself the destination for two earlier parks: the S13 cross-process blocker (V1) and the hookmap's `defer → permissionDecision: deny` gap (V1 fix wave finding 5). |
| Watch-for notes | Copied verbatim below. |
| Corrections | §V3 carries one ⚠️ (the S13 blocker). This plan adds four more — see Corrections. |
| Requirements | R1.5, R1.6, R1.7, R1.8 (all four 🟡 in the shaping doc's R table), plus R1.2 moving from unit-tested to live for all five AGT verdicts. |

### Watch-for notes, verbatim from §V3

> **Two failure domains, kept separate.** AGT fails closed on *evaluation* — bad policy output, invalid transform, missing paths — and that produces a `deny` **verdict**, which §6.4 says the host MUST honor regardless of posture. N27 exists so Guardian-side failures also arrive as decisions rather than bare errors, keeping them in that honored path. `on_decision_failure` only governs *delivery*: Guardian silent, transport dead, error with no decision. Conflating the two would either break AGT's invariant or halt production on a network blip.

> **⚠️ Blocker discovered in V1 — S13 has no home across processes.** V1 built `S13` as an in-process store, but the Claude Code shim is a **fresh subprocess per hook invocation**, so an in-memory negotiated session config can never survive to the next hook. `handshake()` is also not called on the real path in V1 at all. `N6 applyFailurePosture()` reads S13, so V3 cannot work until this is resolved: either persist the negotiated config (a session-keyed file), or have the shim talk to a session-scoped daemon. The choice ripples — V5's second host is in-process and would not share the constraint, and V6's session chain sits on the same seam. Decide this before V3 starts.

> **Rest of the slice is data, not structure.** Disposition coverage lives in S1 (every ACS decision → `permissionDecision` / `updatedInput`) and S8 (stock rules configured to actually fire allow, deny, escalate, transform, and drift-warn). Once the adapter is generic, coverage is configuration.

> Wire N21's error branch to N27, and N4's return through N7 here.

The last of those is a wiring instruction, and this plan honours it: Task 6 replaces `dispatch`'s `EnvelopeValidationError` branch (N21's error branch) with N27, and Task 7 routes `guardianClient.post`'s return (N4) through `validateDecision` (N7) before `renderDecision`.

The third one is **partly wrong**, and Task 5 is why — see Corrections.

---

## Decisions taken during planning

Five choices this plan closes. Each is written back into the slices doc in the same PR (see Corrections and Amendments).

### P1 — S13 lives in a session-keyed file. *(The §V3 blocker, decided by the human partner.)*

The first hook of a session handshakes and writes the ServerHello to `.acs/sessions/<session_id>.json`; later hooks read it and skip the round trip. Claude Code puts `session_id` in every hook payload, so the key costs nothing.

The disqualifier for the alternatives is *when* the value is needed. The posture exists for the case where the Guardian gives no usable decision, so it cannot be fetched from the Guardian at the moment of use — which rules out re-handshaking per hook. A session-scoped daemon would work, but costs a third process to start, supervise and discover, breaks R7.1's "one command on a laptop", and V5's in-process host would share none of it.

The shape this produces is better than a workaround: `S13` becomes **one interface with two implementations** — file-backed for subprocess hosts, in-memory for V5's in-process plugin — so the adapter stops caring how the host runs. That is R3.4 strengthened, not weakened.

### P2 — `defer` comes off the demo. ACS is the wider contract; that is the point, not a gap.

AGT's verdict vocabulary is exactly five: `allow`, `warn`, `deny`, `escalate`, `transform`. **No AGT verdict maps to ACS `defer`**, and `mapping.yaml` correctly declares no rule producing one. The only conformant route to `defer` is ACS §9.2's approver-incapable substitution, which the spec deliberately keeps **off the wire** in v0.1 ("ACS does not put this declaration on the wire in v0.1; it is part of the Guardian's policy bundle") — so it is a Guardian policy choice, driven by no AGT verdict at all.

Manufacturing one would invert this project's thesis. R1 is *"AGT is completely expressible in ACS"* — one direction. ACS carrying a disposition AGT has no need for is headroom in the standard, and V3 says so plainly rather than filling it.

So V3 demonstrates **AGT's five verdicts arriving losslessly** — `allow`, `deny`, `ask` (from `escalate`), `modify` (from `transform`), and `warn` as `allow` with non-empty `policy_references` — which is R1.2 made live. `defer` is recorded as ACS surface with no AGT counterpart.

### P3 — Several config states over one pinned bundle, and that is stated as a mechanic, not a finding.

Verified by running it (`policy/lib/agt_default.rego` and the spike in *Evidence* below): the stock priority chain is `deny > escalate > transform > warn > allow`, and the escalate gate is a **single global switch**, `cfg.approval.required`. The manifest's own `approval:` section configures `default_resolver`, `timeout_seconds`, `on_timeout`, `fatigue_threshold`, `fatigue_window_seconds`, `resolvers` — resolution, not scope. So with approval on, every step that is not denied escalates, and `allow`/`transform`/`warn` become unreachable in that same config.

Consequence: showing several verdict classes means several **config documents** over the same pinned bundle. Zero Rego is authored either way, so R2.1 is untouched, and R2.4 is untouched (`data.agt.defaults.config` is the declared surface being driven).

Per **R4.3** this is a mechanic of the demo and is written that way. AGT's stock library is a starting default for hosts that author no Rego; a host wanting one deployment to both auto-allow and require approval writes a rule, which is what the Rego surface is for. Nothing here is a defect, and the runbook must not read as though it were.

### P4 — `warn` is produced through a manifest-declared annotator, in a manifest used only for that case.

The only stock rule emitting `warn` is `drift.warn_if_drift`, gated on `input.annotations.drift_score`. Verified: **annotations do not come from the snapshot** — placed at the top level, under `envelope`, under `tool_call`, under `context`, or under two snake_case aliases, every one is dropped. They come from a manifest-declared annotator dispatched through the SDK's `annotatorDispatcher`, a surface published in `AgentControl.fromPath`'s own type signature (so R2.4 holds).

Two consequences, both recorded:

1. `warn` is reachable, and V3 makes it live — closing the gap V2 left open, where U21's `◐ ALLOW (policy fired — ACS "warn")` badge state was unit-tested but never seen.
2. The score has **no source on the ACS v0.1.0 wire.** `hooks/tool-call-request.json` carries `tool`, `operation`, `capability`, `arguments`, `raw_command`, `intent` — nothing a drift or confidence score could be honestly derived from. So the Guardian must originate it. AGT's own design says as much ("Hosts run a behaviour-drift detector **outside the policy engine**"), and the Guardian is the host in this architecture — so this is AGT working as intended, and a note about ACS v0.1.0's coverage. It goes to V7's matrix as a resolved cell with a named reason, exactly as D10's attributes did.

The annotator therefore lives in `policy/manifest.drift.yaml` — same `bundle: lib`, same pinned Rego — used by the `warn` test and the runbook's `warn` step only. The main `policy/manifest.yaml` is untouched, so no existing test changes behaviour, and a deployment that wants no annotator has none.

### P5 — A deny decision requires an addressable request; below that, a JSON-RPC error is the honest answer.

`response-envelope.json`'s `AcsResult` requires `type`, `acs_version`, `request_id`, **and** `decision`. N27 turns Guardian-side failures into `deny` decisions, but an envelope that failed validation may not carry a usable `params.request_id`.

So N27 degrades in one declared step: use `params.request_id` when it is a string; otherwise the JSON-RPC `id` when that is a string or number; otherwise **return a JSON-RPC error, not a decision**. A response that cannot name the request it answers is not a decision any host could correlate, and inventing an id would be worse than the error. A JSON parse failure (`-32700`) keeps its error for the same reason — there is no envelope at all.

---

## Evidence gathered during planning

Everything above that says "verified" was run against this tree at the pinned ref, not read. Scripts were scratch-only; their results:

| # | Question | Result |
|---|---|---|
| 1 | Does the stock bundle deny on a destructive command through config alone? | Yes. `{"decision":"deny","reason":"destructive_shell_command_blocked","message":"matched pattern … at offset 0"}` |
| 2 | Does `cfg.approval.required: true` scope to anything? | No. `ls -la` → `{"decision":"escalate","reason":"approval_required","message":"requires approval from [\"security-team\"]"}`. Same config, `rm -rf /` → `deny`. Approval swallows every non-denied step (P3). |
| 3 | What does a `transform` verdict carry? | `{"decision":"transform","reason":"redaction_applied","transform":{"path":"$policy_target","value":"echo [REDACTED]"}}`, **and** the SDK returns `transformedPolicyTarget: "echo [REDACTED]"` — the substitution is already applied, so the Guardian never re-applies it. |
| 4 | Can the snapshot carry `annotations`? | No. Five placements tried, all dropped, all verdicts `allow` with a `confidence.min_score` gate that should have denied. |
| 5 | What are AGT's policy-input members? | Observed directly from a dispatcher's `preliminaryPolicyInput`: `["intervention_point","policy_target","snapshot","annotations","tool"]`. This is R1.3's "five members", named. |
| 6 | Is `warn` reachable? | Yes, with `annotators: {drift_score: {type: classifier}}` plus per-point `annotations: {drift_score: {from: "$.tool_call.args.command"}}` and a dispatcher returning a number → `{"decision":"warn","reason":"drift_detected","message":"drift_score 0.9 reached threshold 0.5"}`. |
| 7 | What does the manifest accept? | Enumerated from the Rust core's own validation errors. Top level: `agent_control_specification_version`, `metadata`, `extends`, `policies`, `intervention_points`, `tools`, `annotators`, `approval`. Per intervention point: `policy_target`, `policy_target_kind`, `tool_name_from`, `annotations`, `policy`. `approval`: `default_resolver`, `timeout_seconds`, `on_timeout`, `fatigue_threshold`, `fatigue_window_seconds`, `resolvers`. Annotator `type`: `classifier` \| `llm` \| `endpoint`. |
| 8 | Does the shipped SDK expose a config/data push? | No. `data.agt.defaults.config` is loaded from the bundle directory, so varying config means varying the bundle directory (P3, Task 9's helper). |

Two of these change what the plan can claim, and both are written back into the slices doc: #2 (P3) and #4/#6 (P4).

---

## Global Constraints

Every task is bound by these. They are the reviewer's attention lens.

1. **Two failure domains never merge.** An arriving `deny` — whoever produced it — is honoured regardless of posture (R1.5, §6.4). `on_decision_failure` governs *delivery only*: silent Guardian, dead transport, or an error response carrying no decision. No code path may let a posture override a decision that arrived, and none may let a delivery failure masquerade as a policy decision.
2. **The audit sink is total, exactly as the envelope tap is (N26's constraint 8, now S14's).** It never throws, never delays a decision, never changes one. A sink that cannot write degrades observability and nothing else.
3. **Every fail-open proceed is audited** (§6.4's MUST). A proceed with no audit entry is a silent bypass and is the one outcome this slice exists to make impossible.
4. **The spec default ships.** `on_decision_failure: "proceed"` (D8, R1.7). `defer_details.timeout_decision` and `ask_details.timeout_disposition` default to `deny` — deliberately the opposite, per §6 — and code must read the decision's own field, defaulting to `deny`, never assume.
5. **Decisions are lowercase on the wire** (C7): `allow|deny|modify|ask|defer`.
6. **Zero Rego is authored.** Behaviour comes from `data.agt.defaults.config`, manifests, and hookmaps only (R2.1). `policy/lib/*.rego` stays byte-identical to upstream; `test/pin.test.ts` is the gate.
7. **R3.2 / R3.3 hold.** No AGT vocabulary in `packages/host-adapter` or `hosts/`; no host vocabulary in `packages/agt-bridge`. `test/invariants.test.ts` is the gate, and it is a grep gate — a comment containing "AGT" fails it.
8. **R5.1 / R5.2 hold, and R5.2 widens.** `packages/inspector/src` names no AGT and no host vocabulary, and imports nothing from `guardian`, `agt-bridge`, **or `host-adapter`** (Task 8 adds the third). The Inspector declares its own types and a round-trip contract test keeps them honest — the V2 precedent, applied to S14.
9. **`session_id` is untrusted input.** It arrives in a host payload and becomes part of a filesystem path. Anything that is not `[A-Za-z0-9._-]{1,128}` is rejected, and `.` / `..` are rejected outright. A traversal must be impossible, not unlikely.
10. **A deny decision must name the request it answers** (P5). Where it cannot, a JSON-RPC error is returned instead. No synthesized `request_id`, ever.
11. **`modifications` is validated before it is applied** (§6.3, R1.8). `modified_content` is exclusive of `redactions`/`parameter_overrides`; `redactions` paths and `parameter_overrides` keys must be disjoint — no ancestor/descendant overlap either. A violation is `DENY`, never a best-effort apply.
12. **Framing discipline (R4.3, R4.4).** AGT's stock config granularity is a mechanic of this demo, never a deficiency. No document produced by this slice may read as though AGT got something wrong.
13. **No new outbound identity.** Commits carry the existing git identity and nothing added — no `Co-Authored-By`, no tool signature, no generated-with footer.

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U23 inspector posture badge | Task 8 | Negotiated posture + fail-open proceed count |
| N6 `applyFailurePosture()` | Task 4 | Needs the client timeout added in the same task |
| N7 `validateDecision()` | Task 6 | Plus `applyModifications` — see Scope added |
| N27 `denyOnInvalidEnvelope()` | Task 7 | Replaces `dispatch`'s error branches |
| N51 `tailAuditSinks()` | Task 8 | Inspector declares its own `AuditEntry` |
| S14 audit sink | Task 3 | Total by construction |
| ⚠️ Blocker: S13 has no home across processes | Task 2 | Resolved as P1 — session-keyed file |
| Watch-for: two failure domains kept separate | Global Constraint 1; asserted in Tasks 4, 7, 9 | |
| Watch-for: rest of the slice is data, not structure | **Partly wrong** — Task 5 and Task 6 are structure. See Corrections | |
| Watch-for: wire N21's error branch to N27 | Task 7 | |
| Watch-for: wire N4's return through N7 | Task 7 | |
| Parked from V1: hookmap `defer → permissionDecision: deny` | Task 6 | Kept, with the reason restated; `defer` is unreachable from AGT (P2) so it stays a guard, not a path |
| R1.5 AGT `deny` honoured regardless of posture | Task 4 (posture cannot override), Task 9 (end to end) | |
| R1.6 `transform`'s `$policy_target` survives as ACS `modify` | Task 5 (Guardian side), Task 6 (host side) | |
| R1.7 delivery failure applies the negotiated posture, every proceed audited | Task 4, Task 7 | |
| R1.8 three mandatory fail-closed cases | Task 6 | Malformed `modifications`, DEFER expiry, ASK expiry |
| R1.2 five verdicts, live rather than unit-tested | Task 9 | Includes `warn` via P4 |

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 7 updates `docs/demos/v2-runbook.md` and `README.md` | V2 | N27 changes what V2's Inspector renders for a schema-invalid envelope: `✖ ERROR -32010` becomes `● DENY`. Both documents quote the old output as *captured* output. V2's own watch-for predicted this ("The Inspector is where that change will become visible"), so leaving them stale would make two documents lie about a run. |
| Task 5 extends `mapping.yaml` | V7 | `mapping.yaml` has two consumers that must never disagree — the runtime and V7's harness. A `modifications` synthesis added only in code would make V7 publish an incomplete table. |
| Task 8 widens the R5.2 gate in `test/invariants.test.ts` | V2 | The gate is V2's. S14 is a host-side artifact the Inspector now reads, so the gate must forbid importing `host-adapter` too, or R5.2 quietly weakens the moment N51 lands. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| S13 file-backed store + session-id validation (Task 2) | N6 reads S13; V1's in-memory store is empty in every hook process | §V3 blocker resolved as P1 |
| `guardianClient.post` gains a timeout (Task 4) | §6.4 defines decision failure as "no usable decision **within the negotiated timeout**". V1's client has no timeout, so a silent Guardian hangs the hook forever and N6 can never fire | New row under §V3 |
| `applyModifications` + hookmap change (Task 6) | V1's hookmap copies the raw ACS `modifications` object into Claude Code's `updatedInput`. Claude Code expects a `tool_input` shape, so the "rewritten tool call" in the demo would arrive as an unusable object. R1.6 is not satisfied by carrying `modifications` — it is satisfied by the rewrite taking effect | §V3 gains a structure row, correcting "data, not structure" |
| `mapping.yaml` gains `modifications` synthesis (Task 5) | `mapVerdict` currently emits `decision: modify` with **no** `modifications` field, which §6 makes invalid (MODIFY requires it) | New row under §V3; noted for V7 |
| R5.2 gate widened to `host-adapter` (Task 8) | Keeps the Inspector wire-only now that it reads a host-side artifact | §V2 scope-added row gains a line |
| Per-config bundle helper, test-only (Task 9) | P3: config lives in the bundle directory and the SDK exposes no data push, so covering five verdict classes means five config documents | New row under §V3 |
| `policy/manifest.drift.yaml` + optional annotator dispatcher (Task 9) | P4: `warn` is otherwise unreachable, leaving R1.2 unit-tested only | New row under §V3 |

---

## Corrections to §V3 (written into the slices doc in this PR)

1. **⚠️ Demo corrected — `defer` is not producible from AGT.** See P2. The demo sentence promises five ACS dispositions from one bundle; AGT's vocabulary has no `defer`, and ACS §9.2 keeps the only route to one off the wire in v0.1. New demo: *"One bundle produces allow, deny, ask, and a rewritten tool call, plus a policy-fired allow that is AGT's `warn`. Then kill the Guardian mid-flight twice — once under `on_decision_failure: proceed`, where the step proceeds and an audit event appears; once under `deny`, where it blocks. Same adapter, same policy, posture negotiated at handshake."* ACS `defer` is recorded as surface with no AGT counterpart — headroom in the standard, not a gap in the demo.
2. **⚠️ "Rest of the slice is data, not structure" is partly wrong.** Two structural pieces are load-bearing and neither is configuration: `mapVerdict` synthesizing `modifications` from an AGT `transform` verdict (Task 5), and the adapter applying those modifications to produce the host's `updatedInput` (Task 6). Without both, `modify` is a decision nothing acts on. Disposition *coverage* is indeed configuration; the `modify` **path** is not.
3. **⚠️ AGT's stock approval gate is a single global switch.** See P3. Recorded as a mechanic of the demo per R4.3, with the manifest's `approval:` field list as evidence.
4. **⚠️ AGT's `annotations` policy-input member does not come from the snapshot.** See P4, evidence rows 4–6. Consequence for V7: the drift score has no ACS v0.1.0 wire source, so a wire consumer cannot drive AGT's `warn` gate — the Guardian must originate it.
5. **D8 closes: `proceed`.** R1.7 and `handshake.json`'s own default both fix it; V1 already ships it in `handshakeResponder()`. V3 makes it configurable per deployment (`ACS_ON_DECISION_FAILURE`) so the demo can show both, with `proceed` as the default when unset.

---

## Tasks

### Task 1: Guardian declares its posture · slice #4 · N28 (V3 extension)

The smallest independently testable piece, and everything downstream negotiates against it. `handshakeResponder()` currently returns a hardcoded `"proceed"`; the demo needs both postures from one binary.

**Files:**
- Modify: `packages/guardian/src/handshake.ts` (lines 40–56)
- Modify: `packages/guardian/test/handshake.test.ts` *(create if absent — V1 tested the responder inside `server.test.ts`; check first with `grep -rn "handshakeResponder" packages/guardian/test`)*

**Interfaces:**
- Consumes: nothing new.
- Produces: `handshakeResponder(env?: { ACS_ON_DECISION_FAILURE?: string })` → `ServerHello`. The optional argument is how tests set the value without mutating `process.env`; production calls it with no argument and it reads `process.env`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/guardian/test/handshake.test.ts
import { describe, expect, it } from "bun:test";
import { handshakeResponder } from "../src/handshake.ts";

describe("handshakeResponder — negotiated posture (D8, R1.7)", () => {
  it("ships the ACS spec default when nothing is configured", () => {
    expect(handshakeResponder({}).on_decision_failure).toBe("proceed");
  });

  it("declares fail-closed when the deployment asks for it", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "deny" }).on_decision_failure).toBe("deny");
  });

  it("declares fail-open when the deployment asks for it explicitly", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "proceed" }).on_decision_failure).toBe("proceed");
  });

  // A typo must not silently pick a posture. Fail-open is the spec default,
  // but "dney" is not a request for it -- it is a broken deployment, and a
  // governance tool that guesses here is the whole problem this slice is about.
  it("throws on a value that is neither posture, naming the value", () => {
    expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: "dney" })).toThrow(/dney/);
  });

  it("still declares every ServerHello field handshake.json requires", () => {
    const hello = handshakeResponder({});
    expect(Object.keys(hello).sort()).toEqual(
      ["methods_evaluated", "negotiated_version", "on_decision_failure", "selected_transport", "timeout_config"],
    );
    expect(hello.timeout_config.default_ms).toBe(5000);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/guardian/test/handshake.test.ts
```

Expected: the first three fail on arity (`handshakeResponder()` takes no argument today), the throw test fails because nothing validates.

- [ ] **Step 3: Minimal implementation**

Replace `handshakeResponder` in `packages/guardian/src/handshake.ts`:

```ts
/** The two postures §6.4 defines. Anything else is a broken deployment. */
const POSTURES = ["proceed", "deny"] as const;
type Posture = (typeof POSTURES)[number];

/**
 * The deployment's declared posture. D8 closed on the spec default
 * (`proceed`, per handshake.json's own `default` and R1.7); this makes it
 * configurable so one binary can demo both halves of V3 without a rebuild.
 *
 * A value that is neither posture THROWS rather than falling back. Falling
 * back to fail-open on a typo is exactly the silent-bypass shape this slice
 * exists to remove: the deployment asked for something, and guessing which
 * posture it meant is not available to us.
 */
function readPosture(env: { ACS_ON_DECISION_FAILURE?: string }): Posture {
  const raw = env.ACS_ON_DECISION_FAILURE;
  if (raw === undefined || raw === "") {
    return "proceed";
  }
  if ((POSTURES as readonly string[]).includes(raw)) {
    return raw as Posture;
  }
  throw new Error(
    `ACS_ON_DECISION_FAILURE must be "proceed" or "deny", got ${JSON.stringify(raw)}`,
  );
}

export function handshakeResponder(env: { ACS_ON_DECISION_FAILURE?: string } = process.env): ServerHello {
  return {
    negotiated_version: NEGOTIATED_VERSION,
    methods_evaluated: METHODS_EVALUATED,
    selected_transport: "http",
    timeout_config: { default_ms: DEFAULT_TIMEOUT_MS },
    on_decision_failure: readPosture(env),
  };
}
```

Also update the module doc comment: the V1 note says `on_decision_failure` "ships the spec default, `proceed`" and that applying it is V3. Replace the second half — the value is now deployment-declared, D8 is closed on `proceed` as the default, and N6 (Task 4) applies it.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/guardian/test/handshake.test.ts && bun test && bun run typecheck
```

The full run matters: `server.test.ts` asserts on the ServerHello and must still pass with no `ACS_ON_DECISION_FAILURE` set.

- [ ] **Step 5: Commit**

```
Guardian: let the deployment declare its failure posture

D8 closes on the spec default (proceed). One binary can now demo both
halves of V3 without a rebuild. A value that is neither posture throws --
guessing a posture from a typo is the silent bypass this slice removes.

Slice: #4
Affordances: N28
```

---

### Task 2: S13 gets a cross-process home · slice #4 · S13 (V1 blocker)

**Files:**
- Modify: `packages/host-adapter/src/session-config.ts` (whole file — the memory store stays, a file-backed store joins it)
- Create: `packages/host-adapter/test/session-config.test.ts`
- Modify: `packages/host-adapter/src/index.ts` (export the new factory)

**Interfaces:**
- Consumes: `SessionConfig`, `SessionConfigStore` (already in this file).
- Produces:
  - `createFileSessionConfigStore(options: { dir: string; sessionId: string }): SessionConfigStore` — same interface as the memory store, so N6 and `handshake()` never learn which they hold.
  - `InvalidSessionIdError` — thrown by the factory, not by `get`/`set`.
  - `sessionConfigPath(dir: string, sessionId: string): string` — exported for tests and for the runbook to name the file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/session-config.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSessionConfigStore,
  createSessionConfigStore,
  InvalidSessionIdError,
  sessionConfigPath,
  type SessionConfig,
} from "../src/session-config.ts";

const HELLO: SessionConfig = {
  negotiated_version: "0.1.0",
  methods_evaluated: ["steps/toolCallRequest"],
  selected_transport: "http",
  timeout_config: { default_ms: 5000 },
  on_decision_failure: "deny",
};

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-session-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  // Named removal only: unlink what we know about, then rmdir. A stray file
  // fails loudly instead of being swept away by a recursive delete.
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir)) {
      unlinkSync(join(dir, entry));
    }
    rmdirSync(dir);
  }
});

describe("createFileSessionConfigStore — S13 across processes", () => {
  it("survives the process that wrote it: a second store reads the first's config", () => {
    const dir = scratch();
    createFileSessionConfigStore({ dir, sessionId: "sess-1" }).set(HELLO);

    // A *different* store instance, standing in for the next hook's process.
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toEqual(HELLO);
  });

  it("keeps sessions apart", () => {
    const dir = scratch();
    createFileSessionConfigStore({ dir, sessionId: "sess-1" }).set(HELLO);
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-2" }).get()).toBeUndefined();
  });

  it("returns undefined before any handshake, without creating anything", () => {
    const dir = scratch();
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates the directory on first write", () => {
    const dir = join(scratch(), "nested", "sessions");
    createFileSessionConfigStore({ dir, sessionId: "sess-1" }).set(HELLO);
    expect(existsSync(sessionConfigPath(dir, "sess-1"))).toBe(true);
    // Clean up the nested tree by name, deepest first.
    unlinkSync(sessionConfigPath(dir, "sess-1"));
    rmdirSync(dir);
    rmdirSync(join(dir, ".."));
  });

  // Total on read: a corrupt or unreadable file degrades to "not negotiated",
  // which the caller resolves to the spec default. It must never throw --
  // a throw here would take out the hook process and, with it, the decision.
  it("returns undefined for a file that is not JSON, and does not throw", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionConfigPath(dir, "sess-1"), "{not json");
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toBeUndefined();
  });

  it("returns undefined for JSON that is not an object", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionConfigPath(dir, "sess-1"), "42");
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toBeUndefined();
  });

  it("returns undefined for an object missing on_decision_failure", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionConfigPath(dir, "sess-1"), JSON.stringify({ timeout_config: { default_ms: 1 } }));
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toBeUndefined();
  });

  it("round-trips fields it does not name", () => {
    const dir = scratch();
    const extended = { ...HELLO, profiles_accepted: ["ACS-Core"], skew_window_ms: 1000 };
    createFileSessionConfigStore({ dir, sessionId: "sess-1" }).set(extended);
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()).toEqual(extended);
  });

  it("leaves no partial file behind: a reader only ever sees a complete config", () => {
    const dir = scratch();
    const store = createFileSessionConfigStore({ dir, sessionId: "sess-1" });
    store.set(HELLO);
    store.set({ ...HELLO, on_decision_failure: "proceed" });
    // The rename is atomic, so no .tmp files survive a completed write.
    expect(readdirSync(dir)).toEqual(["sess-1.json"]);
    expect(createFileSessionConfigStore({ dir, sessionId: "sess-1" }).get()?.on_decision_failure).toBe("proceed");
  });
});

describe("createFileSessionConfigStore — session_id is untrusted input (constraint 9)", () => {
  // session_id arrives in a host payload and becomes part of a path. These
  // must be impossible, not unlikely.
  for (const bad of ["..", ".", "../escape", "a/b", "a\\b", "", "sess ", "a".repeat(129)]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => createFileSessionConfigStore({ dir: scratch(), sessionId: bad })).toThrow(InvalidSessionIdError);
    });
  }

  it("accepts the shapes a real host sends", () => {
    const dir = scratch();
    for (const ok of ["demo", "sess-1", "3f2b9c10-4d5e-6f70-8a9b-0c1d2e3f4a5b", "a_b.c-d"]) {
      expect(() => createFileSessionConfigStore({ dir, sessionId: ok })).not.toThrow();
    }
  });
});

describe("createSessionConfigStore — the in-memory store V5 keeps", () => {
  it("still satisfies the same interface", () => {
    const store = createSessionConfigStore();
    expect(store.get()).toBeUndefined();
    store.set(HELLO);
    expect(store.get()).toEqual(HELLO);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/host-adapter/test/session-config.test.ts
```

Expected: every `createFileSessionConfigStore` test fails on the missing export.

- [ ] **Step 3: Minimal implementation**

Append to `packages/host-adapter/src/session-config.ts` (keep the existing `SessionConfig`, `SessionConfigStore`, `createSessionConfigStore` exactly as they are, and update the file's header comment: the "V1 SCOPE: storage only" paragraph is now wrong — N6 reads this store in V3):

```ts
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `session_id` reaches this module from a host payload and becomes part of
 * a filesystem path, so it is validated as untrusted input: one path segment
 * of safe characters, nothing else. `.` and `..` are excluded by the dot
 * rule below rather than by the character class, which would admit both.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export class InvalidSessionIdError extends Error {
  constructor(sessionId: unknown) {
    super(
      `session_id ${JSON.stringify(sessionId)} is not a safe path segment: ` +
        "expected 1-128 characters of [A-Za-z0-9._-], and neither \".\" nor \"..\"",
    );
    this.name = "InvalidSessionIdError";
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new InvalidSessionIdError(sessionId);
  }
}

/** Where a session's negotiated config lives. Exported so tests and the
 * runbook name the same path this module writes. */
export function sessionConfigPath(dir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(dir, `${sessionId}.json`);
}

/**
 * A `SessionConfig` must at minimum carry the two fields N6 and the client
 * timeout read. Anything less is treated as "not negotiated" rather than
 * trusted half-way: the caller then applies the ACS default, which is a
 * defined posture, where a half-read config is not.
 */
function isSessionConfig(value: unknown): value is SessionConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const posture = candidate.on_decision_failure;
  const timeout = candidate.timeout_config;
  return (
    (posture === "proceed" || posture === "deny") &&
    typeof timeout === "object" &&
    timeout !== null &&
    typeof (timeout as Record<string, unknown>).default_ms === "number"
  );
}

export type CreateFileSessionConfigStoreOptions = {
  /** Directory holding one file per session. Created on first write. */
  dir: string;
  /** The host's session identifier. Untrusted: validated here, once. */
  sessionId: string;
};

/**
 * S13 with a home that outlives the process (P1).
 *
 * The Claude Code shim is a fresh subprocess per hook, so the negotiated
 * ServerHello has to be readable by a process that never handshook. It also
 * has to be readable when the Guardian is unreachable -- that is the only
 * situation the posture exists for -- which is why this is a local file and
 * not a lookup.
 *
 * `get` is TOTAL: a missing, unreadable, malformed, or partial file returns
 * undefined, never throws. The caller resolves undefined to the ACS default
 * (`proceed`, audited). A throw here would kill the hook process and take
 * the decision with it -- the exact failure this store exists to prevent.
 *
 * `set` writes to a temp file and renames, so a concurrent reader (Claude
 * Code may run hooks in parallel) sees either the old complete config or the
 * new one, never a half-written file.
 */
export function createFileSessionConfigStore({
  dir,
  sessionId,
}: CreateFileSessionConfigStoreOptions): SessionConfigStore {
  const path = sessionConfigPath(dir, sessionId);

  return {
    get(): SessionConfig | undefined {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
      return isSessionConfig(parsed) ? parsed : undefined;
    },

    set(config: SessionConfig): void {
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      try {
        writeFileSync(temp, `${JSON.stringify(config)}\n`);
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file may not exist; nothing to clean up.
        }
        throw error;
      }
    },
  };
}
```

`set` deliberately does **not** swallow errors: it runs on the handshake path, where the caller (Task 7) already treats a handshake failure as a delivery failure and applies the posture. Silence there would hide a broken `.acs/` from the one place that can report it.

Then export from `packages/host-adapter/src/index.ts` alongside the existing session-config exports: `createFileSessionConfigStore`, `sessionConfigPath`, `InvalidSessionIdError`.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/host-adapter/test/session-config.test.ts && bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Give S13 a home that outlives the hook process

The Claude Code shim is a fresh subprocess per hook, so V1's in-memory
negotiated config was empty every time N6 would read it. One interface,
two implementations: file-backed for subprocess hosts, in-memory for V5's
in-process plugin, so the adapter stops caring how the host runs.

get() is total -- a missing or corrupt file reads as "not negotiated" and
the caller applies the ACS default. session_id is untrusted input and is
validated as a single safe path segment.

Slice: #4
Affordances: S13
```

---

### Task 3: S14, the audit sink · slice #4 · S14

**Files:**
- Create: `packages/host-adapter/src/audit-sink.ts`
- Create: `packages/host-adapter/test/audit-sink.test.ts`
- Modify: `packages/host-adapter/src/index.ts`

**Interfaces:**
- Produces:
  - `type AuditEntry = { seq: number; recorded_at: string; session_id: string; method: string; rpc_id: string | number | null; posture: "proceed" | "deny"; outcome: "proceeded" | "blocked"; failure: { kind: string; message: string } }`
  - `type AuditSink = { path: string | null; write(entry: Omit<AuditEntry, "seq" | "recorded_at">): void }`
  - `NULL_AUDIT_SINK: AuditSink`
  - `createAuditSink(options: { path: string; now?: () => Date; onError?: (error: unknown) => void }): AuditSink`

This is deliberately the same shape as `packages/guardian/src/envelope-tap.ts`, for the same reason (Global Constraint 2). Read that file before writing this one — the totality discipline there is the spec for the discipline here, including that `disabled` is set **before** `onError` is called, and that `onError` and the `console.error` fallback are each wrapped in their own try/catch.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/audit-sink.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditSink, NULL_AUDIT_SINK, type AuditEntry } from "../src/audit-sink.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-audit-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir)) {
      unlinkSync(join(dir, entry));
    }
    rmdirSync(dir);
  }
});

const EVENT = {
  session_id: "sess-1",
  method: "steps/toolCallRequest",
  rpc_id: "req-1",
  posture: "proceed",
  outcome: "proceeded",
  failure: { kind: "timeout", message: "no decision within 5000ms" },
} as const;

function readEntries(path: string): AuditEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("createAuditSink — S14", () => {
  it("appends one JSONL entry per fail-open proceed", () => {
    const path = join(scratch(), "audit.jsonl");
    const sink = createAuditSink({ path, now: () => new Date("2026-08-10T12:00:00.000Z") });
    sink.write(EVENT);

    expect(readEntries(path)).toEqual([
      { seq: 1, recorded_at: "2026-08-10T12:00:00.000Z", ...EVENT },
    ]);
  });

  it("numbers entries from 1 and never reuses a seq", () => {
    const path = join(scratch(), "audit.jsonl");
    const sink = createAuditSink({ path });
    sink.write(EVENT);
    sink.write({ ...EVENT, outcome: "blocked", posture: "deny" });
    expect(readEntries(path).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("records a blocked step too, so U23 can distinguish the two outcomes", () => {
    const path = join(scratch(), "audit.jsonl");
    createAuditSink({ path }).write({ ...EVENT, posture: "deny", outcome: "blocked" });
    const [entry] = readEntries(path);
    expect(entry?.outcome).toBe("blocked");
    expect(entry?.posture).toBe("deny");
  });

  it("creates the directory it was pointed at", () => {
    const path = join(scratch(), "nested", "audit.jsonl");
    createAuditSink({ path }).write(EVENT);
    expect(readEntries(path)).toHaveLength(1);
    unlinkSync(path);
    rmdirSync(join(path, ".."));
  });
});

describe("createAuditSink — total by construction (constraint 2)", () => {
  it("does not throw when the path cannot be written, and reports once", () => {
    const errors: unknown[] = [];
    // A path whose parent is a file, not a directory: mkdir and write both fail.
    const dir = scratch();
    const blocker = join(dir, "blocker");
    createAuditSink({ path: join(dir, "audit.jsonl") }); // ensure dir exists
    Bun.writeFileSync?.(blocker, "x") ?? require("node:fs").writeFileSync(blocker, "x");

    const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: (e) => errors.push(e) });
    expect(() => sink.write(EVENT)).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("disables itself after the first failure rather than reporting per call", () => {
    const errors: unknown[] = [];
    const dir = scratch();
    const blocker = join(dir, "blocker2");
    require("node:fs").writeFileSync(blocker, "x");
    const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: (e) => errors.push(e) });
    sink.write(EVENT);
    sink.write(EVENT);
    sink.write(EVENT);
    expect(errors).toHaveLength(1);
  });

  it("does not throw when onError itself throws", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker3");
    require("node:fs").writeFileSync(blocker, "x");
    const sink = createAuditSink({
      path: join(blocker, "audit.jsonl"),
      onError: () => {
        throw new Error("reporter is broken too");
      },
    });
    expect(() => sink.write(EVENT)).not.toThrow();
  });
});

describe("NULL_AUDIT_SINK", () => {
  it("accepts writes and reports no path", () => {
    expect(NULL_AUDIT_SINK.path).toBeNull();
    expect(() => NULL_AUDIT_SINK.write(EVENT)).not.toThrow();
  });
});
```

Note for the implementer: the two `require("node:fs")` lines and the `Bun.writeFileSync?.` line above are sloppy — replace them with a top-level `import { writeFileSync } from "node:fs"` and use it directly. The tests' *intent* (a parent path that is a file, so both `mkdirSync` and `appendFileSync` fail) is what must survive.

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/host-adapter/test/audit-sink.test.ts
```

Expected: module not found.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/host-adapter/src/audit-sink.ts
/**
 * S14 -- the host-side audit sink. §6.4 makes one thing a MUST: every step
 * that proceeds without a decision is recorded, so a fail-open bypass is
 * visible rather than silent. That is the entire job.
 *
 * TOTAL BY CONSTRUCTION (Global Constraint 2, inherited from N26's envelope
 * tap). This sink runs on the decision path, in a hook process whose stdout
 * is a policy decision. It must never throw, never change a decision, and
 * never delay one beyond the append it is asked for. A sink that cannot
 * write degrades observability and nothing else -- so the first failure
 * disables it, reports once, and every later write is a no-op.
 *
 * Structurally the same as packages/guardian/src/envelope-tap.ts, and
 * deliberately not shared with it: that one is the Guardian's (P3, the
 * wire), this one is the host's (P1, the posture). They record different
 * things at different sides of the wire, and R3.2 keeps the host adapter
 * free of the Guardian's imports.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEntry = {
  /** 1-based, per sink instance. Gaps mean lost writes. */
  seq: number;
  recorded_at: string;
  session_id: string;
  /** The ACS method whose decision failed to arrive. */
  method: string;
  rpc_id: string | number | null;
  /** The posture in force -- negotiated, or the ACS default when nothing was. */
  posture: "proceed" | "deny";
  /** `proceeded` is the fail-open bypass §6.4 requires be recorded. */
  outcome: "proceeded" | "blocked";
  failure: { kind: string; message: string };
};

export type AuditEvent = Omit<AuditEntry, "seq" | "recorded_at">;

export type AuditSink = {
  /** Where entries land, or null for the null sink. */
  path: string | null;
  write(event: AuditEvent): void;
};

/** Used where no audit path is configured. Accepts writes, records nothing. */
export const NULL_AUDIT_SINK: AuditSink = { path: null, write(): void {} };

export type CreateAuditSinkOptions = {
  path: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export function createAuditSink({ path, now = () => new Date(), onError }: CreateAuditSinkOptions): AuditSink {
  let seq = 0;
  let disabled = false;

  function fail(error: unknown): void {
    // Set FIRST: if onError throws, this sink must already be disabled, or a
    // second write would call the throwing reporter again.
    disabled = true;
    if (onError) {
      try {
        onError(error);
      } catch {
        // A broken reporter cannot be reported. Nothing further to do.
      }
      return;
    }
    try {
      console.error(`audit sink disabled: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // stderr is unavailable; there is nowhere left to say so.
    }
  }

  return {
    path,
    write(event: AuditEvent): void {
      if (disabled) {
        return;
      }
      try {
        const entry: AuditEntry = { seq: seq + 1, recorded_at: now().toISOString(), ...event };
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        // Only after a successful append, so a failed write does not consume
        // a sequence number and invent a gap that never happened.
        seq += 1;
      } catch (error) {
        fail(error);
      }
    },
  };
}
```

Export `createAuditSink`, `NULL_AUDIT_SINK`, and the three types from `packages/host-adapter/src/index.ts`.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/host-adapter/test/audit-sink.test.ts && bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Add S14, the host-side audit sink

§6.4 makes one thing a MUST: every step that proceeds without a decision
is recorded. Total by construction, on the same discipline as N26's
envelope tap -- it runs on the decision path, so a sink that cannot write
degrades observability and never a decision.

Slice: #4
Affordances: S14
```

---

### Task 4: N6 `applyFailurePosture()`, and the timeout it needs · slice #4 · N6

The task's own discovery: §6.4 defines a decision failure as "no usable decision **within the negotiated timeout**", and V1's `guardianClient.post` has no timeout at all. Without one, a silent Guardian hangs the hook forever and N6 can never fire.

**Files:**
- Modify: `packages/host-adapter/src/guardian-client.ts`
- Create: `packages/host-adapter/src/failure-posture.ts`
- Create: `packages/host-adapter/test/failure-posture.test.ts`
- Modify: `packages/host-adapter/test/client.test.ts` (add the timeout cases)
- Modify: `packages/host-adapter/src/index.ts`

**Interfaces:**
- Consumes: `SessionConfigStore` (Task 2), `AuditSink` / `AuditEvent` (Task 3).
- Produces:
  - `class GuardianTimeoutError extends Error { readonly timeoutMs: number }`
  - `guardianClient.post(url, envelope, options?: { timeoutMs?: number })` — unchanged when `timeoutMs` is absent.
  - `classifyDeliveryFailure(error: unknown): { kind: "timeout" | "transport" | "error_without_decision" | "unknown"; message: string }`
  - `applyFailurePosture(input: { failure: unknown; sessionConfig: SessionConfig | undefined; sessionId: string; method: string; rpcId: string | number | null; audit: AuditSink }): { decision: "allow" | "deny"; reasoning: string; reason_codes: string[] }`
  - `DEFAULT_POSTURE = "proceed"`, `DEFAULT_TIMEOUT_MS = 5000`

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/failure-posture.test.ts
import { describe, expect, it } from "bun:test";
import type { AuditEvent, AuditSink } from "../src/audit-sink.ts";
import {
  applyFailurePosture,
  classifyDeliveryFailure,
  DEFAULT_POSTURE,
} from "../src/failure-posture.ts";
import { GuardianTimeoutError } from "../src/guardian-client.ts";
import type { SessionConfig } from "../src/session-config.ts";

function recordingSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: { path: "test", write: (e) => void events.push(e) }, events };
}

const NEGOTIATED = (posture: "proceed" | "deny"): SessionConfig => ({
  negotiated_version: "0.1.0",
  methods_evaluated: ["steps/toolCallRequest"],
  selected_transport: "http",
  timeout_config: { default_ms: 5000 },
  on_decision_failure: posture,
});

const CALL = { sessionId: "sess-1", method: "steps/toolCallRequest", rpcId: "req-1" };

describe("applyFailurePosture — R1.7", () => {
  it("proceeds under the negotiated proceed posture", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason_codes).toEqual(["decision_failure"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ posture: "proceed", outcome: "proceeded", failure: { kind: "timeout" } });
  });

  it("blocks under the negotiated deny posture", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("deny"),
      audit: sink,
      ...CALL,
    });
    expect(decision.decision).toBe("deny");
    expect(events[0]).toMatchObject({ posture: "deny", outcome: "blocked" });
  });

  // The case the file exists for: no handshake ever completed (Guardian was
  // already down at session start), so there is no negotiated posture.
  it("applies the ACS default when nothing was negotiated, and audits it", () => {
    const { sink, events } = recordingSink();
    const decision = applyFailurePosture({
      failure: new TypeError("Unable to connect"),
      sessionConfig: undefined,
      audit: sink,
      ...CALL,
    });
    expect(DEFAULT_POSTURE).toBe("proceed");
    expect(decision.decision).toBe("allow");
    expect(events[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
  });

  it("names the failure in reasoning, so a human sees why the step was not governed", () => {
    const { sink } = recordingSink();
    const decision = applyFailurePosture({
      failure: new GuardianTimeoutError(5000),
      sessionConfig: NEGOTIATED("proceed"),
      audit: sink,
      ...CALL,
    });
    expect(decision.reasoning).toMatch(/no decision/i);
    expect(decision.reasoning).toMatch(/5000/);
  });

  // Constraint 3: a proceed with no audit entry is the silent bypass this
  // slice removes. Auditing must not be skippable, so there is no option for it.
  it("audits every proceed — the sink is a required argument", () => {
    const { sink, events } = recordingSink();
    applyFailurePosture({ failure: new Error("x"), sessionConfig: NEGOTIATED("proceed"), audit: sink, ...CALL });
    applyFailurePosture({ failure: new Error("y"), sessionConfig: NEGOTIATED("proceed"), audit: sink, ...CALL });
    expect(events).toHaveLength(2);
  });

  // Constraint 2: the sink is total, but prove the posture survives even a
  // sink that breaks its contract and throws.
  it("still returns a decision when the sink throws", () => {
    const throwing: AuditSink = { path: null, write: () => { throw new Error("sink is broken"); } };
    expect(
      applyFailurePosture({ failure: new Error("x"), sessionConfig: NEGOTIATED("deny"), audit: throwing, ...CALL })
        .decision,
    ).toBe("deny");
  });
});

describe("classifyDeliveryFailure — §6.4's three failure modes", () => {
  it("classifies a timeout", () => {
    expect(classifyDeliveryFailure(new GuardianTimeoutError(5000)).kind).toBe("timeout");
  });

  it("classifies a dead transport", () => {
    expect(classifyDeliveryFailure(new TypeError("Unable to connect. Is the computer able to access the url?")).kind)
      .toBe("transport");
  });

  it("classifies an error response that carried no decision", () => {
    const { kind, message } = classifyDeliveryFailure({ code: -32020, message: "evaluation failed: boom" });
    expect(kind).toBe("error_without_decision");
    expect(message).toContain("-32020");
  });

  it("never throws on an unknown shape", () => {
    expect(classifyDeliveryFailure(Object.create(null)).kind).toBe("unknown");
    expect(classifyDeliveryFailure(undefined).kind).toBe("unknown");
  });
});
```

And in `packages/host-adapter/test/client.test.ts`, add:

```ts
describe("guardianClient.post — the negotiated timeout (§6.4)", () => {
  it("throws GuardianTimeoutError when no response arrives in time", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return Response.json({ jsonrpc: "2.0", id: "1", result: {} });
      },
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      await expect(guardianClient.post(url, envelope, { timeoutMs: 25 })).rejects.toThrow(GuardianTimeoutError);
    } finally {
      await server.stop(true);
    }
  });

  it("returns normally when the response beats the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ jsonrpc: "2.0", id: "1", result: { decision: "allow" } }),
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      const response = await guardianClient.post(url, envelope, { timeoutMs: 5000 });
      expect(response.result).toEqual({ decision: "allow" });
    } finally {
      await server.stop(true);
    }
  });

  it("still works with no timeout given, exactly as V1 called it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ jsonrpc: "2.0", id: "1", result: { decision: "allow" } }),
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      expect((await guardianClient.post(url, envelope)).result).toEqual({ decision: "allow" });
    } finally {
      await server.stop(true);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/host-adapter/test/failure-posture.test.ts packages/host-adapter/test/client.test.ts
```

- [ ] **Step 3: Minimal implementation**

In `guardian-client.ts`, add the error class and the option:

```ts
/** Thrown when the negotiated timeout elapses with no response (§6.4). */
export class GuardianTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`guardianClient.post: no decision within ${timeoutMs}ms`);
    this.name = "GuardianTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type PostOptions = {
  /** The negotiated `timeout_config` value for this method. Omitted means no
   * timeout, which is how V1 called this and how the handshake calls it --
   * the handshake has no negotiated timeout yet, by definition. */
  timeoutMs?: number;
};
```

and in `post`:

```ts
  async post(url: string, envelope: JsonRpcRequest, options: PostOptions = {}): Promise<JsonRpcResponse> {
    const { timeoutMs } = options;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        // §6.4: the negotiated timeout bounds every failure mode. An
        // unambiguous failure (a refused connection) still rejects
        // immediately -- fetch does not wait out the clock for those.
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (timeoutMs !== undefined && error instanceof Error && error.name === "TimeoutError") {
        throw new GuardianTimeoutError(timeoutMs);
      }
      throw error;
    }

    const response = (await res.json()) as JsonRpcResponse;
    ...
```

Then `failure-posture.ts`:

```ts
/**
 * N6 -- applyFailurePosture. The delivery half of the two failure domains
 * (Global Constraint 1).
 *
 * This function is only ever reached when NO usable decision arrived: the
 * Guardian stayed silent past the negotiated timeout, the transport died, or
 * an error response carried no decision. §6.4 says all three resolve the
 * same way -- apply the deployment's declared posture -- and that every step
 * which proceeds without a decision MUST be audited.
 *
 * It is NOT reached when a decision arrived. A `deny` that arrives is
 * honoured regardless of posture (R1.5), and that is enforced by the caller
 * never calling this on a decision, plus the end-to-end assertions in Task 9.
 *
 * R3.2: nothing here knows AGT. A delivery failure is a property of the
 * wire, not of whatever policy runtime sits behind it.
 */
import type { AuditSink } from "./audit-sink.ts";
import { GuardianTimeoutError } from "./guardian-client.ts";
import type { SessionConfig } from "./session-config.ts";

/** handshake.json's own default, and R1.7's (D8 closed here). */
export const DEFAULT_POSTURE = "proceed" as const;

/** Used when no handshake completed, so no timeout was negotiated either.
 * Matches the Guardian's declared default so the two agree by value. */
export const DEFAULT_TIMEOUT_MS = 5000;

export type DeliveryFailureKind = "timeout" | "transport" | "error_without_decision" | "unknown";

/** A JSON-RPC error object, as it arrives in a response that carried no decision. */
type ErrorLike = { code?: unknown; message?: unknown };

/**
 * Names which of §6.4's failure modes happened, for the audit entry. Total:
 * an unrecognised shape is "unknown", never a throw -- this runs while the
 * host is already handling a failure.
 */
export function classifyDeliveryFailure(failure: unknown): { kind: DeliveryFailureKind; message: string } {
  try {
    if (failure instanceof GuardianTimeoutError) {
      return { kind: "timeout", message: failure.message };
    }
    if (failure instanceof Error) {
      // fetch rejects with a TypeError for a refused connection, DNS
      // failure, or TLS failure -- §6.4's "the transport fails".
      const kind: DeliveryFailureKind = failure instanceof TypeError ? "transport" : "unknown";
      return { kind, message: failure.message };
    }
    if (typeof failure === "object" && failure !== null && "code" in failure) {
      const { code, message } = failure as ErrorLike;
      return {
        kind: "error_without_decision",
        message: `guardian returned error ${String(code)}: ${String(message)}`,
      };
    }
    return { kind: "unknown", message: String(failure) };
  } catch {
    return { kind: "unknown", message: "<unprintable failure>" };
  }
}

export type ApplyFailurePostureInput = {
  /** Whatever the delivery attempt threw, or the JSON-RPC error it returned. */
  failure: unknown;
  /** S13's contents, or undefined when no handshake ever completed. */
  sessionConfig: SessionConfig | undefined;
  sessionId: string;
  method: string;
  rpcId: string | number | null;
  /** Required, not optional: constraint 3 makes auditing non-skippable. */
  audit: AuditSink;
};

export type PostureDecision = {
  decision: "allow" | "deny";
  reasoning: string;
  reason_codes: string[];
};

export function applyFailurePosture({
  failure,
  sessionConfig,
  sessionId,
  method,
  rpcId,
  audit,
}: ApplyFailurePostureInput): PostureDecision {
  const posture = sessionConfig?.on_decision_failure ?? DEFAULT_POSTURE;
  const classified = classifyDeliveryFailure(failure);
  const outcome = posture === "proceed" ? "proceeded" : "blocked";

  // §6.4's MUST. Wrapped because the decision must survive a sink that
  // breaks its own totality contract -- the posture is the load-bearing
  // half, the record is the accountability half, and losing the record must
  // not lose the posture.
  try {
    audit.write({ session_id: sessionId, method, rpc_id: rpcId, posture, outcome, failure: classified });
  } catch {
    // The sink is documented total; if it throws anyway, there is nowhere
    // left to report it that would not have the same problem.
  }

  const negotiated = sessionConfig === undefined ? "no posture was negotiated, so the ACS default applies" : "negotiated";
  return {
    decision: posture === "proceed" ? "allow" : "deny",
    reasoning: `no decision from the guardian (${classified.message}); ${negotiated}: on_decision_failure=${posture}`,
    reason_codes: ["decision_failure"],
  };
}
```

Export the new names from `packages/host-adapter/src/index.ts`.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/host-adapter && bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Add N6 applyFailurePosture, and the timeout §6.4 requires

V1's client had no timeout, so a silent Guardian hung the hook forever and
the posture could never fire. Adds one, then resolves all three of §6.4's
delivery failures the same way: apply the declared posture, audit every
proceed. Reached only when no decision arrived -- a deny that arrives is
honoured regardless of posture.

Slice: #4
Affordances: N6, S14
```

---

### Task 5: `transform` becomes a real ACS `modify` · slice #4 · N24 (V3 extension), R1.6

`mapVerdict` maps AGT `transform` → ACS `modify` today but synthesizes **no** `modifications`, which §6 makes invalid (MODIFY requires it). This is the Guardian half of R1.6; Task 6 is the host half.

**Files:**
- Modify: `mapping.yaml` (add a `modifications` block under `field_synthesis`)
- Modify: `packages/guardian/src/map-verdict.ts`
- Modify: `packages/guardian/test/map-verdict.test.ts`

**Interfaces:**
- Consumes: `AgtVerdict` (already carries `transform?: { path: string; value: unknown }`).
- Produces: `AcsDecision` gains `modifications?: { parameter_overrides?: Record<string, unknown>; modified_content?: string; redactions?: { path: string; replacement?: string }[] }`.
- The mapping's new block:

```yaml
  # R1.6 -- AGT's transform verdict carries {path, value}, where path is the
  # literal "$policy_target": the leaf the manifest's intervention point
  # declared (policy_target: "$.tool_call.args.command"). ACS expresses that
  # as modifications.parameter_overrides keyed by argument name, per
  # modifications.json ("Replacement values for tool call arguments, keyed by
  # argument name"). policy_target_argument names which key, and must agree
  # with the manifest -- this is the one place the two files touch.
  modifications:
    from: verdict.transform
    when_path: "$policy_target"
    into: parameter_overrides
    policy_target_argument: command
```

- [ ] **Step 1: Write the failing test**

```ts
// added to packages/guardian/test/map-verdict.test.ts
describe("mapVerdict — transform becomes a MODIFY that carries modifications (R1.6)", () => {
  it("synthesizes parameter_overrides from the transform's $policy_target value", () => {
    const decision = mapVerdict(
      {
        decision: "transform",
        reason: "redaction_applied",
        transform: { path: "$policy_target", value: "echo [REDACTED]" },
      },
      mapping,
    );
    expect(decision.decision).toBe("modify");
    expect(decision.modifications).toEqual({ parameter_overrides: { command: "echo [REDACTED]" } });
  });

  it("keeps the synthesized reason_codes and policy_references a MODIFY still needs", () => {
    const decision = mapVerdict(
      { decision: "transform", reason: "redaction_applied", transform: { path: "$policy_target", value: "x" } },
      mapping,
    );
    expect(decision.reason_codes).toEqual(["redaction_applied"]);
    expect(decision.policy_references).toEqual([{ policy_id: "agt_stock", rule_id: "redaction_applied" }]);
  });

  // A MODIFY with no modifications is invalid per §6, and silently emitting
  // one would make the host apply nothing while reporting a rewrite. Fail loudly.
  it("throws when a transform verdict carries no transform object", () => {
    expect(() => mapVerdict({ decision: "transform", reason: "redaction_applied" }, mapping)).toThrow(
      /transform/,
    );
  });

  it("throws when the transform names a path this mapping cannot express", () => {
    expect(() =>
      mapVerdict(
        { decision: "transform", reason: "x", transform: { path: "$.some.other.leaf", value: "y" } },
        mapping,
      ),
    ).toThrow(/\$policy_target/);
  });

  it("leaves every other verdict's shape untouched", () => {
    expect(mapVerdict({ decision: "allow" }, mapping).modifications).toBeUndefined();
    expect(mapVerdict({ decision: "deny", reason: "r", message: "m" }, mapping).modifications).toBeUndefined();
    expect(mapVerdict({ decision: "escalate", reason: "approval_required", message: "m" }, mapping).decision)
      .toBe("ask");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/guardian/test/map-verdict.test.ts
```

- [ ] **Step 3: Minimal implementation**

Add to `map-verdict.ts`'s types:

```ts
export type AcsModifications = {
  modified_content?: string;
  redactions?: { path: string; replacement?: string }[];
  parameter_overrides?: Record<string, unknown>;
};

/** The mapping's declaration of how an AGT transform becomes ACS
 * modifications. `when_path` is the only transform path this mapping can
 * express; anything else is a mapping gap and must fail loudly rather than
 * silently drop a rewrite. */
type ModificationsRule = {
  from: string;
  when_path: string;
  into: "parameter_overrides";
  policy_target_argument: string;
};
```

`AcsDecision` gains `modifications?: AcsModifications`, and `Mapping["field_synthesis"]` gains `modifications: ModificationsRule`.

In `mapVerdict`, after the `policy_references` block:

```ts
  if (rule.decision === "modify") {
    out.modifications = synthesizeModifications(verdict, fs.modifications);
  }
```

and the helper:

```ts
/**
 * R1.6 -- the $policy_target bound survives as ACS modifications.
 *
 * AGT's transform names the leaf it rewrote by the literal "$policy_target",
 * resolved against the manifest's intervention point. ACS expresses a
 * rewritten tool argument as parameter_overrides keyed by argument name, so
 * the mapping declares which argument that is and this copies the value in.
 *
 * Note what is NOT here: re-applying the substitution. The SDK already
 * returns the transformed value (verified: transformedPolicyTarget carries
 * the applied string alongside the verdict), so this moves a value rather
 * than recomputing one.
 */
function synthesizeModifications(verdict: AgtVerdict, rule: ModificationsRule): AcsModifications {
  const transform = verdict.transform;
  if (!transform || typeof transform !== "object") {
    throw new Error(
      `mapping.yaml maps this verdict to ACS "modify", which requires modifications, ` +
        `but the verdict carries no ${rule.from}`,
    );
  }
  if (transform.path !== rule.when_path) {
    throw new Error(
      `mapping.yaml can express a transform of ${JSON.stringify(rule.when_path)} only, ` +
        `but the verdict rewrote ${JSON.stringify(transform.path)}`,
    );
  }
  return { parameter_overrides: { [rule.policy_target_argument]: transform.value } };
}
```

Add a comment in `mapping.yaml` and in `policy/manifest.yaml` noting that `policy_target_argument: command` and `policy_target: "$.tool_call.args.command"` must agree — one sentence each, naming the other file.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/guardian && bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Synthesize ACS modifications from an AGT transform (R1.6)

mapVerdict mapped transform to MODIFY while emitting no modifications,
which §6 makes invalid -- the host would report a rewrite and apply
nothing. The transform's $policy_target bound now lands as
parameter_overrides keyed by argument name, declared in mapping.yaml so
V7's harness publishes the same table the runtime uses.

Slice: #4
Affordances: N24
```

---

### Task 6: N7 `validateDecision()` and `applyModifications()` · slice #4 · N7, R1.8

**Files:**
- Create: `packages/host-adapter/src/validate-decision.ts`
- Create: `packages/host-adapter/test/validate-decision.test.ts`
- Modify: `hosts/claude-code/claude-code.hookmap.yaml`
- Modify: `packages/host-adapter/src/render-decision.ts` *(comment only — see Step 3)*
- Modify: `packages/host-adapter/src/index.ts`

**Interfaces:**
- Produces:
  - `validateDecision(decision, context: { elapsedMs: number }): ValidatedDecision`
  - `applyModifications(originalArguments: Record<string, unknown>, modifications: unknown): Record<string, unknown>`
  - `class ModificationsInvalidError extends Error`
- `ValidatedDecision` is the input decision, or a substituted one carrying `decision`, `reasoning`, `reason_codes`, and — for `modify` — an `applied_input` field the hookmap names.

- [ ] **Step 1: Write the failing test**

```ts
// packages/host-adapter/test/validate-decision.test.ts
import { describe, expect, it } from "bun:test";
import { applyModifications, ModificationsInvalidError, validateDecision } from "../src/validate-decision.ts";

const FRESH = { elapsedMs: 10 };
const ARGS = { command: "echo ghp_ABCDEF123456", timeout: 30 };

describe("validateDecision — malformed modifications fail closed (R1.8, §6.3)", () => {
  it("passes a modify whose modifications are well formed, and applies them", () => {
    const out = validateDecision(
      { decision: "modify", reasoning: "redacted", modifications: { parameter_overrides: { command: "echo [REDACTED]" } } },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("modify");
    expect(out.applied_input).toEqual({ command: "echo [REDACTED]", timeout: 30 });
  });

  it("denies when modified_content is combined with parameter_overrides", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { modified_content: "whole", parameter_overrides: { command: "x" } },
      },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
    expect(out.reason_codes).toContain("modifications_invalid");
  });

  it("denies when a redaction path and an override key address the same field", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { redactions: [{ path: "/command" }], parameter_overrides: { command: "x" } },
      },
      { ...FRESH, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
  });

  it("denies on ancestor/descendant overlap, not just exact equality", () => {
    const out = validateDecision(
      {
        decision: "modify",
        reasoning: "r",
        modifications: { redactions: [{ path: "/env/TOKEN" }], parameter_overrides: { env: {} } },
      },
      { ...FRESH, originalArguments: { env: { TOKEN: "t" } } },
    );
    expect(out.decision).toBe("deny");
  });

  it("denies a modify carrying no modifications at all", () => {
    const out = validateDecision({ decision: "modify", reasoning: "r" }, { ...FRESH, originalArguments: ARGS });
    expect(out.decision).toBe("deny");
  });
});

describe("validateDecision — ASK and DEFER expiry (R1.8)", () => {
  it("passes a fresh ask through untouched", () => {
    const ask = {
      decision: "ask",
      reasoning: "approval required",
      ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 60 },
    };
    expect(validateDecision(ask, { ...FRESH, originalArguments: ARGS }).decision).toBe("ask");
  });

  it("substitutes an expired ask with its timeout_disposition", () => {
    const out = validateDecision(
      {
        decision: "ask",
        reasoning: "approval required",
        ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 1, timeout_disposition: "allow" },
      },
      { elapsedMs: 2_000, originalArguments: ARGS },
    );
    expect(out.decision).toBe("allow");
    expect(out.reason_codes).toContain("ask_expired");
  });

  // ask-details.json defaults timeout_disposition to "deny", and §6 says that
  // default is deliberate. Absent must mean deny, never allow.
  it("denies an expired ask that names no timeout_disposition", () => {
    const out = validateDecision(
      {
        decision: "ask",
        reasoning: "approval required",
        ask_details: { approver: { type: "user" }, question: "ok?", timeout_seconds: 1 },
      },
      { elapsedMs: 2_000, originalArguments: ARGS },
    );
    expect(out.decision).toBe("deny");
  });

  it("substitutes an expired defer with its timeout_decision, defaulting to deny", () => {
    const details = { reason: "low_confidence", resolution_method: "timeout", resolution_timeout_ms: 50 };
    expect(
      validateDecision({ decision: "defer", reasoning: "r", defer_details: details }, { elapsedMs: 500, originalArguments: ARGS })
        .decision,
    ).toBe("deny");
    expect(
      validateDecision({ decision: "defer", reasoning: "r", defer_details: details }, { elapsedMs: 10, originalArguments: ARGS })
        .decision,
    ).toBe("defer");
  });

  it("denies an ask or defer whose details are missing entirely", () => {
    expect(validateDecision({ decision: "ask", reasoning: "r" }, { ...FRESH, originalArguments: ARGS }).decision)
      .toBe("deny");
    expect(validateDecision({ decision: "defer", reasoning: "r" }, { ...FRESH, originalArguments: ARGS }).decision)
      .toBe("deny");
  });
});

describe("validateDecision — everything else passes through", () => {
  it("leaves allow and deny exactly as they arrived", () => {
    const allow = { decision: "allow", reason_codes: ["drift_detected"], policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }] };
    expect(validateDecision(allow, { ...FRESH, originalArguments: ARGS })).toEqual(allow);
    const deny = { decision: "deny", reasoning: "blocked", reason_codes: ["destructive_shell_command_blocked"] };
    expect(validateDecision(deny, { ...FRESH, originalArguments: ARGS })).toEqual(deny);
  });

  // Constraint 1: an arriving deny is honoured. There is no path in this
  // module that can turn one into anything else.
  it("never rewrites a deny", () => {
    for (const elapsed of [0, 1, 1_000_000]) {
      expect(validateDecision({ decision: "deny", reasoning: "r" }, { elapsedMs: elapsed, originalArguments: ARGS }).decision)
        .toBe("deny");
    }
  });
});

describe("applyModifications — §6.3", () => {
  it("overrides named arguments and leaves the rest", () => {
    expect(applyModifications(ARGS, { parameter_overrides: { command: "echo [REDACTED]" } }))
      .toEqual({ command: "echo [REDACTED]", timeout: 30 });
  });

  it("replaces a redacted field with its replacement, defaulting to [REDACTED]", () => {
    expect(applyModifications(ARGS, { redactions: [{ path: "/command" }] }))
      .toEqual({ command: "[REDACTED]", timeout: 30 });
    expect(applyModifications(ARGS, { redactions: [{ path: "/command", replacement: "***" }] }))
      .toEqual({ command: "***", timeout: 30 });
  });

  it("does not mutate the arguments it was given", () => {
    const original = { command: "keep me" };
    applyModifications(original, { parameter_overrides: { command: "changed" } });
    expect(original).toEqual({ command: "keep me" });
  });

  it("throws on a modifications object that violates §6.3", () => {
    expect(() => applyModifications(ARGS, { modified_content: "x", redactions: [{ path: "/command" }] }))
      .toThrow(ModificationsInvalidError);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/host-adapter/test/validate-decision.test.ts
```

- [ ] **Step 3: Minimal implementation**

Write `packages/host-adapter/src/validate-decision.ts` implementing exactly the behaviour above. Required details, all load-bearing:

- **§6.3 validation** (`assertValidModifications`): `modified_content` present ⇒ neither `redactions` nor `parameter_overrides` may be present. Every `redactions[].path` (a JSON pointer, so `/command`) is converted to a segment list; every `parameter_overrides` key is a single top-level segment. Two targets overlap when one segment list is a prefix of the other (which covers exact equality, ancestor, and descendant). Any violation throws `ModificationsInvalidError`.
- **`applyModifications`** validates first, then returns a **shallow-cloned** argument object with overrides assigned and redaction paths replaced (default `"[REDACTED]"`). A redaction path of depth > 1 walks and clones each level it descends, so the input object is never mutated.
- **`validateDecision`** switches on `decision`:
  - `modify` → validate + apply; on `ModificationsInvalidError` return `{ decision: "deny", reasoning: <names the violation>, reason_codes: ["modifications_invalid"] }`; on success return the decision plus `applied_input`.
  - `ask` → `ask_details` must be an object with a numeric `timeout_seconds`, else deny with `reason_codes: ["ask_details_invalid"]`. If `elapsedMs > timeout_seconds * 1000`, substitute `ask_details.timeout_disposition ?? "deny"` with `reason_codes: ["ask_expired"]`.
  - `defer` → same shape against `resolution_timeout_ms` and `timeout_decision ?? "deny"`, `reason_codes: ["defer_expired"]` / `["defer_details_invalid"]`.
  - anything else → returned unchanged.
- The module header states Global Constraint 1 explicitly: **no branch may alter an arriving `deny`**, and `allow` is passed through untouched (including AGT's `warn`-as-allow, whose `policy_references` must survive).

Then the hookmap (`hosts/claude-code/claude-code.hookmap.yaml`):

```yaml
  # V3: renderDecision now receives a decision that has been through N7
  # (validateDecision), which applies §6.3's modifications to the original
  # tool arguments and puts the result in `applied_input`. V1 named
  # `modifications` here, which handed Claude Code the raw ACS modifications
  # object -- a shape its updatedInput does not accept, so the rewrite would
  # have been reported and never taken effect (R1.6).
  modify: { permissionDecision: allow, updatedInput_from: applied_input }
```

Keep the existing `defer` entry and its comment block, adding one sentence: V3 confirmed no AGT verdict maps to ACS `defer` (P2), so this entry stays a guard for a Guardian that emits one rather than a path this deployment exercises.

`render-decision.ts` needs **no code change** — it is already hookmap-driven. Add one sentence to its header recording that its input now arrives via N7, so `updatedInput_from` names a post-validation field.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/host-adapter && bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Add N7 validateDecision and §6.3's modification apply (R1.8)

The three mandatory fail-closed cases: malformed modifications deny,
expired ASK and DEFER fall back to their own timeout fields (both
defaulting to deny, per §6's deliberate opposite of on_decision_failure).
applyModifications turns ACS modifications into the host's updatedInput --
V1's hookmap handed Claude Code the raw modifications object, so a
rewrite was reported and never applied.

No branch can alter an arriving deny.

Slice: #4
Affordances: N7
```

---

### Task 7: N27 — Guardian-side failures arrive as decisions · slice #4 · N27

**Files:**
- Modify: `packages/guardian/src/server.ts` (the `dispatch` error branches, lines 277–326)
- Create: `packages/guardian/src/deny-on-invalid-envelope.ts`
- Create: `packages/guardian/test/deny-on-invalid-envelope.test.ts`
- Modify: `packages/guardian/test/server.test.ts`
- Modify: `docs/demos/v2-runbook.md`, `README.md` (cross-slice — see below)

**Interfaces:**
- Produces: `denyOnInvalidEnvelope(raw: unknown, options: { reasonCode: string; message: string }): { kind: "decision"; result: Record<string, unknown> } | { kind: "unaddressable" }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/guardian/test/deny-on-invalid-envelope.test.ts
import { describe, expect, it } from "bun:test";
import { denyOnInvalidEnvelope } from "../src/deny-on-invalid-envelope.ts";

const OPTS = { reasonCode: "envelope_invalid", message: "params.payload.tool is required" };

describe("denyOnInvalidEnvelope — N27", () => {
  it("returns a deny decision addressed by params.request_id", () => {
    const out = denyOnInvalidEnvelope(
      { jsonrpc: "2.0", id: "rpc-1", method: "steps/toolCallRequest", params: { acs_version: "0.1.0", request_id: "req-1" } },
      OPTS,
    );
    expect(out).toEqual({
      kind: "decision",
      result: {
        type: "final",
        acs_version: "0.1.0",
        request_id: "req-1",
        decision: "deny",
        reasoning: "params.payload.tool is required",
        reason_codes: ["envelope_invalid"],
        policy_references: [],
      },
    });
  });

  it("falls back to the JSON-RPC id when params.request_id is unusable", () => {
    const out = denyOnInvalidEnvelope({ jsonrpc: "2.0", id: "rpc-1", method: "steps/toolCallRequest", params: {} }, OPTS);
    expect(out).toMatchObject({ kind: "decision", result: { request_id: "rpc-1" } });
  });

  it("declares an acs_version even when the envelope named none", () => {
    const out = denyOnInvalidEnvelope({ jsonrpc: "2.0", id: 7, method: "steps/toolCallRequest", params: {} }, OPTS);
    expect(out).toMatchObject({ kind: "decision", result: { acs_version: "0.1.0", request_id: "7" } });
  });

  // Constraint 10 / P5: a decision must name the request it answers.
  it("reports unaddressable when there is no id of any kind", () => {
    expect(denyOnInvalidEnvelope({ jsonrpc: "2.0", method: "steps/toolCallRequest" }, OPTS)).toEqual({
      kind: "unaddressable",
    });
    expect(denyOnInvalidEnvelope(null, OPTS)).toEqual({ kind: "unaddressable" });
    expect(denyOnInvalidEnvelope({ id: { not: "a scalar" } }, OPTS)).toEqual({ kind: "unaddressable" });
  });

  it("never throws, whatever it is handed", () => {
    for (const raw of [undefined, 42, "string", [], Object.create(null)]) {
      expect(() => denyOnInvalidEnvelope(raw, OPTS)).not.toThrow();
    }
  });
});
```

Then in `packages/guardian/test/server.test.ts`, change the schema-invalid and evaluation-failure expectations. Find the tests asserting `error.code === -32010` and `-32020` for `steps/*` methods and rewrite them to assert a **decision**:

```ts
  it("answers a schema-invalid steps/* envelope with a deny decision, not a bare error (N27)", async () => {
    // ... post an envelope missing params.payload.tool ...
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      decision: "deny",
      reason_codes: ["envelope_invalid"],
      policy_references: [],
    });
    expect(typeof body.result.reasoning).toBe("string");
  });

  it("answers an evaluation failure with a deny decision (N27, R1.5)", async () => {
    // ... the existing setup that makes bridge.evaluate throw ...
    expect(body.result).toMatchObject({ decision: "deny", reason_codes: ["evaluation_failed"] });
  });

  it("keeps a JSON parse failure a JSON-RPC error — there is no envelope to decide about", async () => {
    // ... post "{not json" ...
    expect(body.error?.code).toBe(-32700);
  });

  it("keeps an unaddressable invalid envelope a JSON-RPC error (constraint 10)", async () => {
    // ... post a steps/* envelope with no id and no params.request_id ...
    expect(body.error?.code).toBe(-32010);
  });

  it("keeps a handshake failure a JSON-RPC error — a ServerHello is not a decision", async () => {
    // ... post handshake/hello with a malformed envelope ...
    expect(body.error?.code).toBe(-32010);
  });

  it("keeps an undispatched method a JSON-RPC error", async () => {
    // ... existing -32011 test, unchanged ...
  });
```

Also assert the tap still records both directions for the deny path (S6 pairs request and response), since the response is now a success rather than an error.

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/guardian
```

- [ ] **Step 3: Minimal implementation**

`deny-on-invalid-envelope.ts`:

```ts
/**
 * N27 -- denyOnInvalidEnvelope.
 *
 * A Guardian-side failure (the envelope failed validation, or evaluation
 * threw) is a governance outcome, not a transport accident. §6.4 says a
 * decision that arrives MUST be honoured regardless of posture, so
 * delivering these as decisions keeps them in the honoured path instead of
 * routing them into the host's fail-open posture -- which for a governance
 * tool is the difference between "blocked" and "silently allowed".
 *
 * That is the whole two-failure-domain rule (Global Constraint 1): AGT's
 * evaluation layer fails CLOSED, the wire's delivery layer applies the
 * negotiated posture, and the two must not be conflated.
 *
 * Constraint 10 (P5): response-envelope.json's AcsResult REQUIRES
 * request_id, and an envelope that failed validation may carry none. Rather
 * than invent one -- which would hand the host a decision it cannot
 * correlate -- this reports `unaddressable` and the caller returns a bare
 * JSON-RPC error. A parse failure never reaches here at all: there is no
 * envelope.
 *
 * Total: never throws, whatever shape it is handed.
 */
const ACS_VERSION_FALLBACK = "0.1.0";

export type DenyOnInvalidEnvelopeOptions = { reasonCode: string; message: string };

export type DenyOnInvalidEnvelopeResult =
  | { kind: "decision"; result: Record<string, unknown> }
  | { kind: "unaddressable" };

function readString(container: unknown, key: string): string | undefined {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function denyOnInvalidEnvelope(
  raw: unknown,
  { reasonCode, message }: DenyOnInvalidEnvelopeOptions,
): DenyOnInvalidEnvelopeResult {
  try {
    const params = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).params : undefined;

    // Preference order is deliberate: the ACS request_id is what a host
    // correlates a decision by; the JSON-RPC id is the fallback because it is
    // what the transport correlates by, and buildEnvelope sets them equal.
    let requestId = readString(params, "request_id");
    if (requestId === undefined) {
      const rpcId = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).id : undefined;
      if (typeof rpcId === "string" && rpcId.length > 0) {
        requestId = rpcId;
      } else if (typeof rpcId === "number") {
        requestId = String(rpcId);
      }
    }
    if (requestId === undefined) {
      return { kind: "unaddressable" };
    }

    return {
      kind: "decision",
      result: {
        type: "final",
        acs_version: readString(params, "acs_version") ?? ACS_VERSION_FALLBACK,
        request_id: requestId,
        decision: "deny",
        reasoning: message,
        reason_codes: [reasonCode],
        // Empty on purpose, and load-bearing: R1.2 makes a NON-empty
        // policy_references the marker of a policy-fired allow (AGT's warn).
        // A Guardian-side failure fired no policy, so this stays empty.
        policy_references: [],
      },
    };
  } catch {
    return { kind: "unaddressable" };
  }
}
```

In `server.ts`'s `dispatch`, replace the `EnvelopeValidationError` branch:

```ts
  } catch (error) {
    if (error instanceof EnvelopeValidationError) {
      // N27, wiring §V3's "wire N21's error branch to N27". Only for steps/*:
      // a handshake failure is not a governance decision (there is no step to
      // decide about), and an undispatched method is answered below.
      if (isStepMethod(raw)) {
        const denial = denyOnInvalidEnvelope(raw, { reasonCode: "envelope_invalid", message: error.message });
        if (denial.kind === "decision") {
          return successResponse(rpcId as string | number, denial.result);
        }
      }
      return errorResponse(rpcId, ENVELOPE_INVALID_CODE, error.message, { pointer: error.pointer });
    }
    throw error;
  }
```

with a small helper:

```ts
/** Whether the raw envelope names a `steps/*` method -- read before
 * validation, so it is a string test and nothing more. */
function isStepMethod(raw: unknown): boolean {
  const method = extractMethod(raw);
  return typeof method === "string" && method.startsWith("steps/");
}
```

and in the `TOOL_CALL_REQUEST_METHOD` branch's catch, replace the bare `EVALUATION_FAILED_CODE` error with the same pattern (`reasonCode: "evaluation_failed"`, message from `toRepoRelativeMessage(error)`), falling back to the error response when unaddressable. Note that `successResponse` requires a non-null id; when `rpcId` is null but a `params.request_id` exists, the JSON-RPC response still needs an id — in that case return the error response, since a JSON-RPC response with a null id cannot be correlated by the client either.

Update the three V1/V2 comments in `server.ts` that say "N27 stays V3's call" — they are now wrong, and a reader who trusts them will conclude the opposite of what the code does.

**Cross-slice documentation (mandatory, same commit or one immediately after):**
- `README.md` line ~140: the sentence "a schema-invalid envelope surfaces as a JSON-RPC **error**, not a `deny` decision. `N27 denyOnInvalidEnvelope()` … is V3" is now false. Rewrite it to state what V3 delivers, and keep the boundary that a *parse* failure and an *unaddressable* envelope remain errors.
- `docs/demos/v2-runbook.md`: its captured `✖ ERROR -32010` output for the schema-invalid case is now stale. Re-run that step against this branch and paste the real new output; if the Inspector renders `● DENY  reason_codes=[envelope_invalid]`, say so. Do **not** hand-edit captured output into what it ought to be — recapture it.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
N27: Guardian-side failures arrive as deny decisions

A schema or evaluation failure is a governance outcome, not a transport
accident. Delivering it as a decision keeps it in §6.4's honoured path
instead of routing it into the host's fail-open posture -- for a
governance tool, the difference between blocked and silently allowed.

A decision must name the request it answers, so an envelope carrying
neither request_id nor a scalar JSON-RPC id stays a JSON-RPC error, as
does a parse failure and a handshake failure. Updates V2's runbook and
the README, which quoted the old error output as captured.

Slice: #4
Affordances: N27
```

---

### Task 8: The shim uses all of it · slice #4 · N1, N5, N6, N7 wiring

The integration task: the first task where a real Claude Code payload meets a real posture. Give this one a standard model, not the cheapest — it coordinates five modules and two processes.

**Files:**
- Modify: `hosts/claude-code/acs-hook.ts` (whole `main`, and the header's "V1 SCOPE" paragraph)
- Create: `hosts/claude-code/test/posture.test.ts`
- Modify: `packages/guardian/src/main.ts` (print the audit path alongside the envelope log)

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, 6, plus `handshake` (N5, existing).
- Produces: no new exports. The shim's contract is stdin → stdout, and it **always exits 0 with a decision on stdout** once a hook payload parses.

- [ ] **Step 1: Write the failing test**

```ts
// hosts/claude-code/test/posture.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGuardian } from "guardian";

const SHIM = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../../policy/manifest.yaml", import.meta.url));

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-posture-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
      const full = join(dir, entry);
      try { unlinkSync(full); } catch { /* a directory; removed below */ }
    }
    for (const entry of (readdirSync(dir) as string[]).reverse()) {
      try { rmdirSync(join(dir, entry)); } catch { /* already gone */ }
    }
    rmdirSync(dir);
  }
});

function payload(command: string, sessionId = "sess-1"): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

async function runShim(
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SHIM], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("acs-hook — the negotiated posture, end to end", () => {
  it("handshakes on the first hook and leaves S13 on disk for the next process", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const env = {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      };
      const first = await runShim(payload("ls -la"), env);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "sessions", "sess-1.json"), "utf8")).on_decision_failure)
        .toBe("proceed");
    } finally {
      await guardian.close();
    }
  });

  it("still denies a destructive command — the posture never touches an arriving decision (R1.5)", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toContain("matched pattern");
      // Nothing failed to be delivered, so nothing is audited.
      expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
    } finally {
      await guardian.close();
    }
  });

  it("proceeds and audits when the Guardian is gone under the proceed posture (R1.7, §6.4)", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    const url = guardian.url;
    const env = {
      ACS_GUARDIAN_URL: url,
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    };
    // Hook 1 negotiates while the Guardian is alive...
    await runShim(payload("ls -la"), env);
    // ...then the Guardian dies, and hook 2 is a fresh process with only the file.
    await guardian.close();

    const out = await runShim(payload("rm -rf /"), env);
    expect(out.exitCode).toBe(0);
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe("allow");
    expect(hook.permissionDecisionReason).toMatch(/no decision/i);

    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ session_id: "sess-1", posture: "proceed", outcome: "proceeded" });
  });

  it("blocks when the Guardian is gone under the deny posture", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST, /* posture via env below */ });
    const env = {
      ACS_GUARDIAN_URL: guardian.url,
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    };
    // The Guardian process under test declares `deny`; startGuardian reads it
    // through handshakeResponder, so this test sets it before starting.
    // (Implementer: if startGuardian cannot take the posture as an option,
    // pass ACS_ON_DECISION_FAILURE through to a spawned Guardian instead --
    // do NOT mutate process.env in-process, which leaks across tests.)
    await runShim(payload("ls -la"), env);
    await guardian.close();

    const out = await runShim(payload("ls -la"), env);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ posture: "deny", outcome: "blocked" });
  });

  it("applies the ACS default when the Guardian was never reachable at all", async () => {
    const dir = scratch();
    const out = await runShim(payload("rm -rf /"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
    expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(false);
  });

  // The V1 placeholder exited 1 with empty stdout, which Claude Code reads as
  // "non-blocking error" and proceeds -- an unaudited, undeclared fail-open.
  // That is the shape of every fail-open this project has found. It must be gone.
  it("never exits non-zero with empty stdout once a hook payload has parsed", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.stdout.length).toBeGreaterThan(0);
    expect(out.exitCode).toBe(0);
  });

  it("still fails loudly on a payload that is not a hook payload at all", async () => {
    const out = await runShim("{not json", { ACS_SESSION_DIR: scratch() });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
  });

  it("rejects a traversal-shaped session_id without writing outside the session dir", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la", "../escape"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.exitCode).toBe(1);
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test hosts/claude-code/test/posture.test.ts
```

- [ ] **Step 3: Minimal implementation**

Rewrite `main()` in `hosts/claude-code/acs-hook.ts` to this shape (keeping the file as thin as V1's header promises — every piece of logic below is a call into the adapter):

1. Read and parse stdin; require a string `hook_event_name` and a string `session_id`. A failure here still throws and exits 1 — there is no hook to decide about, and nothing has been promised to Claude Code yet.
2. Build the session store: `createFileSessionConfigStore({ dir: process.env.ACS_SESSION_DIR ?? ".acs/sessions", sessionId })`. An `InvalidSessionIdError` exits 1 (constraint 9) — a host sending an unsafe `session_id` is a broken host, not a policy question.
3. Build the audit sink: `createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" })`.
4. If `store.get()` is `undefined`, attempt `handshake({ url, agentId: "claude-code", sessionId }, store)` inside a `try`. A failure is **not** fatal: record nothing yet, leave `sessionConfig` undefined, and carry the error forward as the delivery failure if the step call also fails. A handshake failure alone must not decide anything.
5. `const sessionConfig = store.get()`, `const timeoutMs = sessionConfig?.timeout_config.default_ms ?? DEFAULT_TIMEOUT_MS`.
6. `buildEnvelope` → `guardianClient.post(url, envelope, { timeoutMs })` inside a `try`. Three outcomes:
   - a `result` → `validateDecision(result, { elapsedMs, originalArguments })`
   - an `error` → `applyFailurePosture({ failure: response.error, ... })`
   - a throw → `applyFailurePosture({ failure: error, ... })`
7. `renderDecision(hookEventName, decision, hookmap)` → stdout, exit 0.

`elapsedMs` is measured with `performance.now()` around the post call. `originalArguments` is the envelope's unwrapped `payload.arguments` — the same values `buildEnvelope` put on the wire, so a `parameter_overrides` apply lands on what the policy actually saw.

Replace the header's "V1 SCOPE — Guardian-unreachable handling" paragraph entirely. The new text states: once a hook payload parses, this shim always exits 0 with a decision on stdout; the V1 behaviour (exit 1, empty stdout, Claude Code proceeds unaudited) was a placeholder and is gone.

`packages/guardian/src/main.ts` prints one more line so the runbook can name it:

```
Audit sink (S14): .acs/audit.jsonl   ← host-side; written by the hook, not by this process
```

Only if the Guardian actually knows that path — it does not. So instead print the negotiated posture, which it does know:

```
Failure posture (D8): proceed   (override with ACS_ON_DECISION_FAILURE=deny)
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Wire the shim to the posture it negotiates

First hook of a session handshakes and stores the ServerHello; later hooks
read the file, so a fresh subprocess knows the posture without a round
trip -- and still knows it when the Guardian is unreachable, which is the
only case the posture is for.

Removes V1's placeholder: exit 1 with empty stdout, which Claude Code
reads as a non-blocking error and proceeds. That was an unaudited,
undeclared fail-open of exactly the shape this project keeps finding.

Slice: #4
Affordances: N1, N5, N6, N7
```

---

### Task 9: U23 and N51 — the Inspector shows the posture · slice #4 · U23, N51

**Files:**
- Create: `packages/inspector/src/tail-audit-log.ts`
- Create: `packages/inspector/test/tail-audit-log.test.ts`
- Modify: `packages/inspector/src/render.ts`, `packages/inspector/test/render.test.ts`
- Modify: `packages/inspector/src/main.ts`
- Create: `test/audit-sink-roundtrip.test.ts`
- Modify: `test/invariants.test.ts`

**Interfaces:**
- Consumes: nothing from `host-adapter` — that is the point.
- Produces: `tailAuditLog(options)` (an async generator, same contract as `tailEnvelopeLog`), `renderPostureBadge(state)`, `renderAuditEntry(entry, options)`.

Read `packages/inspector/src/tail-envelope-log.ts` before writing the tailer. Its design is the spec: the timer starts lazily inside `drain()` on first `.next()` with the offset captured eagerly at call time, `pending` is a `Buffer` so a poll landing mid-codepoint cannot corrupt a line, `poll()` is wrapped, and a shape check runs between `JSON.parse` and `yield`. Do not re-derive it, and do not import it — declare this module's own `AuditEntry` (constraint 8).

- [ ] **Step 1: Write the failing test**

```ts
// packages/inspector/test/tail-audit-log.test.ts — the shape checks and
// truncation/partial-line cases mirror tail-envelope-log.test.ts. At minimum:
//   - yields entries appended after the tail starts
//   - --from-start replays existing entries
//   - a partial line written in two chunks is reassembled
//   - a line that parses but is not an AuditEntry goes to onMalformedLine, not the stream
//   - truncation resets the offset without losing entries parsed before it
//   - a poll error is reported and does not kill the generator
```

```ts
// added to packages/inspector/test/render.test.ts
describe("renderPostureBadge — U23", () => {
  it("shows the negotiated posture and a zero count before anything fails", () => {
    expect(renderPostureBadge({ posture: "proceed", proceeds: 0 }, { color: false }))
      .toBe("posture=proceed  fail-open proceeds=0");
  });

  // The number that matters. A fail-open bypass is invisible unless something
  // counts it, and §6.4 exists because it must not be invisible.
  it("counts audited fail-open proceeds", () => {
    expect(renderPostureBadge({ posture: "proceed", proceeds: 3 }, { color: false }))
      .toBe("posture=proceed  fail-open proceeds=3");
  });

  it("says so when no posture has been negotiated yet", () => {
    expect(renderPostureBadge({ posture: null, proceeds: 0 }, { color: false }))
      .toBe("posture=(not negotiated)  fail-open proceeds=0");
  });

  it("paints a non-zero proceed count as a warning and zero as clean", () => {
    expect(renderPostureBadge({ posture: "proceed", proceeds: 1 }, { color: true })).toContain("[33m");
    expect(renderPostureBadge({ posture: "proceed", proceeds: 0 }, { color: true })).not.toContain("[33m");
  });

  it("paints the deny posture distinctly from proceed", () => {
    const deny = renderPostureBadge({ posture: "deny", proceeds: 0 }, { color: true });
    const proceed = renderPostureBadge({ posture: "proceed", proceeds: 0 }, { color: true });
    expect(deny).not.toBe(proceed);
  });

  it("is byte-identical with color off, whatever the state", () => {
    for (const posture of ["proceed", "deny", null] as const) {
      for (const proceeds of [0, 1, 42]) {
        const out = renderPostureBadge({ posture, proceeds }, { color: false });
        expect(out).not.toContain("");
      }
    }
  });
});

describe("renderAuditEntry — N51", () => {
  it("renders a proceeded entry with the failure that caused it", () => {
    const line = renderAuditEntry(
      {
        seq: 1,
        recorded_at: "2026-08-10T12:00:00.000Z",
        session_id: "sess-1",
        method: "steps/toolCallRequest",
        rpc_id: "req-1",
        posture: "proceed",
        outcome: "proceeded",
        failure: { kind: "timeout", message: "no decision within 5000ms" },
      },
      { color: false },
    );
    expect(line).toContain("PROCEEDED");
    expect(line).toContain("steps/toolCallRequest");
    expect(line).toContain("timeout");
  });

  it("renders a blocked entry distinctly", () => {
    const line = renderAuditEntry(
      { seq: 2, recorded_at: "2026-08-10T12:00:01.000Z", session_id: "s", method: "m", rpc_id: null,
        posture: "deny", outcome: "blocked", failure: { kind: "transport", message: "gone" } },
      { color: false },
    );
    expect(line).toContain("BLOCKED");
  });
});
```

```ts
// test/audit-sink-roundtrip.test.ts — the contract test that keeps the two
// AuditEntry declarations honest, exactly as envelope-tap-roundtrip.test.ts
// does for TapEntry. Write with createAuditSink (host-adapter), read with
// tailAuditLog (inspector), assert every field survives for both outcomes.
```

And in `test/invariants.test.ts`, widen the R5.2 import gate from `["guardian", "agt-bridge"]` to `["guardian", "agt-bridge", "host-adapter"]`, with a comment stating why: the Inspector now reads a host-side artifact (S14), and without the third entry R5.2 would quietly weaken the moment N51 landed.

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/inspector test/invariants.test.ts test/audit-sink-roundtrip.test.ts
```

The invariants gate should fail **first**, before `tail-audit-log.ts` exists — confirm that, since a gate that only passes is a gate that proves nothing.

- [ ] **Step 3: Minimal implementation**

Write the three pieces. Constraints specific to this task:

- `packages/inspector/src/tail-audit-log.ts` declares its own `AuditEntry` and imports nothing from `host-adapter`. `isAuditEntryShape` validates `seq`, `recorded_at`, `session_id`, `method`, `posture`, `outcome`, and `failure.kind`/`failure.message`; `rpc_id` may be a string, number, or null.
- `renderPostureBadge` takes `{ posture: "proceed" | "deny" | null; proceeds: number }`. With `color: false` it emits no escape bytes at all.
- `main.ts` tails both logs concurrently and keeps a running badge: envelope lines stream as they do today, audit entries print as their own line, and the posture badge is re-emitted when it changes. `--audit-path` and `ACS_AUDIT_LOG` select the audit log, defaulting to `.acs/audit.jsonl`.
- **The vocabulary gate still applies:** no "AGT", no "claude", no host names anywhere under `packages/inspector/src`, comments included.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test && bun run typecheck
```

- [ ] **Step 5: Commit**

```
Inspector: show the negotiated posture and count fail-open proceeds

U23 and N51. A fail-open bypass is invisible unless something counts it,
which is why §6.4 requires the audit entry -- this is where a human sees
the count. The Inspector declares its own AuditEntry and imports nothing
from the adapter; the R5.2 gate now enforces that third boundary, and a
round-trip contract test keeps the two declarations from drifting.

Slice: #4
Affordances: U23, N51
```

---

### Task 10: Five verdicts, live · slice #4 · S8, R1.2

The coverage task. Everything before this made the paths exist; this proves the stock bundle actually drives all five through the wire.

**Files:**
- Create: `test/helpers/config-bundle.ts`
- Create: `test/dispositions.test.ts`
- Create: `policy/manifest.drift.yaml`
- Modify: `packages/agt-bridge/src/index.ts` (optional annotator dispatcher)
- Modify: `packages/agt-bridge/test/bridge.test.ts`
- Create: `docs/demos/v3-runbook.md`
- Modify: `slices/v3/README.md`, `README.md`

**Interfaces:**
- Produces:
  - `buildConfigBundle(config: unknown): { dir: string; cleanup(): void }` — copies `policy/lib/*.rego` into a temp directory alongside a `data.json` holding `{agt:{defaults:{config}}}`, and asserts each copied file is byte-identical to its source so a fixture can never silently fork the pinned bundle.
  - `buildManifest(options: { bundleDir: string; annotator?: boolean }): string` — writes a manifest pointing at that bundle.
  - `createBridge(manifestPath, options?: { annotator?: (name: string, config: unknown, preliminary: unknown) => unknown })`.

- [ ] **Step 1: Write the failing test**

```ts
// test/dispositions.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { startGuardian } from "guardian";
import { buildConfigBundle, buildManifest } from "./helpers/config-bundle.ts";

const DESTRUCTIVE = ["(?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$)"];
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)();
});

async function decide(config: unknown, command: string, annotator?: () => unknown) {
  const bundle = buildConfigBundle(config);
  cleanups.push(bundle.cleanup);
  const manifestPath = buildManifest({ bundleDir: bundle.dir, annotator: annotator !== undefined });
  const guardian = await startGuardian({ port: 0, manifestPath, annotator });
  try {
    const requestId = crypto.randomUUID();
    const res = await fetch(guardian.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "steps/toolCallRequest",
        params: {
          acs_version: "0.1.0",
          request_id: requestId,
          timestamp: new Date().toISOString(),
          metadata: { agent_id: "test", session_id: "sess-1" },
          payload: { tool: { name: "Bash" }, arguments: { command: { value: command } } },
        },
      }),
    });
    return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  } finally {
    await guardian.close();
  }
}

const PATTERNS = { patterns: { patterns: DESTRUCTIVE, reason: "destructive_shell_command_blocked" } };

describe("R1.2 — all five AGT verdicts arrive as ACS decisions, from the pinned bundle", () => {
  it("allow", async () => {
    const { result } = await decide(PATTERNS, "ls -la");
    expect(result).toMatchObject({ decision: "allow" });
    // A clean allow, not a policy-fired one: this is what distinguishes it from warn.
    expect(result?.policy_references ?? []).toEqual([]);
  });

  it("deny", async () => {
    const { result } = await decide(PATTERNS, "rm -rf /");
    expect(result).toMatchObject({ decision: "deny", reason_codes: ["destructive_shell_command_blocked"] });
  });

  it("escalate arrives as ask", async () => {
    const { result } = await decide({ ...PATTERNS, approval: { required: true, approvers: ["security-team"] } }, "ls -la");
    expect(result).toMatchObject({ decision: "ask", reason_codes: ["approval_required"] });
  });

  it("transform arrives as modify, carrying the rewritten argument (R1.6)", async () => {
    const { result } = await decide(
      { ...PATTERNS, redact: { patterns: ["ghp_[A-Za-z0-9]{6,}"], replacement: "[REDACTED]" } },
      "echo ghp_ABCDEF123456",
    );
    expect(result).toMatchObject({
      decision: "modify",
      reason_codes: ["redaction_applied"],
      modifications: { parameter_overrides: { command: "echo [REDACTED]" } },
    });
  });

  // R1.2's load-bearing half: warn has no ACS disposition of its own, so it
  // arrives as allow, and the NON-EMPTY policy_references is the only thing
  // distinguishing it from a clean allow.
  it("warn arrives as allow with non-empty policy_references", async () => {
    const { result } = await decide({ ...PATTERNS, drift: { warn_threshold: 0.5 } }, "ls -la", () => 0.9);
    expect(result).toMatchObject({ decision: "allow", reason_codes: ["drift_detected"] });
    expect(result?.policy_references).toEqual([{ policy_id: "agt_stock", rule_id: "drift_detected" }]);
  });

  // P3, stated as a test so the mechanic is recorded in code, not only prose.
  it("the stock chain's global approval switch outranks allow and transform", async () => {
    const config = {
      ...PATTERNS,
      approval: { required: true, approvers: ["sec"] },
      redact: { patterns: ["ghp_[A-Za-z0-9]{6,}"] },
    };
    expect((await decide(config, "echo ghp_ABCDEF123456")).result).toMatchObject({ decision: "ask" });
    expect((await decide(config, "rm -rf /")).result).toMatchObject({ decision: "deny" });
  });
});

describe("the fixture bundles never fork the pinned bundle", () => {
  it("copies every .rego byte-identically", () => {
    const bundle = buildConfigBundle(PATTERNS);
    cleanups.push(bundle.cleanup);
    // buildConfigBundle asserts this internally; this test proves the
    // assertion exists and runs, so a future edit cannot quietly drop it.
    expect(() => buildConfigBundle(PATTERNS).cleanup()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test test/dispositions.test.ts
```

- [ ] **Step 3: Minimal implementation**

- `test/helpers/config-bundle.ts` as specified. Copy only `*.rego` (not `run_tests.sh`, not `data.json`), read each source and target back and compare, throw naming the file on mismatch. `cleanup()` unlinks by name then `rmdir`s — no recursive delete.
- `buildManifest` emits the V1 manifest with `bundle:` pointing at the fixture directory, and when `annotator: true` adds:

```yaml
annotators:
  drift_score:
    type: classifier
```

and under `pre_tool_call`:

```yaml
    annotations:
      drift_score:
        from: "$.tool_call.args.command"
```

- `policy/manifest.drift.yaml` is the tracked equivalent for the runbook: same `bundle: lib`, same `query`, plus the two blocks above. Its header states plainly that the score is **supplied by the deployment, not derived from the ACS envelope** — `hooks/tool-call-request.json` carries no field it could come from — and that AGT's own design puts drift detection outside the policy engine, so a host-supplied score is AGT working as intended (P4, R4.3).
- `createBridge` gains an optional `annotator` callback, passed through as `AgentControl.fromPath(manifestPath, dispatcher)`. Wrap the caller's function so a throw inside it cannot escape as something other than AGT's own `annotation_failed`. `startGuardian` grows a matching optional `annotator` option, threaded to `createBridge`.
- `docs/demos/v3-runbook.md`: written from **real captured output**, one section per disposition with the exact `data.json` diff, plus the two posture runs (kill the Guardian under each). It must name what was not verified, as the V1 and V2 runbooks do. It must state P3 as a mechanic and not as a shortcoming.
- `slices/v3/README.md`: replace "Implementation goes here" with what shipped, and correct the demo sentence per P2.
- `README.md`: add the "Delivered in V3" table rows, update the Verify test count, update the Status section, and add the audit log to the artifacts `.acs/` holds.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test && bun run typecheck && bun run verify:pin
```

`verify:pin` matters here: this task copies the pinned bundle, and the byte-identity claim (R2.2/R2.3) is the one thing a fixture bundle could quietly break.

- [ ] **Step 5: Commit**

```
All five AGT verdicts, live over the wire (R1.2)

allow, deny, escalate as ask, transform as modify carrying the rewritten
argument, and warn as allow with non-empty policy_references -- which is
the only thing distinguishing it from a clean allow. Zero Rego authored:
every one is driven from data.agt.defaults.config over the pinned bundle.

warn needs a host-supplied annotation, because AGT puts drift detection
outside the policy engine and the ACS v0.1.0 wire carries no field to
derive a score from. Recorded for V7's matrix.

Slice: #4
Affordances: S8
```

---

## Risks

| # | Risk | Handling |
|---|---|---|
| 1 | `AbortSignal.timeout` interacts badly with Bun's `fetch` under load, making the timeout unreliable | Task 4's tests assert both directions (a slow server times out, a fast one does not) against a real `Bun.serve`. If it proves unreliable, the fallback is `Promise.race` with an explicit timer, which is behaviourally identical for our purposes |
| 2 | The audit sink and S13 both write under `.acs/`, which the Guardian creates today; a hook running before any Guardian has started has no `.acs/` | Both `createAuditSink` and `createFileSessionConfigStore` `mkdirSync(..., { recursive: true })` on first write. Task 8's "never reachable at all" test covers exactly this path |
| 3 | Claude Code runs hooks concurrently, so two processes handshake and write S13 at once | `set` writes to a temp file and renames, so a reader sees one complete config or the other. Both are the same ServerHello in practice; the test asserts no partial file survives |
| 4 | N27 changes V2's captured runbook output, and a hand-edited "fix" would put fiction in a document that claims to be a capture | Task 7 requires re-running the step and pasting the real output, and says so in the step |
| 5 | The fixture bundles in Task 10 could drift from the pinned bundle and quietly invalidate R2.2/R2.3 | `buildConfigBundle` asserts byte-identity per file on every build, and Task 10's Step 4 runs `verify:pin` |
| 6 | `warn` could read as "we made AGT do something it does not do" | P4 and the manifest's own header state the opposite: AGT deliberately puts drift outside the policy engine, and a host-supplied score is the design. R4.3 is Global Constraint 12, and the final review checks every document produced here against it |
| 7 | The `deny` posture test needs a Guardian that declares `deny`, which `handshakeResponder` reads from `process.env` | Task 8's test notes the constraint: thread the posture through `startGuardian` as an option, or spawn a real Guardian process with the env var. Mutating `process.env` in-process leaks across tests and is not acceptable |
| 8 | Ten tasks is a long run, and Task 8's integration work depends on five earlier tasks | Task order is dependency order, and every task ends green with `bun test` across the whole workspace, so a break surfaces at the task that caused it rather than at the end |
