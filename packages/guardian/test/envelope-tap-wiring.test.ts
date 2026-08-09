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
