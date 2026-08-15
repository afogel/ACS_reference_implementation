import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendContextEntry,
  createMemorySessionContextStore,
  type SessionContextEntry as AdapterSessionContextEntry,
} from "guardian";
// Not a bare "inspector" specifier: that string is a Node/Bun built-in
// module name (`node:inspector`), which core-module resolution picks over
// any workspace package of the same name with no way for us to override it.
// test/envelope-log-sink-roundtrip.test.ts and test/audit-sink-roundtrip.test.ts
// sidestep the same collision the same way, importing the specific submodule
// directly rather than through the barrel; this file does the same.
import {
  tailSessionContextLog,
  type SessionContextLogEntry as InspectorSessionContextLogEntry,
} from "../packages/inspector/src/tail-session-context.ts";

/**
 * The contract test that keeps two independent SessionContextLogEntry
 * declarations honest -- the same job test/audit-sink-roundtrip.test.ts and
 * test/envelope-log-sink-roundtrip.test.ts do for their own pairs, and the
 * reason the R5.1 import gate is meaningful rather than merely inconvenient.
 * The Inspector declares its own type BECAUSE it must not import the
 * Guardian's; that duplication is only safe while something fails when the
 * two drift.
 *
 * This file is the only place in the tree that imports both sides.
 */
const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-session-context-rt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir)) unlinkSync(join(dir, entry));
    rmdirSync(dir);
  }
});

/**
 * The first entry the Inspector's tailer yields, or a failure that SAYS SO.
 *
 * Bounded rather than a bare `for await`, for the same reason
 * test/audit-sink-roundtrip.test.ts's own `firstEntry` is: if the Inspector's
 * shape validator tightens past what the store writes, the line stops being
 * yielded, the loop never completes, and the test dies of a bun-test timeout
 * whose message points nowhere near the drift. Bounded here instead, so the
 * same drift fails with a sentence naming it.
 */
async function firstEntry(path: string, timeoutMs = 1000): Promise<InspectorSessionContextLogEntry> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const entry of tailSessionContextLog({
      path,
      fromStart: true,
      pollMs: 10,
      signal: controller.signal,
      // A line the validator rejects reaches this instead of the consumer,
      // and its text is what makes the failure below diagnosable.
      onMalformedLine: (line, error) => rejected.push({ line, error }),
    })) {
      return entry;
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  const detail =
    rejected.length > 0
      ? `its shape validator rejected the line the store wrote: ${String(
          rejected[0]?.error instanceof Error ? rejected[0]?.error.message : rejected[0]?.error,
        )} -- ${rejected[0]?.line}`
      : "no line was rejected either, so the entry never reached the tailer at all";
  throw new Error(`the Inspector's tailer yielded no entry within ${timeoutMs}ms: ${detail}`);
}

/** Populated by `firstEntry`'s malformed-line reporter; read only when it
 * has to explain a failure. Reset per test so one test's rejection cannot
 * be reported as another's. */
let rejected: { line: string; error: unknown }[] = [];
afterEach(() => {
  rejected = [];
});

/**
 * The drift direction `toEqual` cannot see. The assertion below compares
 * RUNTIME values, and the tailer yields the parsed JSON object whole -- so
 * dropping a field from the Inspector's TYPE changes nothing at runtime and
 * fails nothing, even though the two declarations have then stopped being
 * one contract. These two assignments are the check, and they are enforced
 * by `bun run typecheck` rather than by `bun test`: a field on either side
 * that the other lacks makes one of them fail to compile, in the direction
 * that names which side lost it.
 *
 * `Required<>` on both sides, not the bare types -- same reasoning as
 * test/audit-sink-roundtrip.test.ts's own version of this check: every field
 * on `SessionContextEntry` happens to be required today, so `Required<>` is
 * a no-op now, but it is what keeps this check meaningful the day a field
 * here becomes optional on one side and not the other.
 *
 * Deliberately not `as` casts between the two, and deliberately not
 * exported -- an `as` here would silence exactly what is being checked.
 */
type SameKeys<Writer, Reader> = [keyof Writer] extends [keyof Reader]
  ? [keyof Reader] extends [keyof Writer]
    ? true
    : { writerIsMissing: Exclude<keyof Reader, keyof Writer> }
  : { readerIsMissing: Exclude<keyof Writer, keyof Reader> };

const _entryFieldsMatch: SameKeys<Required<AdapterSessionContextEntry>, Required<InspectorSessionContextLogEntry>> =
  true;
const _inspectorAcceptsWhatTheStoreWrites: Required<InspectorSessionContextLogEntry> =
  {} as Required<AdapterSessionContextEntry>;
void _entryFieldsMatch;
void _inspectorAcceptsWhatTheStoreWrites;

describe("S3 write -> U22 read: every field survives", () => {
  it("round-trips a Guardian-written entry through the Inspector's own declaration", async () => {
    const path = join(scratch(), "session-context.jsonl");
    // `createMemorySessionContextStore`'s real `append` -- the same code
    // packages/guardian/src/server.ts wires a live Guardian to -- is what
    // builds the entry and computes its hash. Only the file-append itself is
    // supplied here, mirroring what server.ts's own (unexported)
    // `createSessionContextLogAppender` does: append the line plus one
    // newline.
    const store = createMemorySessionContextStore({
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      appendLine: (line) => appendFileSync(path, `${line}\n`),
    });

    const written = appendContextEntry(store, "sess-1", {
      method: "steps/toolCallRequest",
      request_id: "req-1",
      tool_name: "run_shell",
    });

    // toEqual, not toMatchObject: an extra field on either side is drift,
    // and drift is exactly what this test exists to catch. Compared against
    // the real object the store returned, not a hand-copied literal, so the
    // comparison cannot itself drift out of step with the writer's fields.
    expect(await firstEntry(path)).toEqual(written);
  });
});
