import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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

const EVENT = {
  session_id: "sess-1",
  method: "steps/toolCallRequest",
  rpc_id: "req-1",
  posture: "proceed",
  posture_source: "negotiated",
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
    writeFileSync(blocker, "x");

    const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: (e) => errors.push(e) });
    expect(() => sink.write(EVENT)).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("disables itself after the first failure rather than reporting per call", () => {
    const errors: unknown[] = [];
    const dir = scratch();
    const blocker = join(dir, "blocker2");
    writeFileSync(blocker, "x");
    const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: (e) => errors.push(e) });
    sink.write(EVENT);
    sink.write(EVENT);
    sink.write(EVENT);
    expect(errors).toHaveLength(1);
  });

  it("does not throw when onError itself throws", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker3");
    writeFileSync(blocker, "x");
    const sink = createAuditSink({
      path: join(blocker, "audit.jsonl"),
      onError: () => {
        throw new Error("reporter is broken too");
      },
    });
    expect(() => sink.write(EVENT)).not.toThrow();
  });

  // A judgement call the brief left open: a failed write must not consume a
  // sequence number. Concretely, that can only mean one thing an outside
  // observer can check: a failed write leaves no entry -- of any seq -- on
  // disk at all. (The sink disables itself permanently on the first
  // failure, per constraint 1, so there is never a *later* successful write
  // on the same instance whose seq could reveal a skipped or reused number;
  // the file itself is the only externally visible record, and it is the
  // thing this test inspects.)
  it("a failed write persists no entry: it does not invent a seq that was never recorded", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker4");
    writeFileSync(blocker, "x");
    const path = join(blocker, "audit.jsonl");
    const sink = createAuditSink({ path, onError: () => {} });

    sink.write(EVENT);

    // Not merely "no throw" -- the target file was never created, so there
    // is no half-written or wrongly-numbered line sitting on disk either.
    expect(existsSync(path)).toBe(false);
  });

  it("seq counts successful writes only: a fresh sink after an unrelated failure still starts at 1", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker5");
    writeFileSync(blocker, "x");
    const failingSink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: () => {} });
    failingSink.write(EVENT);
    failingSink.write(EVENT);

    const goodPath = join(dir, "audit.jsonl");
    createAuditSink({ path: goodPath }).write(EVENT);
    expect(readEntries(goodPath).map((e) => e.seq)).toEqual([1]);
  });
});

describe("NULL_AUDIT_SINK", () => {
  it("accepts writes and reports no path", () => {
    expect(NULL_AUDIT_SINK.path).toBeNull();
    expect(() => NULL_AUDIT_SINK.write(EVENT)).not.toThrow();
  });
});
