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

  it("never throws when onError itself throws at construction time", () => {
    withTempDir((dir) => {
      const blocker = join(dir, "envelopes.jsonl");
      writeFileSync(blocker, "");
      const path = join(blocker, "nested", "envelopes.jsonl");

      expect(() => {
        createEnvelopeTap({
          path,
          onError: () => {
            throw new Error("onError threw");
          },
        });
      }).not.toThrow();
    });
  });

  it("never throws when onError itself throws at write time, and disables the tap", () => {
    withTempDir((dir) => {
      const path = join(dir, "envelopes.jsonl");
      const blocker = join(dir, "envelopes.jsonl");
      writeFileSync(blocker, "");

      const tap = createEnvelopeTap({
        path: join(blocker, "nested", "envelopes.jsonl"),
        onError: () => {
          throw new Error("onError threw");
        },
      });

      expect(() => tap.write("request", REQUEST, "steps/toolCallRequest")).not.toThrow();
      // Tap should be disabled, so second write is a silent no-op
      expect(() => tap.write("response", RESPONSE, "steps/toolCallRequest")).not.toThrow();
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
