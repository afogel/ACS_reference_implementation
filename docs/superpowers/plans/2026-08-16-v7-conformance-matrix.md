# V7: Conformance matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the two artifacts C5 names — a machine-checked ACS ↔ MS-ACS mapping table, and a coverage matrix of AGT's 8 intervention points against its 5 verdicts with every cell resolved — plus the Trace pillar measured as an explicit non-claim.

**Architecture:** A new `packages/conformance` **imports the Guardian and calls it** (`slices/v7/README.md` commitment 5): N41 round-trips through `resolveInterventionPoint`, N42 through `mapVerdict`, so the harness measures the runtime rather than a re-derivation of `mapping.yaml`. Its expected values come from nowhere the Guardian could also be wrong about — the 8 rows and 5 columns are the pinned SDK's own `InterventionPoint` and `Decision` consts. Four checks (N41–N44) each produce `CoverageCell`s; N47 renders them, N48 renders S10, N49 → N52 render the trace rows. N40 is a runner, not a test: it publishes the matrix and needs the pinned upstream `policy-input.schema.json`, so it fetches at `agt.lock`'s ref exactly as `verify:pin` already does.

**Tech Stack:** Bun, TypeScript, Ajv (already a Guardian dependency), the pinned `agent-control-specification@0.3.1-beta.0` SDK.

## Global Constraints

Copied verbatim from the requirements and commitments that bind every task below.

1. **R2.1 / R2.2 / R2.3 — AGT unforked.** Zero Rego authored. `policy/lib/*.rego` stays byte-identical to the pinned bundle; `policy/lib/data.json` is the only permitted policy-side change, and this slice needs none. `bun run verify:pin` must pass at the end of every task that touches policy or the bridge.
2. **R2.4 — couple to declared contract surfaces only:** `manifest.schema.json`, the `policy-input` / `verdict` / `snapshot` wire schemas, the intervention-point and verdict enums, `reserved-reasons.json`, and `data.agt.defaults.config`. Never SDK internals or private APIs.
3. **Commitment 1** (`slices/v7/README.md`) — the 8 × 5 is intervention points by **AGT** verdicts. Every description says "AGT". The five columns are `allow`, `deny`, `warn`, `escalate`, `transform`; ACS's own five (`allow`, `deny`, `modify`, `ask`, `defer`) are a different list and no name conflates them.
4. **Commitment 2** — `Mapping` is S10's data, `MappingTable` is U32's rendering, `CoverageMatrix` is U30's measurements. A type, file or variable named for one never holds either of the others, and the 8 × 5 is never called a mapping.
5. **Commitment 3** — N47 is `renderCoverageMatrix()`, N52 is `renderTraceRows()`. Nothing in this repository is named `renderMatrix`. No renderer takes a discriminator saying which kind of table it is being asked for.
6. **Commitment 4** — a trace-pillar row is not a cell of the 8 × 5. Nothing here is named `exportTrace`, `traceExporter` or `emitSpan`: V7 *measures* the Trace pillar and does not build an exporter.
7. **Commitment 5** — the harness imports the Guardian and calls it. It does not redeclare `Mapping`. Its axes come from the SDK's consts, never from a list the Guardian hardcodes.
8. **Commitment 6** — N43 is a *recomputation* check. Nothing in this slice is named for a field ACS v0.1.0 does not have; no `enforced_identity` member appears on anything envelope-shaped.
9. **R5.1 / R5.2 — the Inspector still imports nothing** from `@acs/guardian`, `agt-bridge` or `host-adapter`. `test/invariants.test.ts` gates it. The conformance package is **not** subject to this ban (commitment 5) and must not be added to that gate.
10. **Comments state measured facts.** No line, file or diff counts. A claim that outlived what it described is a defect. Captured output is re-run, never hand-edited.
11. **Every cell is resolved, never "green".** A cell that was not measured says so; it does not read as green by omission.

---

## Slice Contract

| Field | Value |
|---|---|
| Slice ID | **GitHub issue #8** — "V7: Conformance matrix" (PR #16, `slice/v7` → `slice/v6`) |
| Slices doc | `docs/shaping/acs-reference-impl-slices.md` **§V7, line 475** |
| Demo | *"Eight intervention points by five AGT verdicts, every cell resolved — green where ACS v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim."* |
| Parts | C1, C2, C5 (`docs/shaping/acs-reference-impl-shaping.md` line 157–162) |
| Requirements | R5.3 (declare claimed profiles/pillars). Cells measured for: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7 |

### Components

| ID | What it is |
|---|---|
| U30 | coverage matrix, 8 intervention points × 5 AGT verdicts — render |
| U32 | rendered ACS ↔ MS-ACS mapping table — render |
| U33 | trace-pillar rows: each required OTel attribute, its v0.1.0 wire source, and whether a wire consumer can emit it — render |
| N40 | the conformance runner — calls N41, N42, N43, N44, N49 |
| N41 | intervention-point round trip, validated against `policy-input.schema.json` → N47 |
| N42 | verdict round trip: AGT verdict → ACS decision → AGT verdict, assert identity → N47 |
| N43 | `enforced_identity` recomputation check → N47 |
| N44 | failure-domain check: an AGT evaluation error arrives as an honored `deny`; a delivery failure applies the negotiated posture and writes an audit event → N47 |
| N49 | trace-pillar check: every attribute `trace/otel-mapping.json` marks required, resolved against the v0.1.0 wire schemas — a cell is green only when a *wire consumer* could emit it → N52 |
| N47 | `renderCoverageMatrix()` — the 8 × 5 cells N41–N44 measure, and nothing else → U30 |
| N52 | `renderTraceRows()` — N49's trace-pillar rows → U33 |
| N48 | `renderMappingTable()` → U32 |
| S10 | `mapping.yaml` — the file the runtime already reads, read here by the harness that measures and publishes it |

### Parked items

| Parked | Defers to |
|---|---|
| N53 `renderUpstreamDiff()` → U31 | **V8.** Its only input is V8's N46 `diffSurfaces()`, so V7 can neither build nor test it. §V8's table carries the row. |
| An OTel exporter | **A slice of its own.** §V7's scope boundary: V7 *measures* the Trace pillar; an exporter could only live in the Guardian, for the reason the measurement itself establishes. |
| A hookmap's `tools` list checked against `policy/manifest.yaml`'s registry | **V8** (§V5's residual, slices doc line 567). |
| Event-driven Inspector tail tests | **V2's rail** (slices doc line 569). Not this slice's. |

### Watch-for notes (verbatim)

> **Scope boundary:** V7 *measures* the Trace pillar. It does not build an exporter. If an exporter is ever wanted it has to live in the Guardian for the reason above, and that is a slice of its own, not V7 scope.

> Red cells with a stated reason are worth more than a green matrix that quietly redefines the claim, and they are the forcing function for `steps/modelCall` and for an `evaluator` field on `AcsResult` in v0.2.

> The three names are frozen in `slices/v7/README.md`; the columns of the 8 × 5 are AGT's five verdicts, never ACS's five dispositions.

### Corrections carried in the slice

| Correction | Governs |
|---|---|
| ⚠️ **Demo corrected (was "all green")** — every cell *resolved*, not green | Task 7, Task 9, Task 10 |
| ⚠️ **`renderMatrix()` split** into N47 / N52 / N53 before anything inherited it | Tasks 7, 8; N53 is V8's |
| ⚠️ **Gap discovered in V1** — the Guardian's outbound envelopes are validated by nothing. *"Add response validation before the matrix is published."* | **Task 2** |
| ⚠️ **The Trace pillar lands here (D10)**, two cells already known red | Task 8 |
| ⚠️ **One more cell to resolve, from V3** — `warn` is green for the Guardian, red for a wire consumer | Task 4 |
| ⚠️ **A third cell resolves the same way — R1.4's.** v0.1.0 carries no action-identity field on any of its 43 schemas | Task 5 |
| ⚠️ **N43 has an input problem the bridge deliberately created** — V7 must choose before it is written | **Resolved: Task 1.** See "Decisions taken" below |
| ⚠️ **R5.3 is a declaration with its evidence beside it**, not a matrix that doubles as both | Task 10 |

### Decisions taken (both were open in §V7; both are amended back into it — see Step 5)

**D-a — N43's seam: a second message on the role.** `PolicyBridge` gains `evaluateWithEvidence()`, and `evaluate()` is implemented *in terms of it*, so there is exactly one path to AGT and the two cannot diverge. `evaluate` still answers with the verdict alone, so the PR #10 finding stands and `server.ts` is unchanged. The alternatives were rejected for stated reasons: a fat return re-creates the bag PR #10 removed, with the harness as its only new reader; a separate factory creates a second path to AGT and a harness certifying a path production does not take.

**D-b — no upstream issues filed.** V7 lands the red cells with their measured reasons and states the v0.2 fork (below). Filing against the ACS repository is a separate, deliberate act, not part of this slice.

**The v0.2 fork V7 publishes, measured during planning.** AGT's `enforcedIdentity` is the SHA-256 of `policyInput` with **`policy_target.value` alone** swapped for the transform — the snapshot copy of that leaf is *not* updated. The host applies ACS `modifications` to the **ACS payload**. Those are two documents in two vocabularies, so "add `enforced_identity` to `AcsResult`" is necessary and not sufficient: a host receiving that field could not check it, because the wire never carries the policy input. v0.2 needs either **(a)** an identity computed over a canonicalization of the ACS action the host will execute — which AGT does not produce — or **(b)** enough of the policy input on the decision envelope for the host to recompute, which re-exposes the snapshot ACS keeps host-side.

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U30 coverage matrix | Task 7 | rendered by N47 |
| U32 mapping table | Task 6 | rendered by N48 |
| U33 trace-pillar rows | Task 8 | rendered by N52 |
| N40 runner | Task 9 | `bun run conformance` |
| N41 intervention-point round trip | Task 3 | schema leg on the pinned-clone path, Task 9 |
| N42 verdict round trip | Task 4 | inverse derived from `mapping.yaml`, never hardcoded |
| N43 `enforced_identity` recomputation | Task 5 | consumes Task 1's evidence surface |
| N44 failure-domain check | Task 6 | drives a live Guardian, both postures |
| N47 `renderCoverageMatrix()` | Task 7 | |
| N48 `renderMappingTable()` | Task 6 | |
| N49 trace-pillar check | Task 8 | |
| N52 `renderTraceRows()` | Task 8 | |
| S10 `mapping.yaml` | Tasks 3, 4, 6 | read via the Guardian's own `loadMapping` |
| Parked → V8: N53 `renderUpstreamDiff()` | not in this plan | stays V8's |
| Parked → own slice: an OTel exporter | not in this plan | commitment 4 forbids even the name |
| Parked → V8: hookmap `tools` vs manifest registry | not in this plan | stays V8's |
| Parked → V2: event-driven tail tests | not in this plan | stays V2's rail |
| ⚠️ Demo corrected — "resolved", not "green" | Tasks 7, 9, 10 | `CellStatus` has no "green-by-omission" state |
| ⚠️ `renderMatrix()` split | Tasks 7, 8 | a gate in Task 7 asserts the name is absent |
| ⚠️ V1 gap — outbound envelopes validated by nothing | **Task 2** | before the matrix is published, as the slice directs |
| ⚠️ Trace pillar (D10) | Task 8 | |
| ⚠️ `warn` green-for-Guardian / red-for-wire | Task 4 | |
| ⚠️ R1.4 green-for-Guardian / red-for-wire | Task 5 | |
| ⚠️ N43's input problem | Task 1 | decision D-a |
| ⚠️ R5.3 declaration ≠ matrix | Task 10 | |
| R1.1 all 8 points map without loss | Task 3 | two red, D4 |
| R1.2 all 5 verdicts map without loss | Task 4 | |
| R1.3 five policy-input members constructible | Task 3 | `annotations` qualified — four of five |
| R1.4 `enforced_identity` survives the adapter | Task 5 | qualified — see Step 5 amendment |
| R1.5 AGT evaluation fail-closed survives | Task 6 | N44 |
| R1.6 `$policy_target` survives as ACS `modify` | Tasks 4, 5 | |
| R1.7 delivery failure applies the negotiated posture | Task 6 | N44 |
| R5.3 declare claimed profiles and pillars | Task 10 | |

---

## File structure

| File | Responsibility |
|---|---|
| `packages/agt-bridge/src/index.ts` **(modify)** | gains `AgtEvidence` and `evaluateWithEvidence`; `evaluate` reimplemented in terms of it |
| `packages/guardian/src/validate-response.ts` **(create)** | N21's outbound twin: validates a JSON-RPC response against `response-envelope.json` |
| `packages/guardian/src/server.ts` **(modify)** | calls the response validator on the one total funnel |
| `packages/guardian/src/index.ts` **(modify)** | exports `resolveInterventionPoint`, which the harness needs |
| `packages/conformance/package.json` **(create)** | workspace member; depends on `guardian` and `agt-bridge` |
| `packages/conformance/src/cells.ts` **(create)** | `CoverageCell`, `CellStatus`, the 8 × 5 axes read off the SDK's consts |
| `packages/conformance/src/intervention-points.ts` **(create)** | N41 |
| `packages/conformance/src/verdicts.ts` **(create)** | N42, and the inverse index derived from `mapping.yaml` |
| `packages/conformance/src/identity.ts` **(create)** | N43 |
| `packages/conformance/src/failure-domains.ts` **(create)** | N44 |
| `packages/conformance/src/trace-pillar.ts` **(create)** | N49 |
| `packages/conformance/src/render.ts` **(create)** | N47, N48, N52 — three renderers, no discriminator |
| `packages/conformance/src/main.ts` **(create)** | N40, the runner |
| `packages/conformance/src/index.ts` **(create)** | the package barrel |
| `scripts/run-conformance.sh` **(create)** | fetches the pinned AGT ref for N41's schema leg, mirroring `scripts/verify-pin.sh` |
| `slices/v7/README.md` **(modify)** | implementation section; the R5.3 declaration |
| `docs/demos/v7-runbook.md` **(create)** | captured output, re-run never hand-edited |
| `README.md` **(modify)** | V7 moves from "Planned" to "Delivered" |

---

## Task 1: `evaluateWithEvidence` on the bridge role · slice #8 · (enables N43)

**Files:**
- Modify: `packages/agt-bridge/src/index.ts:64-66` (the `PolicyBridge` type), `:125-130` (`createBridge`'s return)
- Modify: `packages/agt-bridge/test/bridge.test.ts:99` (the `standIn` stand-in)
- Modify: `packages/guardian/test/server.test.ts:128` (`recordingBridge`)
- Test: `packages/agt-bridge/test/bridge.test.ts`

**Interfaces:**
- Produces: `type AgtEvidence = { verdict: AgtVerdict; policyInput: unknown; inputIdentity: string; enforcedIdentity: string }`; `PolicyBridge<S>.evaluateWithEvidence(point: string, snapshot: S): Promise<AgtEvidence>`
- Consumes: nothing from earlier tasks.

**Why this shape.** The PR #10 review took `inputIdentity` / `enforcedIdentity` / `transformedPolicyTarget` off `evaluate`'s return because the one production caller destructured `{ verdict }` and dropped the rest. That finding is unchanged: `server.ts` still wants a verdict. So the *interface* widens, not the *return* — and `evaluate` is implemented by calling `evaluateWithEvidence`, so there is exactly one path to AGT and a harness measuring the wide message is measuring the same call production takes.

`transformedPolicyTarget` is deliberately **not** on `AgtEvidence`: N43 recomputes the enforced identity from `policyInput` and `verdict.transform.value`, and the SDK's own `transformedPolicyTarget` is its evidence for the claim rather than an input to the check. Carrying it would give the check a way to agree with AGT without recomputing anything.

- [ ] **Step 1: Write the failing tests**

In `packages/agt-bridge/test/bridge.test.ts`, add:

```ts
describe("evaluateWithEvidence -- the wide message, for measurement rather than for deciding", () => {
  it("carries the policy input AGT hashed, and both identities", async () => {
    const evidence = await bridge.evaluateWithEvidence("pre_tool_call", snapshotFor("ls -la"));

    expect(evidence.verdict.decision).toBe("allow");
    expect(evidence.inputIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.enforcedIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The five members R1.3 names, and no sixth: policy-input.schema.json
    // declares additionalProperties: false over exactly these.
    expect(Object.keys(evidence.policyInput as object).sort()).toEqual([
      "annotations",
      "intervention_point",
      "policy_target",
      "snapshot",
      "tool",
    ]);
  });

  it("answers `evaluate` with the same verdict object the wide call carries, because one implements the other", async () => {
    const narrow = await bridge.evaluate("pre_tool_call", snapshotFor("ls -la"));
    const wide = await bridge.evaluateWithEvidence("pre_tool_call", snapshotFor("ls -la"));

    expect(narrow).toEqual(wide.verdict);
  });

  it("separates the identities when a transform actually rewrites the target", async () => {
    const evidence = await bridge.evaluateWithEvidence("post_tool_call", {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "TOKEN=ghp_ONLYINOUTPUT999\n" }] },
      input: { ifc: { source_labels: ["public"] } },
    });

    expect(evidence.verdict.decision).toBe("transform");
    expect(evidence.inputIdentity).not.toBe(evidence.enforcedIdentity);
  });
});
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `bun test packages/agt-bridge/test/bridge.test.ts`
Expected: FAIL — `bridge.evaluateWithEvidence is not a function`.

- [ ] **Step 3: Implement**

In `packages/agt-bridge/src/index.ts`, add above `PolicyBridge`:

```ts
/**
 * What AGT reports about its own evaluation, as distinct from what it
 * decided. Four fields, and the distinction is the whole point of the type
 * being separate from `AgtVerdict`: a verdict is an answer about this step,
 * and these are facts about how the answer was reached.
 *
 * `policyInput` is `unknown` on purpose. It is AGT's five-member policy input
 * document (`policy-input.schema.json` declares `additionalProperties: false`
 * over exactly `intervention_point`, `policy_target`, `snapshot`,
 * `annotations`, `tool`), and this package will not name a shape it does not
 * own -- the conformance harness validates it against AGT's own schema at the
 * pinned ref, which is a stronger check than a hand-written mirror of it here
 * and cannot drift from upstream without the check saying so.
 *
 * `transformedPolicyTarget` is deliberately absent even though the SDK
 * returns it. The one caller recomputes the enforced identity from
 * `policyInput` and `verdict.transform.value`; handing it AGT's own already-
 * transformed target would give the check a way to agree with AGT without
 * recomputing anything, which is the one thing a recomputation check must not
 * have.
 */
export type AgtEvidence = {
  verdict: AgtVerdict;
  policyInput: unknown;
  inputIdentity: string;
  enforcedIdentity: string;
};
```

Replace the `PolicyBridge` type body (keep its existing doc comment and append the paragraph below to it):

```ts
export type PolicyBridge<S extends InterventionSnapshot = InterventionSnapshot> = {
  evaluate(point: string, snapshot: S): Promise<AgtVerdict>;
  evaluateWithEvidence(point: string, snapshot: S): Promise<AgtEvidence>;
};
```

Append to that type's doc comment:

```
 * TWO MESSAGES, ONE PATH. `evaluate` answers the question the Guardian asks
 * -- what was decided -- and still answers with the verdict alone, which is
 * the PR #10 finding and is unchanged: the decision path reads a verdict and
 * would drop anything else. `evaluateWithEvidence` answers the question the
 * conformance harness asks -- what AGT computed on the way -- because V7's
 * N43 recomputes `enforced_identity` and cannot do it from a verdict.
 *
 * Widening `evaluate`'s RETURN instead would have put three fields nothing on
 * the decision path reads back onto every answer, which is precisely the bag
 * that review removed. A separate factory for the harness would have been
 * worse in the other direction: two paths to AGT, with a conformance harness
 * certifying the one production does not take. `createBridge` implements
 * `evaluate` by calling `evaluateWithEvidence`, so there is exactly one call
 * into the SDK and the narrow answer is provably a projection of the wide one.
```

Replace `createBridge`'s returned object:

```ts
  return {
    async evaluateWithEvidence(point: string, snapshot: InterventionSnapshot): Promise<AgtEvidence> {
      const result = await control.evaluateInterventionPoint(point as never, snapshot as never);
      return {
        verdict: result.verdict as AgtVerdict,
        policyInput: result.policyInput,
        // Non-null asserted rather than defaulted: the SDK declares both
        // optional, and a default would let a binding that stopped
        // reporting them read as a successful measurement of an empty
        // string. AGT's Node binding sets both on every result (this
        // package's own test pins it, and A4 was amended to the Node SDK
        // for exactly this reason), so their absence is an upstream change
        // V8 should report, not a case to paper over here.
        inputIdentity: result.inputIdentity!,
        enforcedIdentity: result.enforcedIdentity!,
      };
    },
    async evaluate(point: string, snapshot: InterventionSnapshot): Promise<AgtVerdict> {
      return (await this.evaluateWithEvidence(point, snapshot)).verdict;
    },
  };
```

Then update the two stand-ins. In `packages/agt-bridge/test/bridge.test.ts` the `standIn` object and in `packages/guardian/test/server.test.ts` the `recordingBridge` factory each gain an `evaluateWithEvidence` that returns the same verdict with fixed identities:

```ts
  // A stand-in for a role with two messages implements both. The identities
  // are fixed strings rather than real hashes: this double exists to show the
  // Guardian depends on a role and not on `createBridge`, and the Guardian
  // never reads them.
  async evaluateWithEvidence(_point: string, _snapshot: unknown) {
    return {
      verdict,
      policyInput: {},
      inputIdentity: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      enforcedIdentity: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
  },
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test && bun run typecheck && bun run verify:pin`
Expected: all pass. `verify:pin` because this task touches the package that loads the bundle.

- [ ] **Step 5: Commit**

```bash
git add packages/agt-bridge packages/guardian/test/server.test.ts
git commit -m "Give the bridge role a second message rather than a fatter answer

Slice: #8"
```

---

## Task 2: The Guardian validates what it sends · slice #8 · (§V7's V1 gap)

**Files:**
- Create: `packages/guardian/src/validate-response.ts`
- Modify: `packages/guardian/src/server.ts` — `handleAcsRequest`, at the single point every response passes through
- Modify: `packages/guardian/src/index.ts` — export the validator
- Test: `packages/guardian/test/validate-response.test.ts`

**Interfaces:**
- Produces: `validateResponse(response: unknown): ResponseValidation` where
  `type ResponseValidation = { valid: true } | { valid: false; pointer: string; message: string } | { valid: "unexpressible"; reason: string }`
- Consumes: nothing from Task 1.

**Why this task exists, and why it is not simply "run Ajv on the way out".** §V7: *"Inbound requests get Ajv against all 43 v0.1.0 schemas (N21), but responses are hand-built objects checked by no schema. The conformance harness would therefore measure a wire format that was never itself contract-checked."*

And the measured complication, also from §V7: `response-envelope.json`'s `result` unconditionally `$ref`s `AcsResult`, which requires `decision`. A ServerHello has no `decision`, so **a conformant handshake response cannot satisfy the response envelope schema.** That is a v0.1.0 spec gap, not a Guardian bug. So the validator has a third answer — `"unexpressible"` — and the handshake response takes it, with the reason recorded. A validator with two answers would have to either fail a correct response or skip it silently, and both are worse than saying what is true.

**The validator must never turn a governed step into an ungoverned one.** It reports; it does not throw and does not alter the response. A response that fails validation is still sent, and the failure is written to the envelope log where the Inspector already renders it — the same discipline `envelope-log-sink.ts` states for S6.

- [ ] **Step 1: Write the failing tests**

Create `packages/guardian/test/validate-response.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { validateResponse } from "../src/validate-response.ts";

describe("validateResponse -- N21's outbound twin", () => {
  it("accepts a decision response the Guardian actually builds", () => {
    expect(
      validateResponse({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: {
          type: "final",
          acs_version: "0.1.0",
          request_id: "req-1",
          decision: "allow",
        },
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a decision response carrying a disposition ACS does not define", () => {
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { type: "final", acs_version: "0.1.0", request_id: "req-1", decision: "warn" },
    });

    expect(outcome.valid).toBe(false);
  });

  it("reports a handshake response as unexpressible rather than invalid, because the schema cannot state it", () => {
    const outcome = validateResponse({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { acs_version: "0.1.0", methods_evaluated: [], on_decision_failure: "proceed" },
    });

    expect(outcome).toEqual({
      valid: "unexpressible",
      reason:
        "response-envelope.json's `result` unconditionally $refs AcsResult, which requires `decision`; " +
        "a ServerHello has no such field, so v0.1.0 has no discriminated union for non-decision methods",
    });
  });

  it("accepts a JSON-RPC error response, which the envelope schema does express", () => {
    expect(
      validateResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    ).toEqual({ valid: true });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/guardian/test/validate-response.test.ts`
Expected: FAIL — cannot resolve `../src/validate-response.ts`.

- [ ] **Step 3: Implement**

Create `packages/guardian/src/validate-response.ts`. Read `packages/guardian/src/validate-envelope.ts` first and reuse its Ajv construction and schema-loading approach verbatim — the same 43 v0.1.0 schemas, the same `ajv-formats`, the same repo-relative resolution — so the two validators cannot come to disagree about which spec they are checking against.

```ts
/**
 * N21's outbound twin, and the gap it closes was §V7's to find: inbound
 * requests are checked against all 43 v0.1.0 schemas and responses were
 * hand-built objects checked by nothing. A conformance harness publishing a
 * matrix over that wire would have been measuring a format that was never
 * itself contract-checked -- which weakens exactly the claim C2 exists to
 * prove.
 *
 * THREE ANSWERS, NOT TWO, and the third is a measured fact about v0.1.0
 * rather than a hedge. `response-envelope.json` declares `result` as an
 * unconditional `$ref` to `AcsResult`, and `AcsResult` requires `decision`.
 * A ServerHello has no `decision`. So a correct handshake response cannot
 * satisfy the response envelope schema, and a two-answer validator would have
 * to call a correct response invalid or skip it in silence. `unexpressible`
 * says which, and carries the reason into the envelope log where the
 * Inspector renders it. V7's matrix carries the same cell.
 *
 * REPORTS, NEVER THROWS, and never alters the response. This runs on the
 * decision path; a validator that could turn a governed tool call into an
 * error response would be a fail-open of exactly the family this project
 * keeps closing. A response that fails validation is still sent, and the
 * failure is recorded.
 */
```

Export:

```ts
export type ResponseValidation =
  | { valid: true }
  | { valid: false; pointer: string; message: string }
  | { valid: "unexpressible"; reason: string };

const HANDSHAKE_UNEXPRESSIBLE =
  "response-envelope.json's `result` unconditionally $refs AcsResult, which requires `decision`; " +
  "a ServerHello has no such field, so v0.1.0 has no discriminated union for non-decision methods";

export function validateResponse(response: unknown): ResponseValidation {
  if (isServerHelloResponse(response)) {
    return { valid: "unexpressible", reason: HANDSHAKE_UNEXPRESSIBLE };
  }
  const validate = responseEnvelopeValidator();
  if (validate(response)) {
    return { valid: true };
  }
  const first = validate.errors?.[0];
  return {
    valid: false,
    pointer: first?.instancePath ?? "",
    message: first ? `${first.instancePath || "/"} ${first.message}` : "response failed validation",
  };
}
```

`isServerHelloResponse` tests for a `result` that is an object with no `decision` member and a `methods_evaluated` member — the ServerHello's own required field per `handshake.json` — rather than for the absence of `decision` alone, so a malformed decision response that merely lost its `decision` is reported invalid rather than excused.

Then wire it into `packages/guardian/src/server.ts`'s `handleAcsRequest`, immediately before the existing `envelopeLog.write("response", response, method)` call — the one funnel every route already passes through:

```ts
  const validation = validateResponse(response);
  if (validation.valid === false) {
    // Reported, not thrown, and the response is sent unchanged: see
    // validate-response.ts. This is the outbound half of N21, and it must
    // not be able to turn a governed step into an ungoverned one.
    console.error(
      `guardian sent a response that fails response-envelope.json at ${validation.pointer}: ${validation.message}`,
    );
  }
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test && bun run typecheck`
Expected: all pass. If any existing test's Guardian now logs a validation failure, that is a **finding, not noise** — record it in `slices/v7/README.md` and resolve it before moving on; a response the Guardian builds that its own schema rejects is exactly what this task exists to surface.

- [ ] **Step 5: Commit**

```bash
git add packages/guardian
git commit -m "Check what the Guardian sends against the schema it claims to speak

Slice: #8"
```

---

## Task 3: N41 — the intervention-point round trip · slice #8 · N41, S10

**Files:**
- Create: `packages/conformance/package.json`, `packages/conformance/src/cells.ts`, `packages/conformance/src/intervention-points.ts`, `packages/conformance/src/index.ts`
- Modify: `packages/guardian/src/index.ts` — export `resolveInterventionPoint`
- Test: `packages/conformance/test/intervention-points.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const AGT_POINTS: readonly string[];      // the SDK's InterventionPoint const, values sorted
  export const AGT_VERDICTS: readonly string[];    // the SDK's Decision const, values sorted
  export type CellStatus = "expressed" | "guardian_only" | "unexpressed";
  export type CoverageCell = {
    point: string;
    verdict: string;
    status: CellStatus;
    reason?: string;
    measuredBy: string[];
  };
  export function checkInterventionPoints(mapping: Mapping): CoverageCell[];
  ```
- Consumes: `loadMapping`, `resolveInterventionPoint`, `type Mapping` from `guardian`.

**Why the statuses are named this way.** Not `green` / `red`: §V7 retracted "green" as a success name because a matrix that must be green is a matrix under pressure to redefine its claim. `expressed` says ACS v0.1.0 expresses AGT at this cell; `unexpressed` says it cannot, and carries the reason; `guardian_only` is the third answer three independent findings have now landed on — the `warn` column, D10's Trace attributes, and R1.4 — where the Guardian can do it from process-local knowledge and a wire consumer cannot. There is no default: `CoverageCell` requires `status`, so a cell cannot read as expressed by having gone unmeasured.

**Why the axes come from the SDK.** Commitment 5. The eight rows and five columns are read off `InterventionPoint` and `Decision`, the `Readonly` consts the pinned SDK exports. A matrix whose axes came from `mapping.yaml` — or from a list this package keeps — would be measuring the declaration against itself.

- [ ] **Step 1: Write the failing test**

Create `packages/conformance/test/intervention-points.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { AGT_POINTS, AGT_VERDICTS } from "../src/cells.ts";
import { checkInterventionPoints } from "../src/intervention-points.ts";

const mapping = loadMapping("mapping.yaml");

describe("the axes come from AGT, not from us", () => {
  it("has eight intervention points, which is AGT's closed set", () => {
    expect(AGT_POINTS).toHaveLength(8);
    expect(AGT_POINTS).toContain("pre_tool_call");
    expect(AGT_POINTS).toContain("post_model_call");
  });

  it("has five AGT verdicts, and none of ACS's own three that differ", () => {
    expect(AGT_VERDICTS).toEqual(["allow", "deny", "escalate", "transform", "warn"]);
    expect(AGT_VERDICTS).not.toContain("modify");
    expect(AGT_VERDICTS).not.toContain("ask");
    expect(AGT_VERDICTS).not.toContain("defer");
  });
});

describe("N41 -- the intervention-point round trip", () => {
  const cells = checkInterventionPoints(mapping);

  it("produces one cell per point per verdict, and no others", () => {
    expect(cells).toHaveLength(AGT_POINTS.length * AGT_VERDICTS.length);
  });

  it("round-trips every point that mapping.yaml gives an ACS method", () => {
    const expressed = cells.filter((c) => c.point === "pre_tool_call");

    expect(expressed).toHaveLength(5);
    for (const cell of expressed) {
      expect(cell.status).toBe("expressed");
      expect(cell.measuredBy).toContain("N41");
    }
  });

  it("marks both model-call points unexpressed, carrying mapping.yaml's own stated reason", () => {
    for (const point of ["pre_model_call", "post_model_call"]) {
      const cells_ = cells.filter((c) => c.point === point);
      expect(cells_).toHaveLength(5);
      for (const cell of cells_) {
        expect(cell.status).toBe("unexpressed");
        expect(cell.reason).toBe("no ACS v0.1.0 target — D4, V7 red cell");
      }
    }
  });

  it("fails the round trip when a row's acs_method resolves back to a different point", () => {
    // Two rows naming one method: resolveInterventionPoint throws rather than
    // picking by YAML key order, and N41 records that as unexpressed rather
    // than letting the throw escape and take the whole matrix with it.
    const ambiguous = {
      ...mapping,
      intervention_points: {
        ...mapping.intervention_points,
        output: { acs_method: "steps/toolCallRequest" },
      },
    };
    const broken = checkInterventionPoints(ambiguous).filter((c) => c.point === "pre_tool_call");

    for (const cell of broken) {
      expect(cell.status).toBe("unexpressed");
      expect(cell.reason).toMatch(/more than one/);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Implement**

`packages/conformance/package.json`:

```json
{
  "name": "conformance",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "agt-bridge": "workspace:*",
    "agent-control-specification": "0.3.1-beta.0",
    "guardian": "workspace:*"
  }
}
```

`packages/conformance/src/cells.ts`:

```ts
/**
 * The 8 × 5's axes and its cell, and both come from somewhere the Guardian
 * could not also be wrong about (`slices/v7/README.md`, commitment 5).
 *
 * The rows are AGT's `InterventionPoint` and the columns its `Decision` --
 * the `Readonly` consts the pinned SDK exports, which is what makes
 * commitment 1's enum a fact rather than a list this repository keeps in step
 * by hand. Reading them off `mapping.yaml` instead would have measured the
 * declaration against itself, and hardcoding them here would have measured
 * this file.
 */
import { Decision, InterventionPoint } from "agent-control-specification";

export const AGT_POINTS: readonly string[] = Object.values(InterventionPoint).sort();
export const AGT_VERDICTS: readonly string[] = Object.values(Decision).sort();

/**
 * What a cell resolved to. NOT `green` / `red`: §V7 retracted "green" as a
 * success name, because a matrix that must be green is a matrix under
 * pressure to redefine its claim.
 *
 *   expressed      ACS v0.1.0 expresses AGT here.
 *   guardian_only  the Guardian can do it from process-local knowledge and a
 *                  wire consumer cannot. Three independent findings have
 *                  landed on this one -- the `warn` column (§V3), D10's two
 *                  Trace attributes, and R1.4's identity -- which is itself
 *                  the finding V7 publishes.
 *   unexpressed    it cannot, and `reason` says why.
 *
 * There is no fourth member and no default. `status` is required, so a cell
 * cannot come to read as expressed by having gone unmeasured -- which is the
 * one way a resolved matrix could quietly become a green one.
 */
export type CellStatus = "expressed" | "guardian_only" | "unexpressed";

export type CoverageCell = {
  point: string;
  verdict: string;
  status: CellStatus;
  reason?: string;
  /** Which checks contributed to this cell. A cell no check touched is a
   * defect the runner reports, not a cell that passed. */
  measuredBy: string[];
};

/** Every (point, verdict) pair, in a stable order. The renderers and every
 * check iterate this, so no two of them can disagree about what the matrix's
 * shape is. */
export function everyCell(): { point: string; verdict: string }[] {
  return AGT_POINTS.flatMap((point) => AGT_VERDICTS.map((verdict) => ({ point, verdict })));
}
```

`packages/conformance/src/intervention-points.ts` — N41's point leg:

```ts
/**
 * N41. For each of AGT's eight intervention points: does `mapping.yaml` give
 * it an ACS method, and does the runtime resolve that method back to this
 * same point?
 *
 * Both halves matter, and the second is the one worth having. The table could
 * name a method for every point and still be a declaration nobody checked --
 * which is what it was until the PR #10 review found the Guardian hardcoding
 * `pre_tool_call` beside it. So this calls `resolveInterventionPoint`, the
 * runtime's own resolver, rather than reading the table a second way here.
 *
 * A point with no ACS method is `unexpressed` for all five of its verdicts,
 * carrying the reason mapping.yaml's own row states. A resolver THROW is also
 * a resolved cell, not an escaping error: an ambiguous table is a real answer
 * about that point, and letting the throw out would take the whole matrix
 * with it.
 */
import { resolveInterventionPoint, type Mapping } from "guardian";
import { AGT_VERDICTS, everyCell, type CoverageCell } from "./cells.ts";

export function checkInterventionPoints(mapping: Mapping): CoverageCell[] {
  return everyCell().map(({ point, verdict }) => ({
    point,
    verdict,
    ...resolvePoint(point, mapping),
    measuredBy: ["N41"],
  }));
}

function resolvePoint(point: string, mapping: Mapping): { status: CoverageCell["status"]; reason?: string } {
  const row = mapping.intervention_points[point];
  if (row === undefined) {
    return {
      status: "unexpressed",
      reason: `mapping.yaml's intervention_points table has no row for AGT point "${point}"`,
    };
  }
  if (row.acs_method === null) {
    return { status: "unexpressed", reason: row.note ?? "mapping.yaml declares no ACS method for this point" };
  }
  try {
    const resolved = resolveInterventionPoint(row.acs_method, mapping);
    if (resolved !== point) {
      return {
        status: "unexpressed",
        reason: `mapping.yaml maps "${point}" to ${row.acs_method}, which resolves back to "${resolved}"`,
      };
    }
    return { status: "expressed" };
  } catch (error) {
    return { status: "unexpressed", reason: error instanceof Error ? error.message : String(error) };
  }
}
```

`packages/conformance/src/index.ts` re-exports `cells.ts` and `intervention-points.ts`.

Add `resolveInterventionPoint` to `packages/guardian/src/index.ts`'s existing `map-verdict.ts` export line.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/conformance/ && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance packages/guardian/src/index.ts
git commit -m "Measure the eight points against the runtime that resolves them

Slice: #8 · N41"
```

---

## Task 4: N42 — the verdict round trip · slice #8 · N42, S10

**Files:**
- Create: `packages/conformance/src/verdicts.ts`
- Modify: `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/verdicts.test.ts`

**Interfaces:**
- Produces: `export function checkVerdicts(mapping: Mapping): CoverageCell[]`; `export function invertVerdicts(mapping: Mapping): Map<string, string>` keyed by `"<acs_decision>|<policy_references_non_empty>"`.
- Consumes: `CoverageCell`, `everyCell`, `AGT_VERDICTS` from Task 3; `mapVerdict`, `type Mapping` from `guardian`.

**Why the inverse is derived, never written.** R1.2 is *"All 5 verdicts map to ACS dispositions without loss — `warn` = `allow` with non-empty `policy_references`"*. The forward direction is `mapVerdict`, the runtime's own. The reverse has to come from the same declaration or the round trip proves nothing: an inverse written by hand here would agree with `mapping.yaml` because the same person wrote both, and would keep agreeing after `mapping.yaml` changed.

The mapping is not injective — `allow` and `warn` both become ACS `allow` — and `require_policy_references` is the declared discriminator. So the inverse index is keyed by *decision plus whether `policy_references` is non-empty*, and two AGT verdicts colliding on one key with neither discriminated is a mapping defect that **throws**, on the same principle `resolveInterventionPoint` throws on an ambiguous table: picking one would make the answer depend on YAML key order.

**Why `warn` is `guardian_only` and not `expressed`.** §V7 and risk row 11: AGT's only stock `warn` gate reads `input.annotations.drift_score`, annotations come from a manifest-declared annotator and never from the snapshot, and the ACS v0.1.0 tool-call-request payload carries no field a score could be derived from. The mapping round-trips cleanly — that part is `expressed` — but a *wire consumer* cannot drive the gate. Both facts go in the cell: status `guardian_only`, with the reason naming the annotation.

- [ ] **Step 1: Write the failing test**

Create `packages/conformance/test/verdicts.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { checkVerdicts, invertVerdicts } from "../src/verdicts.ts";

const mapping = loadMapping("mapping.yaml");

describe("the inverse is derived from mapping.yaml, not written beside it", () => {
  it("discriminates warn from allow by the field R1.2 says distinguishes them", () => {
    const inverse = invertVerdicts(mapping);

    expect(inverse.get("allow|false")).toBe("allow");
    expect(inverse.get("allow|true")).toBe("warn");
  });

  it("throws when two AGT verdicts collide on one ACS decision with no discriminator", () => {
    const collided = {
      ...mapping,
      verdicts: { ...mapping.verdicts, escalate: { decision: "deny" as const } },
    };

    expect(() => invertVerdicts(collided)).toThrow(/deny/);
  });
});

describe("N42 -- the verdict round trip", () => {
  const cells = checkVerdicts(mapping);
  const at = (point: string, verdict: string) => cells.find((c) => c.point === point && c.verdict === verdict)!;

  it("round-trips allow, deny, escalate and transform at the request gate", () => {
    for (const verdict of ["allow", "deny", "escalate", "transform"]) {
      expect(at("pre_tool_call", verdict).status).toBe("expressed");
    }
  });

  it("resolves warn as guardian-only, naming the annotation a wire consumer cannot supply", () => {
    const cell = at("pre_tool_call", "warn");

    expect(cell.status).toBe("guardian_only");
    expect(cell.reason).toMatch(/drift_score/);
  });

  it("marks transform unexpressed at a point whose row declares no modifications rule", () => {
    // agent_startup has an acs_method and no modifications rule, so mapVerdict
    // throws rather than answering with a MODIFY the host has nothing to apply.
    expect(at("agent_startup", "transform").status).toBe("unexpressed");
    expect(at("agent_startup", "transform").reason).toMatch(/declares no modifications rule/);
    // ...and its other four verdicts are unaffected, which is what makes this
    // a per-cell fact rather than a per-point one.
    expect(at("agent_startup", "deny").status).toBe("expressed");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/verdicts.test.ts`
Expected: FAIL — cannot resolve `../src/verdicts.ts`.

- [ ] **Step 3: Implement**

Create `packages/conformance/src/verdicts.ts`:

```ts
/**
 * N42. AGT verdict -> ACS decision -> AGT verdict, at every intervention
 * point, asserting the verdict that comes back is the one that went in.
 *
 * The forward leg is `mapVerdict`, the runtime's own -- so this measures what
 * the Guardian does rather than what mapping.yaml says it should. The reverse
 * leg is DERIVED from the same declaration by `invertVerdicts` below, and
 * that is the part worth stating: an inverse written by hand here would agree
 * with mapping.yaml because the same hand wrote both, and would go on
 * agreeing after mapping.yaml changed. A round trip through two independent
 * spellings of one table is not a round trip.
 *
 * The mapping is not injective. `allow` and `warn` both become ACS `allow`,
 * and R1.2 names the discriminator: `warn` is allow with a NON-EMPTY
 * `policy_references`. So the inverse is keyed on the decision AND that
 * emptiness, which is exactly what `require_policy_references` declares.
 *
 * `defer` has no AGT verdict behind it at all (§V3) and therefore never
 * appears here: this walks AGT's five, not ACS's.
 */
import { mapVerdict, type AcsDecision, type Mapping } from "guardian";
import type { AgtVerdict } from "agt-bridge";
import { everyCell, type CoverageCell } from "./cells.ts";

/** The `warn` column's own reason, measured in §V3 and recorded at risk row 11. */
const WARN_GUARDIAN_ONLY =
  "AGT's only stock warn gate reads input.annotations.drift_score, which reaches the policy input from a " +
  "manifest-declared annotator and never from the snapshot; ACS v0.1.0's tool-call-request payload carries " +
  "no field a drift score could be derived from, so the Guardian must originate it";

export function invertVerdicts(mapping: Mapping): Map<string, string> {
  const inverse = new Map<string, string>();
  for (const [agtVerdict, rule] of Object.entries(mapping.verdicts)) {
    const key = `${rule.decision}|${rule.require_policy_references === true}`;
    const existing = inverse.get(key);
    if (existing !== undefined) {
      // Two AGT verdicts on one ACS decision with no discriminator between
      // them: picking either would make the answer depend on YAML key order,
      // which is the same reason resolveInterventionPoint throws on an
      // ambiguous table rather than taking the first row.
      throw new Error(
        `mapping.yaml's verdicts table maps both "${existing}" and "${agtVerdict}" to ACS ` +
          `"${rule.decision}" with the same policy_references requirement, so the mapping is not invertible`,
      );
    }
    inverse.set(key, agtVerdict);
  }
  return inverse;
}

export function checkVerdicts(mapping: Mapping): CoverageCell[] {
  const inverse = invertVerdicts(mapping);
  return everyCell().map(({ point, verdict }) => ({
    point,
    verdict,
    ...roundTrip(verdict, point, mapping, inverse),
    measuredBy: ["N42"],
  }));
}

function roundTrip(
  verdict: string,
  point: string,
  mapping: Mapping,
  inverse: Map<string, string>,
): { status: CoverageCell["status"]; reason?: string } {
  // A verdict AGT would actually emit for this decision: `reason` and
  // `message` are what field_synthesis reads, and `transform` is what the
  // modifications rule reads. Nothing is invented that AGT does not send.
  const agt: AgtVerdict = {
    decision: verdict as AgtVerdict["decision"],
    reason: "conformance_probe",
    message: "conformance probe",
    ...(verdict === "transform"
      ? { transform: { path: "$policy_target", value: "probe" } }
      : {}),
  };

  let acs: AcsDecision;
  try {
    acs = mapVerdict(agt, mapping, point);
  } catch (error) {
    return { status: "unexpressed", reason: error instanceof Error ? error.message : String(error) };
  }

  const hasReferences = (acs.policy_references?.length ?? 0) > 0;
  const back = inverse.get(`${acs.decision}|${hasReferences}`);
  if (back !== verdict) {
    return {
      status: "unexpressed",
      reason: `AGT "${verdict}" becomes ACS "${acs.decision}", which reads back as "${back ?? "nothing"}"`,
    };
  }

  if (verdict === "warn") {
    return { status: "guardian_only", reason: WARN_GUARDIAN_ONLY };
  }
  return { status: "expressed" };
}
```

Re-export from `packages/conformance/src/index.ts`.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/conformance/ && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance
git commit -m "Round-trip five verdicts through the runtime and back out of the table

Slice: #8 · N42"
```

---

## Task 5: N43 — the `enforced_identity` recomputation · slice #8 · N43

**Files:**
- Create: `packages/conformance/src/identity.ts`
- Modify: `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/identity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IdentityFinding = { recomputed: boolean; inputIdentity: string; enforcedIdentity: string; boundTo: "policy_target" | "snapshot" | "neither" };
  export function canonicalIdentity(policyInput: unknown): string;
  export async function checkEnforcedIdentity(bridge: PolicyBridge, point: string, snapshot: InterventionSnapshot): Promise<IdentityFinding>;
  export function identityCells(finding: IdentityFinding): CoverageCell[];
  ```
- Consumes: Task 1's `evaluateWithEvidence` and `AgtEvidence`; `CoverageCell` from Task 3.

**What was measured during planning, and what the check must reproduce independently.** AGT's identity is the SHA-256 of the **key-sorted, whitespace-free JSON** of `policyInput`, prefixed `sha256:`. `enforcedIdentity` is the same hash after replacing **`policy_target.value` alone** with `verdict.transform.value` — the snapshot's copy of that same leaf is *not* updated. Both reproduce exactly.

That second fact is the finding, and it is what makes R1.4's cells `guardian_only`: AGT's enforced identity binds to the policy target it rewrote, not to the document the host will execute. Making those agree is the adapter's job, and nothing on the ACS wire carries the identity to check it — `identity` occurs twice in the whole v0.1.0 spec directory, as `session-start.json`'s `user_identity` and as prose in `skill-register.json`, and neither is this.

**Commitment 6 binds this task.** N43 is a recomputation check. Nothing here is named for a field ACS v0.1.0 does not have, and no `enforced_identity` member appears on anything envelope-shaped.

- [ ] **Step 1: Write the failing test**

Create `packages/conformance/test/identity.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createBridge } from "agt-bridge";
import { canonicalIdentity, checkEnforcedIdentity, identityCells } from "../src/identity.ts";

const bridge = createBridge("policy/manifest.yaml");

const REDACTABLE = {
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "Bash" },
  tool_result: { outputs: [{ value: "TOKEN=ghp_ONLYINOUTPUT999\n" }] },
  input: { ifc: { source_labels: ["public"] } },
};

describe("N43 -- recomputing AGT's identity rather than believing it", () => {
  it("reproduces the identity of a policy input AGT hashed", async () => {
    const finding = await checkEnforcedIdentity(bridge, "post_tool_call", REDACTABLE);

    expect(finding.recomputed).toBe(true);
  });

  it("finds the enforced identity bound to the policy target, not to the snapshot the host executes", async () => {
    const finding = await checkEnforcedIdentity(bridge, "post_tool_call", REDACTABLE);

    expect(finding.inputIdentity).not.toBe(finding.enforcedIdentity);
    expect(finding.boundTo).toBe("policy_target");
  });

  it("hashes key-sorted, whitespace-free JSON -- so key order in the input cannot change the identity", () => {
    expect(canonicalIdentity({ b: 1, a: 2 })).toBe(canonicalIdentity({ a: 2, b: 1 }));
    expect(canonicalIdentity({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("resolves the transform column guardian-only, naming the absent wire field", async () => {
    const cells = identityCells(await checkEnforcedIdentity(bridge, "post_tool_call", REDACTABLE));

    expect(cells).not.toHaveLength(0);
    for (const cell of cells) {
      expect(cell.verdict).toBe("transform");
      expect(cell.status).toBe("guardian_only");
      expect(cell.reason).toMatch(/no action-identity field/);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/identity.test.ts`
Expected: FAIL — cannot resolve `../src/identity.ts`.

- [ ] **Step 3: Implement**

Create `packages/conformance/src/identity.ts`:

```ts
/**
 * N43. Recomputes AGT's action identity instead of taking its word for it,
 * and reports what that identity actually binds to.
 *
 * MEASURED, not read from AGT's docs: the identity is the SHA-256 of the
 * key-sorted, whitespace-free JSON of the policy input, prefixed "sha256:".
 * `enforced_identity` is the same hash after replacing `policy_target.value`
 * ALONE with `verdict.transform.value` -- the snapshot's own copy of that leaf
 * is not updated. Both reproduce exactly against the pinned SDK.
 *
 * The second half is the finding, and it is why R1.4's cells resolve
 * guardian-only rather than expressed. AGT's enforced identity binds to the
 * policy target it rewrote, not to the document the host will execute; making
 * those agree is the adapter's job, and ACS v0.1.0 carries no field to check
 * it with. `identity` occurs twice in the whole v0.1.0 spec directory --
 * `session-start.json`'s `user_identity` and prose inside
 * `skill-register.json` -- and neither is this.
 *
 * A RECOMPUTATION, which is why this takes the policy input and the transform
 * and nothing else. AGT also returns `transformedPolicyTarget`, its own
 * already-transformed value; `AgtEvidence` deliberately does not carry it,
 * because a check handed AGT's answer has a way to agree with AGT without
 * computing anything.
 */
import { createHash } from "node:crypto";
import type { InterventionSnapshot, PolicyBridge } from "agt-bridge";
import type { CoverageCell } from "./cells.ts";

const NO_WIRE_IDENTITY =
  "ACS v0.1.0 carries no action-identity field on any of its 43 schemas, so a wire consumer cannot bind an " +
  "approval to the action that executed; AGT's enforced identity binds to the policy target it rewrote, not " +
  "to the document the host applies modifications to";

export type IdentityFinding = {
  recomputed: boolean;
  inputIdentity: string;
  enforcedIdentity: string;
  boundTo: "policy_target" | "snapshot" | "neither";
};

/** Canonical JSON, then SHA-256. Key-sorted at every depth and free of
 * whitespace -- measured against the pinned SDK, not assumed. */
export function canonicalIdentity(policyInput: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(policyInput))).digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export async function checkEnforcedIdentity(
  bridge: PolicyBridge,
  point: string,
  snapshot: InterventionSnapshot,
): Promise<IdentityFinding> {
  const evidence = await bridge.evaluateWithEvidence(point, snapshot);
  const recomputed = canonicalIdentity(evidence.policyInput) === evidence.inputIdentity;

  return {
    recomputed,
    inputIdentity: evidence.inputIdentity,
    enforcedIdentity: evidence.enforcedIdentity,
    boundTo: resolveBinding(evidence),
  };
}

/** Which document AGT's enforced identity actually covers, decided by
 * recomputing each candidate rather than by reading AGT's description of it. */
function resolveBinding(evidence: {
  policyInput: unknown;
  enforcedIdentity: string;
  verdict: { transform?: { value: unknown } };
}): IdentityFinding["boundTo"] {
  const transformed = evidence.verdict.transform?.value;
  if (transformed === undefined) {
    // No rewrite: enforced and input identity are the same document by
    // definition, so there is nothing to distinguish and nothing to claim.
    return "neither";
  }
  const targetOnly = structuredClone(evidence.policyInput) as {
    policy_target: { value: unknown };
  };
  targetOnly.policy_target.value = transformed;
  return canonicalIdentity(targetOnly) === evidence.enforcedIdentity ? "policy_target" : "snapshot";
}

/** The cells this finding resolves: the `transform` column, which is the only
 * one where the two identities can differ at all. */
export function identityCells(finding: IdentityFinding): CoverageCell[] {
  if (!finding.recomputed) {
    return [
      {
        point: "post_tool_call",
        verdict: "transform",
        status: "unexpressed",
        reason: "AGT's input identity could not be reproduced from the policy input it reported",
        measuredBy: ["N43"],
      },
    ];
  }
  return [
    {
      point: "post_tool_call",
      verdict: "transform",
      status: "guardian_only",
      reason: NO_WIRE_IDENTITY,
      measuredBy: ["N43"],
    },
  ];
}
```

Re-export from `packages/conformance/src/index.ts`.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/conformance/ && bun run typecheck && bun run verify:pin`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance
git commit -m "Recompute the identity AGT reports, and say what it binds to

Slice: #8 · N43"
```

---

## Task 6: N44 failure domains, and N48 the mapping table · slice #8 · N44, N48, U32, S10

Two deliverables in one task because the second is small and neither can be rejected without the other being re-reviewed: N48 renders S10, and N44 is the last check feeding N47.

**Files:**
- Create: `packages/conformance/src/failure-domains.ts`, `packages/conformance/src/render.ts`
- Modify: `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/failure-domains.test.ts`, `packages/conformance/test/render-mapping-table.test.ts`

**Interfaces:**
- Produces: `export async function checkFailureDomains(guardianUrl: string): Promise<CoverageCell[]>`; `export function renderMappingTable(mapping: Mapping): string`
- Consumes: `CoverageCell` from Task 3; `startGuardian`, `loadMapping` from `guardian`.

**What N44 measures, and why it drives a live Guardian.** Two failure domains that this project has spent three slices keeping apart, and the matrix's job is to show they are still apart:

1. **AGT's evaluation layer fails closed (R1.5, §6.4).** An evaluation error arrives as an honoured ACS `deny`, not as a bare JSON-RPC error. `denyOnInvalidEnvelope` (N27) is what does it.
2. **Wire delivery failure applies the negotiated posture (R1.7).** A `proceed` deployment proceeds and audits; a `deny` deployment blocks. Never conflated with (1).

A check that constructed those in-process would be measuring its own construction. This drives a real Guardian over HTTP, exactly as `test/dispositions.test.ts` and `hosts/claude-code/test/posture.test.ts` already do.

- [ ] **Step 1: Write the failing tests**

Create `packages/conformance/test/failure-domains.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startGuardian, type StartedGuardian } from "guardian";
import { checkFailureDomains } from "../src/failure-domains.ts";

let guardian: StartedGuardian;
beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
});
afterAll(async () => {
  await guardian.close();
});

describe("N44 -- the two failure domains stay apart", () => {
  it("resolves the deny column expressed: an evaluation failure arrives as an honoured ACS deny", async () => {
    const cells = await checkFailureDomains(guardian.url);
    const deny = cells.filter((c) => c.verdict === "deny");

    expect(deny).not.toHaveLength(0);
    for (const cell of deny) {
      expect(cell.status).toBe("expressed");
      expect(cell.measuredBy).toContain("N44");
    }
  });

  it("gets a decision rather than a JSON-RPC error when the envelope cannot be validated", async () => {
    const response = await fetch(guardian.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-n44",
        method: "steps/toolCallRequest",
        params: { acs_version: "0.1.0", request_id: "req-n44", metadata: { session_id: "sess-n44" }, payload: {} },
      }),
    });
    const body = (await response.json()) as { result?: { decision?: string }; error?: unknown };

    expect(body.error).toBeUndefined();
    expect(body.result?.decision).toBe("deny");
  });
});
```

Create `packages/conformance/test/render-mapping-table.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { renderMappingTable } from "../src/render.ts";

describe("N48 -- renderMappingTable renders S10 and nothing else", () => {
  const table = renderMappingTable(loadMapping("mapping.yaml"));

  it("names every AGT intervention point mapping.yaml declares, with its ACS method", () => {
    expect(table).toContain("pre_tool_call");
    expect(table).toContain("steps/toolCallRequest");
    expect(table).toContain("post_model_call");
  });

  it("says what an unmapped point is, rather than leaving its ACS column blank", () => {
    expect(table).toMatch(/post_model_call.*no ACS v0\.1\.0 target/s);
  });

  it("renders AGT's five verdicts against ACS's five dispositions without calling either list 'the five'", () => {
    expect(table).toContain("warn");
    expect(table).toContain("escalate");
    // R1.2's discriminator is part of the mapping and must be visible in it.
    expect(table).toMatch(/warn.*policy_references/s);
  });

  it("is a pure function of the mapping it is handed", () => {
    const mapping = loadMapping("mapping.yaml");
    expect(renderMappingTable(mapping)).toBe(renderMappingTable(mapping));
  });
});
```

- [ ] **Step 2: Run them, expect FAIL**

Run: `bun test packages/conformance/`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement**

`packages/conformance/src/failure-domains.ts` drives the live Guardian: post a `steps/toolCallRequest` whose payload fails `hooks/tool-call-request.json`, assert the answer is a `deny` **decision** rather than a JSON-RPC error, and resolve the `deny` column `expressed` with that as the reason. Post a second envelope naming a method `mapping.yaml` does not map, and record that it comes back `method_not_dispatched` — the boundary that keeps domain (1) from swallowing an undispatched method.

Its module comment must state which domain each assertion belongs to and that R1.7's delivery-failure half is the host's, measured by `hosts/claude-code/test/posture.test.ts`, and referenced here rather than re-driven — the Guardian is not the component that applies a posture.

`packages/conformance/src/render.ts` starts with `renderMappingTable` only; Tasks 7 and 8 add the other two renderers to the same file. Its module header states the rule the file lives under:

```ts
/**
 * Three renderers, one per measurement, and none of them takes a
 * discriminator saying which kind of table it is being asked for
 * (`slices/v7/README.md`, commitment 3).
 *
 *   renderMappingTable   (N48 -> U32)  S10's declaration
 *   renderCoverageMatrix (N47 -> U30)  the 8 × 5 N41-N44 measure
 *   renderTraceRows      (N52 -> U33)  N49's attribute-against-wire-source rows
 *
 * A coverage cell is an intervention point against an AGT verdict; a trace
 * row is a required OTel attribute against its wire source; they share a verb
 * and nothing else. Detail C once wired a single `renderMatrix()` to all
 * three, which is the name that would have let the second and third arrive as
 * columns of the first -- and a coverage claim rendered by the same function
 * as everything beside it is a coverage claim whose subject is whatever was
 * rendered. `renderUpstreamDiff` is not here and is not V7's: its only input
 * is V8's `diffSurfaces()`.
 *
 * EVERY FUNCTION HERE IS PURE. Each is handed its measurement and renders
 * that one; none reads a file, a clock or a store. V6's own review found a
 * renderer that had quietly become a write, under a header claiming exactly
 * this -- so the property is asserted, not only stated: each renderer's test
 * renders the same input twice and expects the same string.
 */
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance
git commit -m "Keep the two failure domains apart in the matrix, and render the table S10 declares

Slice: #8 · N44, N48"
```

---

## Task 7: N47 — `renderCoverageMatrix()` · slice #8 · N47, U30

**Files:**
- Modify: `packages/conformance/src/render.ts`, `packages/conformance/src/index.ts`
- Create: `packages/conformance/src/merge-cells.ts`
- Test: `packages/conformance/test/render-coverage-matrix.test.ts`, `packages/conformance/test/merge-cells.test.ts`
- Modify: `test/invariants.test.ts` — a gate asserting no source file names `renderMatrix`

**Interfaces:**
- Produces: `export function mergeCells(...contributions: CoverageCell[][]): CoverageCell[]`; `export function renderCoverageMatrix(cells: CoverageCell[], options?: RenderOptions): string`
- Consumes: `CoverageCell`, `everyCell` from Task 3; all four checks' outputs.

**The merge rule, stated before it is written.** Four checks each produce cells for the same 40 coordinates, and they must combine to one answer per cell. The rule is **the worst status wins, and every contributing check is named**: `unexpressed` beats `guardian_only` beats `expressed`. A cell no check touched is `unexpressed` with the reason *"no check measured this cell"* — never expressed by default, which is the one way a resolved matrix could become a green one. When two checks agree on a status, both reasons are carried, joined by `; `.

- [ ] **Step 1: Write the failing tests**

`packages/conformance/test/merge-cells.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mergeCells } from "../src/merge-cells.ts";
import { AGT_POINTS, AGT_VERDICTS } from "../src/cells.ts";

const cell = (point: string, verdict: string, status: "expressed" | "guardian_only" | "unexpressed", by: string, reason?: string) =>
  ({ point, verdict, status, measuredBy: [by], ...(reason ? { reason } : {}) }) as const;

describe("mergeCells -- the worst status wins and every check is named", () => {
  it("lets unexpressed beat guardian_only, and guardian_only beat expressed", () => {
    const merged = mergeCells(
      [cell("pre_tool_call", "warn", "expressed", "N41")],
      [cell("pre_tool_call", "warn", "guardian_only", "N42", "no wire source")],
    );
    const at = merged.find((c) => c.point === "pre_tool_call" && c.verdict === "warn")!;

    expect(at.status).toBe("guardian_only");
    expect(at.measuredBy).toEqual(["N41", "N42"]);
    expect(at.reason).toBe("no wire source");
  });

  it("carries both reasons when two checks land on the same status", () => {
    const merged = mergeCells(
      [cell("input", "transform", "unexpressed", "N41", "first")],
      [cell("input", "transform", "unexpressed", "N42", "second")],
    );

    expect(merged.find((c) => c.point === "input" && c.verdict === "transform")!.reason).toBe("first; second");
  });

  it("reports a cell no check measured as unexpressed, never as expressed by default", () => {
    const merged = mergeCells([]);

    expect(merged).toHaveLength(AGT_POINTS.length * AGT_VERDICTS.length);
    for (const c of merged) {
      expect(c.status).toBe("unexpressed");
      expect(c.reason).toBe("no check measured this cell");
      expect(c.measuredBy).toEqual([]);
    }
  });
});
```

`packages/conformance/test/render-coverage-matrix.test.ts` asserts: every one of the 8 rows and 5 columns appears; the legend names all three statuses; no cell renders blank; a `guardian_only` cell renders its reason rather than a symbol alone; the header says "AGT verdicts"; and — the purity assertion the module header promises — rendering the same cells twice produces the same string.

Add to `test/invariants.test.ts`:

```ts
  it("nothing in this repository is named renderMatrix -- the split that happened before anything inherited it", () => {
    const offenders = sourceFiles().filter((path) => stripComments(readFileSync(path, "utf8")).includes("renderMatrix"));

    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Run, expect FAIL**
Run: `bun test packages/conformance/ test/invariants.test.ts` — FAIL, modules absent.

- [ ] **Step 3: Implement** `mergeCells` per the rule above, and `renderCoverageMatrix` in `render.ts`. Render an 8-row × 5-column grid with a symbol per status and a numbered footnote per distinct reason beneath it, so no cell is blank and no reason is truncated into a cell. Colour is opt-in via `RenderOptions`, matching `packages/inspector/src/render.ts`'s existing convention.

- [ ] **Step 4: Run, expect PASS** — `bun test && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance test/invariants.test.ts
git commit -m "Merge four checks into one answer per cell, worst status winning

Slice: #8 · N47"
```

---

## Task 8: N49 and N52 — the Trace pillar, measured · slice #8 · N49, N52, U33

**Files:**
- Create: `packages/conformance/src/trace-pillar.ts`
- Modify: `packages/conformance/src/render.ts`, `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/trace-pillar.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TraceRow = { attribute: string; span: string; wireSource: string | null; emittableByWireConsumer: boolean; reason?: string };
  export function checkTracePillar(): TraceRow[];
  export function renderTraceRows(rows: TraceRow[], options?: RenderOptions): string;
  ```
- Consumes: nothing from earlier tasks. Reads `spec/acs/specification/v0.1.0/trace/otel-mapping.json` and the v0.1.0 hook schemas as files.

**Scope, from §V7 and commitment 4.** V7 *measures* the pillar and does not build an exporter; nothing here is named `exportTrace`, `traceExporter` or `emitSpan`. The verbs are *check* and *render*.

**Which attributes are in scope.** `otel-mapping.json` declares 18 step spans. R5.3 is about what *this implementation* claims, and it can only claim or decline the pillar for the methods it evaluates — the six `mapping.yaml` gives an `acs_method`. So N49 covers those six spans' `required_attributes`, plus `decision_event.required_attributes` (`acs.decision`, `acs.evaluator`) and `provenance_attributes.required` (`acs.provenance.origin`), which apply to every step. The mapping states its data inside JSON Schema `default` keys; N49 reads those, and its comment says so, because a reader who expects the mapping to *be* the data will look in the wrong place.

**The five rows already measured in §V7 must come out of this check, not be asserted beside it** — `gen_ai.tool.name` green, `acs.capability` red because `hooks/tool-call-request.json` requires only `tool` and `arguments`, `acs.decision` green, `acs.evaluator` red, and the three conditional attributes red.

> ⚠️ **Corrected during execution — this paragraph said `acs.evaluator` was "red with no wire source" and the conditional attributes red "because no such fields exist on `AcsResult`". Both were wrong**, inherited from the shaping round. `$defs.AcsResult.properties.metadata.properties` declares `evaluator`, `evaluator_version`, `evaluation_duration_ms`, `model_id` and `confidence`, expressly so *"Trace consumers [can] key on a stable shape"*. They stay red because neither `metadata` nor its members are required — the same reason `acs.capability` is red, not a different one. N49 resolves each row against the schema at runtime, which is what caught this; a check that transcribed the answers above would have published the error instead.

- [ ] **Step 1: Write the failing test** — assert those five rows come back with exactly those verdicts and reasons; that `emittableByWireConsumer` is false wherever `wireSource` is null; that an optional-but-present wire field (`acs.capability`) is false *with a reason naming the optionality* rather than true; and that `renderTraceRows` is pure.

- [ ] **Step 2: Run, expect FAIL** — `bun test packages/conformance/test/trace-pillar.test.ts`

- [ ] **Step 3: Implement.** `checkTracePillar` resolves each required attribute against the v0.1.0 schema that would carry it, and marks a row emittable **only when the field is present *and* required** — an optional field means a conformant envelope may omit it, so a consumer cannot be relied on to emit the attribute. `renderTraceRows` renders attribute · span · wire source · emittable, with the reason inline; it is not a column of the 8 × 5 and shares no rendering code with `renderCoverageMatrix`.

- [ ] **Step 4: Run, expect PASS** — `bun test && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance
git commit -m "Measure the Trace pillar as a non-claim, attribute by attribute

Slice: #8 · N49, N52"
```

---

## Task 9: N40 — the runner · slice #8 · N40, U30, U32, U33

**Files:**
- Create: `packages/conformance/src/main.ts`, `scripts/run-conformance.sh`
- Modify: `package.json` — add `"conformance": "bash scripts/run-conformance.sh"`
- Test: `packages/conformance/test/main.test.ts`

**Interfaces:**
- Consumes: every check and renderer from Tasks 3–8.
- Produces: the runner. No exported API beyond `main()`.

**Why a runner and not a test.** The affordance table calls N40 a *runner*: it publishes the artifacts C5 names. Its N41 schema leg needs upstream `policy-input.schema.json` at `agt.lock`'s ref (`policy-engine/spec/schema/wire/policy-input.schema.json` — confirmed present at the pinned commit), which means a network fetch. `scripts/verify-pin.sh` already establishes exactly this pattern: shallow-clone at the ref into a temp dir, hand the path to the code by environment variable, clean up with `trash`. `run-conformance.sh` mirrors it, including the `trash` precondition check — `rm -rf` is not permitted in this repo.

Everything that does *not* need the network stays in `bun test`, so the checks are covered whether or not a network is available. The runner reports **which legs ran**: a matrix published without the schema leg says so on its own face rather than presenting the same cells as if it had.

- [ ] **Step 1: Write the failing test** — `main.test.ts` runs the runner in-process with the schema leg disabled and asserts: all three artifacts appear in the output; the coverage matrix has 40 cells; the output names the legs that ran and the leg that did not; and the exit status is 0 for a fully *resolved* matrix (a red cell is a resolved cell, not a failure — §V7's whole point) but non-zero if any cell is `unexpressed` with the reason `"no check measured this cell"`.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** `main.ts` (start a Guardian on port 0 for N44, run the five checks, merge, render three tables, close the Guardian) and `scripts/run-conformance.sh` modelled on `scripts/verify-pin.sh`.

- [ ] **Step 4: Run, expect PASS** — `bun test && bun run typecheck && bun run conformance && bun run verify:pin`

- [ ] **Step 5: Commit**

```bash
git add packages/conformance scripts/run-conformance.sh package.json
git commit -m "Publish the two artifacts C5 names, and say which legs measured them

Slice: #8 · N40"
```

---

## Task 10: The declaration, and the evidence beside it · slice #8 · R5.3

**Files:**
- Modify: `slices/v7/README.md` — the implementation section and the R5.3 declaration
- Create: `docs/demos/v7-runbook.md`
- Modify: `README.md` — V7 moves from "Planned, not yet built" to a "Delivered in V7" table

**What the declaration must and must not say.** R5.3 lands here *as a declaration with its evidence beside it, and the two are not one artifact* (§V7, and commitment 2). So `slices/v7/README.md` states which ACS profiles and pillars this implementation claims and which it does not, and each line points at the measurement that tests it. The matrix is not the declaration and no sentence says it is.

The Trace pillar is declared **not claimed**, with the measured reason: a downstream consumer of the ACS wire cannot emit a conformant trace, because two required attributes have no wire source and one maps to an optional field. Only the Guardian can, from process-local knowledge the contract does not carry.

The three `guardian_only` findings are stated as one finding, because that is what they are: **v0.1.0's response envelope carries a decision but not the evidence for it** — no evaluator, no confidence, no identity of the action the decision bound to. The (a)/(b) v0.2 fork from "Decisions taken" goes here, with the measurement behind it.

**The runbook is captured, never composed.** Every block is the real output of the command printed above it, re-run rather than edited. This repo has retracted three claims for being written rather than measured; a runbook is the last place to add a fourth.

- [ ] **Step 1: Run the runner and capture**

```bash
bun run conformance > /tmp/v7-capture.txt 2>&1
```

- [ ] **Step 2: Write `docs/demos/v7-runbook.md`** with the captured blocks pasted verbatim, each under the exact command that produced it.

- [ ] **Step 3: Write the declaration** in `slices/v7/README.md`, replacing the `Implementation goes here.` line. Keep all six frozen commitments above it and add a short note under each saying where it landed — a commitment with no landing site is a commitment nothing kept.

- [ ] **Step 4: Move V7 in `README.md`** from the "Planned, not yet built" table to a "Delivered in V7" claims table, in the established shape (claim · how it is demonstrated, with links to the tests and the runbook). Remove exactly the two V7 rows from the planned table, leaving V8's.

- [ ] **Step 5: Verify and commit**

Run: `bun test && bun run typecheck && bun run verify:pin && bun run verify:zero-diff`

```bash
git add slices/v7/README.md docs/demos/v7-runbook.md README.md
git commit -m "Declare what this implementation claims, with the measurement beside each line

Slice: #8 · R5.3"
```

---

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 2 — outbound response validation | **V1** (the gap it closes is V1's, found during V7 shaping) | §V7 states the reason and the deadline: *"The conformance harness would therefore measure a wire format that was never itself contract-checked — which quietly weakens exactly the claim C2 exists to prove. Add response validation before the matrix is published."* V7 is the slice that publishes, so V7 is the slice that pays. |
| Task 1 — `evaluateWithEvidence` on `PolicyBridge` | **V1's package** (`agt-bridge`), amended by V7 | N43 has no input without it, and §V7 records the choice as V7's to make. The change is additive: `evaluate`'s contract is unchanged and `server.ts` is untouched. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| `AgtEvidence` / `evaluateWithEvidence` on the bridge role | N43 recomputes an identity and cannot do it from a verdict | §V7's N43 note gains the resolution (decision D-a), replacing "V7 has to choose" |
| `validateResponse`, and its third `"unexpressible"` answer | §V7 directs it; the third answer is forced by a measured v0.1.0 gap, not chosen | §V7's V1-gap note records that the handshake case is `unexpressible` and why |
| Package named `conformance`, not `acs-agt-conformance` | Every package in this repo is a bare noun (`guardian`, `inspector`, `agt-bridge`, `host-adapter`); a fifth spelled as a full title would be the only one | §V7's N40 row and Detail C's N40 row read `conformance` runner (`bun run conformance`) |
| `CellStatus`'s third member, `guardian_only` | Three independent findings resolve this way; a two-valued status would force each into a lie | §V7 gains a sentence naming the third status and the three findings that share it |
| A `test/invariants.test.ts` gate on the name `renderMatrix` | Commitment 3 says nothing in this repository is named it; a commitment with no gate is a comment | §V7's `renderMatrix()`-split note records that the ban is now gated |
| R1.4 restated as qualified | v0.1.0 carries no action-identity field, so "survives the adapter" is not true of the wire and cannot be made true by this slice | **Shaping doc R1.4** gains a ⚠️ and reads *"Must-have, qualified"*, on the precedent R1.3 already set |

## Slices-doc amendments — made in the same PR as this plan

1. **§V7 line 475** — add `Plan: docs/superpowers/plans/2026-08-16-v7-conformance-matrix.md`, matching every other slice section.
2. **§V7's N43 note** — replace *"V7 has to choose before it is written"* with the resolution: a second message on the bridge role, `evaluate` implemented in terms of it, and the two rejected alternatives with their reasons.
3. **§V7's V1-gap note** — record that the handshake response is `unexpressible` against `response-envelope.json`, and that the validator reports rather than throws.
4. **§V7** — add the third cell status `guardian_only`, naming the three findings that share it, and the (a)/(b) v0.2 fork measured during planning.
5. **§V7's N40 row and Detail C's N40 row** — `conformance` runner (`bun run conformance`).
6. **Shaping doc R1.4** — ⚠️ qualified, on R1.3's precedent, with the measurement.
7. **Shaping doc Detail C** — Task 7's `renderMatrix` gate noted on the N47 row.
8. **Risk row 7** — retire the "Resolved by embedding the Node SDK" wording's implication that N43 is thereby unblocked: the Node SDK made N43 *possible*, and Task 1 is what made it *reachable*.
