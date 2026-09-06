import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
  failure: { kind: "timeout", message: "no response within 5000ms" },
} as const;

function readEntries(path: string): AuditEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("createAuditSink", () => {
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

  // A per-instance counter would number every entry in a session `seq: 1`,
  // since the shipped host builds a fresh sink in a fresh subprocess per
  // hook. That would order nothing, could not exhibit the gap the module's
  // own doc tells a reader to look for, and would render as identical `#1`
  // headers that read as one entry repeated.
  it("continues the numbering a previous sink instance left in the file", () => {
    const path = join(scratch(), "audit.jsonl");
    createAuditSink({ path }).write(EVENT);
    createAuditSink({ path }).write(EVENT);
    expect(readEntries(path).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps counting across many instances, the way a session of hooks does", () => {
    const path = join(scratch(), "audit.jsonl");
    for (let i = 0; i < 4; i += 1) {
      createAuditSink({ path }).write(EVENT);
    }
    expect(readEntries(path).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  // Total: the numbering is a nicety, the entry is the §6.4 MUST. An
  // unreadable or garbled log must cost the former and never the latter.
  it("starts from 1 rather than throwing when the existing log cannot be parsed", () => {
    const path = join(scratch(), "audit.jsonl");
    writeFileSync(path, "{not json\n");
    const sink = createAuditSink({ path });
    expect(sink.write(EVENT)).toBe(true);
    // One prior line, unparseable: it still counts as an entry, so the new
    // one takes 2 rather than colliding with it. Read by hand -- readEntries
    // would choke on the deliberately broken first line.
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] as string) as AuditEntry).seq).toBe(2);
  });

  it("does not reuse a number after a gap left by a lost write", () => {
    const path = join(scratch(), "audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ ...EVENT, seq: 7, recorded_at: "2026-08-10T12:00:00.000Z" })}\n`);
    createAuditSink({ path }).write(EVENT);
    expect(readEntries(path).map((e) => e.seq)).toEqual([7, 8]);
  });

  it("reports whether the entry was recorded", () => {
    const path = join(scratch(), "audit.jsonl");
    expect(createAuditSink({ path }).write(EVENT)).toBe(true);
  });

  it("records a blocked step too, so the Inspector's posture badge can distinguish the two outcomes", () => {
    const path = join(scratch(), "audit.jsonl");
    createAuditSink({ path }).write({ ...EVENT, posture: "deny", outcome: "blocked" });
    const [entry] = readEntries(path);
    expect(entry?.outcome).toBe("blocked");
    expect(entry?.posture).toBe("deny");
  });

  // The one entry shape an incident reviewer has to be able to read off the
  // file alone: a step the Guardian refused. `posture: "proceed"` beside
  // `outcome: "blocked"` is the pair no posture-driven entry can produce, and
  // the Guardian's own code is in `failure.message` because that is the only
  // place it travels -- there is no separate structured field for it, so if
  // this line loses it, an incident review cannot tell which refusal happened.
  it("records a refused step, keeping the refusal's kind and the guardian's code", () => {
    const path = join(scratch(), "audit.jsonl");
    createAuditSink({ path }).write({
      ...EVENT,
      posture: "proceed",
      outcome: "blocked",
      failure: { kind: "refused", message: "guardian refused the envelope with error -32020: evaluation failed" },
    });
    const [entry] = readEntries(path);
    expect(entry?.outcome).toBe("blocked");
    expect(entry?.posture).toBe("proceed");
    expect(entry?.failure.kind).toBe("refused");
    expect(entry?.failure.message).toContain("-32020");
  });

  it("creates the directory it was pointed at", () => {
    const path = join(scratch(), "nested", "audit.jsonl");
    createAuditSink({ path }).write(EVENT);
    expect(readEntries(path)).toHaveLength(1);
    unlinkSync(path);
    rmdirSync(join(path, ".."));
  });
});

describe("createAuditSink — total by construction", () => {
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

  // Totality and silence are different properties: the sink stays total,
  // and it still tells the caller nothing was recorded, so
  // applyFailurePosture can downgrade an unrecorded proceed instead of
  // letting it stand as a silent bypass.
  it("reports false when it could not write, without throwing", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker-false");
    writeFileSync(blocker, "x");
    const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), onError: () => {} });
    expect(sink.write(EVENT)).toBe(false);
    // And every later write too, since the sink has disabled itself.
    expect(sink.write(EVENT)).toBe(false);
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

  // Every other test in this file supplies `onError`, so the branch a caller
  // passing no reporter actually takes -- the `console.error` fallback --
  // needs its own direct coverage. The shipped host is that caller:
  // acs-hook.ts builds its sink with a path and nothing else, so this is the
  // reporting path a real deployment uses when its audit log cannot be
  // written.
  //
  // Spied rather than left to print, so the run stays pristine, and spied
  // rather than silenced by a new production option: adding an option to
  // keep a test quiet would change the shipped code to suit the test, and
  // the branch under test is precisely "no options were given".
  it("falls back to console.error when no reporter is supplied, and still does not throw", () => {
    const dir = scratch();
    const blocker = join(dir, "blocker-default-reporter");
    writeFileSync(blocker, "x");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sink = createAuditSink({ path: join(blocker, "audit.jsonl") });
      expect(() => sink.write(EVENT)).not.toThrow();
      expect(sink.write(EVENT)).toBe(false);
      // Once, not per write: the sink disables itself on the first failure,
      // and the default reporter is subject to the same discipline as a
      // supplied one.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("audit sink disabled");
    } finally {
      errorSpy.mockRestore();
    }
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

  // A failed write must not consume a sequence number. Concretely, that can
  // only mean one thing an outside observer can check: a failed write
  // leaves no entry -- of any seq -- on disk at all. (The sink disables
  // itself permanently on the first failure, so there is never a *later*
  // successful write on the same instance whose seq could reveal a skipped
  // or reused number; the file itself is the only externally visible
  // record, and it is the thing this test inspects.)
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

  // It records nothing, so it says nothing was recorded. Claiming otherwise
  // would make this the one sink able to hide a bypass.
  it("reports false, because it recorded nothing", () => {
    expect(NULL_AUDIT_SINK.write(EVENT)).toBe(false);
  });
});
