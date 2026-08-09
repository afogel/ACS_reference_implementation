# V1 — One host, one hook, a real AGT decision

## Slice Contract

| Field | Value |
|---|---|
| Slice ID | [#2](https://github.com/afogel/ACS_reference_implementation/issues/2) (epic [#1](https://github.com/afogel/ACS_reference_implementation/issues/1), PR [#10](https://github.com/afogel/ACS_reference_implementation/pull/10)) |
| Slices doc | `docs/shaping/acs-reference-impl-slices.md` §V1, line 30 |
| Demo | "In Claude Code, ask for a destructive shell command. AGT's stock policy denies it; the deny reason appears in the transcript." |
| Components | U1, U2 (Claude Code surfaces) · N1 (hook shim) · N2 `buildEnvelope` · N3 `renderDecision` · N4 `guardianClient.post` · N5 `handshake` · N20 `POST /acs` · N21 `validateEnvelope` · N23 `assembleSnapshot` · N24 `mapVerdict` · N28 `handshakeResponder` · N30 `evaluateInterventionPoint` · N31 `AgentControl.fromPath` · S1 hookmap · S7 manifest · S8 config · S9 stock bundle · S10 `mapping.yaml` · S11 `agt.lock` · S13 negotiated session config |
| Parked items | Session state (S3/S4/S5) → **V6**. Envelope tap (N26/S6) and Inspector (P4) → **V2**. Failure posture application (N6/N7/S14) → **V3**. `denyOnInvalidEnvelope` (N27) → **V3**. Output redaction (U3) → **V4**. Second host (P2) → **V5**. Conformance harness (P5) → **V7**. |
| Watch-for | "Only `pre_tool_call` is wired. No session state, no tap, no second host. N23 assembles the snapshot from the envelope alone; it starts reading S3/S4/S5 in V6." (slices doc line 58) |
| Corrections | Ten, all discovered during planning and all verified empirically — see **Corrections discovered during planning** below. Each is amended into the slices doc in this PR. |
| Requirements | R0, R1.3, R2.1, R2.2, R2.3, R3.2, R3.3, R5.2, R6.1, R7.1, R7.2 |

**Global Constraints** (bind every task; copy verbatim into reviewer dispatches):

1. **Zero Rego authored.** Policy behaviour is configured only through `data.agt.defaults.config`. No `.rego` file is written or edited by us. (R2.1)
2. **Stock bundle byte-identical.** Every `.rego` under `policy/lib/` matches AGT at the pinned ref exactly. The only permitted addition to that directory is `data.json`. (R2.2, R2.3)
3. **The host adapter contains zero AGT-specific code.** No file under `packages/host-adapter/` may mention AGT, Rego, OPA, verdicts, or intervention points. Verifiable by grep. (R3.2)
4. **The AGT bridge contains zero host-specific code.** No file under `packages/agt-bridge/` may mention Claude Code, hooks, OpenCode, or stdin/stdout hook protocols. Verifiable by grep. (R3.3)
5. **ACS decisions are lowercase on the wire** — `allow`, `deny`, `modify`, `ask`, `defer`. Uppercase appears in spec prose only and must never be emitted.
6. **The bundle path in `policy/manifest.yaml` must not begin with `./`.** See Correction C2 — a `./` prefix silently disables the entire policy and every decision becomes `allow`.
7. **AGT is stateless.** Nothing under `packages/agt-bridge/` persists anything between calls. (R6.1)

---

## Corrections discovered during planning

Every one of these was verified by running code, not by reading docs. They are amended into the slices doc in this PR.

| # | Correction | Evidence | Amends |
|---|---|---|---|
| C1 | **The bridge embeds the Node SDK, not the Python SDK.** The PyO3 binding sets only `action_identity`; the Node binding sets `input_identity` and `enforced_identity` distinctly. Python would make R1.4 unverifiable and V7's N43 impossible. | `sdk/python/src/lib.rs:152-154` vs `sdk/node/native/lib.rs:191-204`; confirmed on the installed package — both fields present on the result | Shaping A4; slices §V1 N30/N31 |
| C2 | **`bundle:` must not start with `./`.** AGT joins the manifest dir to the literal value, producing `<dir>/./policy/lib`; OPA's bundle loader mis-derives the data mount path from a `/./` segment and drops `data.json`. The policy then matches nothing and returns `allow` — a silent fail-open. | Measured: `./policy/lib` → config loads; `/abs/policy/lib` → loads; `/abs/./policy/lib` → UNDEFINED | New watch-for + risk row |
| C3 | **Config must live inside the bundle directory as `data.json`.** `data_paths` cannot deliver `data.agt.defaults.config` when `bundle:` is set: the bundle ships no `.manifest`, so its roots default to `""`, it owns the whole data tree, and the `--data` document is discarded. | Traced argv: `opa eval --bundle <dir> --data <config>` → config UNDEFINED; same with `-d` → config loads | slices §V1 S8 |
| C4 | **The stock bundle ships no shell/command patterns** — only generic PII regexes. `agt.patterns` is the module that denies, but the destructive-command regex list is authored by us as config. R2.1 still holds (zero Rego), but the demo must not claim Microsoft ships an `rm -rf` deny-list. | `policy/lib/patterns.rego:17-33` | slices §V1 demo framing |
| C5 | **`policy_target` must resolve to a leaf string.** `pattern_text()` falls back to `input.policy_target.value` and requires `is_string`. Binding `$.tool_call.args` (an object) makes the check silently never fire. | `agt_default.rego:86-92` | slices §V1 S7 |
| C6 | **AGT's verdict has no `rule_id`, no `reason_codes`, no `reasoning`.** Its shape is `{decision, reason, message, transform?, evidence?, result_labels?}`. ACS's richer fields must be synthesized by `mapVerdict`, and that synthesis is `mapping.yaml`'s job. | `core/src/verdict.rs:99-121`; `grep -rn rule_id policy-engine/spec/` → zero matches | slices §V1 N24/S10 |
| C7 | **ACS decisions are lowercase on the wire.** `docs/acs.md`'s `response.action == "DENY"` pseudocode contradicts `response-envelope.json`. | `specification/v0.1.0/response-envelope.json` | Shaping N7 (writes `DENY`) |
| C8 | **The method is `steps/toolCallRequest`**, and ACS v0.1.0 defines **19** `steps/*` hooks, not the 16 in `specification.md` §5's stale table. | `hooks.md`; 19 payload schemas on disk | slices §V1 N2; D3 framing |
| C9 | **`opa` on PATH is no longer a setup cost.** The npm package pulls `agent-control-specification-opa-darwin-arm64`, shipping OPA 0.70.0, with `ACS_OPA_PATH` / `ACS_OPA_NO_BUNDLE` overrides. The stock bundle passes 105/105 under both that and system OPA 1.18.2. | `bun add` output; `opa test` under both binaries | slices §V1 setup-cost note; **closes D7** |
| C10 | **`enforced_identity` bisection is unavailable over the Python binding** and available over Node. Recorded because it is the reason C1 matters beyond convenience, and because V7's N43 depends on it. | as C1 | New risk row |

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U1 prompt input | Task 9 | Claude Code's own surface; exercised by the runbook |
| U2 tool permission outcome in transcript | Task 9 | `permissionDecisionReason` carries the deny reason |
| N1 hook shim | Task 9 | |
| N2 `buildEnvelope` | Task 7 | |
| N3 `renderDecision` | Task 8 | |
| N4 `guardianClient.post` | Task 8 | |
| N5 `handshake` | Task 8 | |
| N20 `POST /acs` | Task 6 | |
| N21 `validateEnvelope` | Task 5 | |
| N23 `assembleSnapshot` | Task 4 | Envelope-only, per the watch-for |
| N24 `mapVerdict` | Task 3 | |
| N28 `handshakeResponder` | Task 6 | |
| N30 `evaluateInterventionPoint` | Task 2 | |
| N31 `AgentControl.fromPath` | Task 2 | |
| S1 `claude-code.hookmap.yaml` | Task 7 | |
| S7 `manifest.yaml` | Task 2 | |
| S8 `data.agt.defaults.config` | Task 2 | Ships as `policy/lib/data.json` per C3 |
| S9 AGT stock bundle | Task 1 | |
| S10 `mapping.yaml` | Task 3 | |
| S11 `agt.lock` | Task 1 | |
| S13 negotiated session config | Task 8 | Stored; *applied* in V3 |
| Watch-for: only `pre_tool_call` wired | Tasks 2, 4 honour it | |
| Watch-for: N23 envelope-only | Task 4 honours it | |
| R2.1 policy used as shipped | Task 1 (byte-identity test), Task 2 | |
| R3.2 adapter has zero AGT code | Task 10 (grep gate) | |
| R3.3 bridge has zero host code | Task 10 (grep gate) | |
| R7.1 one command on a laptop | Task 10 | |
| Setup cost: `opa` CLI | **obsolete** — see C9 | |

---

## Tasks

### Task 1: Workspace, vendored bundle, and the pin · slice #2 · S9, S11

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore` (append), `agt.lock`
- Create: `policy/lib/**` (vendored from AGT `81955d48025c6b11deb3fc9dabf89f74f4145775`, path `policy-engine/policy/lib`)
- Test: `test/pin.test.ts`

**Interfaces:**
- Produces: `agt.lock` — `{ "agt_ref": "<40-hex>", "agt_repo": "https://github.com/microsoft/agent-governance-toolkit", "sdk_package": "agent-control-specification", "sdk_version": "0.3.1-beta.0", "bundle_path": "policy-engine/policy/lib" }`. Read by Task 2 and, in V8, by `diffSurfaces()`.

- [ ] **Step 1: Write the failing test** — `test/pin.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const lock = JSON.parse(readFileSync("agt.lock", "utf8"));

describe("AGT pin", () => {
  it("records a full 40-character commit ref", () => {
    expect(lock.agt_ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pins the SDK version the bridge installs", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const dep =
      pkg.dependencies?.["agent-control-specification"] ??
      pkg.devDependencies?.["agent-control-specification"];
    expect(dep).toBeDefined();
    expect(dep.replace(/^[^0-9]*/, "")).toBe(lock.sdk_version);
  });

  it("vendors the stock bundle with every stock module present", () => {
    const files = readdirSync("policy/lib").filter((f) => f.endsWith(".rego"));
    for (const mod of [
      "agt_default.rego", "agt_ifc.rego", "approval.rego", "budgets.rego",
      "confidence.rego", "content_hash.rego", "drift.rego", "egress.rego",
      "ifc.rego", "patterns.rego", "redact.rego",
    ]) {
      expect(files).toContain(mod);
    }
  });

  it("adds nothing to the bundle except data.json", () => {
    const extra = readdirSync("policy/lib").filter(
      (f) => !f.endsWith(".rego") && f !== "run_tests.sh" && f !== "data.json",
    );
    expect(extra).toEqual([]);
  });

  it("authors no Rego of our own — every .rego is byte-identical to upstream", () => {
    // UPSTREAM_BUNDLE is set by `bun run verify:pin`, which clones the pinned ref.
    const upstream = process.env.UPSTREAM_BUNDLE;
    if (!upstream) return; // skipped in the fast unit run; enforced by verify:pin in CI
    for (const f of readdirSync("policy/lib").filter((f) => f.endsWith(".rego"))) {
      expect(readFileSync(join("policy/lib", f), "utf8")).toBe(
        readFileSync(join(upstream, f), "utf8"),
      );
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/pin.test.ts` → fails on missing `agt.lock`.
- [ ] **Step 3: Minimal implementation** — create the workspace and vendor the bundle.

`package.json`:
```json
{
  "name": "acs-reference-implementation",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "dependencies": { "agent-control-specification": "0.3.1-beta.0" },
  "scripts": {
    "test": "bun test",
    "verify:pin": "bash scripts/verify-pin.sh"
  }
}
```

`agt.lock`:
```json
{
  "agt_repo": "https://github.com/microsoft/agent-governance-toolkit",
  "agt_ref": "81955d48025c6b11deb3fc9dabf89f74f4145775",
  "bundle_path": "policy-engine/policy/lib",
  "sdk_package": "agent-control-specification",
  "sdk_version": "0.3.1-beta.0"
}
```

`scripts/verify-pin.sh` clones the pinned ref into a temp dir, exports `UPSTREAM_BUNDLE`, and re-runs the pin test so the byte-identity assertion actually executes.

- [ ] **Step 4: Run it, expect PASS** — `bun test test/pin.test.ts` and `bun run verify:pin`.
- [ ] **Step 5: Commit** — `Slice: #2` / `Affordances: S9, S11`

---

### Task 2: The AGT bridge · slice #2 · N30, N31, S7, S8

The single highest-risk task, and the one whose behaviour is already measured — the code below is the verified probe, not a sketch.

**Files:**
- Create: `packages/agt-bridge/package.json`, `packages/agt-bridge/src/index.ts`
- Create: `policy/manifest.yaml` (S7), `policy/lib/data.json` (S8)
- Test: `packages/agt-bridge/test/bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgtVerdict = {
    decision: "allow" | "deny" | "warn" | "escalate" | "transform";
    reason?: string; message?: string;
    transform?: { path: string; value: unknown };
    result_labels?: string[];
  };
  export type BridgeResult = {
    verdict: AgtVerdict;
    inputIdentity?: string;
    enforcedIdentity?: string;
    transformedPolicyTarget?: unknown;
  };
  export function createBridge(manifestPath: string): {
    evaluate(point: string, snapshot: Record<string, unknown>): Promise<BridgeResult>;
  };
  ```
  Consumed by Task 3 (`mapVerdict`) and Task 6 (the Guardian).

**Constraint:** no file in this package may name a host. It receives an assembled snapshot and returns a verdict.

- [ ] **Step 1: Write the failing test** — `packages/agt-bridge/test/bridge.test.ts`

```ts
import { describe, expect, it, beforeAll } from "bun:test";
import { createBridge } from "../src/index.ts";

const snapshotFor = (command: string) => ({
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "run_shell", args: { command }, id: "t1" },
});

let bridge: ReturnType<typeof createBridge>;
beforeAll(() => { bridge = createBridge("policy/manifest.yaml"); });

describe("agt-bridge", () => {
  it("denies a destructive shell command using the stock bundle", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -rf /"));
    expect(r.verdict.decision).toBe("deny");
    expect(r.verdict.reason).toBe("destructive_shell_command_blocked");
    expect(r.verdict.message).toContain("matched pattern");
  });

  it("denies the -fr spelling too", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -fr / --no-preserve-root"));
    expect(r.verdict.decision).toBe("deny");
  });

  it("allows benign commands", async () => {
    for (const cmd of ["ls -la", "git status"]) {
      expect((await bridge.evaluate("pre_tool_call", snapshotFor(cmd))).verdict.decision).toBe("allow");
    }
  });

  // Guards Correction C2 — the failure mode this catches is a SILENT fail-open.
  it("surfaces the policy config to Rego (guards the ./ bundle-path landmine)", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -rf /"));
    expect(r.verdict.decision).not.toBe("allow");
  });

  // Guards Correction C1 — this is why the bridge is Node, not Python.
  it("returns input and enforced identity as distinct fields", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("ls -la"));
    expect(r.inputIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.enforcedIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/agt-bridge` → module not found.
- [ ] **Step 3: Minimal implementation**

`policy/manifest.yaml` (S7) — note `bundle: policy/lib` with **no** `./`, per C2, and the leaf `policy_target`, per C5:
```yaml
agent_control_specification_version: "0.3.1-beta"
metadata:
  name: "acs-reference-implementation"
policies:
  agt_stock:
    type: rego
    bundle: policy/lib
    query: data.agt.defaults.verdict
intervention_points:
  pre_tool_call:
    policy_target: "$.tool_call.args.command"
    policy_target_kind: tool_args
    tool_name_from: "$.tool_call.name"
    policy:
      id: agt_stock
tools:
  run_shell:
    type: Tool
    id: run_shell
    security_labels: [shell]
```

`policy/lib/data.json` (S8) — the only file we add to the bundle, per C3:
```json
{
  "agt": {
    "defaults": {
      "config": {
        "patterns": {
          "patterns": [
            "(?i)rm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/(?:\\s|$)",
            "(?i)rm\\s+-[a-z]*f[a-z]*r[a-z]*\\s+/(?:\\s|$)"
          ],
          "reason": "destructive_shell_command_blocked"
        }
      }
    }
  }
}
```

`packages/agt-bridge/src/index.ts`:
```ts
import { AgentControl } from "agent-control-specification";

export type AgtVerdict = {
  decision: "allow" | "deny" | "warn" | "escalate" | "transform";
  reason?: string;
  message?: string;
  transform?: { path: string; value: unknown };
  result_labels?: string[];
};

export type BridgeResult = {
  verdict: AgtVerdict;
  inputIdentity?: string;
  enforcedIdentity?: string;
  transformedPolicyTarget?: unknown;
};

/**
 * N31 — construct once at boot. N30 — evaluate per decision.
 * Stateless: nothing is retained between evaluate() calls (R6.1).
 */
export function createBridge(manifestPath: string) {
  if (manifestPath.includes("/./")) {
    throw new Error(
      `manifest path contains "/./": ${manifestPath}. AGT joins this verbatim and OPA ` +
        `then drops the bundle's data document, silently disabling policy. See C2.`,
    );
  }
  const control = AgentControl.fromPath(manifestPath);

  return {
    async evaluate(point: string, snapshot: Record<string, unknown>): Promise<BridgeResult> {
      const result = await control.evaluateInterventionPoint(point, snapshot as never);
      return {
        verdict: result.verdict as AgtVerdict,
        inputIdentity: result.inputIdentity,
        enforcedIdentity: result.enforcedIdentity,
        transformedPolicyTarget: result.transformedPolicyTarget,
      };
    },
  };
}
```

- [ ] **Step 4: Run it, expect PASS** — `bun test packages/agt-bridge`.
- [ ] **Step 5: Commit** — `Slice: #2` / `Affordances: N30, N31, S7, S8`

---

### Task 3: `mapping.yaml` and `mapVerdict` · slice #2 · S10, N24

S10 is the load-bearing artifact: the same file drives the runtime here and the conformance harness in V7. If they diverge, V7 goes red.

**Files:**
- Create: `mapping.yaml`, `packages/guardian/src/map-verdict.ts`
- Test: `packages/guardian/test/map-verdict.test.ts`

**Interfaces:**
- Consumes: `AgtVerdict` from Task 2.
- Produces: `mapVerdict(v: AgtVerdict, mapping: Mapping): AcsDecision` where
  ```ts
  export type AcsDecision = {
    decision: "allow" | "deny" | "modify" | "ask" | "defer";
    reasoning?: string;
    reason_codes?: string[];
    policy_references?: { policy_id: string; policy_version?: string; rule_id: string }[];
  };
  ```

**Mapping rules** (C6 — AGT carries no `rule_id`/`reason_codes`/`reasoning`, so these are synthesized):
`allow`→`allow` · `deny`→`deny` · `warn`→`allow` **with non-empty `policy_references`** (R1.2) · `escalate`→`ask` · `transform`→`modify`.
`reasoning` ← `verdict.message` · `reason_codes` ← `[verdict.reason]` · `policy_references[0].rule_id` ← `verdict.reason`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { loadMapping, mapVerdict } from "../src/map-verdict.ts";

const m = loadMapping("mapping.yaml");

describe("mapVerdict", () => {
  it("maps allow to allow", () => {
    expect(mapVerdict({ decision: "allow" }, m).decision).toBe("allow");
  });

  it("maps deny, carrying reason and message into ACS fields", () => {
    const d = mapVerdict(
      { decision: "deny", reason: "destructive_shell_command_blocked", message: "matched pattern X" },
      m,
    );
    expect(d.decision).toBe("deny");
    expect(d.reasoning).toBe("matched pattern X");
    expect(d.reason_codes).toEqual(["destructive_shell_command_blocked"]);
    expect(d.policy_references?.[0].rule_id).toBe("destructive_shell_command_blocked");
  });

  // R1.2 — the whole warn round trip rests on this.
  it("maps warn to allow WITH non-empty policy_references", () => {
    const d = mapVerdict({ decision: "warn", reason: "drift_detected", message: "drift 0.8" }, m);
    expect(d.decision).toBe("allow");
    expect(d.policy_references?.length).toBeGreaterThan(0);
    expect(d.policy_references?.[0].rule_id).toBe("drift_detected");
  });

  it("distinguishes warn-allow from clean allow by policy_references", () => {
    expect(mapVerdict({ decision: "allow" }, m).policy_references ?? []).toHaveLength(0);
  });

  it("maps escalate to ask and transform to modify", () => {
    expect(mapVerdict({ decision: "escalate", reason: "approval_required" }, m).decision).toBe("ask");
    expect(mapVerdict({ decision: "transform", reason: "redacted" }, m).decision).toBe("modify");
  });

  it("emits only lowercase decisions (C7)", () => {
    for (const dec of ["allow", "deny", "warn", "escalate", "transform"] as const) {
      const out = mapVerdict({ decision: dec, reason: "r" }, m).decision;
      expect(out).toBe(out.toLowerCase());
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**
- [ ] **Step 3: Minimal implementation** — `mapping.yaml` holds the verdict table and the point table (the latter read by V7):

```yaml
acs_version: "0.1.0"
agt_version: "0.3.1-beta"

intervention_points:
  pre_tool_call:  { acs_method: "steps/toolCallRequest" }
  post_tool_call: { acs_method: "steps/toolCallResult" }
  agent_startup:  { acs_method: "steps/sessionStart" }
  agent_shutdown: { acs_method: "steps/sessionEnd" }
  input:          { acs_method: "steps/userMessage" }
  output:         { acs_method: "steps/agentResponse" }
  pre_model_call:  { acs_method: null, note: "no ACS v0.1.0 target — D4, V7 red cell" }
  post_model_call: { acs_method: null, note: "no ACS v0.1.0 target — D4, V7 red cell" }

verdicts:
  allow:     { decision: allow }
  deny:      { decision: deny }
  warn:      { decision: allow, require_policy_references: true }
  escalate:  { decision: ask }
  transform: { decision: modify }

# AGT carries no rule_id / reason_codes / reasoning (C6). These are synthesized.
field_synthesis:
  reasoning:                    from: verdict.message
  reason_codes:                 from: [verdict.reason]
  policy_references[].rule_id:  from: verdict.reason
  policy_references[].policy_id: literal: agt_stock
```

`packages/guardian/src/map-verdict.ts` implements exactly that table — no behaviour that is not expressed in `mapping.yaml`.

- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** — `Slice: #2` / `Affordances: S10, N24`

---

### Task 4: `assembleSnapshot` · slice #2 · N23

**Files:** Create `packages/guardian/src/assemble-snapshot.ts`; Test `packages/guardian/test/assemble-snapshot.test.ts`

**Interfaces:**
- Consumes: a validated ACS request envelope (Task 5's shape).
- Produces: `assembleSnapshot(envelope): Record<string, unknown>` — the AGT snapshot for `pre_tool_call`, shaped per `AGT-SNAPSHOT-1.0.md` §2.5.

**Watch-for (honoured):** envelope-only. No S3/S4/S5 reads — those arrive in V6.

- [ ] **Step 1: Write the failing test** — asserts that `params.payload.tool.name` → `tool_call.name`, that each `arguments.<k>.value` unwraps to `tool_call.args.<k>` (dropping the ACS provenance wrapper), that `tool_call.args.command` is a **string** (C5), that `envelope.budgets` is always present with four zeroed counters, and that no session-derived key appears in the output.
- [ ] **Step 2: Run it, expect FAIL.**
- [ ] **Step 3: Minimal implementation** — unwrap `{value, provenance}` argument envelopes; emit `{ envelope: { budgets: {...} }, tool_call: { name, args, id } }`.
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** — `Slice: #2` / `Affordances: N23`

---

### Task 5: `validateEnvelope` · slice #2 · N21

**Files:** Create `packages/guardian/src/validate-envelope.ts`; Test `packages/guardian/test/validate-envelope.test.ts`

Validates against the v0.1.0 schemas in the `spec/acs` submodule — `specification/v0.1.0/request-envelope.json` plus `hooks/tool-call-request.json` — with Ajv, resolving the modular `$ref`s by `$id`.

**Scope note:** V1 *rejects* invalid envelopes. Turning that rejection into an explicit ACS `deny` **decision** is N27, which belongs to **V3**. Task 5 throws a typed error; Task 6 returns a JSON-RPC error. Do not implement N27 here.

- [ ] **Step 1: Write the failing test** — a valid `steps/toolCallRequest` envelope passes; each of a missing `params.metadata.session_id`, a missing `payload.tool.name`, and a bad `method` prefix fails with the offending JSON pointer named.
- [ ] **Step 2–5** as above. Commit — `Slice: #2` / `Affordances: N21`

---

### Task 6: Guardian JSON-RPC endpoint and handshake · slice #2 · N20, N28

**Files:** Create `packages/guardian/src/server.ts`, `packages/guardian/src/handshake.ts`, `packages/guardian/src/index.ts`; Test `packages/guardian/test/server.test.ts`

**Interfaces:**
- Produces: `startGuardian({ port, manifestPath }): Promise<{ url: string; close(): Promise<void> }>`, serving `POST /acs`.
- Dispatch is by the JSON-RPC `method` field. The spec mandates no URL path; `/acs` is our convention and is recorded as such in the slices doc.

`handshakeResponder` (N28) returns a ServerHello with the required `negotiated_version`, `methods_evaluated`, `selected_transport`, `timeout_config`, plus `on_decision_failure`. **D8 note:** the reference ships the spec default `proceed`. V1 only negotiates and stores it; V3 applies it.

- [ ] **Step 1: Write the failing test** — `handshake/hello` returns a schema-valid ServerHello with `timeout_config.default_ms` present and `on_decision_failure: "proceed"`; `steps/toolCallRequest` carrying `rm -rf /` returns `result.decision === "deny"` with `reasoning` and non-empty `reason_codes`; the same carrying `ls -la` returns `allow`; an unknown method returns a JSON-RPC error in `-32000..-32099`; and every response echoes `params.request_id`.
- [ ] **Step 2–5** as above. Commit — `Slice: #2` / `Affordances: N20, N28`

---

### Task 7: `buildEnvelope` and the hookmap · slice #2 · N2, S1

**Files:** Create `packages/host-adapter/package.json`, `packages/host-adapter/src/build-envelope.ts`, `hosts/claude-code/claude-code.hookmap.yaml`; Test `packages/host-adapter/test/build-envelope.test.ts`

**Constraint:** this package must contain zero AGT-specific code (R3.2). It knows ACS and hookmaps, nothing else.

S1 maps Claude Code hook names to ACS methods and ACS decisions to Claude Code outputs:
```yaml
host: claude-code
hooks:
  PreToolUse:
    acs_method: steps/toolCallRequest
    tool_name: $.tool_name
    arguments: $.tool_input
decisions:
  allow:  { permissionDecision: allow }
  deny:   { permissionDecision: deny, reason_from: reasoning }
  ask:    { permissionDecision: ask }
  defer:  { permissionDecision: defer }
  modify: { permissionDecision: allow, updatedInput_from: modifications }
```

- [ ] **Step 1: Write the failing test** — a real Claude Code `PreToolUse` payload produces an envelope that validates against `request-envelope.json`; `method` is `steps/toolCallRequest`; `arguments` are wrapped as `{value}`; `request_id` is a UUID; `session_id` is carried; and `buildEnvelope` is driven by the hookmap (an unmapped hook name throws rather than defaulting).
- [ ] **Step 2–5** as above. Commit — `Slice: #2` / `Affordances: N2, S1`

---

### Task 8: `guardianClient.post`, `handshake`, `renderDecision` · slice #2 · N3, N4, N5, S13

**Files:** Create `packages/host-adapter/src/guardian-client.ts`, `packages/host-adapter/src/render-decision.ts`, `packages/host-adapter/src/session-config.ts`; Test `packages/host-adapter/test/client.test.ts`, `packages/host-adapter/test/render-decision.test.ts`

`renderDecision` (N3) turns an ACS decision into Claude Code's `hookSpecificOutput` **using S1** — no hardcoded dispatch. A `deny` must place the ACS `reasoning` into `permissionDecisionReason`; that string is what U2 renders, and it is the demo's payoff.

S13 stores the negotiated config. V1 stores it only; N6/N7 consume it in V3.

- [ ] **Step 1: Write the failing test** — `deny` renders `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:"<reasoning>"}}`; `allow` renders `permissionDecision:"allow"`; a `warn`-derived allow (allow + non-empty `policy_references`) still renders `allow`; `handshake()` stores `timeout_config` and `on_decision_failure` into S13; and the client posts JSON-RPC 2.0 with a matching `id`.
- [ ] **Step 2–5** as above. Commit — `Slice: #2` / `Affordances: N3, N4, N5, S13`

---

### Task 9: The Claude Code hook shim and the demo · slice #2 · N1, U1, U2

**Files:** Create `hosts/claude-code/acs-hook.ts`, `hosts/claude-code/settings.json`, `docs/demos/v1-runbook.md`; Test `hosts/claude-code/test/hook.test.ts`

N1 is deliberately thin: read hook JSON on stdin, call `buildEnvelope` → `guardianClient.post` → `renderDecision`, write `hookSpecificOutput` to stdout. All logic lives in the adapter so V5 can reuse it unchanged.

- [ ] **Step 1: Write the failing test** — spawn the shim as a subprocess against a live Guardian, feed a real `PreToolUse` payload for `rm -rf /` on stdin, and assert stdout parses to `permissionDecision: "deny"` with `permissionDecisionReason` containing the deny reason; repeat with `ls -la` for `allow`; assert exit code 0 in both cases.
- [ ] **Step 2–5** as above. The runbook states the demo in the slice's own words and names what a viewer should watch for. Commit — `Slice: #2` / `Affordances: N1, U1, U2`

---

### Task 10: The invariant gates · slice #2 · R3.2, R3.3, R7.1

The claims V1 exists to support, made mechanical so they cannot rot.

**Files:** Create `test/invariants.test.ts`, `README.md` (quickstart section)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const read = (dir: string) =>
  [...new Glob("**/*.ts").scanSync(dir)]
    .filter((f) => !f.includes("/test/"))
    .map((f) => ({ f, src: readFileSync(`${dir}/${f}`, "utf8") }));

describe("architectural invariants", () => {
  // R3.2 — this is the claim the whole M×N argument rests on.
  it("host adapter contains zero AGT-specific code", () => {
    for (const { f, src } of read("packages/host-adapter/src")) {
      for (const term of ["agt", "AgentControl", "rego", "opa", "intervention_point", "verdict"]) {
        expect({ file: f, term, found: new RegExp(term, "i").test(src) })
          .toEqual({ file: f, term, found: false });
      }
    }
  });

  // R3.3 — and this is what makes V5 cost zero AGT code.
  it("AGT bridge contains zero host-specific code", () => {
    for (const { f, src } of read("packages/agt-bridge/src")) {
      for (const term of ["claude", "opencode", "hookSpecificOutput", "permissionDecision", "stdin"]) {
        expect({ file: f, term, found: new RegExp(term, "i").test(src) })
          .toEqual({ file: f, term, found: false });
      }
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (or pass trivially if earlier tasks were disciplined — either way it is now enforced).
- [ ] **Step 3: Implementation** — fix any leak the gate catches; write the README quickstart proving R7.1 (`bun install && bun run guardian` then launch Claude Code with the hook).
- [ ] **Step 4: Run it, expect PASS** — plus a full `bun test`.
- [ ] **Step 5: Commit** — `Slice: #2` / `Affordances: R3.2, R3.3, R7.1`

---

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 3 — `mapping.yaml` point table for all 8 AGT points | V7 (C1/N41) | S10 is one file read by both runtime and harness. Writing only the `pre_tool_call` row would mean rewriting the file's shape in V7, and the shaping doc names S10 as the design choice that makes C1 a contract. The rows are data; only `pre_tool_call` is exercised in V1. |
| Task 6 — `on_decision_failure` in ServerHello | V3 (N6) | The handshake is a V1 affordance (N5/N28) and the field is part of ServerHello. V1 negotiates and stores; V3 applies. Storing without applying is the slice boundary, not a gap. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| `policy/lib/data.json` inside the bundle | `data_paths` cannot deliver `data.agt.defaults.config` when `bundle:` is set (C3). Without this the policy is inert and the demo silently allows. | S8 row rewritten |
| Bundle-path guard in `createBridge` + a test asserting deny | The `/./` landmine (C2) fails open silently. An assertion that "deny is not allow" is the only thing standing between the demo and a policy that quietly does nothing. | New watch-for + risk row |
| Our own destructive-command regex list | The stock bundle ships none (C4). | Demo framing corrected |
| Task 10 invariant gates | R3.2/R3.3 are "verifiable by inspection" in the shaping doc. Inspection rots; a test does not. | Noted under V1 |
| `scripts/verify-pin.sh` | R2.2/R2.3 claim an unforked pinned engine. Nothing enforced it. | S9/S11 rows |

---

## Risks carried into execution

| # | Risk | Handling |
|---|---|---|
| 1 | The `/./` landmine reappears via a different path join | `createBridge` throws on `/./`; Task 2's deny test is the backstop |
| 2 | Upstream AGT moves and `data.json`-in-bundle stops working | `agt.lock` pins the ref; V8 watches the surface |
| 3 | Bun's napi support regresses on the AGT addon | Verified loading under both bun and node; pnpm + node is the fallback and costs only the package manager |
| 4 | `enforced_identity` bisection unverified end-to-end | Task 2 asserts both fields are present and well-formed; true bisection needs a `transform` verdict and lands in V3/V7 |
