# V6: Session state and provenance carriage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Guardian a per-session hash-chained `SessionContext`, an immutable per-session `Intent`, and a provenance record that carries AGT's IFC labels — so AGT emits `result_labels` at one step and reads them back as `input.ifc.source_labels` at the next, with the Inspector rendering the chain.

**Architecture:** Three stores land Guardian-side (R6.2, A3): S3 `sessionContext` (hash-chained per `session_id`), S4 `intent` (immutable baseline), S5 `provenance` (`origin`/`derived_from` plus an `IfcLabels` field). `evaluateStep` rewires from V1's direct N21 → N23 to **N21 → N22 → N23**: validate, append the arriving step to the chain, then assemble a snapshot that now carries session state. After the verdict, N25 `persistIfcLabels()` writes AGT's `result_labels` into S5 so the next step's `supplySourceLabels()` finds them. The label round trip is driven **entirely through `data.agt.defaults.config`** — the stock `agt.defaults` bundle already has the gate — so no Rego is authored and `policy/lib/*.rego` stays byte-identical. S3 is also appended to a JSONL file the Inspector tails, importing nothing from the Guardian (R5.1).

**Tech Stack:** TypeScript on Bun; `bun test`; `node:crypto` for SHA-256 chaining; the pinned `agent-control-specification` SDK via `packages/agt-bridge`; no new dependencies.

## Verified ground

Established by reading the tree before this plan was written. Each is a fact a task depends on; re-verify before contradicting one.

1. **The stock IFC gate is config-driven and point-agnostic.** `policy/lib/agt_default.rego`:
   ```rego
   ifc_verdict := value if {
       clearance := cfg.ifc.sink_clearance
       is_string(clearance)
       labels := ifc_labels
       value := ifc.verdict_propagating(clearance, labels)
   }
   ifc_labels := labels if {
       input.intervention_point == "output"
       labels := ifc.result_labels
   } else := labels if {
       labels := ifc.source_labels
   }
   ```
   At `pre_tool_call` and `post_tool_call` — this Guardian's two points — the `else` branch runs, so the gate reads `source_labels` at both. It is dormant until `cfg.ifc.sink_clearance` is a string. Turning it on is a `data.json` edit, which is what R2.1 permits.
2. **The path AGT reads is `input.snapshot.input.ifc.source_labels`,** and the obvious shorter one is wrong. `policy/lib/agt_ifc.rego` reads exactly that, and `policy/lib/agt_ifc_test.rego` pins the trap: labels at `input.snapshot.ifc.source_labels` resolve to `[]`. So the snapshot member is `input: { ifc: { source_labels } }`, nested, not `ifc` at the snapshot root.
3. **`verdict_propagating` emits the labels — and denies a flow that has none.** On allowed flow it returns `{"decision": "allow", "result_labels": propagated_labels(labels)}`, where `propagated_labels(labels)` is `[max_sensitivity(labels)]` when non-empty and `[]` otherwise. `AgtVerdict.result_labels?: string[]` already exists on the bridge type (`packages/agt-bridge/src/index.ts`).

   ⚠️ **Corrected during execution, and the correction is the point.** This entry originally stopped at `propagated_labels`, which is a red herring: the branch it describes is unreachable with zero labels. `flow_allowed` (`policy/lib/agt_ifc.rego:59-65`) requires `count(labels) > 0` before anything else, so a snapshot carrying **no** labels is not an allowed flow — `verdict_propagating` takes its first branch and returns `violation(...)`, a `deny` with reason `ifc_clearance_violation`. **AGT's stock IFC gate is fail-closed on absent labels, not permissive.** Turning it on with nothing seeding a first label denied every governed step: the suite went from 775 pass / 1 skip / 0 fail to 744 pass / 35 fail across nine files. Task 4 owns the seed that resolves it, and §"The one gap" below is what makes the seed necessary rather than optional.
4. **`data.json` is the sanctioned config knob.** `test/pin.test.ts` byte-checks every `.rego` against the upstream bundle and asserts the bundle "adds nothing except data.json". Editing `policy/lib/data.json` is inside R2.1/R2.2/R2.3; editing any `.rego` is not.
5. **`session_id` is already on every envelope** (`packages/guardian/src/validate-envelope.ts:46`), so no wire change is needed to key the stores.
6. **The assemblers are envelope-only today** and say so: `assemble-snapshot.ts`'s header states "no session state, no chain hash, no prior decisions, no intent. Those arrive in V6 via S3/S4/S5." Both are exported from `packages/guardian/src/index.ts`.
7. **The Inspector imports nothing from the Guardian** (R5.1) — it reads `.acs/envelopes.jsonl` and `.acs/audit.jsonl` as files via `tail-envelope-log.ts` / `tail-audit-log.ts`, and `test/invariants.test.ts` gates that.
8. **No CI workflows exist** (`.github/workflows/` is absent), so `verify:zero-diff` is a local gate, not a branch gate. See Global Constraint 4.

## The one gap, stated before it is discovered

**ACS v0.1.0 carries no IFC label field, so the first step's labels cannot be wire-derived.** `spec/acs/specification/v0.1.0/provenance.json` defines `provenance_id`, `origin`, `source_id`, `derived_from` — and nothing a sensitivity label could be read from. AGT propagates labels it is given; it does not originate them. So the seed for a session is **deployment-supplied**, exactly as V3's drift score is, and for the same reason.

This is not a workaround and must not be written up as one. It is the same shape as risk row 11 and D10: AGT's design explicitly delegates label persistence to the host ("The core stores and propagates nothing"), and ACS v0.1.0 has no field for the host to read one from. V6 does the delegated job; V7's matrix records the cell as **green for the Guardian, red for a wire consumer**. Task 7 files it.

**V6 does not inherit S14's `seq` duplicate.** Risk row 13 says a per-session monotonic sequence "would need the duplicate closed first" — that is conditional on V6 indexing its chain by S14's `seq`. It does not. S14 is the host-side audit log, derived by re-reading a file from a fresh subprocess per hook; S3 is Guardian-side, appended in one single-threaded `Bun.serve` process, and its order is carried by `prev_hash` rather than by a counter anyone derives. Task 1 states this in the module header.

## Global Constraints

Every task's requirements implicitly include this section.

1. **R2.1 / R2.2 / R2.3 — AGT unforked.** Zero Rego authored or edited. Every file under `policy/lib/*.rego` stays byte-identical; `bun run verify:pin` proves it. The only policy-side change V6 may make is `data.agt.defaults.config` in `policy/lib/data.json`.
2. **R5.1 — the Inspector imports nothing** from `@acs/guardian` or `@acs/host-adapter`. It reads stores as files and re-declares the entry types it needs; `test/invariants.test.ts` gates this and a roundtrip test keeps the duplicate declarations honest.
3. **R6.2 / A3 — session state is Guardian-side.** `SessionContext` and its store are declared in `packages/guardian/src/`. Nothing about them is added to `@acs/host-adapter`.
4. **`verify:zero-diff` is V5's gate, not V6's.** It freezes `packages/guardian/src/` against `slice/v4` to prove V5's "zero AGT changes" claim. V6 changes the Guardian by design, so **it is not part of V6's green bar** and must not be "fixed" by loosening its frozen set. V5's claim is still checkable as a range that ends at V5: `bash scripts/verify-zero-diff.sh slice/v4` run with `slice/v5` checked out.
5. **The five names frozen in `slices/v6/README.md` are binding**, verbatim: `SessionContext` (never shortened to `session`, never in `@acs/host-adapter`); `IfcLabels` for the label store, with ACS `Provenance` left as the spec defines it and the labels riding a named **field**; `persistIfcLabels()` ∥ `supplySourceLabels()`; `appendContextEntry()` ∥ `loadSessionContext()`; session state injected into **both** assemblers, once each, with no collapse into one function that asks which point it is on.
6. **Comments state measured facts.** No line counts, file counts, or diff stats in any comment — three went stale in three consecutive commits in a prior round. A comment describing code that no longer exists is a defect.
7. **Green bar for every task:** `bun test` (baseline **747 pass / 1 skip / 0 fail** — never fewer passing), `bun run typecheck`, `bun run verify:pin`. Use `bun`, never `npm`.
8. **Stacked PRs.** All work lands on `slice/v6` (PR #15, based on `slice/v5`). Do not rebase or force-push `slice/v7` or `slice/v8` from inside a task — the controller does that once, after the final review. Never `git add -A`; stage by explicit path. Seven pre-existing untracked files under `docs/` belong to another epic and must stay untracked.

## File Structure

| File | Responsibility |
|---|---|
| `packages/guardian/src/session-context.ts` **(create)** | S3/S4/S5 types, the hash chain, `appendContextEntry()`, `loadSessionContext()`. No I/O policy, no AGT vocabulary. |
| `packages/guardian/src/session-context-store.ts` **(create)** | The store `appendContextEntry` writes through: in-memory map plus an optional JSONL appender for the Inspector to tail. |
| `packages/guardian/src/ifc-labels.ts` **(create)** | N25 `persistIfcLabels()` and its twin `supplySourceLabels()`, over S5's `ifc_labels` field. |
| `packages/guardian/src/assemble-snapshot.ts` **(modify)** | Both assemblers gain a session-state parameter and emit `input.ifc.source_labels`. |
| `packages/guardian/src/server.ts` **(modify)** | `evaluateStep` rewired N21 → N22 → N23; persists `result_labels` after the verdict. |
| `packages/guardian/src/index.ts` **(modify)** | Export the session verbs and types. |
| `packages/guardian/src/main.ts` **(modify)** | Default S3 path, beside `DEFAULT_ENVELOPE_LOG`. |
| `policy/lib/data.json` **(modify)** | `config.ifc.sink_clearance` — the one policy-side change. |
| `packages/inspector/src/tail-session-context.ts` **(create)** | U22's reader. Re-declares its own entry type; imports nothing from the Guardian. |
| `packages/inspector/src/render.ts` **(modify)** | U22's session chain view. |
| `packages/inspector/src/main.ts` **(modify)** | `ACS_SESSION_CONTEXT_LOG` wiring. |
| `test/session-context-roundtrip.test.ts` **(create)** | Keeps the Guardian's and Inspector's duplicate entry declarations honest, as S6/S14 already do. |
| `slices/v6/README.md`, `docs/demos/v6-runbook.md`, `docs/shaping/acs-reference-impl-slices.md` **(modify/create)** | The slice's own record and the V7 cell this slice discovers. |

---

## Task 1: S3/S4/S5 — the hash chain and its store

**Files:**
- Create: `packages/guardian/src/session-context.ts`
- Create: `packages/guardian/src/session-context-store.ts`
- Test: `packages/guardian/test/session-context.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type IfcLabels = readonly string[]`
  - `type ProvenanceOrigin = "user_input" | "system" | "tool_output" | "retrieved" | "agent_generated" | "a2a_inbound" | "external"`
  - `type Provenance = { provenance_id: string; origin: ProvenanceOrigin; source_id?: string; derived_from?: readonly string[]; ifc_labels: IfcLabels }`
  - `type Intent = { readonly text: string; readonly recorded_at: string }`
  - `type SessionContextEntry = { session_id: string; seq: number; prev_hash: string; hash: string; recorded_at: string; method: string; request_id: string; tool_name: string }`
  - `type SessionContext = { session_id: string; intent: Intent | undefined; entries: readonly SessionContextEntry[]; provenance: Provenance }`
  - `interface SessionContextStore { load(sessionId: string): SessionContext; append(sessionId: string, step: SessionStep): SessionContextEntry; setIntent(sessionId: string, text: string): void; putProvenance(sessionId: string, provenance: Provenance): void }`
  - `type SessionStep = { method: string; request_id: string; tool_name: string }`
  - `function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext`
  - `function appendContextEntry(store: SessionContextStore, sessionId: string, step: SessionStep): SessionContextEntry`
  - `function createMemorySessionContextStore(options?: { now?: () => Date; appendLine?: (line: string) => void }): SessionContextStore`
  - `const GENESIS_HASH = "0".repeat(64)`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/guardian/test/session-context.test.ts
import { describe, expect, it } from "bun:test";
import {
  GENESIS_HASH,
  appendContextEntry,
  createMemorySessionContextStore,
  loadSessionContext,
} from "../src/session-context-store.ts";

const at = (iso: string) => () => new Date(iso);
const step = (n: number) => ({ method: "steps/toolCallRequest", request_id: `req-${n}`, tool_name: "Bash" });

describe("SessionContext — the hash chain (S3)", () => {
  it("starts a session at the genesis hash and seq 1", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const entry = appendContextEntry(store, "sess-a", step(1));
    expect(entry.seq).toBe(1);
    expect(entry.prev_hash).toBe(GENESIS_HASH);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chains each entry to the one before it, per session", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const first = appendContextEntry(store, "sess-a", step(1));
    const second = appendContextEntry(store, "sess-a", step(2));
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it("keeps two sessions on independent chains", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    appendContextEntry(store, "sess-a", step(1));
    const b = appendContextEntry(store, "sess-b", step(1));
    expect(b.seq).toBe(1);
    expect(b.prev_hash).toBe(GENESIS_HASH);
    expect(loadSessionContext(store, "sess-a").entries).toHaveLength(1);
  });

  it("makes the hash cover the step, so a forged entry does not verify", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const honest = appendContextEntry(store, "sess-a", step(1));
    const other = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const forged = appendContextEntry(other, "sess-a", { ...step(1), tool_name: "Write" });
    expect(forged.hash).not.toBe(honest.hash);
  });

  it("loads an unknown session as an empty chain rather than throwing", () => {
    const store = createMemorySessionContextStore();
    const context = loadSessionContext(store, "never-seen");
    expect(context.entries).toEqual([]);
    expect(context.intent).toBeUndefined();
    expect(context.provenance.ifc_labels).toEqual([]);
  });
});

describe("Intent (S4) — immutable baseline per session", () => {
  it("records the first intent it is given", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    store.setIntent("sess-a", "ship the redaction slice");
    expect(loadSessionContext(store, "sess-a").intent?.text).toBe("ship the redaction slice");
  });

  it("ignores every later intent, because the baseline is immutable", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    store.setIntent("sess-a", "the baseline");
    store.setIntent("sess-a", "something else entirely");
    expect(loadSessionContext(store, "sess-a").intent?.text).toBe("the baseline");
  });
});

describe("the JSONL appender the Inspector tails", () => {
  it("emits one line per entry, in chain order", () => {
    const lines: string[] = [];
    const store = createMemorySessionContextStore({
      now: at("2026-08-14T00:00:00.000Z"),
      appendLine: (line) => lines.push(line),
    });
    appendContextEntry(store, "sess-a", step(1));
    appendContextEntry(store, "sess-a", step(2));
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { seq: number; prev_hash: string; hash: string });
    expect(parsed.map((p) => p.seq)).toEqual([1, 2]);
    expect(parsed[1]!.prev_hash).toBe(parsed[0]!.hash);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/guardian/test/session-context.test.ts`
Expected: FAIL — cannot resolve `../src/session-context-store.ts`.

- [ ] **Step 3: Write `session-context.ts` — the types and the chaining function**

```ts
// packages/guardian/src/session-context.ts
/**
 * S3/S4/S5: the Guardian's per-session state, and the hash chain that orders
 * it.
 *
 * DECLARED HERE, NOT IN `@acs/host-adapter`, and that is R6.2/A3 rather than
 * a filing preference: the adapter is what a HOST links against, and a host
 * neither writes this chain nor is trusted to. `@acs/host-adapter` already
 * exports a `Session*` cluster -- `SessionConfig`, `SessionConfigStore`,
 * `ResolvedSessionConfig` and friends -- and every one of them is about the
 * handshake. `SessionContext` is a different object with a different owner,
 * so it is never shortened to `session`, and the two names always appear
 * written out in full (slices/v6/README.md, commitment 1).
 *
 * THIS CHAIN DOES NOT INHERIT S14's DUPLICATE-`seq` HAZARD, and the reason is
 * structural rather than careful. Risk row 13 of the slices doc says a
 * per-session monotonic sequence "would need the duplicate closed first" --
 * true of S14's, which a fresh host subprocess derives per hook by re-reading
 * the log, so two concurrent hooks can derive the same number. `seq` here is
 * assigned by the store that owns the chain, in the Guardian's single
 * `Bun.serve` process, and the ORDER is carried by `prev_hash` rather than by
 * the counter: two entries claiming the same `seq` would still have to agree
 * on a hash covering the entry before them. `seq` is an index for readers,
 * not the chain's integrity.
 */
import { createHash } from "node:crypto";

/**
 * AGT's IFC tags, as a store rather than as ACS `Provenance`.
 *
 * `Provenance` is the object `spec/acs/specification/v0.1.0/provenance.json`
 * defines -- `provenance_id`, `origin`, `source_id`, `derived_from` -- and it
 * carries no label member. V6 does not widen it into a label bag; the labels
 * ride a NAMED FIELD on the record below (slices/v6/README.md, commitment 2).
 */
export type IfcLabels = readonly string[];

/**
 * `origin`'s seven values, as `spec/acs/specification/v0.1.0/provenance.json`
 * enumerates them. A union rather than `string`, so a value outside the
 * spec's enum is a compile error here rather than a schema failure wherever
 * this record is eventually read.
 */
export type ProvenanceOrigin =
  | "user_input"
  | "system"
  | "tool_output"
  | "retrieved"
  | "agent_generated"
  | "a2a_inbound"
  | "external";

/** ACS `Provenance` as v0.1.0 defines it, plus the one field carrying AGT's labels. */
export type Provenance = {
  provenance_id: string;
  origin: ProvenanceOrigin;
  source_id?: string;
  derived_from?: readonly string[];
  /** AGT's labels. A field ON the provenance record, not a redefinition of it. */
  ifc_labels: IfcLabels;
};

/** S4: the immutable per-session baseline. First one written wins. */
export type Intent = { readonly text: string; readonly recorded_at: string };

/** What a step contributes to the chain. Deliberately not the whole envelope. */
export type SessionStep = { method: string; request_id: string; tool_name: string };

export type SessionContextEntry = {
  session_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  recorded_at: string;
  method: string;
  request_id: string;
  tool_name: string;
};

export type SessionContext = {
  session_id: string;
  intent: Intent | undefined;
  entries: readonly SessionContextEntry[];
  provenance: Provenance;
};

/** The `prev_hash` of a session's first entry. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The hash covering one entry: its predecessor, its position, and its own
 * facts. Key order is fixed by the literal below rather than by
 * `JSON.stringify` of a caller's object, so the digest cannot change because
 * a field was declared somewhere else.
 */
export function hashEntry(input: Omit<SessionContextEntry, "hash">): string {
  const canonical = JSON.stringify([
    input.prev_hash,
    input.session_id,
    input.seq,
    input.recorded_at,
    input.method,
    input.request_id,
    input.tool_name,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A session with no history yet: no intent, no entries, no labels. */
export function emptySessionContext(sessionId: string): SessionContext {
  return {
    session_id: sessionId,
    intent: undefined,
    entries: [],
    // `origin` names where data entered the system, and this record is one the
    // Guardian synthesizes to hold a session's labels -- so "system", with the
    // Guardian named in `source_id`, which is the member the spec gives for
    // "identifier within the origin".
    provenance: {
      provenance_id: `acs:session:${sessionId}`,
      origin: "system",
      source_id: "acs.guardian",
      ifc_labels: [],
    },
  };
}
```

- [ ] **Step 4: Write `session-context-store.ts` — the store and the two verbs**

```ts
// packages/guardian/src/session-context-store.ts
/**
 * The store S3/S4/S5 live in, and the two verbs that read and write it.
 *
 * `loadSessionContext` and `appendContextEntry` are a NAMED PAIR -- the
 * reader and the writer of one store (slices/v6/README.md, commitment 4).
 * The retired `appendSessionEntry()` is not revived: set beside any
 * `SessionContext` reader it yields two different nouns for one store.
 *
 * `appendLine` is how U22 sees the chain without importing this package
 * (R5.1). The Guardian hands the store a line appender; the Inspector tails
 * the file it writes and re-declares the entry type itself.
 */
import {
  GENESIS_HASH,
  emptySessionContext,
  hashEntry,
  type Provenance,
  type SessionContext,
  type SessionContextEntry,
  type SessionStep,
} from "./session-context.ts";

export {
  GENESIS_HASH,
  type IfcLabels,
  type Intent,
  type Provenance,
  type SessionContext,
  type SessionContextEntry,
  type SessionStep,
} from "./session-context.ts";

export interface SessionContextStore {
  load(sessionId: string): SessionContext;
  append(sessionId: string, step: SessionStep): SessionContextEntry;
  setIntent(sessionId: string, text: string): void;
  putProvenance(sessionId: string, provenance: Provenance): void;
}

export type CreateMemorySessionContextStoreOptions = {
  now?: () => Date;
  /** Called once per appended entry with its JSON line, no trailing newline. */
  appendLine?: (line: string) => void;
};

/**
 * The in-memory store. Named for what it is rather than as the default one,
 * the same correction V5 made to `createMemorySessionConfigStore` -- a bare
 * `createSessionContextStore` would read as the general factory and is not.
 */
export function createMemorySessionContextStore(
  options: CreateMemorySessionContextStoreOptions = {},
): SessionContextStore {
  const now = options.now ?? (() => new Date());
  const appendLine = options.appendLine;
  const sessions = new Map<string, SessionContext>();

  const ensure = (sessionId: string): SessionContext => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = emptySessionContext(sessionId);
    sessions.set(sessionId, fresh);
    return fresh;
  };

  return {
    load(sessionId) {
      return sessions.get(sessionId) ?? emptySessionContext(sessionId);
    },

    append(sessionId, step) {
      const context = ensure(sessionId);
      const previous = context.entries.at(-1);
      const withoutHash: Omit<SessionContextEntry, "hash"> = {
        session_id: sessionId,
        seq: (previous?.seq ?? 0) + 1,
        prev_hash: previous?.hash ?? GENESIS_HASH,
        recorded_at: now().toISOString(),
        method: step.method,
        request_id: step.request_id,
        tool_name: step.tool_name,
      };
      const entry: SessionContextEntry = { ...withoutHash, hash: hashEntry(withoutHash) };
      sessions.set(sessionId, { ...context, entries: [...context.entries, entry] });
      appendLine?.(JSON.stringify(entry));
      return entry;
    },

    setIntent(sessionId, text) {
      const context = ensure(sessionId);
      // S4 is an immutable baseline: the first intent a session declares is
      // the one it is held to. Later ones are dropped rather than refused,
      // because a step arriving with a different intent is a fact about the
      // step, not a reason to stop governing it.
      if (context.intent !== undefined) return;
      sessions.set(sessionId, { ...context, intent: { text, recorded_at: now().toISOString() } });
    },

    putProvenance(sessionId, provenance) {
      const context = ensure(sessionId);
      sessions.set(sessionId, { ...context, provenance });
    },
  };
}

/** S3's reader (commitment 4's twin of `appendContextEntry`). */
export function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext {
  return store.load(sessionId);
}

/** N22: append one step to this session's hash chain. */
export function appendContextEntry(
  store: SessionContextStore,
  sessionId: string,
  step: SessionStep,
): SessionContextEntry {
  return store.append(sessionId, step);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/guardian/test/session-context.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the chain test is non-vacuous by mutation**

Change `prev_hash: previous?.hash ?? GENESIS_HASH` to `prev_hash: GENESIS_HASH` and re-run. Expected: "chains each entry to the one before it" and the JSONL ordering test both FAIL. Restore, re-run, confirm green. Record which mutation killed which test in the report.

- [ ] **Step 7: Full green bar and commit**

```bash
bun test && bun run typecheck && bun run verify:pin
git add packages/guardian/src/session-context.ts packages/guardian/src/session-context-store.ts packages/guardian/test/session-context.test.ts
git commit -m "Give the Guardian a session chain whose order does not rest on a counter"
```

---

## Task 2: N25 — `persistIfcLabels()` and `supplySourceLabels()`

**Files:**
- Create: `packages/guardian/src/ifc-labels.ts`
- Test: `packages/guardian/test/ifc-labels.test.ts`

**Interfaces:**
- Consumes: `SessionContextStore`, `IfcLabels`, `Provenance` from Task 1.
- Produces:
  - `function persistIfcLabels(store: SessionContextStore, sessionId: string, labels: IfcLabels | undefined): void`
  - `function supplySourceLabels(store: SessionContextStore, sessionId: string): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/guardian/test/ifc-labels.test.ts
import { describe, expect, it } from "bun:test";
import { createMemorySessionContextStore } from "../src/session-context-store.ts";
import { persistIfcLabels, supplySourceLabels } from "../src/ifc-labels.ts";

describe("persistIfcLabels / supplySourceLabels — the round trip AGT delegates", () => {
  it("supplies an empty list for a session that has none", () => {
    const store = createMemorySessionContextStore();
    expect(supplySourceLabels(store, "sess-a")).toEqual([]);
  });

  it("gives back at the next step what AGT emitted at this one", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["confidential"]);
    expect(supplySourceLabels(store, "sess-a")).toEqual(["confidential"]);
  });

  it("replaces rather than accumulates, because AGT's labels are the propagated set", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["internal"]);
    persistIfcLabels(store, "sess-a", ["secret"]);
    expect(supplySourceLabels(store, "sess-a")).toEqual(["secret"]);
  });

  it("leaves what it has alone when a verdict carries no labels at all", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["secret"]);
    persistIfcLabels(store, "sess-a", undefined);
    expect(supplySourceLabels(store, "sess-a")).toEqual(["secret"]);
  });

  it("clears them when a verdict carries an explicitly empty set", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["secret"]);
    persistIfcLabels(store, "sess-a", []);
    expect(supplySourceLabels(store, "sess-a")).toEqual([]);
  });

  it("keeps two sessions' labels apart", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["secret"]);
    expect(supplySourceLabels(store, "sess-b")).toEqual([]);
  });

  it("hands back a copy, so a caller cannot edit the store through it", () => {
    const store = createMemorySessionContextStore();
    persistIfcLabels(store, "sess-a", ["secret"]);
    supplySourceLabels(store, "sess-a").push("public");
    expect(supplySourceLabels(store, "sess-a")).toEqual(["secret"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/guardian/test/ifc-labels.test.ts`
Expected: FAIL — cannot resolve `../src/ifc-labels.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/guardian/src/ifc-labels.ts
/**
 * N25 and its twin: the two halves of the round trip AGT's spec asks a host
 * to perform and declines to standardize.
 *
 * AGT's `verdict.schema.json` says the core "stores and propagates nothing"
 * and requires the host to persist returned labels and re-supply them. This
 * module is the Guardian doing exactly that job -- R8.1 made concrete. It is
 * not a criticism of AGT; it fills a role AGT explicitly delegates.
 *
 * NAMED FOR IFC, NOT FOR A GATE. The retired `persistResultLabels()` is not
 * revived: this Guardian has had a genuine result gate since V4
 * (`post_tool_call`), so "result labels" reads as that gate's labels rather
 * than as AGT's IFC tags (slices/v6/README.md, commitment 3).
 *
 * WHERE THE FIRST LABEL COMES FROM IS NOT HERE, and that is a property of
 * ACS v0.1.0 rather than of this module. AGT propagates labels it is given
 * and originates none; `spec/acs/specification/v0.1.0/provenance.json`
 * defines `provenance_id`, `origin`, `source_id` and `derived_from`, and no
 * member a sensitivity label could be read from. So a session's first labels
 * are deployment-supplied, exactly as V3's drift score is and for the same
 * reason -- see §V6 of the slices doc, which files it as a V7 matrix cell:
 * green for the Guardian, red for a wire consumer.
 */
import type { IfcLabels, SessionContextStore } from "./session-context-store.ts";

/**
 * Persist what a verdict returned. `undefined` means the verdict carried no
 * `result_labels` member at all -- a policy that never ran the IFC gate --
 * and leaves what the session already had. An explicitly EMPTY array is a
 * different answer: the gate ran and propagated nothing, so the session's
 * labels are cleared. Conflating the two would make a session that once
 * touched secret data look secret forever.
 */
export function persistIfcLabels(
  store: SessionContextStore,
  sessionId: string,
  labels: IfcLabels | undefined,
): void {
  if (labels === undefined) return;
  const context = store.load(sessionId);
  store.putProvenance(sessionId, { ...context.provenance, ifc_labels: [...labels] });
}

/**
 * Read them back for the next snapshot. Returns a fresh array: the value
 * goes into a snapshot that crosses the bridge into the policy runtime, and
 * a caller holding the store's own array could edit S5 by editing a snapshot.
 */
export function supplySourceLabels(store: SessionContextStore, sessionId: string): string[] {
  return [...store.load(sessionId).provenance.ifc_labels];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/guardian/test/ifc-labels.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the `undefined`/`[]` distinction is non-vacuous**

Change `if (labels === undefined) return;` to `if (labels === undefined || labels.length === 0) return;` and re-run. Expected: "clears them when a verdict carries an explicitly empty set" FAILS and nothing else does. Restore and confirm green. Record it.

- [ ] **Step 6: Full green bar and commit**

```bash
bun test && bun run typecheck && bun run verify:pin
git add packages/guardian/src/ifc-labels.ts packages/guardian/test/ifc-labels.test.ts
git commit -m "Persist the labels AGT returns, and tell an absent set apart from an empty one"
```

---

## Task 3: N23 — session state in both snapshots, and the N21 → N22 → N23 rewire

**This task is what the plan first drew as two.** The split made the assemblers'
session-state parameter required in one task and left `server.ts` failing
typecheck until the next one closed it — a red bar mid-branch, which Global
Constraint 7 forbids. Merged, the task has one green bar and one commit: no
placeholder call site, and no commit in the branch's history that does not
typecheck.

**Files:**
- Modify: `packages/guardian/src/assemble-snapshot.ts`
- Modify: `packages/guardian/src/server.ts`
- Modify: `packages/guardian/src/index.ts`
- Modify: `packages/guardian/src/main.ts`
- Test: `packages/guardian/test/assemble-snapshot.test.ts` (extend)
- Test: `packages/guardian/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1-2. Note that `supplySourceLabels` is called in `server.ts` and *not* in `assemble-snapshot.ts` — the caller resolves labels and passes them in, so the assembler module stays free of store vocabulary.
- Produces:
  - `type AgtSessionState = { sourceLabels: readonly string[] }`
  - `assemblePreToolCallSnapshot(envelope: ToolCallRequestEnvelope, session: AgtSessionState): AgtPreToolCallSnapshot`
  - `assemblePostToolCallSnapshot(envelope: ToolCallResultEnvelope, session: AgtSessionState): AgtPostToolCallSnapshot`
  - Both snapshot types gain `input: { ifc: { source_labels: string[] } }`.
  - `StartGuardianOptions` gains `sessionContextLog?: string` and `sessionContextStore?: SessionContextStore`; the guardian barrel re-exports the session verbs and types.

**The exact path is load-bearing.** `policy/lib/agt_ifc.rego` reads `input.snapshot.input.ifc.source_labels`. Its own test file pins that labels placed at `input.snapshot.ifc.source_labels` resolve to `[]` — the upstream library's path, which AGT hosts do not populate. The member below is therefore `input.ifc.source_labels`, nested inside the snapshot, not `ifc` at the snapshot root.

**The parameter is required, not optional.** An optional one would let a call site silently omit session state and get a snapshot AGT reads as "no labels", which is the fail-open shape this project has closed repeatedly. Required means the compiler names every call site.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/guardian/test/assemble-snapshot.test.ts
describe("session state in the snapshot (V6, N23)", () => {
  const NO_LABELS = { sourceLabels: [] as readonly string[] };

  it("puts source labels where AGT's stock IFC library actually reads them", () => {
    const snapshot = assemblePreToolCallSnapshot(requestEnvelope(), { sourceLabels: ["confidential"] });
    // policy/lib/agt_ifc.rego: input.snapshot.input.ifc.source_labels.
    // Its own test pins that input.snapshot.ifc.source_labels reads as [].
    expect(snapshot.input.ifc.source_labels).toEqual(["confidential"]);
    expect((snapshot as Record<string, unknown>).ifc).toBeUndefined();
  });

  it("carries an empty list rather than omitting the member", () => {
    const snapshot = assemblePreToolCallSnapshot(requestEnvelope(), NO_LABELS);
    expect(snapshot.input.ifc.source_labels).toEqual([]);
  });

  it("injects into the result gate's assembler too, once, in its own function", () => {
    const snapshot = assemblePostToolCallSnapshot(resultEnvelope(), { sourceLabels: ["secret"] });
    expect(snapshot.input.ifc.source_labels).toEqual(["secret"]);
  });

  it("copies the labels, so a snapshot cannot be edited through the caller's array", () => {
    const labels = ["secret"];
    const snapshot = assemblePreToolCallSnapshot(requestEnvelope(), { sourceLabels: labels });
    labels.push("public");
    expect(snapshot.input.ifc.source_labels).toEqual(["secret"]);
  });

  it("leaves every V1/V4 member of both snapshots exactly as it was", () => {
    const pre = assemblePreToolCallSnapshot(requestEnvelope(), NO_LABELS);
    expect(pre.tool_call.name).toBe("Bash");
    expect(pre.envelope.budgets).toEqual({ tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 });
    const post = assemblePostToolCallSnapshot(resultEnvelope(), NO_LABELS);
    expect(post.tool_result.outputs).toHaveLength(1);
    expect((post as Record<string, unknown>).tool_call).toEqual({ name: "Bash" });
  });
});
```

Use the file's existing envelope fixtures; if it builds envelopes inline, extract `requestEnvelope()` / `resultEnvelope()` helpers from what is already there rather than writing new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/guardian/test/assemble-snapshot.test.ts`
Expected: FAIL — `assemblePreToolCallSnapshot` takes 1 argument, and `snapshot.input` does not exist.

- [ ] **Step 3: Add the type, the parameter, and the member**

```ts
/**
 * The session state an assembler injects, resolved by the caller.
 *
 * The assemblers take a VALUE, not the store: this module converts an
 * envelope into a snapshot and knows nothing about where session state is
 * kept. `supplySourceLabels` is `server.ts`'s call, one seam up.
 */
export type AgtSessionState = { sourceLabels: readonly string[] };

/**
 * Where AGT reads them, and the shorter path is wrong.
 * `policy/lib/agt_ifc.rego` resolves `input.snapshot.input.ifc.source_labels`;
 * `policy/lib/agt_ifc_test.rego` pins that the upstream library's
 * `input.snapshot.ifc.source_labels` reads as `[]` against an AGT host's
 * snapshot. Nested, therefore, and never hoisted to the snapshot root.
 */
function ifcMember(session: AgtSessionState): { ifc: { source_labels: string[] } } {
  return { ifc: { source_labels: [...session.sourceLabels] } };
}
```

Add `input: { ifc: { source_labels: string[] } };` to both `AgtPreToolCallSnapshot` and `AgtPostToolCallSnapshot`, and `input: ifcMember(session),` to both returned literals. Give each snapshot type's doc comment one sentence naming the new member and why it is nested.

Update the module header: the sentence "no session state, no chain hash, no prior decisions, no intent. Those arrive in V6 via S3/S4/S5" is now describing what this file no longer does. Replace it with what is true — labels arrive here in V6; the chain hash and intent stay out, and say which module holds them.

- [ ] **Step 4: Run the assembler tests to verify they pass**

Run: `bun test packages/guardian/test/assemble-snapshot.test.ts`
Expected: PASS. Do **not** run `bun run typecheck` yet and do **not** commit here — `server.ts` still calls both assemblers with one argument, and Step 8 is what closes that. This task's single commit is Step 11.

- [ ] **Step 5: Prove the path test is non-vacuous**

Change `input: ifcMember(session)` to `ifc: ifcMember(session).ifc` (hoisting to the root, the exact trap the rego test records). Expected: "puts source labels where AGT's stock IFC library actually reads them" FAILS. Restore. Record it.

**The order the rest of this task wires is the master doc's:** *"Wire N21 → N22 → N23 in place of V1's direct N21 → N23."* Validate, append the arriving step to the chain, then assemble. So the entry records that the step arrived, before any verdict exists for it — a step that is later denied is still in the chain, which is the point of a chain.

- [ ] **Step 6: Write the failing server tests**

```ts
// append to packages/guardian/test/server.test.ts
describe("session state end to end (V6)", () => {
  it("grows the chain by one entry per governed step, on one session", async () => {
    const store = createMemorySessionContextStore();
    const guardian = await startGuardian({ ...baseOptions, sessionContextStore: store });
    try {
      await postStep(guardian, toolCallRequest({ session_id: "sess-a", request_id: "req-1" }));
      await postStep(guardian, toolCallRequest({ session_id: "sess-a", request_id: "req-2" }));
      const chain = loadSessionContext(store, "sess-a").entries;
      expect(chain.map((e) => e.seq)).toEqual([1, 2]);
      expect(chain[1]!.prev_hash).toBe(chain[0]!.hash);
      expect(chain.map((e) => e.request_id)).toEqual(["req-1", "req-2"]);
    } finally {
      await guardian.stop();
    }
  });

  it("appends the step even when the decision denies it", async () => {
    const store = createMemorySessionContextStore();
    const guardian = await startGuardian({ ...baseOptions, sessionContextStore: store });
    try {
      const response = await postStep(guardian, toolCallRequest({ session_id: "sess-a", command: "rm -rf /" }));
      expect(response.result.decision).toBe("deny");
      expect(loadSessionContext(store, "sess-a").entries).toHaveLength(1);
    } finally {
      await guardian.stop();
    }
  });

  it("hands the snapshot the labels the previous step's verdict returned", async () => {
    const store = createMemorySessionContextStore();
    const seen: unknown[] = [];
    const bridge = recordingBridge(seen, { decision: "allow", result_labels: ["confidential"] });
    const guardian = await startGuardian({ ...baseOptions, bridge, sessionContextStore: store });
    try {
      await postStep(guardian, toolCallRequest({ session_id: "sess-a", request_id: "req-1" }));
      await postStep(guardian, toolCallRequest({ session_id: "sess-a", request_id: "req-2" }));
    } finally {
      await guardian.stop();
    }
    const first = seen[0] as { input: { ifc: { source_labels: string[] } } };
    const second = seen[1] as { input: { ifc: { source_labels: string[] } } };
    expect(first.input.ifc.source_labels).toEqual([]);
    expect(second.input.ifc.source_labels).toEqual(["confidential"]);
  });

  it("keeps two sessions' labels and chains apart", async () => {
    const store = createMemorySessionContextStore();
    const bridge = recordingBridge([], { decision: "allow", result_labels: ["secret"] });
    const guardian = await startGuardian({ ...baseOptions, bridge, sessionContextStore: store });
    try {
      await postStep(guardian, toolCallRequest({ session_id: "sess-a" }));
      expect(supplySourceLabels(store, "sess-b")).toEqual([]);
      expect(loadSessionContext(store, "sess-b").entries).toEqual([]);
    } finally {
      await guardian.stop();
    }
  });

  it("writes one JSONL line per entry when given a log path", async () => {
    const path = join(tmpdir(), `acs-session-${crypto.randomUUID()}.jsonl`);
    const guardian = await startGuardian({ ...baseOptions, sessionContextLog: path });
    try {
      await postStep(guardian, toolCallRequest({ session_id: "sess-a", request_id: "req-1" }));
    } finally {
      await guardian.stop();
    }
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ session_id: "sess-a", seq: 1, request_id: "req-1" });
    rmSync(path, { force: true });
  });
});
```

Reuse the file's existing helpers (`baseOptions`, `postStep`, `toolCallRequest`, a recording/stub bridge) rather than inventing new ones; add `recordingBridge` beside the existing stub if none captures the snapshot.

- [ ] **Step 7: Run the server tests to verify they fail**

Run: `bun test packages/guardian/test/server.test.ts`
Expected: FAIL — `sessionContextStore` is not an option, and the assemblers are still called with one argument.

- [ ] **Step 8: Wire it in `server.ts`**

In `evaluateStep`, thread the store through and resolve labels before assembling. The assembler parameter keeps its narrowing (`evaluateStep` is still called once per envelope kind, with that kind's assembler), so V1's union-avoidance is untouched:

```ts
// Inside evaluateStep, before the snapshot is assembled:
//
// N21 -> N22 -> N23, replacing V1's direct N21 -> N23 (slices doc, §V6). The
// entry is appended on ARRIVAL, before any verdict exists: a step that is
// later denied is still a step this session took, and a chain that recorded
// only permitted steps would be a chain an incident review cannot use.
appendContextEntry(sessionContextStore, envelope.params.session_id, {
  method: envelope.method,
  request_id: envelope.params.request_id,
  tool_name: envelope.params.payload.tool.name,
});

const snapshot = assemble(envelope, {
  sourceLabels: supplySourceLabels(sessionContextStore, envelope.params.session_id),
});
```

And after `mapVerdict`, before the response is built:

```ts
// N25 -> S5. `verdict.result_labels` is `undefined` when the IFC gate did not
// run at all and `[]` when it ran and propagated nothing; `persistIfcLabels`
// keeps those apart deliberately -- see its own doc comment.
persistIfcLabels(sessionContextStore, envelope.params.session_id, verdict.result_labels);
```

Add to `StartGuardianOptions`:

```ts
  /**
   * Where S3's chain is appended for U22 to tail. Defaults to no file: the
   * store is authoritative, and the JSONL is a projection for the Inspector,
   * the same relationship S6 has to the envelopes it records.
   */
  sessionContextLog?: string;
  /**
   * The store itself, for tests and for a deployment that wants to own it.
   * Omitted means a fresh in-memory one per Guardian.
   */
  sessionContextStore?: SessionContextStore;
```

Construct the default store where the envelope log sink is constructed, passing `appendLine` when `sessionContextLog` is set. Add `DEFAULT_SESSION_CONTEXT_LOG = ".acs/session-context.jsonl"` to `main.ts` beside `DEFAULT_ENVELOPE_LOG`, and honour `ACS_SESSION_CONTEXT_LOG`.

Export from `packages/guardian/src/index.ts`:

```ts
export {
  loadSessionContext,
  appendContextEntry,
  createMemorySessionContextStore,
  GENESIS_HASH,
  type SessionContext,
  type SessionContextEntry,
  type SessionContextStore,
  type IfcLabels,
  type Intent,
  type Provenance,
} from "./session-context-store.ts";
export { persistIfcLabels, supplySourceLabels } from "./ifc-labels.ts";
```

Follow that barrel's own stated rule: it exports "the governance verbs, and nothing else". The session verbs are governance verbs; the JSONL appender is not, and stays internal exactly as `createEnvelopeLogSink` does.

- [ ] **Step 9: Run the server tests to verify they pass**

Run: `bun test packages/guardian/test/server.test.ts && bun run typecheck`
Expected: PASS, and typecheck clean — this closes the red opened at Step 3, inside the same task and before any commit.

- [ ] **Step 10: Prove the wiring tests are non-vacuous**

Two mutations, each run and restored:
- Delete the `persistIfcLabels` call. Expected: "hands the snapshot the labels the previous step's verdict returned" FAILS.
- Move `appendContextEntry` to after the verdict and skip it on deny. Expected: "appends the step even when the decision denies it" FAILS.

Record which mutation killed which test.

- [ ] **Step 11: Full green bar and one commit**

Every file this task touched goes in one commit — that is the point of the merge. Stage by explicit path; never `git add -A`.

```bash
bun test && bun run typecheck && bun run verify:pin
git add packages/guardian/src/assemble-snapshot.ts packages/guardian/src/server.ts packages/guardian/src/index.ts packages/guardian/src/main.ts packages/guardian/test/assemble-snapshot.test.ts packages/guardian/test/server.test.ts
git commit -m "Append every arriving step to its session chain, then assemble from what the chain knows"
```

---

## Task 4: Seed the session floor, turn the stock IFC gate on, and measure the round trip

**Files:**
- Modify: `policy/lib/data.json`
- Modify: `packages/guardian/src/session-context.ts` — the seed
- Modify: `packages/guardian/test/session-context.test.ts`, `packages/guardian/test/ifc-labels.test.ts`, `packages/guardian/test/server.test.ts` — the expectations the seed changes
- Test: `test/ifc-round-trip.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1-3, and the real `policy/lib` bundle through `packages/agt-bridge`.
- Produces: `emptySessionContext` seeds `ifc_labels` at `["public"]` rather than `[]`.

**This is the slice's claim, so it is measured against the shipped bundle, not a stub.** The gate already exists in `policy/lib/agt_default.rego` and is dormant because `cfg.ifc.sink_clearance` is absent. Adding it to `data.json` is the only policy-side change V6 makes, and `test/pin.test.ts` explicitly permits it: every `.rego` stays byte-identical and the bundle "adds nothing except data.json".

Pick `"sink_clearance": "confidential"` — with the stock lattice (`policy/lib/agt_ifc.rego:22-27`), `confidential` dominates `public`, `internal`, `confidential` and **not** `secret`, so the same config demonstrates both propagation (a label flows and is echoed back) and refusal (a `secret` label denies with `ifc_clearance_violation`). One config, both halves.

### The seed, and why the gate cannot ship without one

⚠️ **This task grew during execution.** Turning the gate on alone denied every governed step — 775 pass / 1 skip / 0 fail became 744 pass / 35 fail across nine files, every one an `ifc_clearance_violation` on a step that carried no labels. The cause is Verified ground 3's correction: `flow_allowed` requires `count(labels) > 0`, so **zero labels is not a permissive state in AGT's stock gate, it is a denied one.**

That composes with the gap this plan states up front. ACS v0.1.0's `provenance.json` has no label member, so nothing on the wire can give a session its first label. AGT propagates labels and originates none. If the host does not seed one, no session ever has one, and a gate that denies zero-label flows denies everything forever.

So the seed is not a workaround for a test failure — it is the deployment-supplied first label the plan already said V6 would have to provide, made concrete. `emptySessionContext` starts a session at `["public"]`, the lattice's floor:

```ts
    provenance: {
      provenance_id: `acs:session:${sessionId}`,
      origin: "system",
      source_id: "acs.guardian",
      // The lattice floor, and the deployment-supplied first label this slice
      // exists to demonstrate the need for. ACS v0.1.0 carries no label field
      // (`spec/acs/specification/v0.1.0/provenance.json` defines
      // provenance_id/origin/source_id/derived_from and nothing a sensitivity
      // could be read from), and AGT's gate denies a zero-label flow outright
      // rather than waving it through: `flow_allowed` in
      // `policy/lib/agt_ifc.rego` requires `count(labels) > 0`. A session with
      // no seed is therefore a session that can do nothing at all.
      ifc_labels: ["public"],
    },
```

**Keep the cleared-to-`[]` state distinct from the unseeded state.** `persistIfcLabels(store, id, [])` still clears to `[]`, and `[]` is still a denied flow — that is correct and must not be softened into "clearing means reseeding". Measure whether the shipped bundle can actually emit `result_labels: []` and record the answer: `propagated_labels` returns `[]` only when `count(labels) == 0`, which cannot reach the allow branch, so this deployment's gate should never produce it. If measurement disagrees, that is a finding, not a test to adjust.

- [ ] **Step 1: Write the failing test**

```ts
// test/ifc-round-trip.test.ts
/**
 * The V6 demo, against the real pinned bundle: AGT emits `result_labels` at
 * one step and reads them back as `input.ifc.source_labels` at the next.
 *
 * Nothing here stubs the policy runtime. The gate is AGT's own
 * `agt.defaults` rule set, turned on through `data.agt.defaults.config`
 * alone (R2.1), and the labels travel the path `policy/lib/agt_ifc.rego`
 * actually resolves.
 */
import { describe, expect, it } from "bun:test";
import { createBridge } from "@acs/agt-bridge";
import { createMemorySessionContextStore, persistIfcLabels, supplySourceLabels } from "@acs/guardian";

describe("the IFC round trip, on the shipped bundle", () => {
  it("propagates a label the session already carries, and returns it", async () => {
    const bridge = await createBridge({ manifestPath: "policy/manifest.yaml" });
    const verdict = await bridge.evaluate("pre_tool_call", {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash", args: { command: "echo hello" }, id: "req-1" },
      input: { ifc: { source_labels: ["confidential"] } },
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.result_labels).toEqual(["confidential"]);
  });

  it("denies a flow the configured clearance does not dominate", async () => {
    const bridge = await createBridge({ manifestPath: "policy/manifest.yaml" });
    const verdict = await bridge.evaluate("pre_tool_call", {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash", args: { command: "echo hello" }, id: "req-1" },
      input: { ifc: { source_labels: ["secret"] } },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("ifc_clearance_violation");
  });

  it("reads nothing from the path the upstream library uses, which AGT hosts do not populate", async () => {
    const bridge = await createBridge({ manifestPath: "policy/manifest.yaml" });
    const verdict = await bridge.evaluate("pre_tool_call", {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash", args: { command: "echo hello" }, id: "req-1" },
      // The trap agt_ifc_test.rego pins: labels at the snapshot root are not read.
      ifc: { source_labels: ["secret"] },
    } as never);
    expect(verdict.decision).not.toBe("deny");
  });

  it("carries one step's returned labels into the next step's snapshot", () => {
    const store = createMemorySessionContextStore();
    expect(supplySourceLabels(store, "sess-a")).toEqual(["public"]);
    persistIfcLabels(store, "sess-a", ["confidential"]);
    expect(supplySourceLabels(store, "sess-a")).toEqual(["confidential"]);
  });

  it("denies a session whose labels were cleared outright, because zero labels is a denied flow", async () => {
    const bridge = await createBridge({ manifestPath: "policy/manifest.yaml" });
    const verdict = await bridge.evaluate("pre_tool_call", {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash", args: { command: "echo hello" }, id: "req-1" },
      input: { ifc: { source_labels: [] } },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("ifc_clearance_violation");
  });
});
```

The last test is the one that pins what this task discovered: an empty label set is **denied**, not waved through. It is what makes the seed load-bearing rather than cosmetic, so it must not be softened.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/ifc-round-trip.test.ts`
Expected: the propagation and refusal cases FAIL — with no `cfg.ifc.sink_clearance`, `ifc_verdict` is undefined, so the gate never fires and no `result_labels` come back.

- [ ] **Step 3: Turn the gate on**

Add to `policy/lib/data.json` under `agt.defaults.config`, beside `patterns` and `redact`:

```json
        "ifc": {
          "sink_clearance": "confidential"
        }
```

- [ ] **Step 4: Seed the session floor**

Change `emptySessionContext`'s provenance in `packages/guardian/src/session-context.ts` to the seeded literal given in this task's preamble, comment and all. Without it the next step measures 35 failures rather than a demo.

- [ ] **Step 5: Update the expectations the seed changes, and only those**

A fresh session now reports `["public"]` where it used to report `[]`. Three test files assert that value and each assertion is still describing the same behaviour — an unseeded session — so each is updated, not deleted:

- `packages/guardian/test/session-context.test.ts` — "loads an unknown session as an empty chain rather than throwing" asserts `provenance.ifc_labels` is `[]`.
- `packages/guardian/test/ifc-labels.test.ts` — "supplies an empty list for a session that has none" and "keeps two sessions' labels apart" both assert `[]` for a session with no history. Rename the first to say what it now asserts. **"clears them when a verdict carries an explicitly empty set" must keep expecting `[]`** — an explicit clear is not a reseed, and that test is the one holding the two states apart.
- `packages/guardian/test/server.test.ts` — the first snapshot in "hands the snapshot the labels the previous step's verdict returned" and session B in "keeps two sessions' labels and chains apart" both expect `[]`.

- [ ] **Step 5b: The label-free fixtures, and the precedence they exposed**

⚠️ **Also discovered during execution.** Six further tests fail, and they are a different kind from Step 5's: they build snapshots **by hand**, bypassing the assemblers and the session store, so the seed never reaches them. `test/redaction.test.ts` (3), `packages/agt-bridge/test/bridge.test.ts` (2), `packages/guardian/test/assemble-snapshot.test.ts` (1).

What they exposed is worth more than the fix. `policy/lib/agt_default.rego`'s own header states the combination order: *"consults each one in priority order: IFC deny > confidence deny > budget deny > content_hash deny > egress deny > pattern deny > drift warn > allow."* **IFC deny outranks every other gate.** So a caller whose snapshot carries no labels does not merely lose IFC — it gets `ifc_clearance_violation` in place of whatever the policy would otherwise have said. Two of these tests measure exactly that: a `rm -rf /` that reported `destructive_shell_command_blocked` now reports `ifc_clearance_violation`. Still denied, differently blamed.

Give each fixture the `["public"]` label the Guardian would have given it, so the fixture represents what this deployment actually produces. Then **pin the property, or the fixture edits are indistinguishable from silencing the tests**: add a test asserting that a snapshot carrying `["public"]` and a `rm -rf /` command denies with `destructive_shell_command_blocked` — the pattern gate reached, because IFC allowed. Without that assertion there is no evidence the gates still compose; with it, the six edits are demonstrably fixture repairs.

Record the precedence order in the report. Task 6 files it in the slice's record: turning the IFC gate on makes `input.ifc.source_labels` a required member of every snapshot in the deployment, including for callers with no session concept.

Anything failing that Steps 5 and 5b do not name is not a ripple. Stop and report it rather than editing it.

- [ ] **Step 6: Run the round trip and the pin gate**

Run: `bun test test/ifc-round-trip.test.ts && bun run verify:pin`
Expected: PASS, and `verify:pin` green — every `.rego` byte-identical, `data.json` the only addition.

- [ ] **Step 7: Confirm the whole suite still passes**

Run: `bun test`
Expected: the prior tasks' 775 plus this task's additions, 0 fail. **If a test fails that Step 5 does not name, stop and report it rather than editing it** — a policy gate that changes an existing decision is a real finding about the deployment, not a test to adjust. That stop condition is what produced this task's own scope; honour it again.

- [ ] **Step 8: Commit**

```bash
bun test && bun run typecheck && bun run verify:pin
git add policy/lib/data.json packages/guardian/src/session-context.ts packages/guardian/test/session-context.test.ts packages/guardian/test/ifc-labels.test.ts packages/guardian/test/server.test.ts packages/guardian/test/assemble-snapshot.test.ts packages/agt-bridge/test/bridge.test.ts test/redaction.test.ts test/ifc-round-trip.test.ts
git commit -m "Seed a session at the lattice floor, because AGT denies a flow that carries no labels"
```

---

## Task 5: U22 — the session chain view

**Files:**
- Create: `packages/inspector/src/tail-session-context.ts`
- Modify: `packages/inspector/src/render.ts`
- Modify: `packages/inspector/src/main.ts`
- Create: `test/session-context-roundtrip.test.ts`
- Test: `packages/inspector/test/tail-session-context.test.ts`

**Interfaces:**
- Consumes: the JSONL lines Task 3's store appends.
- Produces: `tailSessionContextLog(path, options)` and a `renderSessionChain(entries)` view.

**R5.1 is the constraint that shapes this task.** The Inspector imports nothing from `@acs/guardian`. It re-declares the entry type it reads, exactly as it re-declares `EnvelopeLogEntry` and `AuditEntry`, and `test/session-context-roundtrip.test.ts` keeps the two declarations from drifting — the same pairing `test/envelope-log-sink-roundtrip.test.ts` and `test/audit-sink-roundtrip.test.ts` already use. `test/invariants.test.ts` already gates the import ban; confirm it covers the new file rather than assuming it.

**Model `tail-session-context.ts` on `tail-audit-log.ts`**, which is the closer sibling: both read an append-only JSONL of records with a monotonic index. Reuse its truncation-and-rotation handling rather than inventing new logic.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/inspector/test/tail-session-context.test.ts
describe("tailSessionContextLog", () => {
  it("emits each entry already in the file, in chain order", async () => { /* … */ });
  it("emits entries appended after the tail starts", async () => { /* … */ });
  it("resets when the file is truncated underneath it", async () => { /* … */ });
  it("skips a malformed line rather than stopping the tail", async () => { /* … */ });
});

describe("renderSessionChain (U22)", () => {
  it("shows each entry's seq, tool, and a short hash", () => { /* … */ });
  it("marks a break where prev_hash does not match the entry before it", () => { /* … */ });
  it("renders an empty chain as an explicit empty state, not a blank panel", () => { /* … */ });
});
```

Write these out against `tail-audit-log.test.ts`'s existing shape — same fixtures, same helpers, same waiting strategy as that file already uses.

**Note on the existing flake:** `docs/shaping/acs-reference-impl-slices.md` records that the two tail suites gate assertions on bare `Bun.sleep` waits and that a rare transient failure was observed. Do not copy that pattern into the new suite: await the next emission (a promise resolved by the tail's own callback) rather than a duration. If that turns out to require a change to the tail's interface, say so in the report rather than reaching for a sleep.

```ts
// test/session-context-roundtrip.test.ts
/**
 * The Inspector re-declares the Guardian's entry type rather than importing
 * it (R5.1). That duplication is only safe while something fails when the
 * two drift -- the same contract test S6 and S14 each already have.
 */
it("round-trips a Guardian-written entry through the Inspector's own declaration", () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/inspector/test/tail-session-context.test.ts test/session-context-roundtrip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tail, the render, and the wiring**

`tail-session-context.ts` declares its own entry type:

```ts
/**
 * U22's reader. Declares its own entry shape rather than importing the
 * Guardian's (R5.1) -- the Inspector imports nothing from that package and
 * proves it by reading S3 as a file. `test/session-context-roundtrip.test.ts`
 * is what keeps this declaration honest against the writer's.
 */
export type SessionContextLogEntry = {
  session_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  recorded_at: string;
  method: string;
  request_id: string;
  tool_name: string;
};
```

`renderSessionChain` shows one row per entry and marks a chain break where `prev_hash` does not match the previous row's `hash` — the view's whole value is that a chain is checkable, so rendering it without checking it would be a panel that looks like evidence and is not.

`main.ts` reads `ACS_SESSION_CONTEXT_LOG`, defaulting to `.acs/session-context.jsonl`, beside the two existing defaults.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/inspector/ test/session-context-roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the chain-break marker is non-vacuous**

Feed the renderer two entries whose hashes do not link and assert the marker appears; then mutate the renderer to always report an intact chain and confirm that test fails. Restore. Record it.

- [ ] **Step 6: Confirm R5.1 still holds mechanically**

Run: `bun test test/invariants.test.ts`
Expected: PASS. Confirm by reading the gate that it covers `packages/inspector/src/tail-session-context.ts` — if it enumerates files rather than globbing the directory, add the new one and say so in the report.

- [ ] **Step 7: Full green bar and commit**

```bash
bun test && bun run typecheck && bun run verify:pin
git add packages/inspector/src/tail-session-context.ts packages/inspector/src/render.ts packages/inspector/src/main.ts packages/inspector/test/tail-session-context.test.ts test/session-context-roundtrip.test.ts
git commit -m "Let the Inspector read the session chain, and check it rather than just print it"
```

---

## Task 6: The slice's own record

**Files:**
- Modify: `slices/v6/README.md`
- Create: `docs/demos/v6-runbook.md`
- Modify: `docs/shaping/acs-reference-impl-slices.md`

**Interfaces:**
- Consumes: the measurements from Tasks 1-5.
- Produces: nothing code depends on.

- [ ] **Step 1: Replace `slices/v6/README.md`'s "Implementation goes here."**

Keep the frozen-names section exactly as it is — it is the record of a commitment that was kept, and each numbered sentence should now be checkable against a file. Add a short section naming what shipped for each affordance (U22, N22, N25, S3, S4, S5) and where it lives. Where a commitment was met by a name that differs from the sentence, say so plainly rather than editing the sentence.

- [ ] **Step 2: Write `docs/demos/v6-runbook.md`**

Follow `docs/demos/v5-runbook.md`'s rules, which are this project's standard and are stricter than they look: every capture is from a real run against this tree, nothing composed or hand-derived, and where a capture needed a script rather than a real model, say so plainly. The runbook must show the chain growing across two steps and the label emitted at one step arriving at the next, with the actual JSONL lines.

- [ ] **Step 3: File the wire-coverage finding in the master doc**

Add to `docs/shaping/acs-reference-impl-slices.md` §V6 the finding this plan states up front: ACS v0.1.0's `provenance.json` defines no label member, so a session's first labels are deployment-supplied rather than wire-derived, exactly as V3's drift score is. Cross-reference risk row 11 and D10, which are the same shape, and note it as a V7 matrix cell — **green for the Guardian, red for a wire consumer**. Use the file's own `⚠️` convention.

Also record, in the same place, that V6 did **not** need risk row 13's `seq` duplicate closed, with the reason: S3's order is carried by `prev_hash` and assigned in one process, so it never depended on S14's cross-process counter. Row 13 names V6 as a slice that would need it; that expectation was checked and did not hold, and leaving it unamended would have the next reader believe V6 took a dependency it did not.

- [ ] **Step 3b: File what execution discovered, which the plan did not predict**

⚠️ Three findings came out of turning the gate on, each measured against a `.rego` file rather than reasoned about. All three belong in §V6 and in the runbook; none of them is a footnote.

1. **AGT's stock IFC gate is fail-closed on absent labels.** `flow_allowed` (`policy/lib/agt_ifc.rego`) requires `count(labels) > 0` *before* it checks dominance, so a snapshot carrying no labels is not a permitted flow — it is a denied one, `ifc_clearance_violation`. Turning the gate on with nothing seeding a first label took the suite from 775 pass / 1 skip / 0 fail to 744 pass / 35 fail across nine files. **This is what makes the deployment-supplied seed mandatory rather than a design preference**, and it is the sharpest available statement of the wire gap in Step 3: a conforming ACS v0.1.0 deployment cannot obtain a first label from the wire, and AGT denies every session that has none. Record the seed (`["public"]`, the lattice floor) as V6's answer.

2. **IFC deny outranks every other gate.** `policy/lib/agt_default.rego`'s own header states the order: *"IFC deny > confidence deny > budget deny > content_hash deny > egress deny > pattern deny > drift warn > allow."* So a label-free snapshot does not merely lose IFC — it reports `ifc_clearance_violation` **in place of** whatever the policy would otherwise have said. Measured: a `rm -rf /` that reported `destructive_shell_command_blocked` reported `ifc_clearance_violation` instead. Still denied, differently blamed.

3. **Turning the gate on makes `input.ifc.source_labels` a required member of every snapshot in the deployment** — including for callers with no session concept at all, such as `packages/agt-bridge`, whose own tests had to start carrying a label. That is a real cost of shipping the gate on and belongs in the record rather than absorbed silently.

- [ ] **Step 4: Verify every claim before committing**

For each factual statement written in this task, name the file or command that establishes it. Any claim you cannot back gets deleted or rewritten as an open question. This project's last five review rounds each found stale or unmeasured claims in exactly this kind of prose — including three introduced by the very edits meant to remove one.

**Two specific things not to overclaim:**

- **The round trip is measured in pieces, not end to end.** One test proves the real bundle emits `result_labels` for a carried label; another proves the store carries them across steps; a third proves the server wires emit → persist → next snapshot, but through a stub bridge. **No single test drives a real Guardian over two steps against the real bundle.** Such a test would be degenerate today — `public → public` is the only seed available — so the seam split is defensible, but the runbook must describe what was measured and not more.
- **No process citations in shipped prose.** No "fix round N", no SDD workspace paths. Those point at scratch that is deleted when this slice lands.

- [ ] **Step 5: Full green bar and commit**

```bash
bun test && bun run typecheck && bun run verify:pin
git add slices/v6/README.md docs/demos/v6-runbook.md docs/shaping/acs-reference-impl-slices.md
git commit -m "Say what V6 shipped, and file the wire gap its demo ran into"
```

---

## After the tasks

The controller — not a task implementer — does this once, after the final whole-branch review:

1. Push `slice/v6` (PR #15).
2. Rebase the upper stack onto the new tip, in order, each onto its own true base:
   `git rebase --onto slice/v6 <old-v6-tip> slice/v7`, then `git rebase --onto slice/v7 <old-v7-tip> slice/v8`.
3. Force-push both with `--force-with-lease`.
4. Confirm the stack is linear (`git merge-base --is-ancestor` for each pair), that each PR's own diff shows only its slice, and that all eight PRs report `MERGEABLE`.
5. Reply on issue #7 and PR #15 with what shipped.

## Self-Review

**Spec coverage.** §V6's six affordances: U22 → Task 5; N22 → Tasks 1 and 3; N25 → Tasks 2 and 3; S3 → Task 1; S4 → Task 1; S5 → Tasks 1 and 2. The demo sentence → Task 4 (the policy half) and Task 3 (the carriage half). "Wire N21 → N22 → N23 in place of V1's direct N21 → N23" → Task 3. R8.1 → Task 2's module header and Task 6's filing. The five frozen names → Global Constraint 5, and each is exercised by the task that introduces it.

**Placeholder scan.** Task 5's test bodies are the one place with elided implementations (`/* … */`), and deliberately: they must follow `tail-audit-log.test.ts`'s existing fixtures and waiting strategy, which the implementer reads rather than has retyped here. Every test name states the behaviour to assert, and that task's Step 3 note names the one pattern not to copy. All other steps carry the code they need.

**Type consistency.** `SessionContextStore` is the parameter type in Tasks 1, 2 and 3. `IfcLabels` is `readonly string[]` throughout; `supplySourceLabels` returns a mutable `string[]` because it is handed to a snapshot, and the assembler copies it again — the double copy is intentional and each is asserted. `AgtSessionState` is Task 3's, taken by both assemblers. `appendContextEntry` and `loadSessionContext` keep `(store, sessionId, …)` argument order everywhere.

**One thing left to the implementer's measurement rather than decided here:** whether `evaluateStep`'s existing signature takes the store as a parameter or reads it from a closure over `startGuardian`'s options. Both satisfy the wiring; the file's own structure should decide, and Task 3's tests pass either way.

**Task count.** Six, after the merge ruled on before execution: the assembler change and the `server.ts` rewire are one task, so no commit on this branch fails `bun run typecheck`.
