# V2 — Envelope Inspector

## Slice Contract

| Field | Value |
|---|---|
| Slice ID | [#3](https://github.com/afogel/ACS_reference_implementation/issues/3) (epic [#1](https://github.com/afogel/ACS_reference_implementation/issues/1), PR [#11](https://github.com/afogel/ACS_reference_implementation/pull/11), stacked on `slice/v1`) |
| Slices doc | `docs/shaping/acs-reference-impl-slices.md` §V2, line 74 |
| Demo | "Watch the ACS request and response JSON stream live while you work in Claude Code." |
| Components | U20 envelope stream (request/response JSON pairs) · U21 decision badge (decision + `policy_references` + `reason_codes`) · N26 `writeEnvelopeTap()` · N50 `tailEnvelopeLog()` · S6 envelope log, JSONL |
| Parked items | U22 session chain view → **V6** (needs S3/S4/S5, which do not exist yet). U23 posture badge and N51 `tailAuditSinks()` → **V3** (need S14, the audit sink). N27 `denyOnInvalidEnvelope()` → **V3**. |
| Watch-for | None recorded in §V2. Three are **added by this plan** (tap totality, pre-validation request tap, unpaired responses) and amended into the slices doc in this PR. |
| Corrections | None marked in §V2. |
| Requirements | R5.1 (every hook firing inspectable as an ACS envelope), R5.2 (an ACS-first reader traces one action end to end without reading AGT source), R7.1, R7.2 |

**Global Constraints** (bind every task; copy verbatim into reviewer dispatches):

1. **Zero Rego authored.** Policy behaviour is configured only through `data.agt.defaults.config`. No `.rego` file is written or edited by us. (R2.1)
2. **Stock bundle byte-identical.** Every `.rego` under `policy/lib/` matches AGT at the pinned ref exactly. The only permitted addition to that directory is `data.json`. (R2.2, R2.3)
3. **The host adapter contains zero AGT-specific code.** No file under `packages/host-adapter/` may mention AGT, Rego, OPA, verdicts, or intervention points. (R3.2)
4. **The AGT bridge contains zero host-specific code.** No file under `packages/agt-bridge/` may mention Claude Code, hooks, OpenCode, or stdin/stdout hook protocols. (R3.3)
5. **ACS decisions are lowercase on the wire** — `allow`, `deny`, `modify`, `ask`, `defer`. Uppercase appears in spec prose and in *rendered output* only, never on the wire.
6. **The bundle path in `policy/manifest.yaml` must not begin with `./`.** A `./` prefix silently disables the entire policy and every decision becomes `allow`.
7. **AGT is stateless.** Nothing under `packages/agt-bridge/` persists anything between calls. (R6.1)
8. **The tap is total.** `writeEnvelopeTap` must never throw, and a tap failure must never change, delay, or suppress a decision. Observability degrades; governance does not. V1 shipped three separate fail-opens before they were caught — the tap is new code on the decision path and gets this constraint explicitly.
9. **The Inspector contains zero AGT vocabulary and zero host vocabulary.** It reads ACS envelopes as data and knows nothing about AGT or about Claude Code. That is R5.2 stated as a property of the code, and Task 6 enforces it by grep.
10. **The Inspector imports nothing from `guardian` or `agt-bridge`.** It reads the log file. A compile-time dependency would make "inspectable on the wire" (R5.1) a claim about our own type graph rather than about the wire.
11. **S6 records exactly what crossed the wire** — no reformatting, no field stripping, no redaction, no reordering. Pretty-printing happens at render time only. An inspector that shows something other than what was sent is worse than no inspector.
12. **No new runtime dependencies.** Bun and TypeScript `strict` + `noUncheckedIndexedAccess` only, as in V1.

---

## Decisions taken during planning

These are choices §V2 leaves open. Each is amended into the slices doc in this PR.

| # | Decision | Why | What it rules out |
|---|---|---|---|
| P1 | **The Inspector is a terminal process** — `bun run inspector`, a third terminal beside `bun run guardian` and `claude`. | Zero new dependencies (constraint 12), works over SSH, and matches the repo's existing one-process-per-command shape. R7.1/R7.2 are about a laptop and no paid dependency; a browser UI would add a server, a bundler, and an asset pipeline without proving anything further about the wire. | A web UI, SSE, WebSockets, and any bundler. If a browser view is wanted later it reads the same S6 file and costs nothing already built here. |
| P2 | **S6 is `.acs/envelopes.jsonl`**, gitignored, one JSON object per line. Overridable with `ACS_ENVELOPE_LOG`. | A file is the seam that makes constraint 10 possible: the Guardian writes, anything at all reads. `jq` works on it unchanged. | An in-process event bus or a socket between Guardian and Inspector — either would couple P3 to P4. |
| P3 | **The Guardian's tap is opt-in at the library level, on by default in the CLI.** `startGuardian` taps only when `envelopeLogPath` is passed; `packages/guardian/src/main.ts` passes it. | Existing V1 tests construct Guardians constantly; a default-on tap would scatter files through the working tree and make test output order-dependent. The demo path still gets the tap without anyone opting in. | A module-level singleton tap, or a default path baked into `startGuardian`. |
| P4 | **Request/response pairing is by JSON-RPC `id`**, carried on every entry as `rpc_id`. | It is the only identifier present on both directions of a JSON-RPC exchange. `params.request_id` exists on requests only. | Pairing by arrival order, which breaks the moment two hooks are in flight. |
| P5 | **The request is tapped *before* validation.** | An envelope that fails schema validation is the single most useful thing an ACS-first reader can see, and it is exactly what disappears if the tap sits after the validator. R5.1 says *every* hook firing. | Tapping only well-formed envelopes. |

---

## Slice accounting

| From the slice | Handled by | Note |
|---|---|---|
| U20 envelope stream, request/response JSON pairs | Task 4 (`renderEntry`), Task 5 (CLI) | |
| U21 decision badge: decision + `policy_references` + `reason_codes` | Task 4 (`renderDecisionBadge`) | Includes the `warn`-as-`allow`-with-`policy_references` case the slice calls out by name |
| N26 `writeEnvelopeTap()` | Task 1 (module), Task 2 (wiring) | |
| N50 `tailEnvelopeLog()` | Task 3 | |
| S6 envelope log, JSONL | Task 1 (format), Task 2 (path + gitignore) | |
| "Why this early": R5.1 | Tasks 1, 2 | Every firing reaches S6, including envelopes that fail validation |
| "Why this early": R5.2 | Task 6 | Enforced as a grep gate, not asserted in prose |
| "Why this early": `warn` becomes visible through U21 | Task 4 | A dedicated badge state, with its own test |
| Parked → V3: U23 posture badge, N51 `tailAuditSinks()`, N27 | not in this plan | stays V3's |
| Parked → V6: U22 session chain view | not in this plan | stays V6's |
| R7.1 one command on a laptop | Task 6 | Runbook; `bun install` adds nothing |
| R7.2 no paid dependency | Task 6 | Constraint 12 makes it structural |

---

## Cross-slice work in this plan

| Task | Belongs to | Why it must happen here |
|---|---|---|
| Task 2's refactor of `handleAcsRequest` into parse → tap → `dispatch` → tap | V1's N20 | The tap has to see every response including the JSON-RPC parse error, and V1 left six `return` sites inside one function. Tapping at six sites would guarantee the seventh is missed when V3 adds N27. This is the smallest change that makes the tap total by construction. |

## Scope added during planning

| What | Why the slice cannot ship without it | Slices-doc amendment |
|---|---|---|
| An invariant gate on `packages/inspector/src` (zero AGT vocabulary, zero host vocabulary, no import of `guardian`/`agt-bridge`) | R5.2 is the reason §V2 says "why this early". V1 established that this project turns architectural claims into grep gates rather than prose; an Inspector that merely *happens* not to import AGT proves nothing next slice. | New line under §V2 recording the gate |
| A cross-package round-trip test (Guardian tap writes → Inspector tail reads → badge renders) | The Inspector declares its own `TapEntry` rather than importing the Guardian's (constraint 10). That duplication is only safe if something fails when the two drift. | New line under §V2 recording the contract test |
| `.gitignore` entry for `.acs/` | S6 lands in the working tree the first time the demo runs, and it contains raw tool arguments. | Recorded in the S6 amendment |
| Risk row: S6 grows unbounded | Honest limitation of a JSONL tap with no rotation. | New risk row 9 |
| Open decision D10: the ACS Trace pillar is unclaimed | `spec/acs/specification/v0.1.0/trace/otel-mapping.json` and `trace/ocsf-mapping.json` are normative mappings no slice claims. V2's tap is deliberately *not* an OTel/OCSF export, and R5.3 says this implementation declares what it claims and what it does not. Recording it is the honest move; building it is not this slice. | New D10 row |

---

## Tasks

### Task 1: S6's format and N26 `writeEnvelopeTap()` · slice #3 · N26, S6

**Files:**
- Create: `packages/guardian/src/envelope-tap.ts`
- Test: `packages/guardian/test/envelope-tap.test.ts`

**Interfaces:**
- Produces: `createEnvelopeTap(options): EnvelopeTap`, `NULL_TAP: EnvelopeTap`, `extractRpcId(envelope): string | number | null`, and the types `TapEntry`, `TapDirection`, `EnvelopeTap`, `CreateEnvelopeTapOptions`. Task 2 wires `createEnvelopeTap` and `NULL_TAP` into `server.ts`. Task 3 re-declares `TapEntry` independently in the Inspector (constraint 10); Task 5's round-trip test is what keeps the two honest.

- [ ] **Step 1: Write the failing test** — `packages/guardian/test/envelope-tap.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelopeTap, extractRpcId, NULL_TAP, type TapEntry } from "../src/envelope-tap.ts";

/** A temp directory per test. Cleanup is deliberately non-recursive --
 * unlink the one file we created, then rmdir -- so a stray file makes the
 * test fail loudly instead of being silently blown away. */
function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acs-tap-"));
  try {
    run(dir);
  } finally {
    try {
      unlinkSync(join(dir, "envelopes.jsonl"));
    } catch {
      // the test may not have produced a log at all -- that is the point of some of them
    }
    rmdirSync(dir);
  }
}

function readEntries(path: string): TapEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TapEntry);
}

const REQUEST = { jsonrpc: "2.0", method: "steps/toolCallRequest", id: 7, params: { acs_version: "0.1.0" } };
const RESPONSE = { jsonrpc: "2.0", id: 7, result: { decision: "deny" } };

describe("createEnvelopeTap (N26) -- S6's JSONL format", () => {
  it("writes one line per call, with a monotonic seq starting at 1", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      const tap = createEnvelopeTap({ path });

      tap.write("request", REQUEST, "steps/toolCallRequest");
      tap.write("response", RESPONSE, "steps/toolCallRequest");

      const entries = readEntries(path);
      expect(entries.map((e) => e.seq)).toEqual([1, 2]);
      expect(entries.map((e) => e.direction)).toEqual(["request", "response"]);
    });
  });

  it("records the envelope verbatim -- constraint 11, no reformatting or stripping", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      createEnvelopeTap({ path }).write("request", REQUEST, "steps/toolCallRequest");

      expect(readEntries(path)[0]?.envelope).toEqual(REQUEST);
    });
  });

  it("carries rpc_id from both directions, so the Inspector can pair them (P4)", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      const tap = createEnvelopeTap({ path });

      tap.write("request", REQUEST, "steps/toolCallRequest");
      tap.write("response", RESPONSE, "steps/toolCallRequest");

      expect(readEntries(path).map((e) => e.rpc_id)).toEqual([7, 7]);
    });
  });

  it("stamps recorded_at from the injected clock", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      const tap = createEnvelopeTap({ path, now: () => new Date("2026-08-09T12:04:31.221Z") });

      tap.write("request", REQUEST, "steps/toolCallRequest");

      expect(readEntries(path)[0]?.recorded_at).toBe("2026-08-09T12:04:31.221Z");
    });
  });

  it("records method as null when the caller cannot determine one", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      createEnvelopeTap({ path }).write("response", { jsonrpc: "2.0", id: null, error: { code: -32700 } }, null);

      const entry = readEntries(path)[0];
      expect(entry?.method).toBeNull();
      expect(entry?.rpc_id).toBeNull();
    });
  });

  // Global constraint 8. This is the whole reason the tap is a module and
  // not three inline appendFileSync calls.
  it("never throws when the log path is unwritable, reports once, and goes quiet", () => {
    withTempDir((dir) => {
      const blocker = join(dir, "envelopes.jsonl");
      writeFileSync(blocker, "");
      // A path *through* a regular file: mkdirSync and appendFileSync both
      // fail with ENOTDIR, deterministically, on every platform.
      const path = join(blocker, "nested", "envelopes.jsonl");
      const errors: unknown[] = [];
      const tap = createEnvelopeTap({ path, onError: (error) => errors.push(error) });

      expect(() => tap.write("request", REQUEST, "steps/toolCallRequest")).not.toThrow();
      expect(() => tap.write("response", RESPONSE, "steps/toolCallRequest")).not.toThrow();
      expect(errors.length).toBe(1);
    });
  });

  it("never throws on an envelope JSON.stringify cannot serialize", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      const errors: unknown[] = [];
      const tap = createEnvelopeTap({ path, onError: (error) => errors.push(error) });
      const circular: Record<string, unknown> = { id: 1 };
      circular.self = circular;

      expect(() => tap.write("request", circular, "steps/toolCallRequest")).not.toThrow();
      expect(errors.length).toBe(1);
    });
  });

  it("NULL_TAP writes nothing and never throws", () => {
    expect(() => NULL_TAP.write("request", REQUEST, "steps/toolCallRequest")).not.toThrow();
    expect(NULL_TAP.path).toBeNull();
  });
});

describe("extractRpcId", () => {
  it("reads string and number ids", () => {
    expect(extractRpcId({ id: 7 })).toBe(7);
    expect(extractRpcId({ id: "abc" })).toBe("abc");
  });

  it("returns null for a missing, null, or non-scalar id", () => {
    expect(extractRpcId({})).toBeNull();
    expect(extractRpcId({ id: null })).toBeNull();
    expect(extractRpcId({ id: { nested: true } })).toBeNull();
    expect(extractRpcId("not an object")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/guardian/test/envelope-tap.test.ts
```

Expected: every test errors on the unresolved import of `../src/envelope-tap.ts`.

- [ ] **Step 3: Minimal implementation** — `packages/guardian/src/envelope-tap.ts`

```ts
/**
 * writeEnvelopeTap (N26) writes S6: a JSONL record of every ACS envelope
 * that crosses this Guardian's wire, in both directions, exactly as it
 * crossed (global constraint 11). The Envelope Inspector (P4) reads this
 * file and nothing else -- see packages/inspector, which deliberately
 * imports nothing from here.
 *
 * Total by construction (global constraint 8). Every write is wrapped: a
 * failure disables the tap for the process lifetime, reports once, and is
 * never propagated to the caller. The tap sits on the decision path, and
 * V1 shipped three separate fail-opens before they were caught -- an
 * observability feature that can turn a governed tool call into an
 * ungoverned one would be the fourth. Observability degrades; governance
 * does not.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TapDirection = "request" | "response";

/**
 * One line of S6. `envelope` is the JSON-RPC object verbatim -- request or
 * response -- and every other field is Guardian-side context the wire does
 * not carry: a sequence number so a reader can detect gaps, a timestamp, the
 * direction, the ACS method (JSON-RPC responses carry none, so the Guardian
 * supplies the one it dispatched), and the JSON-RPC id that pairs the two
 * directions.
 */
export type TapEntry = {
  seq: number;
  recorded_at: string;
  direction: TapDirection;
  method: string | null;
  rpc_id: string | number | null;
  envelope: unknown;
};

export type EnvelopeTap = {
  write(direction: TapDirection, envelope: unknown, method: string | null): void;
  readonly path: string | null;
};

export type CreateEnvelopeTapOptions = {
  path: string;
  /** Injectable clock, so tests can assert recorded_at exactly. */
  now?: () => Date;
  /** Called at most once, on the first failure. Defaults to one stderr line. */
  onError?: (error: unknown) => void;
};

/** The tap a Guardian gets when no envelopeLogPath was configured (P3). */
export const NULL_TAP: EnvelopeTap = {
  path: null,
  write(): void {},
};

/** The JSON-RPC id, when it is a scalar. Both request and response envelopes
 * carry `id` at the top level, so one extractor serves both directions. */
export function extractRpcId(envelope: unknown): string | number | null {
  if (typeof envelope === "object" && envelope !== null && "id" in envelope) {
    const id = (envelope as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}

export function createEnvelopeTap({ path, now = () => new Date(), onError }: CreateEnvelopeTapOptions): EnvelopeTap {
  let seq = 0;
  let disabled = false;

  const fail = (error: unknown): void => {
    disabled = true;
    if (onError) {
      onError(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`envelope tap disabled after failure (${path}): ${message}`);
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    fail(error);
  }

  return {
    path,
    write(direction, envelope, method): void {
      if (disabled) {
        return;
      }
      try {
        const entry: TapEntry = {
          seq: seq + 1,
          recorded_at: now().toISOString(),
          direction,
          method,
          rpc_id: extractRpcId(envelope),
          envelope,
        };
        const line = `${JSON.stringify(entry)}\n`;
        appendFileSync(path, line);
        seq += 1;
      } catch (error) {
        fail(error);
      }
    },
  };
}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/guardian/test/envelope-tap.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```
Add writeEnvelopeTap and S6's JSONL entry format (N26, S6)

Slice: #3
Affordances: N26, S6
```

---

### Task 2: Wire the tap into the Guardian · slice #3 · N26, N20

**Files:**
- Modify: `packages/guardian/src/server.ts` (lines 85-173 — `startGuardian` and `handleAcsRequest`)
- Modify: `packages/guardian/src/index.ts` (append exports)
- Modify: `packages/guardian/src/main.ts` (pass the log path)
- Modify: `.gitignore` (append)
- Test: `packages/guardian/test/envelope-tap-wiring.test.ts`

**Interfaces:**
- Consumes: `createEnvelopeTap`, `NULL_TAP`, `EnvelopeTap` from `./envelope-tap.ts` (Task 1).
- Produces: `StartGuardianOptions.envelopeLogPath?: string`. Task 5's round-trip test passes it.

**Requirements:**

`handleAcsRequest` currently has six `return` sites. Tapping at each is how the seventh gets missed. Restructure it into exactly three phases, so totality is structural rather than remembered:

```
parse  →  (on failure: tap the error response, return)
tap the request  →  dispatch()  →  tap the response  →  return
```

`dispatch()` holds V1's existing logic verbatim — validate, handshake branch, toolCallRequest branch, not-dispatched branch — and returns a response instead of the caller returning it directly. Do not change any decision, any error code, or any message text: this task adds a tap and moves code, nothing else. V1's `packages/guardian/test/server.test.ts` must pass untouched.

Add a best-effort `extractMethod(raw): string | null` beside the existing `extractId`, used only to label tap entries.

- [ ] **Step 1: Write the failing test** — `packages/guardian/test/envelope-tap-wiring.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGuardian } from "../src/index.ts";
import type { TapEntry } from "../src/envelope-tap.ts";

function makeEnvelope(
  method: string,
  payload: Record<string, unknown>,
  overrides: { id?: number; requestId?: string } = {},
): Record<string, unknown> {
  const { id = 1, requestId = crypto.randomUUID() } = overrides;
  return {
    jsonrpc: "2.0",
    method,
    id,
    params: {
      acs_version: "0.1.0",
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: { agent_id: "agent-1", session_id: crypto.randomUUID() },
      payload,
    },
  };
}

function toolCallEnvelope(command: string, overrides: { id?: number } = {}) {
  return makeEnvelope(
    "steps/toolCallRequest",
    { tool: { name: "run_shell" }, arguments: { command: { value: command } } },
    overrides,
  );
}

function readEntries(path: string): TapEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TapEntry);
}

/** Non-recursive cleanup, as in envelope-tap.test.ts. */
async function withGuardian(
  logPathFor: (dir: string) => string,
  run: (url: string, logPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acs-tap-wiring-"));
  const logPath = logPathFor(dir);
  const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml", envelopeLogPath: logPath });
  try {
    await run(guardian.url, logPath);
  } finally {
    await guardian.close();
    try {
      unlinkSync(logPath);
    } catch {
      // some tests deliberately make the path unwritable
    }
    try {
      rmdirSync(dir);
    } catch {
      // a blocker file may remain; the assertions already covered what matters
    }
  }
}

async function postRaw(url: string, body: string): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  return await res.json();
}

const logIn = (dir: string) => join(dir, "envelopes.jsonl");

describe("Guardian envelope tap wiring (N26 x N20)", () => {
  it("taps one request and one response per exchange, paired by rpc_id", async () => {
    await withGuardian(logIn, async (url, logPath) => {
      await postRaw(url, JSON.stringify(toolCallEnvelope("rm -rf /", { id: 11 })));

      const entries = readEntries(logPath);
      expect(entries.length).toBe(2);
      expect(entries[0]?.direction).toBe("request");
      expect(entries[1]?.direction).toBe("response");
      expect(entries[0]?.rpc_id).toBe(11);
      expect(entries[1]?.rpc_id).toBe(11);
      expect(entries[0]?.method).toBe("steps/toolCallRequest");
      expect(entries[1]?.method).toBe("steps/toolCallRequest");
      expect((entries[1]?.envelope as { result?: { decision?: string } }).result?.decision).toBe("deny");
    });
  });

  it("taps handshake/hello in both directions", async () => {
    await withGuardian(logIn, async (url, logPath) => {
      await postRaw(url, JSON.stringify(makeEnvelope("handshake/hello", {}, { id: 42 })));

      const entries = readEntries(logPath);
      expect(entries.map((e) => e.direction)).toEqual(["request", "response"]);
      expect(entries.every((e) => e.method === "handshake/hello")).toBe(true);
    });
  });

  // Decision P5. The envelope that fails validation is the most useful
  // thing an ACS-first reader can see; tapping after the validator is
  // exactly what would hide it.
  it("taps a schema-invalid request, then its JSON-RPC error response", async () => {
    await withGuardian(logIn, async (url, logPath) => {
      const bad = toolCallEnvelope("rm -rf /", { id: 12 });
      delete (bad.params as Record<string, unknown>).acs_version;

      await postRaw(url, JSON.stringify(bad));

      const entries = readEntries(logPath);
      expect(entries.length).toBe(2);
      expect(entries[0]?.direction).toBe("request");
      expect((entries[0]?.envelope as { params: Record<string, unknown> }).params.acs_version).toBeUndefined();
      const error = (entries[1]?.envelope as { error?: { code: number } }).error;
      expect(error?.code).toBeLessThanOrEqual(-32000);
      expect(error?.code).toBeGreaterThanOrEqual(-32099);
    });
  });

  it("taps an unparseable body as a lone response with rpc_id null -- no request line to pair with", async () => {
    await withGuardian(logIn, async (url, logPath) => {
      await postRaw(url, "{not json");

      const entries = readEntries(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]?.direction).toBe("response");
      expect(entries[0]?.rpc_id).toBeNull();
      expect(entries[0]?.method).toBeNull();
      expect((entries[0]?.envelope as { error?: { code: number } }).error?.code).toBe(-32700);
    });
  });

  // Global constraint 8, end to end: the tap is on the decision path, so
  // this is the test that says a broken tap cannot become a fail-open.
  it("still denies rm -rf / when every tap write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tap-broken-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      envelopeLogPath: join(blocker, "nested", "envelopes.jsonl"),
    });
    try {
      const response = (await postRaw(guardian.url, JSON.stringify(toolCallEnvelope("rm -rf /")))) as {
        result?: { decision?: string };
        error?: unknown;
      };
      expect(response.error).toBeUndefined();
      expect(response.result?.decision).toBe("deny");
    } finally {
      await guardian.close();
      unlinkSync(blocker);
      rmdirSync(dir);
    }
  });

  // Decision P3.
  it("writes nothing when envelopeLogPath is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tap-off-"));
    const logPath = join(dir, "envelopes.jsonl");
    const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
    try {
      await postRaw(guardian.url, JSON.stringify(toolCallEnvelope("ls -la")));
      expect(existsSync(logPath)).toBe(false);
    } finally {
      await guardian.close();
      rmdirSync(dir);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/guardian/test/envelope-tap-wiring.test.ts
```

Expected: `envelopeLogPath` is not a known option, so nothing is written and the first assertion fails on `entries.length` being 0.

- [ ] **Step 3: Minimal implementation**

`packages/guardian/src/server.ts` — add the import, extend the options, create the tap, restructure `handleAcsRequest`:

```ts
import { createEnvelopeTap, NULL_TAP, type EnvelopeTap } from "./envelope-tap.ts";
```

```ts
export type StartGuardianOptions = {
  port: number;
  manifestPath: string;
  mappingPath?: string;
  /** Path to S6, the JSONL envelope log (N26). Omitted means no tap: every
   * V1 test constructs Guardians freely and a default-on tap would scatter
   * files through the working tree. `packages/guardian/src/main.ts` -- the
   * demo path -- passes it. See the plan's decision P3. */
  envelopeLogPath?: string;
};
```

```ts
export async function startGuardian({
  port,
  manifestPath,
  mappingPath,
  envelopeLogPath,
}: StartGuardianOptions): Promise<StartedGuardian> {
  const bridge = createBridge(manifestPath);
  const mapping = loadMapping(mappingPath ?? MAPPING_PATH);
  const tap = envelopeLogPath ? createEnvelopeTap({ path: envelopeLogPath }) : NULL_TAP;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== ACS_PATH) {
        return new Response("Not Found", { status: 404 });
      }
      const response = await handleAcsRequest(req, bridge, mapping, tap);
      return Response.json(response);
    },
  });

  return {
    url: `http://localhost:${server.port}${ACS_PATH}`,
    async close() {
      await server.stop(true);
    },
  };
}
```

Replace `handleAcsRequest` with the three-phase version, and move V1's body into `dispatch` unchanged:

```ts
/**
 * Three phases, in order: parse, tap the request, dispatch, tap the
 * response. The tap calls live here and only here -- `dispatch` below has
 * four return sites and V3 adds a fifth (N27), so tapping inside it would
 * make totality something a future task has to remember rather than
 * something the structure guarantees.
 *
 * The tap itself is total (see envelope-tap.ts): these two calls cannot
 * throw, so they cannot turn a governed tool call into an ungoverned one.
 */
async function handleAcsRequest(
  req: Request,
  bridge: ReturnType<typeof createBridge>,
  mapping: Mapping,
  tap: EnvelopeTap,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    // Nothing parseable arrived, so there is no request envelope to tap --
    // the response is deliberately recorded unpaired, which is what the
    // Inspector renders when a host sends a malformed body.
    const parseError = errorResponse(null, -32700, "Parse error");
    tap.write("response", parseError, null);
    return parseError;
  }

  // Decision P5: before validation, so an envelope that fails the schema is
  // visible to the Inspector rather than invisible.
  const method = extractMethod(raw);
  tap.write("request", raw, method);

  const response = await dispatch(raw, bridge, mapping);
  tap.write("response", response, method);
  return response;
}

async function dispatch(
  raw: unknown,
  bridge: ReturnType<typeof createBridge>,
  mapping: Mapping,
): Promise<JsonRpcSuccess | JsonRpcFailure> {
  const rpcId = extractId(raw);

  let envelope: ToolCallRequestEnvelope;
  try {
    envelope = validateEnvelope(raw);
  } catch (error) {
    if (error instanceof EnvelopeValidationError) {
      return errorResponse(rpcId, ENVELOPE_INVALID_CODE, error.message, { pointer: error.pointer });
    }
    throw error;
  }

  if (envelope.method === HANDSHAKE_METHOD) {
    return successResponse(envelope.id, handshakeResponder());
  }

  if (envelope.method === TOOL_CALL_REQUEST_METHOD) {
    try {
      const snapshot = assembleSnapshot(envelope);
      const { verdict } = await bridge.evaluate("pre_tool_call", snapshot);
      const decision = mapVerdict(verdict, mapping);

      const result: Record<string, unknown> = {
        type: "final",
        acs_version: envelope.params.acs_version,
        request_id: envelope.params.request_id,
        ...decision,
      };
      return successResponse(envelope.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(rpcId, EVALUATION_FAILED_CODE, `evaluation failed: ${message}`);
    }
  }

  return errorResponse(rpcId, METHOD_NOT_DISPATCHED_CODE, `method not dispatched by this Guardian: ${envelope.method}`, {
    method: envelope.method,
  });
}
```

Add beside `extractId`:

```ts
/** Best-effort method name for tap labelling only. Never used to dispatch --
 * `dispatch` reads the schema-validated envelope's own `method`. */
function extractMethod(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "method" in raw) {
    const method = (raw as { method: unknown }).method;
    if (typeof method === "string") {
      return method;
    }
  }
  return null;
}
```

`packages/guardian/src/index.ts` — append:

```ts
export {
  createEnvelopeTap,
  extractRpcId,
  NULL_TAP,
  type CreateEnvelopeTapOptions,
  type EnvelopeTap,
  type TapDirection,
  type TapEntry,
} from "./envelope-tap.ts";
```

`packages/guardian/src/main.ts` — add the constant, the env read, and pass it. Also print the log path, so the operator knows what to point the Inspector at:

```ts
const DEFAULT_ENVELOPE_LOG = ".acs/envelopes.jsonl";
```

```ts
const envelopeLogPath = process.env.ACS_ENVELOPE_LOG ?? DEFAULT_ENVELOPE_LOG;

const guardian = await startGuardian({ port, manifestPath, envelopeLogPath });
console.log(`Guardian listening at ${guardian.url}`);
console.log(`Envelope log (S6): ${envelopeLogPath}`);
```

`.gitignore` — append:

```
# S6, the ACS envelope log (N26). Local demo artifact; carries raw tool
# arguments verbatim, so it is never committed.
.acs/
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/guardian
bun run typecheck
```

V1's `packages/guardian/test/server.test.ts` must still pass unmodified — this task moved code and added a tap, it changed no decision and no error code.

- [ ] **Step 5: Commit**

```
Tap every ACS envelope crossing the Guardian's wire (N26, N20, S6)

Slice: #3
Affordances: N26, N20, S6
```

---

### Task 3: `tailEnvelopeLog()` and the Inspector package · slice #3 · N50

**Files:**
- Create: `packages/inspector/package.json`
- Create: `packages/inspector/src/tail-envelope-log.ts`
- Test: `packages/inspector/test/tail-envelope-log.test.ts`

**Interfaces:**
- Produces: `tailEnvelopeLog(options): AsyncGenerator<TapEntry, void, void>` and the Inspector's **own** `TapEntry` / `TapDirection` types. Task 4's renderers consume `TapEntry`; Task 5's CLI consumes `tailEnvelopeLog`.
- **Does not consume anything from `guardian` or `agt-bridge`** (global constraint 10). `TapEntry` is re-declared here on purpose — Task 5's round-trip test is what keeps the two declarations in agreement.

- [ ] **Step 1: Write the failing test** — `packages/inspector/test/tail-envelope-log.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmdirSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailEnvelopeLog, type TapEntry } from "../src/tail-envelope-log.ts";

const POLL_MS = 10;

function entryLine(seq: number, direction: "request" | "response"): string {
  const entry: TapEntry = {
    seq,
    recorded_at: "2026-08-09T12:04:31.221Z",
    direction,
    method: "steps/toolCallRequest",
    rpc_id: seq,
    envelope: { jsonrpc: "2.0", id: seq },
  };
  return `${JSON.stringify(entry)}\n`;
}

/** Collects `count` entries or rejects after `timeoutMs`, then aborts the
 * generator so the test cannot hang the suite. */
async function collect(
  iterable: AsyncGenerator<TapEntry, void, void>,
  count: number,
  controller: AbortController,
  timeoutMs = 3000,
): Promise<TapEntry[]> {
  const out: TapEntry[] = [];
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const entry of iterable) {
      out.push(entry);
      if (out.length >= count) {
        break;
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return out;
}

function withTempDir(run: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acs-tail-"));
  const path = join(dir, "envelopes.jsonl");
  return run(dir, path).finally(() => {
    try {
      unlinkSync(path);
    } catch {
      // the not-yet-created case never writes one
    }
    rmdirSync(dir);
  });
}

describe("tailEnvelopeLog (N50)", () => {
  it("yields entries appended after the tail starts, skipping what was already there", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, entryLine(1, "request"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, pollMs: POLL_MS, signal: controller.signal });
      // Give the generator a poll to record its starting offset before the
      // append lands, which is the behaviour under test.
      await Bun.sleep(POLL_MS * 3);
      appendFileSync(path, entryLine(2, "response"));

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([2]);
    });
  });

  it("yields pre-existing entries when fromStart is set", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, entryLine(1, "request") + entryLine(2, "response"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      const entries = await collect(tail, 2, controller);
      expect(entries.map((e) => e.seq)).toEqual([1, 2]);
      expect(entries[0]?.direction).toBe("request");
    });
  });

  it("waits for a log file that does not exist yet", async () => {
    await withTempDir(async (_dir, path) => {
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });
      await Bun.sleep(POLL_MS * 3);
      writeFileSync(path, entryLine(1, "request"));

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([1]);
    });
  });

  it("reassembles a line delivered in two chunks", async () => {
    await withTempDir(async (_dir, path) => {
      const line = entryLine(1, "request");
      const split = Math.floor(line.length / 2);
      writeFileSync(path, "");
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      appendFileSync(path, line.slice(0, split));
      await Bun.sleep(POLL_MS * 3);
      appendFileSync(path, line.slice(split));

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([1]);
    });
  });

  it("restarts from zero when the log is truncated underneath it", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, entryLine(1, "request"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      const first = await collectOne(tail);
      expect(first?.seq).toBe(1);

      truncateSync(path, 0);
      await Bun.sleep(POLL_MS * 3);
      appendFileSync(path, entryLine(9, "response"));

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([9]);
    });

    async function collectOne(tail: AsyncGenerator<TapEntry, void, void>): Promise<TapEntry | undefined> {
      const { value } = await tail.next();
      return value ?? undefined;
    }
  });

  it("reports a malformed line and keeps streaming", async () => {
    await withTempDir(async (_dir, path) => {
      const malformed: string[] = [];
      writeFileSync(path, "{not json\n" + entryLine(3, "request"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({
        path,
        fromStart: true,
        pollMs: POLL_MS,
        signal: controller.signal,
        onMalformedLine: (line) => malformed.push(line),
      });

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([3]);
      expect(malformed).toEqual(["{not json"]);
    });
  });

  it("ends when the signal aborts", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, "");
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });
      controller.abort();

      const entries: TapEntry[] = [];
      for await (const entry of tail) {
        entries.push(entry);
      }
      expect(entries).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/inspector
```

Expected: the module does not exist.

- [ ] **Step 3: Minimal implementation**

`packages/inspector/package.json`:

```json
{
  "name": "inspector",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

No `dependencies` block at all — global constraints 10 and 12. Run `bun install` once so the workspace links it.

`packages/inspector/src/tail-envelope-log.ts`:

```ts
/**
 * tailEnvelopeLog (N50) streams S6 -- the Guardian's JSONL envelope log --
 * as it grows, the way `tail -f` does.
 *
 * This package deliberately imports nothing from `guardian` or from
 * `agt-bridge` (global constraint 10). The Inspector reads a file that the
 * Guardian happens to write; it holds no compile-time knowledge of the
 * process that produced it, which is the point of R5.1 -- envelopes are
 * inspectable *on the wire*, not through our own type graph. TapEntry is
 * therefore re-declared here rather than imported. The round-trip test at
 * test/envelope-tap-roundtrip.test.ts is what keeps the two declarations in
 * agreement; if they drift, it fails.
 *
 * Polling rather than fs.watch: appends to a growing file are exactly the
 * case where watch semantics differ most across platforms, and a 120ms poll
 * on a local demo log costs nothing.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export type TapDirection = "request" | "response";

/** One line of S6, as written by the Guardian's envelope tap. */
export type TapEntry = {
  seq: number;
  recorded_at: string;
  direction: TapDirection;
  method: string | null;
  rpc_id: string | number | null;
  envelope: unknown;
};

export type TailOptions = {
  path: string;
  /** Replay everything already in the file before following. Default false:
   * start at the current end, like `tail -f`. */
  fromStart?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called per unparseable line. Defaults to one stderr warning. Streaming
   * continues either way -- a corrupt line is not a reason to stop showing
   * the ones after it. */
  onMalformedLine?: (line: string, error: unknown) => void;
};

const NEWLINE = 0x0a;

export async function* tailEnvelopeLog({
  path,
  fromStart = false,
  pollMs = 120,
  signal,
  onMalformedLine = warnMalformedLine,
}: TailOptions): AsyncGenerator<TapEntry, void, void> {
  let offset = fromStart ? 0 : sizeOf(path);
  // Bytes, not a string: a poll can land mid-line and, worse, mid-codepoint.
  // Decoding only complete lines keeps multi-byte UTF-8 intact.
  let pending = Buffer.alloc(0);

  while (!signal?.aborted) {
    const size = sizeOf(path);

    if (size < offset) {
      // Truncated or rotated underneath us (`: > .acs/envelopes.jsonl`).
      offset = 0;
      pending = Buffer.alloc(0);
    }

    if (size > offset) {
      pending = Buffer.concat([pending, readRange(path, offset, size - offset)]);
      offset = size;

      let newline = pending.indexOf(NEWLINE);
      while (newline !== -1) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(NEWLINE);

        if (line.trim() === "") {
          continue;
        }
        let entry: TapEntry;
        try {
          entry = JSON.parse(line) as TapEntry;
        } catch (error) {
          onMalformedLine(line, error);
          continue;
        }
        yield entry;
      }
    }

    if (signal?.aborted) {
      return;
    }
    await sleep(pollMs, signal);
  }
}

function sizeOf(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRange(path: string, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function warnMalformedLine(line: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skipping unparseable envelope-log line (${message}): ${line.slice(0, 120)}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun install
bun test packages/inspector
bun run typecheck
```

- [ ] **Step 5: Commit**

```
Add the Inspector package and tailEnvelopeLog (N50)

Slice: #3
Affordances: N50
```

---

### Task 4: The envelope stream and the decision badge · slice #3 · U20, U21

**Files:**
- Create: `packages/inspector/src/render.ts`
- Test: `packages/inspector/test/render.test.ts`

**Interfaces:**
- Consumes: `TapEntry` from `./tail-envelope-log.ts` (Task 3).
- Produces: `renderEntry(entry, options?): string` (U20) and `renderDecisionBadge(entry, options?): string | null` (U21), plus `type RenderOptions = { color?: boolean; indent?: number }`. Task 5's CLI calls `renderEntry`.

**Requirements:**

Both functions are pure — no `process`, no env reads, no clock. `color` defaults to `false` so tests assert plain strings; the CLI decides whether the terminal wants ANSI.

`renderDecisionBadge` returns `null` for requests and for responses that carry no decision (a ServerHello is the live example). Its states:

| Response shape | Badge | Colour |
|---|---|---|
| `error` present | `✖ ERROR <code>` + message | red |
| `result.decision === "deny"` | `● DENY` | red |
| `result.decision === "allow"` with non-empty `policy_references` | `◐ ALLOW (policy fired — ACS "warn")` | yellow |
| `result.decision === "allow"` | `○ ALLOW` | green |
| any other decision (`modify`, `ask`, `defer`) | `◆ <DECISION>` | cyan |
| neither `result.decision` nor `error` | `null` | — |

The fourth row against the third is the slice's own reason for U21: §V2 says a `warn` arrives as `allow` with a non-empty `policy_references`, "and the badge is what makes that legible rather than buried". A badge that renders both as `ALLOW` fails this slice.

`reason_codes` and `policy_references` are appended when present, as `reason_codes=[a, b]` and `policy_references=[policy_id#rule_id]`.

- [ ] **Step 1: Write the failing test** — `packages/inspector/test/render.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { renderDecisionBadge, renderEntry } from "../src/render.ts";
import type { TapEntry } from "../src/tail-envelope-log.ts";

function entry(overrides: Partial<TapEntry>): TapEntry {
  return {
    seq: 3,
    recorded_at: "2026-08-09T12:04:31.221Z",
    direction: "response",
    method: "steps/toolCallRequest",
    rpc_id: 1,
    envelope: {},
    ...overrides,
  };
}

function response(result: Record<string, unknown>): TapEntry {
  return entry({ envelope: { jsonrpc: "2.0", id: 1, result } });
}

describe("renderDecisionBadge (U21)", () => {
  it("returns null for requests", () => {
    expect(renderDecisionBadge(entry({ direction: "request", envelope: { jsonrpc: "2.0", id: 1 } }))).toBeNull();
  });

  it("returns null for a response with no decision -- a ServerHello", () => {
    expect(renderDecisionBadge(response({ negotiated_version: "0.1.0", on_decision_failure: "proceed" }))).toBeNull();
  });

  it("badges a deny, with reason_codes and policy_references", () => {
    const badge = renderDecisionBadge(
      response({
        decision: "deny",
        reason_codes: ["destructive_shell_command_blocked"],
        policy_references: [{ policy_id: "agt_stock", rule_id: "destructive_shell_command_blocked" }],
      }),
    );

    expect(badge).toBe(
      "● DENY  reason_codes=[destructive_shell_command_blocked]  " +
        "policy_references=[agt_stock#destructive_shell_command_blocked]",
    );
  });

  it("badges a plain allow", () => {
    expect(renderDecisionBadge(response({ decision: "allow" }))).toBe("○ ALLOW");
  });

  // The reason U21 exists, per the slices doc: an AGT `warn` arrives as an
  // ACS `allow` with a non-empty policy_references, and the badge is what
  // keeps it from being buried.
  it("distinguishes an allow that carries policy_references -- ACS's encoding of warn", () => {
    const badge = renderDecisionBadge(
      response({
        decision: "allow",
        reason_codes: ["drift_detected"],
        policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }],
      }),
    );

    expect(badge).toBe(
      '◐ ALLOW (policy fired — ACS "warn")  reason_codes=[drift_detected]  ' +
        "policy_references=[agt_stock#drift_detected]",
    );
    expect(badge).not.toBe(renderDecisionBadge(response({ decision: "allow" })));
  });

  it("badges modify, ask, and defer", () => {
    expect(renderDecisionBadge(response({ decision: "modify" }))).toBe("◆ MODIFY");
    expect(renderDecisionBadge(response({ decision: "ask" }))).toBe("◆ ASK");
    expect(renderDecisionBadge(response({ decision: "defer" }))).toBe("◆ DEFER");
  });

  it("badges a JSON-RPC error", () => {
    const badge = renderDecisionBadge(
      entry({ envelope: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "ACS envelope failed" } } }),
    );

    expect(badge).toBe("✖ ERROR -32010  ACS envelope failed");
  });

  it("emits ANSI only when colour is asked for", () => {
    const plain = renderDecisionBadge(response({ decision: "deny" }), { color: false });
    const coloured = renderDecisionBadge(response({ decision: "deny" }), { color: true });

    expect(plain).toBe("● DENY");
    expect(coloured).toContain("\u001b[");
    expect(coloured).toContain("DENY");
  });
});

describe("renderEntry (U20)", () => {
  it("renders a request as a header line plus pretty JSON, with no badge", () => {
    const rendered = renderEntry(
      entry({
        direction: "request",
        seq: 1,
        envelope: { jsonrpc: "2.0", method: "steps/toolCallRequest", id: 1 },
      }),
    );

    expect(rendered.split("\n")[0]).toBe("── #1  12:04:31.221  → REQUEST   steps/toolCallRequest  id=1");
    expect(rendered).toContain('"jsonrpc": "2.0"');
    expect(rendered).not.toContain("●");
  });

  it("renders a response as a header line, a badge line, then pretty JSON", () => {
    const rendered = renderEntry(response({ decision: "deny", reason_codes: ["blocked"] }));
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("── #3  12:04:31.221  ← RESPONSE  steps/toolCallRequest  id=1");
    expect(lines[1]).toBe("● DENY  reason_codes=[blocked]");
    expect(lines[2]).toBe("{");
  });

  it("labels an unpaired response -- the malformed-body case -- without an id or a method", () => {
    const rendered = renderEntry(
      entry({ method: null, rpc_id: null, envelope: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } }),
    );

    expect(rendered.split("\n")[0]).toBe("── #3  12:04:31.221  ← RESPONSE  (no method)  (unpaired)");
  });

  it("keeps the envelope verbatim -- pretty-printing only reshapes whitespace", () => {
    const envelope = { jsonrpc: "2.0", id: 1, result: { decision: "allow", nested: { deep: [1, 2] } } };
    const rendered = renderEntry(entry({ envelope }));
    const jsonStart = rendered.indexOf("{");

    expect(JSON.parse(rendered.slice(jsonStart))).toEqual(envelope);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test packages/inspector/test/render.test.ts
```

- [ ] **Step 3: Minimal implementation** — `packages/inspector/src/render.ts`

```ts
/**
 * U20 (envelope stream) and U21 (decision badge).
 *
 * Both functions are pure: no clock, no env, no process. The CLI decides
 * whether the terminal wants ANSI and passes `color`; tests assert exact
 * plain strings. Nothing here knows what produced a decision -- the badge
 * reads ACS's own `decision`, `reason_codes`, and `policy_references`
 * fields and nothing else (global constraint 9).
 */
import type { TapEntry } from "./tail-envelope-log.ts";

export type RenderOptions = { color?: boolean; indent?: number };

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";

type PolicyReference = { policy_id?: string; policy_version?: string; rule_id?: string };
type DecisionResult = {
  decision?: unknown;
  reason_codes?: unknown;
  policy_references?: unknown;
};
type ResponseEnvelope = { result?: DecisionResult; error?: { code?: unknown; message?: unknown } };

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

/** `2026-08-09T12:04:31.221Z` -> `12:04:31.221`. Sliced, not parsed: UTC and
 * locale-independent, so rendered output is the same everywhere. */
function clockOf(recordedAt: string): string {
  const time = recordedAt.slice(11, 23);
  return time.length === 12 ? time : recordedAt;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function referenceList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is PolicyReference => typeof item === "object" && item !== null)
    .map((ref) => (ref.rule_id ? `${ref.policy_id ?? "?"}#${ref.rule_id}` : `${ref.policy_id ?? "?"}`));
}

/** U21. Null when this entry carries no decision and no error: a request, or
 * a response such as a ServerHello. */
export function renderDecisionBadge(entry: TapEntry, options: RenderOptions = {}): string | null {
  if (entry.direction !== "response") {
    return null;
  }
  const color = options.color ?? false;
  const envelope = (typeof entry.envelope === "object" && entry.envelope !== null ? entry.envelope : {}) as ResponseEnvelope;

  if (envelope.error) {
    const code = typeof envelope.error.code === "number" ? envelope.error.code : "?";
    const message = typeof envelope.error.message === "string" ? envelope.error.message : "";
    return paint(`✖ ERROR ${code}${message ? `  ${message}` : ""}`, RED, color);
  }

  const result = envelope.result;
  if (!result || typeof result.decision !== "string") {
    return null;
  }

  const reasonCodes = stringList(result.reason_codes);
  const references = referenceList(result.policy_references);

  let head: string;
  if (result.decision === "deny") {
    head = paint("● DENY", RED, color);
  } else if (result.decision === "allow" && references.length > 0) {
    // ACS has no `warn`; a policy that fired but let the action proceed
    // arrives as `allow` with a non-empty policy_references. Rendering it
    // identically to a clean allow is exactly what this badge exists to
    // prevent (slices doc, §V2).
    head = paint('◐ ALLOW (policy fired — ACS "warn")', YELLOW, color);
  } else if (result.decision === "allow") {
    head = paint("○ ALLOW", GREEN, color);
  } else {
    head = paint(`◆ ${result.decision.toUpperCase()}`, CYAN, color);
  }

  const parts = [head];
  if (reasonCodes.length > 0) {
    parts.push(`reason_codes=[${reasonCodes.join(", ")}]`);
  }
  if (references.length > 0) {
    parts.push(`policy_references=[${references.join(", ")}]`);
  }
  return parts.join("  ");
}

/** U20. Header line, optional badge line, then the envelope as pretty JSON --
 * the same bytes that crossed the wire, only re-indented. */
export function renderEntry(entry: TapEntry, options: RenderOptions = {}): string {
  const color = options.color ?? false;
  const arrow = entry.direction === "request" ? "→ REQUEST " : "← RESPONSE";
  const method = entry.method ?? "(no method)";
  const id = entry.rpc_id === null ? "(unpaired)" : `id=${entry.rpc_id}`;

  const header = paint(`── #${entry.seq}  ${clockOf(entry.recorded_at)}  ${arrow}  ${method}  ${id}`, DIM, color);
  const badge = renderDecisionBadge(entry, options);
  const body = JSON.stringify(entry.envelope, null, options.indent ?? 2);

  return [header, ...(badge === null ? [] : [badge]), body].join("\n");
}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test packages/inspector
bun run typecheck
```

- [ ] **Step 5: Commit**

```
Render the envelope stream and the decision badge (U20, U21)

Slice: #3
Affordances: U20, U21
```

---

### Task 5: The Inspector CLI and the tap↔tail contract test · slice #3 · U20, U21, N50, N26

**Files:**
- Create: `packages/inspector/src/main.ts`
- Create: `packages/inspector/src/index.ts`
- Modify: `package.json` (add the `inspector` script)
- Test: `test/envelope-tap-roundtrip.test.ts`

**Interfaces:**
- Consumes: `tailEnvelopeLog` (Task 3), `renderEntry` (Task 4), `startGuardian` with `envelopeLogPath` (Task 2).
- Produces: `bun run inspector`.

**Requirements:**

The round-trip test is the point of this task, not the CLI. Constraint 10 has the Inspector declaring its own `TapEntry` instead of importing the Guardian's; that duplication is only safe while something fails when they drift. This test writes through the real Guardian tap and reads through the real Inspector tail, so a field renamed on either side breaks it.

- [ ] **Step 1: Write the failing test** — `test/envelope-tap-roundtrip.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGuardian } from "../packages/guardian/src/index.ts";
import { tailEnvelopeLog, type TapEntry } from "../packages/inspector/src/tail-envelope-log.ts";
import { renderDecisionBadge } from "../packages/inspector/src/render.ts";

/**
 * The contract test for S6. The Guardian writes the log; the Inspector
 * declares its own TapEntry and reads it back (global constraint 10). If
 * either side renames a field, adds a required one, or changes a type, this
 * is what fails -- nothing else would, because the two never share a type.
 */
function toolCallEnvelope(command: string, id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "steps/toolCallRequest",
    id,
    params: {
      acs_version: "0.1.0",
      request_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      metadata: { agent_id: "agent-1", session_id: crypto.randomUUID() },
      payload: { tool: { name: "run_shell" }, arguments: { command: { value: command } } },
    },
  };
}

async function take(
  tail: AsyncGenerator<TapEntry, void, void>,
  count: number,
  controller: AbortController,
): Promise<TapEntry[]> {
  const out: TapEntry[] = [];
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    for await (const entry of tail) {
      out.push(entry);
      if (out.length >= count) {
        break;
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return out;
}

describe("S6 round trip: Guardian tap (N26) -> Inspector tail (N50) -> badge (U21)", () => {
  it("a denied tool call arrives as a paired request/response the Inspector can render", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-roundtrip-"));
    const logPath = join(dir, "envelopes.jsonl");
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      envelopeLogPath: logPath,
    });
    const controller = new AbortController();

    try {
      await fetch(guardian.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toolCallEnvelope("rm -rf /", 77)),
      });

      const tail = tailEnvelopeLog({ path: logPath, fromStart: true, pollMs: 10, signal: controller.signal });
      const [request, response] = await take(tail, 2, controller);

      // Every field the Inspector's TapEntry declares must actually be
      // present and correctly typed on what the Guardian wrote.
      expect(request?.seq).toBe(1);
      expect(response?.seq).toBe(2);
      expect(typeof request?.recorded_at).toBe("string");
      expect(request?.direction).toBe("request");
      expect(response?.direction).toBe("response");
      expect(request?.method).toBe("steps/toolCallRequest");
      expect(request?.rpc_id).toBe(77);
      expect(response?.rpc_id).toBe(77);

      // ...and the badge reads a real AGT-backed decision off it.
      expect(renderDecisionBadge(response as TapEntry)).toContain("DENY");
    } finally {
      controller.abort();
      await guardian.close();
      unlinkSync(logPath);
      rmdirSync(dir);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bun test test/envelope-tap-roundtrip.test.ts
```

- [ ] **Step 3: Minimal implementation**

`packages/inspector/src/index.ts`:

```ts
/** Public surface of the inspector package. */
export { tailEnvelopeLog, type TailOptions, type TapDirection, type TapEntry } from "./tail-envelope-log.ts";
export { renderDecisionBadge, renderEntry, type RenderOptions } from "./render.ts";
```

`packages/inspector/src/main.ts`:

```ts
/**
 * The Envelope Inspector's entrypoint -- `bun run inspector`.
 *
 * A third terminal beside `bun run guardian` and `claude`: it tails S6 and
 * prints each ACS envelope as it crosses the wire. Not re-exported from
 * ./index.ts -- this is a process entrypoint, not a library call.
 *
 * `ACS_ENVELOPE_LOG` defaults to `.acs/envelopes.jsonl`, the same default
 * packages/guardian/src/main.ts writes to, so the two agree without either
 * hardcoding the other's value.
 */
import { tailEnvelopeLog } from "./tail-envelope-log.ts";
import { renderEntry } from "./render.ts";

const DEFAULT_ENVELOPE_LOG = ".acs/envelopes.jsonl";

const argv = process.argv.slice(2);
const fromStart = argv.includes("--from-start");
const pathFlag = argv.indexOf("--path");
const flagValue = pathFlag === -1 ? undefined : argv[pathFlag + 1];

if (pathFlag !== -1 && (flagValue === undefined || flagValue.startsWith("--"))) {
  console.error("usage: bun run inspector -- [--from-start] [--path <envelope log>]");
  process.exit(2);
}

const path = flagValue ?? process.env.ACS_ENVELOPE_LOG ?? DEFAULT_ENVELOPE_LOG;
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

console.log(`Envelope Inspector — tailing ${path}${fromStart ? " (from the start)" : ""}`);
console.log("Ctrl-C to stop.\n");

for await (const entry of tailEnvelopeLog({ path, fromStart, signal: controller.signal })) {
  console.log(renderEntry(entry, { color }));
  console.log("");
}
```

Root `package.json` — add to `scripts`:

```json
"inspector": "bun run packages/inspector/src/main.ts"
```

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test
bun run typecheck
```

Then confirm the CLI itself runs, against the tree's own log path:

```bash
ACS_ENVELOPE_LOG=/dev/null timeout 2 bun run inspector || true
```

Expected: it prints the two header lines and waits — no crash, no stack trace.

- [ ] **Step 5: Commit**

```
Add the Inspector CLI and the S6 round-trip contract test (U20, U21, N50)

Slice: #3
Affordances: U20, U21, N50, N26
```

---

### Task 6: The R5.2 gate, the runbook, and a live run · slice #3 · R5.1, R5.2, R7.1

**Files:**
- Modify: `test/invariants.test.ts` (append two `it` blocks inside the existing `describe`)
- Create: `docs/demos/v2-runbook.md`
- Modify: `slices/v2/README.md`
- Modify: `README.md` (Quickstart, What this proves, Status, Verify)

**Interfaces:**
- Consumes: `readSourceFiles` and `assertNoVocabulary`, already module-scoped in `test/invariants.test.ts`.

**Requirements:**

R5.2 — "an ACS-first reader can trace one action end to end without reading AGT source" — becomes a property of the code: the tool that renders the trace names neither AGT nor any host, and imports neither. V1 established that this project turns its architectural claims into grep gates rather than prose, and the same reasoning applies here.

Then **run the thing**, all three processes, and write the runbook from what actually appeared — not from what this plan predicts. If the output differs from what is written here, the output is right and the runbook says what happened.

- [ ] **Step 1: Write the failing test** — append inside `describe("architectural invariants", ...)` in `test/invariants.test.ts`

```ts
  /**
   * R5.2 -- "an ACS-first reader can trace one action end to end without
   * reading AGT source". The Inspector is that reader's tool, so the claim
   * is only real if the tool itself knows nothing about AGT and nothing
   * about any particular host: it renders ACS envelopes as data. Both term
   * lists from the two gates above apply to it at once.
   */
  it("the Envelope Inspector's source contains zero AGT vocabulary and zero host vocabulary", () => {
    assertNoVocabulary("packages/inspector/src", [
      "agt",
      "AgentControl",
      "rego",
      "opa",
      "intervention_point",
      "verdict",
      "claude",
      "opencode",
      "hookSpecificOutput",
      "permissionDecision",
      "stdin",
    ]);
  });

  /**
   * R5.1 -- envelopes are inspectable *on the wire*. If the Inspector
   * imported the Guardian's types, "inspectable" would be a claim about our
   * own type graph instead: any third-party reader of S6 has only the file.
   * So does this one.
   */
  it("the Envelope Inspector imports nothing from the Guardian or the AGT bridge", () => {
    for (const { file, code } of readSourceFiles("packages/inspector/src")) {
      for (const spec of ["guardian", "agt-bridge"]) {
        const found = new RegExp(`from\\s+["'][^"']*${spec}[^"']*["']`).test(code);
        expect({ file, spec, found }).toEqual({ file, spec, found: false });
      }
    }
  });
```

- [ ] **Step 2: Run it, expect PASS immediately, then prove the gate bites**

```bash
bun test test/invariants.test.ts
```

A gate that has never failed is not known to work. Temporarily add `import { NULL_TAP } from "guardian";` to `packages/inspector/src/render.ts`, re-run, and confirm **both** new tests fail. Then revert it and confirm they pass again. Record both outcomes in the task report.

- [ ] **Step 3: Run the demo live, then write it down**

Three terminals, from a clean tree:

```bash
# 1
bun run guardian
# 2
bun run inspector
# 3
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | bun run hosts/claude-code/acs-hook.ts
echo '{"session_id":"demo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | bun run hosts/claude-code/acs-hook.ts
```

Then the same through a real `claude` session, with `hosts/claude-code/settings.json` copied into `.claude/settings.json` as V1's quickstart describes.

Write `docs/demos/v2-runbook.md` from the captured output. It must contain:
- the three-terminal setup, in order, and why the Guardian starts first (it creates `.acs/`);
- **real** pasted Inspector output for the deny and for the allow — the actual bytes, not a reconstruction;
- the note that `.acs/envelopes.jsonl` carries raw tool arguments verbatim and is gitignored for that reason;
- `: > .acs/envelopes.jsonl` as the way to clear the log mid-demo, and that the Inspector picks up cleanly afterwards because `tailEnvelopeLog` resets on truncation;
- `bun run inspector -- --from-start` to replay a session already recorded;
- the honest boundary: a schema-invalid envelope shows as a JSON-RPC **error**, not a `deny` decision. N27 — the affordance that turns Guardian-side failures into decisions — is V3. Say so, and say where.

Update `slices/v2/README.md` to V1's shape: demo sentence, master-doc link, affordances, "What this slice delivers", and what is explicitly *not* in it (U22 session chain → V6; U23 posture badge and N51 → V3).

Update `README.md`:
- **Quickstart**: a third step for `bun run inspector`, and the Guardian's new `Envelope log (S6)` line in its startup output.
- **What this proves → Delivered**: a row for R5.1 — every hook firing is inspectable as an ACS envelope, in both directions, including envelopes that fail validation — pointing at `test/envelope-tap-roundtrip.test.ts` and `packages/guardian/test/envelope-tap-wiring.test.ts`.
- **Verify**: the test count, re-read from a real `bun test` run. Do not carry V1's number forward and do not estimate it.
- **Status**: V2 implemented; V3–V8 shaped but not started.

- [ ] **Step 4: Run it, expect PASS**

```bash
bun test
bun run typecheck
```

- [ ] **Step 5: Commit**

```
Gate the Inspector on R5.1/R5.2, add the V2 runbook and quickstart

Slice: #3
Affordances: U20, U21, N26, N50, S6
```

---

## Risks

| # | Risk | Handling |
|---|---|---|
| 1 | A partially-written line is read mid-append and mis-parsed | `tailEnvelopeLog` buffers **bytes** and decodes only up to a newline, so a split line — or a split UTF-8 codepoint — is held until it completes. Task 3 tests it directly. |
| 2 | The tap becomes a fourth fail-open | Global constraint 8, `createEnvelopeTap`'s total-by-construction design, and Task 2's end-to-end test asserting `rm -rf /` is still denied when every tap write fails. |
| 3 | S6 grows without bound | Accepted for V2 and recorded in the slices doc. It is a gitignored local demo artifact; `: > .acs/envelopes.jsonl` truncates it safely mid-run because the tail resets on truncation. Rotation is not built. |
| 4 | The Inspector's duplicated `TapEntry` silently drifts from the Guardian's | Task 5's round-trip test exercises both real implementations against one file. |
| 5 | S6 contains sensitive tool arguments | Constraint 11 says record the wire verbatim — a redacting tap would make the Inspector lie. Handled by gitignoring `.acs/` and stating it in the runbook and the README, not by filtering. |
