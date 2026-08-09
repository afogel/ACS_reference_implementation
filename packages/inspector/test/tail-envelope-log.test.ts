import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmdirSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("keeps streaming, without crashing, when the log file is unlinked and later reappears", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, entryLine(1, "request"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      const first = await collectOne(tail);
      expect(first?.seq).toBe(1);

      unlinkSync(path);
      await Bun.sleep(POLL_MS * 3);
      writeFileSync(path, entryLine(9, "response"));

      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([9]);
    });

    async function collectOne(tail: AsyncGenerator<TapEntry, void, void>): Promise<TapEntry | undefined> {
      const { value } = await tail.next();
      return value ?? undefined;
    }
  });

  it("does not start polling until the caller asks for a value", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, "");
      const malformed: string[] = [];
      const controller = new AbortController();
      const tail = tailEnvelopeLog({
        path,
        fromStart: true,
        pollMs: POLL_MS,
        signal: controller.signal,
        onMalformedLine: (line) => malformed.push(line),
      });

      appendFileSync(path, "{not json\n");
      // Several poll intervals pass with nobody ever calling next(). If a
      // timer had started at construction time rather than on first
      // consumption, this malformed line would already have been reported.
      await Bun.sleep(POLL_MS * 5);
      expect(malformed).toEqual([]);

      appendFileSync(path, entryLine(4, "request"));
      const entries = await collect(tail, 1, controller);
      expect(entries.map((e) => e.seq)).toEqual([4]);
      expect(malformed).toEqual(["{not json"]);
    });
  });

  it("reassembles a line split across two writes when a poll lands on the partial write first", async () => {
    await withTempDir(async (_dir, path) => {
      const line = entryLine(1, "request");
      const split = Math.floor(line.length / 2);
      writeFileSync(path, "");
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      appendFileSync(path, line.slice(0, split));
      // Start consuming now, while only the first chunk is on disk, so the
      // (now lazily-started) timer is actually running and gets several
      // ticks against a partial line before the second chunk lands. This is
      // the case the test above this one no longer exercises: there,
      // consumption doesn't begin until after both chunks are already
      // written, so the first poll ever run sees the complete line in one
      // shot.
      const collecting = collect(tail, 1, controller);
      await Bun.sleep(POLL_MS * 5);
      appendFileSync(path, line.slice(split));

      const entries = await collecting;
      expect(entries.map((e) => e.seq)).toEqual([1]);
    });
  });

  it("reassembles a line whose split lands mid-codepoint, without corrupting the multi-byte character", async () => {
    await withTempDir(async (_dir, path) => {
      const note = "🎉café";
      const entry: TapEntry = {
        seq: 7,
        recorded_at: "2026-08-09T12:04:31.221Z",
        direction: "request",
        method: "steps/toolCallRequest",
        rpc_id: 7,
        envelope: { jsonrpc: "2.0", id: 7, note },
      };
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.from(line, "utf8");
      const emojiStart = bytes.indexOf(Buffer.from("🎉", "utf8"));
      // Split mid-way through the emoji's 4-byte UTF-8 sequence, so neither
      // chunk on its own is valid UTF-8 -- exactly what a buffer that
      // decoded each poll's bytes to a string before concatenating would
      // corrupt into a replacement character.
      const splitAt = emojiStart + 2;
      writeFileSync(path, "");
      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path, fromStart: true, pollMs: POLL_MS, signal: controller.signal });

      appendFileSync(path, bytes.subarray(0, splitAt));
      const collecting = collect(tail, 1, controller);
      await Bun.sleep(POLL_MS * 5);
      appendFileSync(path, bytes.subarray(splitAt));

      const entries = await collecting;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.envelope).toEqual({ jsonrpc: "2.0", id: 7, note });
    });
  });

  it("reports a line that parses as JSON but has a non-string recorded_at, and keeps streaming", async () => {
    await withTempDir(async (_dir, path) => {
      const malformed: string[] = [];
      const badLine = JSON.stringify({
        seq: 1,
        recorded_at: 12345,
        direction: "request",
        method: "steps/toolCallRequest",
        rpc_id: 1,
        envelope: { jsonrpc: "2.0", id: 1 },
      });
      writeFileSync(path, `${badLine}\n${entryLine(3, "request")}`);
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
      expect(malformed).toEqual([badLine]);
    });
  });

  // Whole-branch review, finding 5. `if (added) wake?.()` used to sit after
  // `onMalformedLine(...)` inside the same `try`, so a reporter that threw
  // skipped the wake-up entirely: an entry already pushed to `ready` sat
  // undelivered until some later write -- or the abort -- happened to fire
  // `wake` for an unrelated reason. Reproduced at 300ms of silence before the
  // fix. The good line here is written BEFORE the bad one so that `added` is
  // already true when the throw happens.
  it("delivers an entry parsed before a throwing onMalformedLine, without waiting for another write", async () => {
    await withTempDir(async (_dir, path) => {
      let calls = 0;
      writeFileSync(path, entryLine(1, "request") + "{not json\n");
      const controller = new AbortController();
      const tail = tailEnvelopeLog({
        path,
        fromStart: true,
        pollMs: POLL_MS,
        signal: controller.signal,
        onMalformedLine: () => {
          calls += 1;
          throw new Error("reporter blew up");
        },
      });

      // Raced against a timer rather than read through `collect`, because
      // `collect`'s own deadline calls `controller.abort()` -- and `stop()`
      // fires `wake?.()` on the way out, which is exactly the incidental
      // rescue that made this bug look benign. No further appends and no
      // abort inside the window: the only thing that can deliver entry #1
      // is the wake-up the poll itself owes the drain loop.
      const first = tail.next();
      const outcome = await Promise.race([
        first.then(({ value }) => (value === undefined ? "ended" : `seq:${value.seq}`)),
        Bun.sleep(POLL_MS * 20).then(() => "stranded" as const),
      ]);
      controller.abort();
      await first;

      expect(outcome).toBe("seq:1");
      expect(calls).toBe(1);
    });
  });

  // The other half of finding 5: `offset` is already at `size` by the time a
  // line is scanned, so a batch abandoned mid-scan strands every complete
  // line still in `pending` -- no later tick has anything new to read, and
  // they are never re-scanned. Guarding the reporter at its own call site is
  // what keeps the scan going.
  it("keeps parsing the lines behind a bad one when onMalformedLine throws", async () => {
    await withTempDir(async (_dir, path) => {
      writeFileSync(path, "{not json\n" + entryLine(2, "response") + entryLine(3, "request"));
      const controller = new AbortController();
      const tail = tailEnvelopeLog({
        path,
        fromStart: true,
        pollMs: POLL_MS,
        signal: controller.signal,
        onMalformedLine: () => {
          throw new Error("reporter blew up");
        },
      });

      const entries = await collect(tail, 2, controller, 1000);
      expect(entries.map((e) => e.seq)).toEqual([2, 3]);
    });
  });

  // `poll()`'s outer try/catch was carried through the task loop as "possibly
  // unreachable, definitely untested". It is reachable, and it does not need
  // a lost race to get there: pointing the tail at a directory makes
  // `existsSync` true and `statSync().size` non-zero, so the read is
  // attempted and `readSync` throws EISDIR every tick. Without the catch,
  // that throw leaves a bare timer callback and takes the process down.
  it("survives a read that throws every tick, and resyncs once the path becomes a real file", async () => {
    await withTempDir(async (_dir, path) => {
      const asDirectory = `${path}.d`;
      mkdirSync(asDirectory);
      // Non-zero st_size for a directory, so `size > offset` and the read is
      // actually attempted rather than skipped.
      writeFileSync(join(asDirectory, "child"), "x");

      const controller = new AbortController();
      const tail = tailEnvelopeLog({ path: asDirectory, fromStart: true, pollMs: POLL_MS, signal: controller.signal });
      const collecting = collect(tail, 1, controller, 2000);

      // Several ticks against the unreadable path. The process is still
      // alive on the other side of this sleep, which is the assertion.
      await Bun.sleep(POLL_MS * 5);

      unlinkSync(join(asDirectory, "child"));
      rmdirSync(asDirectory);
      writeFileSync(asDirectory, entryLine(6, "response"));

      const entries = await collecting;
      expect(entries.map((e) => e.seq)).toEqual([6]);
      unlinkSync(asDirectory);
    });
  });

  it("reports a line that parses as JSON but is missing direction, and keeps streaming", async () => {
    await withTempDir(async (_dir, path) => {
      const malformed: string[] = [];
      const badLine = JSON.stringify({
        seq: 1,
        recorded_at: "2026-08-09T12:04:31.221Z",
        method: "steps/toolCallRequest",
        rpc_id: 1,
        envelope: { jsonrpc: "2.0", id: 1 },
      });
      writeFileSync(path, `${badLine}\n${entryLine(3, "request")}`);
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
      expect(malformed).toEqual([badLine]);
    });
  });
});
