# V8: Upstream contract watch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled harness that reads AGT's eight declared contract surfaces at `main`, diffs them against the same eight at the ref `agt.lock` pins, and reports each moved field as a `SurfaceDiff` naming the surface, the field, and what it was against what it is now.

**Architecture:** Three functions in `packages/conformance/`, mirroring the shape V7 already established for the policy-input schema leg. A shell script shallow-clones AGT twice — once at `agt.lock`'s ref, once at `main` — and hands both paths to the runner by environment variable; the runner reads each clone into a surfaces snapshot, diffs the pair, and renders. Nothing reaches the network from TypeScript, and nothing reads `agt.lock` inside the differ.

**Tech Stack:** Bun, TypeScript, `bun test`. Git for the two clones. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

1. **The stem is `upstream`, and nothing this slice builds is named `drift`.** `drift.rego`, `drift_score`, `drift_detected`, `drift.warn_threshold` and `policy/manifest.drift.yaml` are V3's family, they are shipped, and this slice leaves every one where it is. (`slices/v8/README.md`, commitment 1.)
2. **`PinnedSurfaces` and `UpstreamSurfaces` are a twin pair; neither is ever just `Surfaces`.** One shape, two sources, and the name says which source. (Commitment 2.)
3. **`diffSurfaces(pinned, upstream)` is told both snapshots and reads neither store itself.** It does not open `agt.lock`, does not resolve a git ref, and does not reach the network. (Commitment 3.)
4. **A `SurfaceDiff` is not a cell of V7's 8 × 5**, and it renders through `renderUpstreamDiff()`, never through `renderCoverageMatrix()`. (Commitment 4.)
5. **The pinned clone is `PINNED_AGT_CLONE`; `UPSTREAM_AGT_CLONE` is this slice's.** The two must never be read by the same name. (Commitment 5.)
6. **Every comment and document sentence states a measured fact.** Captured output is re-run, never hand-edited.
7. **Comments and test names carry no shaping identifiers** (`N45`, `R2.5`, `S12`, …) and no review archaeology. Name the function, the file, or the requirement in words. This is the standing rule across the stack.
8. **No attribution on outbound git traffic.** Both clones use the pattern `scripts/verify-pin.sh` and `scripts/run-conformance.sh` already share: no credential helper, `GIT_TERMINAL_PROMPT=0`, git's default User-Agent.
9. **`trash`, never `rm -rf`,** for scratch-dir cleanup — both existing scripts check for it and refuse to run without it.
10. **This slice reports; it never refuses.** Nothing here fails a build, blocks a decision, or changes a runtime path. A moved surface is published, and a human reads it.

---

## Slice Contract

| Field | Value |
|---|---|
| **Slice ID** | GitHub issue **#9** — titled "V8: Upstream drift watch" ⚠️ *stale: commitment 1 retires `drift` for this slice; Task 7 retitles the issue to "V8: Upstream contract watch"* |
| **Slices doc** | `docs/shaping/acs-reference-impl-slices.md` **§V8, line 560** |
| **Branch** | `slice/v8`, stacked on `slice/v7` (PR #17 → `slice/v7`) |
| **Demo** | "Point the harness at AGT `main`. A changed enum value is reported as a `SurfaceDiff` naming the surface and the field that moved." |
| **Components** | **U31** surface-diff detail (render) · **N45** `fetchUpstreamSurfaces()` → S12 · **N46** `diffSurfaces(pinned, upstream)` → N53 · **N53** `renderUpstreamDiff()` → U31 · **S12** upstream AGT surfaces at `main` · **S11** `agt.lock`, the pinned side (shared store, not new) |
| **Requirements** | **R2.4** coupling to AGT's declared contract surfaces only · **R2.5** scheduled CI re-run so a moved surface shows up rather than rotting silently · **R2.6** a failure names what changed in AGT's own terms · **R2.7** non-breaking upstream releases require no code change here |
| **Parked items** | Six posture-seam hookmap faults → **not in this plan** (destination amended by Task 7) · Inspector tail-test sleeps → **not in this plan**, V2's rail (destination amended by Task 7) |
| **Watch-for notes** | "Surfaces watched, and nothing else (R2.4)" — the eight below, and no others. "Runs on a schedule in CI." |
| **Corrections in the slice** | ⚠️ Demo restated in this slice's own noun (was "turns a cell red and names the field") — a changed enum is a `SurfaceDiff`, not a coverage cell · ⚠️ N53 is new scope, added by V7's `renderMatrix()` split · ⚠️ S11 is not new scope and was simply missing from the table |

### The eight surfaces, located by measurement

Verified by shallow-cloning `agent-governance-toolkit` at `agt.lock`'s ref `81955d48025c6b11deb3fc9dabf89f74f4145775` during planning, not by reading documentation.

| # | Surface | Where it lives at the pinned ref | Shape |
|---|---|---|---|
| 1 | `manifest.schema.json` | `policy-engine/spec/schema/manifest.schema.json` | whole document |
| 2 | `policy-input.schema.json` | `policy-engine/spec/schema/wire/policy-input.schema.json` | whole document |
| 3 | `verdict.schema.json` | `policy-engine/spec/schema/wire/verdict.schema.json` | whole document |
| 4 | `snapshot.schema.json` | `policy-engine/spec/schema/wire/snapshot.schema.json` | whole document |
| 5 | intervention-point enum | **inside** surface 1, at `/properties/intervention_points/propertyNames/enum` | 8 values: `agent_startup`, `input`, `pre_model_call`, `post_model_call`, `pre_tool_call`, `post_tool_call`, `output`, `agent_shutdown` |
| 6 | verdict enum | **inside** surface 3, at `/properties/decision/enum` | 5 values: `allow`, `deny`, `warn`, `escalate`, `transform` |
| 7 | `reserved-reasons.json` | `policy-engine/spec/reserved-reasons.json` | whole document |
| 8 | `data.agt.defaults.config` keys | **not a document** — derived by reading `cfg.<key>` in `policy-engine/policy/lib/agt_default.rego` | 10 keys: `approval.approvers`, `approval.required`, `budgets`, `confidence.min_score`, `content_hash.enforce`, `drift.warn_threshold`, `egress`, `ifc.sink_clearance`, `patterns`, `redact` |

**Eight surfaces are not eight files.** Five are documents, two are enums extracted from documents already fetched, and one is a key set that exists only as Rego source. A reader who assumes one-file-per-surface writes a fetcher that cannot express surfaces 5, 6 or 8.

---

## Corrections produced during planning

Each is verified by running the thing rather than reading it, and each is amended into the slices doc by Task 7.

### C1 — The wire schemas exist in two copies at the pinned ref, and they are identical there

`policy-engine/spec/schema/wire/` and `policy-engine/generator/acs_generator/schema/wire/` both carry `policy-input`, `verdict`, `snapshot` and `effect`; `manifest.schema.json` exists at both `spec/schema/` and `core/schema/`. Measured byte-identical at the pinned ref for all four watched documents.

**Consequence:** the watch reads the `spec/` copy, because that is the one V7's schema leg already validates against and the one AGT's own specification prose cites. A divergence between the two copies upstream is invisible to this watch. Recorded as a known limit rather than fixed: watching both doubles every diff row for the common case where they agree, and the `spec/` copy is the declared contract surface R2.4 names.

### C2 — The `tools`-registry cross-check cannot catch the failure it was filed for

§V8's residual proposes "cross-check each `tools` entry against `policy/manifest.yaml`'s tool registry at load" as the candidate close for a measured failure: OpenCode's `tools: [bash]` recased to `[Bash]` loads clean and the gate then silently governs nothing.

**Measured:** `policy/manifest.yaml`'s registry is `["run_shell", "Bash", "bash"]` — all three, deliberately, because each is a different host's real spelling (`Bash` is Claude Code's, `bash` is OpenCode's, `run_shell` is AGT's stock example, and each has its own comment in the file saying so). A registry cross-check therefore **passes** the recased hookmap, because `Bash` is registered.

**Consequence, and it inverts the residual's framing.** The open question was recorded as "what a hookmap may legitimately name that a manifest does not". The measurement says the opposite is the problem: the manifest names *more* than any one host dispatches, and it must, because it serves both hosts. The check this slice builds is still worth building — it catches a `tools` entry naming nothing at all, which is the typo class — but it does not close the recasing case, and this plan does not claim it does. Closing that needs a per-host declaration of dispatched names, which no document in this repo carries today.

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U31 surface-diff detail | Task 4 | rendered by N53, never by `renderCoverageMatrix` |
| R2.7 non-breaking releases need no code change | Task 3, and proved by Task 6 | an added optional field is a diff row and still validates; nothing exits non-zero |
| N45 `fetchUpstreamSurfaces()` | Task 2 | reads a clone the script made; no network in TS |
| N46 `diffSurfaces(pinned, upstream)` | Task 3 | told both sides, reads neither store |
| N53 `renderUpstreamDiff()` | Task 4 | |
| S12 upstream AGT surfaces | Task 1 (shape), Task 2 (populated) | |
| S11 `agt.lock` pinned side | Task 1 (shape), Task 5 (read by the runner) | shared store, read here, not owned here |
| R2.4 declared surfaces only | Tasks 1–2 | the eight of the Slice Contract, and no others |
| R2.5 scheduled CI re-run, as a failing case | Task 5 (schedule) + **Task 6** (the re-validation) | a surface diff alone reports movement without re-measuring anything; Task 6 is the behavioural half |
| R2.6 names what changed in AGT's terms | Tasks 3–4 | surface, field path, was → is |
| R2.7 non-breaking releases need no code change | Task 3 | an added optional field is reported, not failed; nothing exits non-zero |
| Correction: demo restated in this slice's noun | Global Constraint 4, Task 4 | |
| Correction: N53 is new scope | Task 4 | |
| Correction: S11 was missing from the table | Slice Contract; no code consequence | |
| Commitments 1–5 (`slices/v8/README.md`) | Global Constraints 1–5 | every task is bound by them |
| Residual → `tools` vs manifest registry | Task 7 | reporting only; C2 records what it does not close |
| Residual → six posture-seam hookmap faults | **not in this plan** | Task 8 amends §V8 to name a destination |
| Residual → Inspector tail-test sleeps | **not in this plan** | V2's rail; Task 8 amends §V8 to say so |

---

## Task 1: The twin pair and the surfaces reader · slice #9 · S11, S12

**Files:**
- Create: `packages/conformance/src/surfaces.ts`
- Create: `packages/conformance/test/surfaces.test.ts`
- Modify: `packages/conformance/src/index.ts` (add exports)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type SurfaceName`, `type SurfaceSnapshot`, `type PinnedSurfaces`, `type UpstreamSurfaces`, `readSurfaces(cloneDir: string): SurfaceSnapshot`, `asPinned(s: SurfaceSnapshot): PinnedSurfaces`, `asUpstream(s: SurfaceSnapshot): UpstreamSurfaces`, `SURFACE_NAMES: readonly SurfaceName[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/surfaces.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readSurfaces, asPinned, asUpstream, SURFACE_NAMES } from "../src/surfaces.ts";

function fakeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfaces-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write(
    "policy-engine/spec/schema/manifest.schema.json",
    JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["pre_tool_call", "output"] } } } }),
  );
  write("policy-engine/spec/schema/wire/policy-input.schema.json", JSON.stringify({ title: "policy input" }));
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: ["allow", "deny"] } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", JSON.stringify({ title: "snapshot" }));
  write("policy-engine/spec/reserved-reasons.json", JSON.stringify({ reasons: ["tool_unknown"] }));
  write("policy-engine/policy/lib/agt_default.rego", "x := cfg.drift.warn_threshold\ny := cfg.patterns\nz := cfg.drift.warn_threshold\n");
  return dir;
}

describe("readSurfaces -- the eight declared surfaces, and nothing else", () => {
  it("names exactly eight surfaces", () => {
    expect(SURFACE_NAMES).toHaveLength(8);
  });

  it("reads the four wire documents whole", () => {
    const s = readSurfaces(fakeClone());
    expect(s["policy-input.schema.json"]).toEqual({ title: "policy input" });
    expect(s["snapshot.schema.json"]).toEqual({ title: "snapshot" });
  });

  it("extracts the intervention-point enum from inside manifest.schema.json", () => {
    expect(readSurfaces(fakeClone())["intervention-point enum"]).toEqual(["pre_tool_call", "output"]);
  });

  it("extracts the verdict enum from inside verdict.schema.json", () => {
    expect(readSurfaces(fakeClone())["verdict enum"]).toEqual(["allow", "deny"]);
  });

  it("derives the defaults config keys from the rego source, deduped and sorted", () => {
    expect(readSurfaces(fakeClone())["data.agt.defaults.config keys"]).toEqual(["drift.warn_threshold", "patterns"]);
  });

  it("throws when a surface is missing rather than reporting it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "surfaces-empty-"));
    expect(() => readSurfaces(dir)).toThrow(/manifest.schema.json/);
  });

  it("brands a snapshot as pinned or upstream without changing it", () => {
    const s = readSurfaces(fakeClone());
    expect(asPinned(s)).toEqual(s);
    expect(asUpstream(s)).toEqual(s);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/surfaces.test.ts`
Expected: FAIL — `Cannot find module '../src/surfaces.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/surfaces.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The eight AGT contract surfaces this watch reads, and no others. Coupling
 * is to what AGT declares -- its wire schemas, its two enums, its reserved
 * reasons and the config keys its default policy reads -- never to SDK
 * internals or private APIs.
 *
 * Eight surfaces are not eight files. Five are documents; two are enums that
 * live inside documents already read here; one exists only as Rego source.
 */
export type SurfaceName =
  | "manifest.schema.json"
  | "policy-input.schema.json"
  | "verdict.schema.json"
  | "snapshot.schema.json"
  | "intervention-point enum"
  | "verdict enum"
  | "reserved-reasons.json"
  | "data.agt.defaults.config keys";

export const SURFACE_NAMES: readonly SurfaceName[] = [
  "manifest.schema.json",
  "policy-input.schema.json",
  "verdict.schema.json",
  "snapshot.schema.json",
  "intervention-point enum",
  "verdict enum",
  "reserved-reasons.json",
  "data.agt.defaults.config keys",
];

export type SurfaceSnapshot = Readonly<Record<SurfaceName, unknown>>;

/**
 * The same eight surfaces read at the ref `agt.lock` records, and the same
 * eight read at `main`. One shape, two sources, and the name says which --
 * a single type serving both is the shape in which a run that read the
 * pinned side twice still reports a clean diff.
 */
export type PinnedSurfaces = SurfaceSnapshot & { readonly __side: "pinned" };
export type UpstreamSurfaces = SurfaceSnapshot & { readonly __side: "upstream" };

export const asPinned = (s: SurfaceSnapshot): PinnedSurfaces => s as PinnedSurfaces;
export const asUpstream = (s: SurfaceSnapshot): UpstreamSurfaces => s as UpstreamSurfaces;

const SPEC = "policy-engine/spec";
const PATHS = {
  manifest: `${SPEC}/schema/manifest.schema.json`,
  policyInput: `${SPEC}/schema/wire/policy-input.schema.json`,
  verdict: `${SPEC}/schema/wire/verdict.schema.json`,
  snapshot: `${SPEC}/schema/wire/snapshot.schema.json`,
  reservedReasons: `${SPEC}/reserved-reasons.json`,
  defaultsRego: "policy-engine/policy/lib/agt_default.rego",
} as const;

function readJson(cloneDir: string, relative: string): unknown {
  const full = join(cloneDir, relative);
  let raw: string;
  try {
    raw = readFileSync(full, "utf8");
  } catch {
    throw new Error(`readSurfaces: expected an AGT surface at ${relative}, and the clone has no such file`);
  }
  return JSON.parse(raw);
}

/**
 * Every `cfg.<key>` the default policy reads, deduped and sorted. This
 * surface has no document to fetch: the keys exist only as reads in Rego
 * source, so a moved key shows up here as a name appearing or disappearing.
 */
function defaultsConfigKeys(cloneDir: string): string[] {
  const full = join(cloneDir, PATHS.defaultsRego);
  let source: string;
  try {
    source = readFileSync(full, "utf8");
  } catch {
    throw new Error(`readSurfaces: expected AGT's default policy at ${PATHS.defaultsRego}, and the clone has no such file`);
  }
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bcfg\.([a-z_]+(?:\.[a-z_]+)?)/g)) {
    keys.add(match[1] as string);
  }
  return [...keys].sort();
}

function enumAt(document: unknown, path: readonly string[], surface: string): unknown {
  let cursor: unknown = document;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new Error(`readSurfaces: ${surface} is not where it was: ${path.join("/")} left the document early at "${segment}"`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(cursor)) {
    throw new Error(`readSurfaces: ${surface} is not an array at ${path.join("/")}`);
  }
  return cursor;
}

/** Reads all eight surfaces out of one AGT clone. Throws on a missing or
 * relocated surface: a watch that reports an absent surface as "unchanged"
 * is the silent rot this slice exists to catch. */
export function readSurfaces(cloneDir: string): SurfaceSnapshot {
  const manifest = readJson(cloneDir, PATHS.manifest);
  const verdict = readJson(cloneDir, PATHS.verdict);
  return {
    "manifest.schema.json": manifest,
    "policy-input.schema.json": readJson(cloneDir, PATHS.policyInput),
    "verdict.schema.json": verdict,
    "snapshot.schema.json": readJson(cloneDir, PATHS.snapshot),
    "intervention-point enum": enumAt(
      manifest,
      ["properties", "intervention_points", "propertyNames", "enum"],
      "the intervention-point enum",
    ),
    "verdict enum": enumAt(verdict, ["properties", "decision", "enum"], "the verdict enum"),
    "reserved-reasons.json": readJson(cloneDir, PATHS.reservedReasons),
    "data.agt.defaults.config keys": defaultsConfigKeys(cloneDir),
  };
}
```

Add to `packages/conformance/src/index.ts`:

```ts
export {
  asPinned,
  asUpstream,
  readSurfaces,
  SURFACE_NAMES,
  type PinnedSurfaces,
  type SurfaceName,
  type SurfaceSnapshot,
  type UpstreamSurfaces,
} from "./surfaces.ts";
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/surfaces.test.ts && bun run typecheck`
Expected: PASS, 7 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/surfaces.ts packages/conformance/test/surfaces.test.ts packages/conformance/src/index.ts
git commit -m "Read AGT's eight declared surfaces out of one clone

Slice: #9
Affordances: S11, S12"
```

---

## Task 2: `fetchUpstreamSurfaces()` · slice #9 · N45

**Files:**
- Create: `packages/conformance/src/fetch-upstream.ts`
- Create: `packages/conformance/test/fetch-upstream.test.ts`
- Modify: `packages/conformance/src/index.ts`

**Interfaces:**
- Consumes: `readSurfaces`, `asUpstream`, `type UpstreamSurfaces` from `./surfaces.ts`.
- Produces: `UPSTREAM_AGT_CLONE_ENV = "UPSTREAM_AGT_CLONE"`, `fetchUpstreamSurfaces(env?: Record<string, string | undefined>): UpstreamSurfaces | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/fetch-upstream.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fetchUpstreamSurfaces, UPSTREAM_AGT_CLONE_ENV } from "../src/fetch-upstream.ts";

function fakeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "upstream-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write("policy-engine/spec/schema/manifest.schema.json", JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["input"] } } } }));
  write("policy-engine/spec/schema/wire/policy-input.schema.json", "{}");
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: ["allow"] } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", "{}");
  write("policy-engine/spec/reserved-reasons.json", "{}");
  write("policy-engine/policy/lib/agt_default.rego", "a := cfg.patterns\n");
  return dir;
}

describe("fetchUpstreamSurfaces -- reads the clone the script made, never the network", () => {
  it("self-skips when the upstream clone variable is unset, exactly as the schema leg does", () => {
    expect(fetchUpstreamSurfaces({})).toBeUndefined();
  });

  it("reads the eight surfaces out of the clone the variable names", () => {
    const surfaces = fetchUpstreamSurfaces({ [UPSTREAM_AGT_CLONE_ENV]: fakeClone() });
    expect(surfaces?.["verdict enum"]).toEqual(["allow"]);
  });

  it("names its own variable, never the pinned one", () => {
    expect(UPSTREAM_AGT_CLONE_ENV).toBe("UPSTREAM_AGT_CLONE");
  });

  it("throws rather than self-skipping when the variable names a directory with no AGT in it", () => {
    const empty = mkdtempSync(join(tmpdir(), "upstream-empty-"));
    expect(() => fetchUpstreamSurfaces({ [UPSTREAM_AGT_CLONE_ENV]: empty })).toThrow(/manifest.schema.json/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/fetch-upstream.test.ts`
Expected: FAIL — `Cannot find module '../src/fetch-upstream.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/fetch-upstream.ts
import { asUpstream, readSurfaces, type UpstreamSurfaces } from "./surfaces.ts";

/**
 * The clone of AGT at `main` this watch reads. A shell script makes the
 * clone and passes its path here, for the same reason the policy-input
 * schema check takes its pinned clone that way: fetching needs the network,
 * and keeping the network in one shell script means every TypeScript module
 * stays runnable under `bun test` with no network at all.
 *
 * Deliberately not the pinned clone's variable. The pinned ref and `main`
 * are the two sides of the diff, and a differ told the same side twice
 * reports a clean run against a contract that moved.
 */
export const UPSTREAM_AGT_CLONE_ENV = "UPSTREAM_AGT_CLONE";

/**
 * Reads AGT's eight surfaces at `main` out of the clone the environment
 * names, or answers `undefined` when there is no clone to read.
 *
 * Absent variable and unreadable clone are different answers on purpose.
 * `bun test` never sets the variable, so the watch self-skips there and the
 * rest of the suite stays covered without a network. A variable that IS set
 * and names a directory with no AGT in it is a broken run, and `readSurfaces`
 * throws rather than reporting eight surfaces that were never read.
 */
export function fetchUpstreamSurfaces(
  env: Record<string, string | undefined> = process.env,
): UpstreamSurfaces | undefined {
  const cloneDir = env[UPSTREAM_AGT_CLONE_ENV];
  if (cloneDir === undefined || cloneDir.length === 0) {
    return undefined;
  }
  return asUpstream(readSurfaces(cloneDir));
}
```

Add to `packages/conformance/src/index.ts`:

```ts
export { fetchUpstreamSurfaces, UPSTREAM_AGT_CLONE_ENV } from "./fetch-upstream.ts";
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/fetch-upstream.test.ts && bun run typecheck`
Expected: PASS, 4 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/fetch-upstream.ts packages/conformance/test/fetch-upstream.test.ts packages/conformance/src/index.ts
git commit -m "Fetch AGT's surfaces at main, from a clone the script made

Slice: #9
Affordances: N45, S12"
```

---

## Task 3: `diffSurfaces()` · slice #9 · N46

**Files:**
- Create: `packages/conformance/src/diff-surfaces.ts`
- Create: `packages/conformance/test/diff-surfaces.test.ts`
- Modify: `packages/conformance/src/index.ts`

**Interfaces:**
- Consumes: `type PinnedSurfaces`, `type UpstreamSurfaces`, `type SurfaceName`, `SURFACE_NAMES` from `./surfaces.ts`.
- Produces: `type SurfaceDiff = { surface: SurfaceName; field: string; pinned: unknown; upstream: unknown }`, `diffSurfaces(pinned: PinnedSurfaces, upstream: UpstreamSurfaces): SurfaceDiff[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/diff-surfaces.test.ts
import { describe, expect, it } from "bun:test";
import { diffSurfaces } from "../src/diff-surfaces.ts";
import { asPinned, asUpstream, SURFACE_NAMES, type SurfaceSnapshot } from "../src/surfaces.ts";

const base = (): SurfaceSnapshot =>
  Object.fromEntries(SURFACE_NAMES.map((n) => [n, n === "verdict enum" ? ["allow", "deny"] : { unchanged: true }])) as SurfaceSnapshot;

const withSurface = (name: string, value: unknown): SurfaceSnapshot => ({ ...base(), [name]: value }) as SurfaceSnapshot;

describe("diffSurfaces -- one row per field that moved", () => {
  it("reports nothing when both sides are the same", () => {
    expect(diffSurfaces(asPinned(base()), asUpstream(base()))).toEqual([]);
  });

  it("names the surface, the field, and what it was against what it is", () => {
    const diffs = diffSurfaces(asPinned(base()), asUpstream(withSurface("verdict enum", ["allow", "deny", "quarantine"])));

    expect(diffs).toEqual([
      { surface: "verdict enum", field: "/2", pinned: undefined, upstream: "quarantine" },
    ]);
  });

  it("reports a removed enum value as upstream undefined", () => {
    const diffs = diffSurfaces(asPinned(base()), asUpstream(withSurface("verdict enum", ["allow"])));

    expect(diffs).toEqual([{ surface: "verdict enum", field: "/1", pinned: "deny", upstream: undefined }]);
  });

  it("reports a changed nested field by its JSON pointer", () => {
    const diffs = diffSurfaces(
      asPinned(asPinned(withSurface("snapshot.schema.json", { properties: { tool_call: { type: "object" } } }))),
      asUpstream(withSurface("snapshot.schema.json", { properties: { tool_call: { type: "string" } } })),
    );

    expect(diffs).toEqual([
      { surface: "snapshot.schema.json", field: "/properties/tool_call/type", pinned: "object", upstream: "string" },
    ]);
  });

  it("reports an added optional field rather than failing on it", () => {
    const diffs = diffSurfaces(
      asPinned(withSurface("manifest.schema.json", { properties: {} })),
      asUpstream(withSurface("manifest.schema.json", { properties: { retries: { type: "number" } } })),
    );

    expect(diffs).toEqual([
      { surface: "manifest.schema.json", field: "/properties/retries", pinned: undefined, upstream: { type: "number" } },
    ]);
  });

  it("walks every surface, not only the first that moved", () => {
    const upstream = { ...base(), "verdict enum": ["allow"], "reserved-reasons.json": { changed: true } } as SurfaceSnapshot;
    const surfaces = diffSurfaces(asPinned(base()), asUpstream(upstream)).map((d) => d.surface);

    expect(new Set(surfaces)).toEqual(new Set(["verdict enum", "reserved-reasons.json"]));
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/diff-surfaces.test.ts`
Expected: FAIL — `Cannot find module '../src/diff-surfaces.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/diff-surfaces.ts
import { SURFACE_NAMES, type PinnedSurfaces, type SurfaceName, type UpstreamSurfaces } from "./surfaces.ts";

/**
 * One field that moved, in AGT's own terms: which surface, which field, and
 * what it was against what it is now. `undefined` on either side means the
 * field is absent there, which is how an added or removed field reads.
 */
export type SurfaceDiff = {
  readonly surface: SurfaceName;
  readonly field: string;
  readonly pinned: unknown;
  readonly upstream: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(surface: SurfaceName, pointer: string, pinned: unknown, upstream: unknown, out: SurfaceDiff[]): void {
  if (Array.isArray(pinned) && Array.isArray(upstream)) {
    const longest = Math.max(pinned.length, upstream.length);
    for (let i = 0; i < longest; i += 1) {
      walk(surface, `${pointer}/${i}`, pinned[i], upstream[i], out);
    }
    return;
  }
  if (isObject(pinned) && isObject(upstream)) {
    for (const key of new Set([...Object.keys(pinned), ...Object.keys(upstream)])) {
      walk(surface, `${pointer}/${key}`, pinned[key], upstream[key], out);
    }
    return;
  }
  if (JSON.stringify(pinned) !== JSON.stringify(upstream)) {
    out.push({ surface, field: pointer, pinned, upstream });
  }
}

/**
 * Diffs the eight surfaces read at the pinned ref against the eight read at
 * `main`, and answers one row per field that moved.
 *
 * Told both snapshots and reads neither store. It does not open `agt.lock`,
 * does not resolve a git ref, and does not reach the network -- fetching is
 * the fetcher's job, and reading the pinned side belongs to whatever
 * assembles the run. The parameter order is the diff's own direction:
 * pinned first, because that is the side this repository is built against.
 *
 * Reports rather than judges. An added optional field is a row like any
 * other, so a non-breaking upstream release produces output and no failure.
 */
export function diffSurfaces(pinned: PinnedSurfaces, upstream: UpstreamSurfaces): SurfaceDiff[] {
  const out: SurfaceDiff[] = [];
  for (const surface of SURFACE_NAMES) {
    walk(surface, "", pinned[surface], upstream[surface], out);
  }
  return out;
}
```

Add to `packages/conformance/src/index.ts`:

```ts
export { diffSurfaces, type SurfaceDiff } from "./diff-surfaces.ts";
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/diff-surfaces.test.ts && bun run typecheck`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/diff-surfaces.ts packages/conformance/test/diff-surfaces.test.ts packages/conformance/src/index.ts
git commit -m "Diff two surface snapshots, and name every field that moved

Slice: #9
Affordances: N46"
```

---

## Task 4: `renderUpstreamDiff()` · slice #9 · N53, U31

**Files:**
- Create: `packages/conformance/src/render-upstream-diff.ts`
- Create: `packages/conformance/test/render-upstream-diff.test.ts`
- Modify: `packages/conformance/src/index.ts`

**Interfaces:**
- Consumes: `type SurfaceDiff` from `./diff-surfaces.ts`; `type RenderOptions` from `./render.ts`.
- Produces: `renderUpstreamDiff(diffs: readonly SurfaceDiff[], options?: RenderOptions): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/render-upstream-diff.test.ts
import { describe, expect, it } from "bun:test";
import { renderUpstreamDiff } from "../src/render-upstream-diff.ts";
import type { SurfaceDiff } from "../src/diff-surfaces.ts";

const diff = (over: Partial<SurfaceDiff> = {}): SurfaceDiff => ({
  surface: "verdict enum",
  field: "/2",
  pinned: undefined,
  upstream: "quarantine",
  ...over,
});

describe("renderUpstreamDiff -- what moved, in AGT's own terms", () => {
  it("says the contract has not moved when nothing did", () => {
    const out = renderUpstreamDiff([]);

    expect(out).toContain("no watched surface moved");
    expect(out).not.toContain("|");
  });

  it("names the surface, the field, and both sides", () => {
    const out = renderUpstreamDiff([diff()]);

    expect(out).toContain("verdict enum");
    expect(out).toContain("/2");
    expect(out).toContain("quarantine");
  });

  it("renders an absent side as absent rather than as empty", () => {
    expect(renderUpstreamDiff([diff()])).toContain("(absent)");
  });

  it("groups rows under the surface they belong to, each surface once", () => {
    const out = renderUpstreamDiff([diff(), diff({ field: "/3", upstream: "escalate_hard" })]);

    expect(out.match(/verdict enum/g)).toHaveLength(1);
  });

  it("counts what it found, so a reader can tell one moved field from twenty", () => {
    expect(renderUpstreamDiff([diff(), diff({ field: "/3" })])).toContain("2 fields moved");
  });

  it("is a surface diff and never a coverage cell -- it names no intervention point and no verdict column", () => {
    const out = renderUpstreamDiff([diff()]);

    expect(out).not.toContain("pre_tool_call");
    expect(out).not.toContain("expressed");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/render-upstream-diff.test.ts`
Expected: FAIL — `Cannot find module '../src/render-upstream-diff.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/render-upstream-diff.ts
import type { SurfaceDiff } from "./diff-surfaces.ts";
import type { RenderOptions } from "./render.ts";

function show(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/**
 * Renders what moved between the pinned ref and `main`, grouped by surface.
 *
 * A surface diff is not a coverage cell. A cell pairs an intervention point
 * with an AGT verdict and says whether ACS can express it; a row here names
 * a surface, a field, and what that field was against what it is now. They
 * are different claims, so they are rendered by different functions and land
 * in different places -- publishing an upstream diff as a column of the
 * coverage matrix would make the matrix answer "what did the harness notice"
 * under the name of "does ACS express AGT".
 */
export function renderUpstreamDiff(diffs: readonly SurfaceDiff[], options: RenderOptions = {}): string {
  void options;
  if (diffs.length === 0) {
    return "Upstream contract watch: no watched surface moved between the pinned ref and main.";
  }

  const bySurface = new Map<string, SurfaceDiff[]>();
  for (const diff of diffs) {
    const rows = bySurface.get(diff.surface) ?? [];
    rows.push(diff);
    bySurface.set(diff.surface, rows);
  }

  const lines: string[] = [
    `Upstream contract watch: ${diffs.length} fields moved between the pinned ref and main.`,
    "",
  ];
  for (const [surface, rows] of bySurface) {
    lines.push(`${surface}`);
    lines.push("| field | pinned | main |");
    lines.push("|---|---|---|");
    for (const row of rows) {
      lines.push(`| \`${row.field}\` | ${show(row.pinned)} | ${show(row.upstream)} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
```

Add to `packages/conformance/src/index.ts`:

```ts
export { renderUpstreamDiff } from "./render-upstream-diff.ts";
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/render-upstream-diff.test.ts && bun run typecheck`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/render-upstream-diff.ts packages/conformance/test/render-upstream-diff.test.ts packages/conformance/src/index.ts
git commit -m "Render a surface diff as a surface diff, never as a coverage cell

Slice: #9
Affordances: N53, U31"
```

---

## Task 5: The runner, the script, and the schedule · slice #9 · N45, N46, N53, S11

**Files:**
- Create: `packages/conformance/src/upstream-watch.ts`
- Create: `packages/conformance/test/upstream-watch.test.ts`
- Create: `scripts/run-upstream-watch.sh`
- Create: `.github/workflows/upstream-watch.yml`
- Modify: `package.json` (add `watch:upstream` script)

**Interfaces:**
- Consumes: `fetchUpstreamSurfaces`, `UPSTREAM_AGT_CLONE_ENV`, `readSurfaces`, `asPinned`, `diffSurfaces`, `renderUpstreamDiff`.
- Produces: `PINNED_AGT_CLONE_ENV` reuse, `runUpstreamWatch(env?): { ran: boolean; output: string; diffs: SurfaceDiff[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/upstream-watch.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUpstreamWatch } from "../src/upstream-watch.ts";
import { UPSTREAM_AGT_CLONE_ENV } from "../src/fetch-upstream.ts";
import { PINNED_AGT_CLONE_ENV } from "../src/policy-input-schema.ts";

function clone(verdicts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write("policy-engine/spec/schema/manifest.schema.json", JSON.stringify({ properties: { intervention_points: { propertyNames: { enum: ["input"] } } } }));
  write("policy-engine/spec/schema/wire/policy-input.schema.json", "{}");
  write("policy-engine/spec/schema/wire/verdict.schema.json", JSON.stringify({ properties: { decision: { enum: verdicts } } }));
  write("policy-engine/spec/schema/wire/snapshot.schema.json", "{}");
  write("policy-engine/spec/reserved-reasons.json", "{}");
  write("policy-engine/policy/lib/agt_default.rego", "a := cfg.patterns\n");
  return dir;
}

describe("runUpstreamWatch -- the pinned side is read here, not inside the differ", () => {
  it("self-skips when either clone is missing", () => {
    expect(runUpstreamWatch({}).ran).toBe(false);
    expect(runUpstreamWatch({ [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) }).ran).toBe(false);
  });

  it("reports a clean run when both sides agree", () => {
    const env = { [PINNED_AGT_CLONE_ENV]: clone(["allow"]), [UPSTREAM_AGT_CLONE_ENV]: clone(["allow"]) };
    const run = runUpstreamWatch(env);

    expect(run.ran).toBe(true);
    expect(run.diffs).toEqual([]);
    expect(run.output).toContain("no watched surface moved");
  });

  it("names a changed enum value, which is the demo", () => {
    const env = {
      [PINNED_AGT_CLONE_ENV]: clone(["allow", "deny"]),
      [UPSTREAM_AGT_CLONE_ENV]: clone(["allow", "quarantine"]),
    };
    const run = runUpstreamWatch(env);

    expect(run.diffs).toEqual([
      { surface: "verdict enum", field: "/1", pinned: "deny", upstream: "quarantine" },
    ]);
    expect(run.output).toContain("quarantine");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/upstream-watch.test.ts`
Expected: FAIL — `Cannot find module '../src/upstream-watch.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/upstream-watch.ts
import { diffSurfaces, type SurfaceDiff } from "./diff-surfaces.ts";
import { fetchUpstreamSurfaces, UPSTREAM_AGT_CLONE_ENV } from "./fetch-upstream.ts";
import { PINNED_AGT_CLONE_ENV } from "./policy-input-schema.ts";
import { renderUpstreamDiff } from "./render-upstream-diff.ts";
import { asPinned, readSurfaces } from "./surfaces.ts";

export type UpstreamWatchRun = {
  readonly ran: boolean;
  readonly output: string;
  readonly diffs: readonly SurfaceDiff[];
};

/**
 * Assembles the run: reads the pinned side, fetches the upstream side, hands
 * both to the differ, and renders what came back.
 *
 * The pinned side is read HERE rather than inside the differ, so the differ
 * has no store to reach for and no ref to resolve -- it is told two snapshots
 * and compares them. Both clones are made by the shell script, which is the
 * only place in this slice that touches the network.
 *
 * Reports and never refuses: the answer carries what moved, and no caller
 * turns it into an exit code. A moved surface is something a human reads,
 * not something that fails a build.
 */
export function runUpstreamWatch(env: Record<string, string | undefined> = process.env): UpstreamWatchRun {
  const pinnedClone = env[PINNED_AGT_CLONE_ENV];
  const upstream = fetchUpstreamSurfaces(env);
  if (pinnedClone === undefined || pinnedClone.length === 0 || upstream === undefined) {
    return {
      ran: false,
      diffs: [],
      output:
        `Upstream contract watch: skipped. Both ${PINNED_AGT_CLONE_ENV} and ${UPSTREAM_AGT_CLONE_ENV} must name ` +
        `an AGT clone; run it through scripts/run-upstream-watch.sh, which makes both.`,
    };
  }

  const pinned = asPinned(readSurfaces(pinnedClone));
  const diffs = diffSurfaces(pinned, upstream);
  return { ran: true, diffs, output: renderUpstreamDiff(diffs) };
}

if (import.meta.main) {
  const run = runUpstreamWatch();
  console.log(run.output);
}
```

`scripts/run-upstream-watch.sh` — mirrors `scripts/run-conformance.sh`, with two clones instead of one:

```bash
#!/usr/bin/env bash
# Runs the upstream contract watch for real: shallow-clones AGT twice --
# once at agt.lock's pinned ref, once at main -- and hands both paths to the
# runner by environment variable.
#
# Two clones, two variables, and they are never the same name: the pinned
# side is PINNED_AGT_CLONE (the variable the conformance run already uses)
# and the upstream side is UPSTREAM_AGT_CLONE. A run that read one side
# twice would report a clean diff against a contract that moved.
#
# `bun test` sets neither, so the watch self-skips there and the rest of the
# suite stays covered whether or not a network is available.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

lock_file="agt.lock"
if [ ! -f "$lock_file" ]; then
  echo "run-upstream-watch: missing $lock_file" >&2
  exit 1
fi

agt_repo="$(jq -r '.agt_repo' "$lock_file")"
agt_ref="$(jq -r '.agt_ref' "$lock_file")"

if [ -z "$agt_repo" ] || [ -z "$agt_ref" ]; then
  echo "run-upstream-watch: agt.lock is missing agt_repo/agt_ref" >&2
  exit 1
fi

if ! command -v trash >/dev/null 2>&1; then
  echo "run-upstream-watch: 'trash' is required for scratch-dir cleanup (rm -rf is not permitted in this repo) — install it and re-run" >&2
  exit 1
fi

pinned_dir="$(mktemp -d "${TMPDIR:-/tmp}/upstream-watch-pinned.XXXXXX")"
upstream_dir="$(mktemp -d "${TMPDIR:-/tmp}/upstream-watch-main.XXXXXX")"
cleanup() {
  trash "$pinned_dir"
  trash "$upstream_dir"
}
trap cleanup EXIT

# No identifying information on outbound git traffic: no credential helper,
# no terminal credential prompt, and git's default HTTP User-Agent carries
# no contact field.
export GIT_TERMINAL_PROMPT=0

fetch_into() {
  local dir="$1" ref="$2"
  git -c credential.helper= -c credential.useHttpPath=false init --quiet "$dir"
  git -C "$dir" -c credential.helper= remote add origin "$agt_repo"
  git -C "$dir" -c credential.helper= fetch --quiet --depth 1 origin "$ref"
  git -C "$dir" -c credential.helper= checkout --quiet FETCH_HEAD
}

fetch_into "$pinned_dir" "$agt_ref"
fetch_into "$upstream_dir" "main"

PINNED_AGT_CLONE="$pinned_dir" UPSTREAM_AGT_CLONE="$upstream_dir" \
  bun run packages/conformance/src/upstream-watch.ts
```

`.github/workflows/upstream-watch.yml`:

```yaml
name: upstream contract watch

# Weekly, and on demand. The point is that a moved AGT surface shows up as
# published output rather than rotting silently between releases.
on:
  schedule:
    - cron: "17 6 * * 1"
  workflow_dispatch:

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install trash
        run: sudo apt-get update && sudo apt-get install -y trash-cli
      - run: bun install --frozen-lockfile
      - name: Watch AGT's declared surfaces
        run: bun run watch:upstream | tee "$GITHUB_STEP_SUMMARY"
```

Add to `package.json` scripts: `"watch:upstream": "bash scripts/run-upstream-watch.sh"`.

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/upstream-watch.test.ts && bun run typecheck && bash -n scripts/run-upstream-watch.sh`
Expected: PASS, 3 tests; typecheck clean; the script parses.

Then run it for real once and keep the output for Task 8's runbook:

Run: `chmod +x scripts/run-upstream-watch.sh && bun run watch:upstream`
Expected: exit 0, and either "no watched surface moved" or a table of rows. **Whatever it prints is what Task 8 captures — it is never hand-edited.**

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/upstream-watch.ts packages/conformance/test/upstream-watch.test.ts scripts/run-upstream-watch.sh .github/workflows/upstream-watch.yml package.json
git commit -m "Run the watch on a schedule, with a clone on each side

Slice: #9
Affordances: N45, N46, N53, S11"
```

---

## Task 6: Re-validate against `main`'s schema, not just diff it · slice #9 · R2.5

A surface diff reports that a field moved. It never re-measures whether anything still holds, and R2.5 asks for the second thing: *a moved contract surface shows up as a failing case rather than silent rot*. This task is the behavioural half.

**What it can reach, and what it cannot.** V7's schema leg already validates the policy input the Guardian would send against AGT's own `policy-input.schema.json` at the pinned ref. Pointing that same validation at **`main`'s** copy answers a real compatibility question — *would the document we send still be accepted by the contract as it stands today?* — rather than a textual one. Re-running the *whole* harness against `main` is out of reach here: the coverage matrix evaluates through the AGT **Node SDK**, and the SDK at `main` is not published to npm, so it would have to be built from source. That is its own decision and is recorded under "Not in this plan".

**Files:**
- Modify: `packages/conformance/src/policy-input-schema.ts` (take the clone dir as a parameter)
- Modify: `packages/conformance/src/upstream-watch.ts`
- Create: `packages/conformance/test/upstream-schema-check.test.ts`

**Interfaces:**
- Consumes: `checkPolicyInputSchema` from `./policy-input-schema.ts`, `UPSTREAM_AGT_CLONE_ENV`.
- Produces: `checkPolicyInputSchemaAt(bridge, cloneDir): Promise<SchemaLegResult>`; `checkPolicyInputSchema` keeps its signature and delegates, so V7's conformance run is untouched.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/upstream-schema-check.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkPolicyInputSchemaAt } from "../src/policy-input-schema.ts";
import { createBridge } from "agt-bridge";

const SCHEMA_REL = "policy-engine/spec/schema/wire/policy-input.schema.json";

function cloneWithSchema(schema: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "upstream-schema-"));
  const full = join(dir, SCHEMA_REL);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(schema));
  return dir;
}

describe("checkPolicyInputSchemaAt -- the document we send, against the schema at a given clone", () => {
  it("validates against a permissive schema", async () => {
    const bridge = createBridge("policy/manifest.yaml");
    const result = await checkPolicyInputSchemaAt(bridge, cloneWithSchema({ type: "object" }));

    expect(result.ran).toBe(true);
  });

  it("reports a FAILURE, not a skip, when the schema at that clone rejects what we send", async () => {
    const bridge = createBridge("policy/manifest.yaml");
    const tightened = { type: "object", required: ["a_field_agt_does_not_send_today"] };

    await expect(checkPolicyInputSchemaAt(bridge, cloneWithSchema(tightened))).rejects.toThrow(
      /policy-input\.schema\.json/,
    );
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/upstream-schema-check.test.ts`
Expected: FAIL — `checkPolicyInputSchemaAt` is not exported.

- [ ] **Step 3: Minimal implementation**

In `policy-input-schema.ts`, lift the clone directory out of `process.env` and into a parameter:

```ts
/** Validates the policy input the Guardian would send against the
 * `policy-input.schema.json` in the clone it is given. The clone is a
 * parameter rather than an environment read, because this repository now
 * asks the question against two refs: the pinned one, and `main`. */
export async function checkPolicyInputSchemaAt(
  bridge: PolicyBridge,
  cloneDir: string,
): Promise<SchemaLegResult> {
  // the existing body, with `pinnedClone` replaced by `cloneDir`
}

/** The pinned-ref question, which is the one the conformance run asks. */
export async function checkPolicyInputSchema(bridge: PolicyBridge): Promise<SchemaLegResult> {
  const pinnedClone = process.env[PINNED_AGT_CLONE_ENV];
  if (pinnedClone === undefined || pinnedClone.length === 0) {
    return { ran: false, reason: `${PINNED_AGT_CLONE_ENV} is not set -- run \`bun run conformance\`` };
  }
  return checkPolicyInputSchemaAt(bridge, pinnedClone);
}
```

Then in `runUpstreamWatch`, after the surface diff, run the same validation against the **upstream** clone and carry its answer into the output — a pass is "the document we send still validates against main", a throw is the failing case R2.5 asks for.

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/upstream-schema-check.test.ts && bun test && bun run typecheck && bun run conformance`
Expected: both new tests pass; whole suite green; typecheck clean; **`bun run conformance` exits 0 with output byte-identical to before** — V7's run must be unchanged by this refactor.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/policy-input-schema.ts packages/conformance/src/upstream-watch.ts packages/conformance/test/upstream-schema-check.test.ts
git commit -m "Ask the pinned question of main too, so rot fails rather than diffs

Slice: #9"
```

---

## Task 7: A hookmap's `tools` against the manifest registry · slice #9 · N46 (widened subject)

Reporting only. Global Constraint 10 governs: this never refuses a load, because an over-refusal at load makes OpenCode run an entire session with no plugin registered — trading a silently-skipped gate for a silently-ungoverned one.

**Files:**
- Create: `packages/conformance/src/tools-registry.ts`
- Create: `packages/conformance/test/tools-registry.test.ts`
- Modify: `packages/conformance/src/upstream-watch.ts` (append the section to the run's output)
- Modify: `packages/conformance/src/index.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–5 except the run's output assembly.
- Produces: `type UnregisteredTool = { hookmap: string; hook: string; tool: string }`, `checkToolsAgainstRegistry(hookmaps: readonly {path: string; hooks: Record<string, {tools?: unknown}>}[], registry: readonly string[]): UnregisteredTool[]`, `renderToolsRegistryReport(findings: readonly UnregisteredTool[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/conformance/test/tools-registry.test.ts
import { describe, expect, it } from "bun:test";
import { checkToolsAgainstRegistry, renderToolsRegistryReport } from "../src/tools-registry.ts";

const hookmap = (path: string, tools: unknown) => ({ path, hooks: { "tool.execute.before": { tools } } });

describe("checkToolsAgainstRegistry -- a tools entry the manifest registers nothing for", () => {
  it("reports a tool name no registry entry matches", () => {
    const found = checkToolsAgainstRegistry([hookmap("opencode.hookmap.yaml", ["bashh"])], ["bash", "Bash"]);

    expect(found).toEqual([{ hookmap: "opencode.hookmap.yaml", hook: "tool.execute.before", tool: "bashh" }]);
  });

  it("says nothing about a hook that declares no tools at all", () => {
    expect(checkToolsAgainstRegistry([hookmap("claude-code.hookmap.yaml", undefined)], ["Bash"])).toEqual([]);
  });

  it("compares case-sensitively, exactly as governsTool does", () => {
    expect(checkToolsAgainstRegistry([hookmap("h.yaml", ["BASH"])], ["bash"])).toHaveLength(1);
  });

  it("does NOT report a name the manifest registers for a different host -- the case this check cannot close", () => {
    // policy/manifest.yaml registers run_shell, Bash and bash: one per host,
    // deliberately. So OpenCode's `tools: [bash]` recased to `[Bash]` is a
    // gate that governs nothing, and this check passes it clean.
    expect(checkToolsAgainstRegistry([hookmap("opencode.hookmap.yaml", ["Bash"])], ["run_shell", "Bash", "bash"])).toEqual([]);
  });

  it("renders nothing found as a clean line, and findings as rows", () => {
    expect(renderToolsRegistryReport([])).toContain("every declared tool is registered");
    expect(renderToolsRegistryReport([{ hookmap: "h.yaml", hook: "g", tool: "bashh" }])).toContain("bashh");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/conformance/test/tools-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/tools-registry.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// packages/conformance/src/tools-registry.ts

/** A hookmap gate naming a tool the policy manifest registers nothing for. */
export type UnregisteredTool = {
  readonly hookmap: string;
  readonly hook: string;
  readonly tool: string;
};

type HookmapLike = { readonly path: string; readonly hooks: Record<string, { tools?: unknown }> };

/**
 * Reports every `tools` entry in a hookmap that the policy manifest
 * registers no tool for. A gate scoped to a name nothing dispatches governs
 * nothing, and today nothing anywhere says so.
 *
 * Case-sensitive, because that is how the scoping comparison itself works:
 * a check that matched case-insensitively would report clean for exactly the
 * mismatch that makes a gate silent.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed. The manifest
 * registers every host's spelling -- `run_shell`, `Bash` and `bash` -- because
 * one manifest serves both hosts. So a gate recased from its own host's name
 * to the other host's name is still a registered name, and this check passes
 * it. Catching that needs a per-host declaration of the names that host
 * actually dispatches, which no document in this repository carries.
 */
export function checkToolsAgainstRegistry(
  hookmaps: readonly HookmapLike[],
  registry: readonly string[],
): UnregisteredTool[] {
  const registered = new Set(registry);
  const found: UnregisteredTool[] = [];
  for (const hookmap of hookmaps) {
    for (const [hook, entry] of Object.entries(hookmap.hooks ?? {})) {
      const tools = entry?.tools;
      if (!Array.isArray(tools)) {
        continue;
      }
      for (const tool of tools) {
        if (typeof tool === "string" && !registered.has(tool)) {
          found.push({ hookmap: hookmap.path, hook, tool });
        }
      }
    }
  }
  return found;
}

export function renderToolsRegistryReport(findings: readonly UnregisteredTool[]): string {
  if (findings.length === 0) {
    return "Hookmap tools against the policy manifest: every declared tool is registered.";
  }
  const lines = [
    `Hookmap tools against the policy manifest: ${findings.length} declared tool(s) the manifest registers nothing for.`,
    "",
    "| hookmap | hook | tool |",
    "|---|---|---|",
  ];
  for (const f of findings) {
    lines.push(`| ${f.hookmap} | ${f.hook} | \`${f.tool}\` |`);
  }
  return lines.join("\n");
}
```

Wire it into `runUpstreamWatch`'s output by appending `renderToolsRegistryReport(...)` beneath the surface diff, reading the two shipped hookmaps and `policy/manifest.yaml`'s `tools` keys with `Bun.YAML.parse`.

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/conformance/test/tools-registry.test.ts && bun run typecheck && bun test`
Expected: PASS, 5 new tests; typecheck clean; the whole suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src/tools-registry.ts packages/conformance/test/tools-registry.test.ts packages/conformance/src/upstream-watch.ts packages/conformance/src/index.ts
git commit -m "Report a hookmap tool the manifest registers nothing for

Slice: #9
Affordances: N46"
```

---

## Task 8: Declaration, runbook, and the slices-doc amendment · slice #9

**Files:**
- Modify: `slices/v8/README.md` (replace `Implementation goes here.`)
- Create: `docs/demos/v8-runbook.md`
- Modify: `docs/shaping/acs-reference-impl-slices.md` (§V8 amendments — see below)
- Modify: `README.md` (a `**Delivered in V8**` row)

- [ ] **Step 1: Capture the evidence**

Run `bun run watch:upstream` and paste its output into `docs/demos/v8-runbook.md` verbatim. Re-run it a second time and confirm the capture is byte-identical. **Never hand-edit a captured block.** If it will not run (no network), say so in the runbook and capture the skip message instead.

- [ ] **Step 2: Write the declaration**

Replace `Implementation goes here.` in `slices/v8/README.md` with what this slice measured: the eight surfaces and where each was found, the two-clone arrangement, what the watch reports, and — stated plainly — the two things it does not do: it never fails a build, and its hookmap-tools check does not catch a gate recased to another host's registered name.

- [ ] **Step 3: Check the slices doc still says what this slice did**

**The amendments are already committed with this plan — do not redo them.** Planning landed five, and they are the doc of record now:

1. The eight surfaces with their measured locations, and the note that eight surfaces are not eight files.
2. C1 — the wire schemas exist in two copies, identical at the pinned ref; the watch reads the `spec/` copy, and a divergence between the copies is a known blind spot.
3. C2 against the `tools` residual — the registry cross-check cannot close the recasing case, and the open question is inverted.
4. Both remaining residuals explicitly marked **not V8's**, with reasons.
5. The confirm/does-not-confirm boundary, and the R2.5 split — mirrored into the shaping doc's Fit Check row for R2.5/R2.6.

Your job here is only to reconcile them against what was actually built. If any task departed from the plan, the departure is an amendment and belongs in the same commit as the code — not in a follow-up.

- [ ] **Step 4: Verify**

Run: `bun test && bun run typecheck && bun run verify:pin && bun run conformance`
Expected: suite green, typecheck clean, pin 5/5, conformance exits 0 — this slice changes no runtime path, so V7's numbers must be unchanged.

- [ ] **Step 5: Commit**

```bash
git add slices/v8/README.md docs/demos/v8-runbook.md docs/shaping/acs-reference-impl-slices.md README.md
git commit -m "Declare what this slice watches, and what it does not close

Slice: #9"
```

Then retitle the tracker issue, which still carries the noun commitment 1 retires:

```bash
gh issue edit 9 --title "V8: Upstream contract watch"
```

---

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 7 — hookmap `tools` vs the manifest registry | V5 found it; pre-existing before V5 | §V8 names V8 as its destination: V8 is the slice whose mechanism already fits — a scheduled harness that diffs two declared surfaces and reports the field that moved. It widens V8's subject from upstream AGT surfaces to a deployment-side pair, which Task 7 records in the slices doc. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| Measured locations for the eight surfaces | "The intervention-point enum" is not a file; a fetcher written from the slice's prose alone cannot express surfaces 5, 6 or 8 | Task 8, amendment 1 |
| C1 — two copies of the wire schemas | The fetcher has to name one path; which one is a decision, and the other copy is a known blind spot | Task 8, amendment 2 |
| C2 — the registry check's real reach | §V8 currently presents the registry cross-check as the candidate close for the recasing failure, and the measurement refutes that | Task 8, amendment 3 |
| Destinations for the two residuals not in scope | The skill forbids dropping a filed item silently; each needs a destination or an explicit "not this slice" | Task 8, amendment 4 |

## Not in this plan

| Item | Why | Destination |
|---|---|---|
| Six posture-seam hookmap faults decidable without a payload | Not an upstream-contract subject. The repair is one sweep of `buildPayload`/`exitStatusOf` moving each check to `loadHookmap`, where it exits 2 | Recorded in §V8 by Task 8 as unassigned, with the one-sentence rule that governs it |
| Inspector tail tests gating on wall-clock sleeps | A change to the Inspector's own rail, not to anything this slice builds or that upstream AGT moves | Recorded in §V8 by Task 8 as the Inspector's |
| Closing the recased-`tools` failure | Needs a per-host declaration of dispatched tool names, which no document here carries. Building one is its own decision, not a drive-by inside a watch | Recorded in §V8 by Task 8 as the residual's restated open question |
| Running V7's **whole** coverage matrix against `main` | The matrix evaluates through the AGT Node SDK, and the SDK at `main` is not published to npm — it would have to be built from source in CI, on every scheduled run, with no guarantee it builds. Task 6 takes the reachable half (the schema question, which reads a file) and this plan does not pretend to the rest | A slice of its own. Task 8 records it in §V8 as the gap between what R2.5 asks and what a surface diff plus a schema re-validation can answer |

## What this slice does and does not confirm

Stated here because the demo sentence invites the stronger reading, and the stronger reading is false.

**It cannot break the running implementation, and V8 is not why.** `agent-control-specification` is pinned at exactly `0.3.1-beta.0` with no caret, `agt.lock` pins ref `81955d48`, and `verify:pin` proves `policy/lib` is byte-identical to that ref. Nothing on AGT's `main` reaches this repository until a human bumps the pin. Forward compatibility is bought by pinning, not by watching.

**What upstream movement does break is the truth of the published claim.** V7's matrix says ACS v0.1.0 expresses AGT at 40 coordinates, measured against a ref that quietly becomes historical. A confidently wrong table is the failure mode this slice exists for.

**So V8 answers "has the contract moved, and where", plus "would the document we send still be accepted".** It does not answer "does the implementation still behave correctly against `main`" — that needs the matrix re-measured through `main`'s SDK, which is the row above. The slice README and the runbook say so in those words, so no reader takes the watch for a compatibility guarantee.
