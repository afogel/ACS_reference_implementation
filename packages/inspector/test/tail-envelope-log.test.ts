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
