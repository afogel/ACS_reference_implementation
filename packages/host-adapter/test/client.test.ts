import { afterAll, beforeAll, describe, expect, it } from "bun:test";
// Test-only import: stands up a real Guardian so these tests prove the
// wire contract for real, not against a hand-copied shape. Never imported
// by packages/host-adapter/src (R3.2) -- see build-envelope.test.ts for
// the precedent (Task 7).
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, loadHookmap, type Hookmap } from "../src/build-envelope.ts";
import { guardianClient } from "../src/guardian-client.ts";
import { handshake } from "../src/handshake.ts";
import { renderDecision } from "../src/render-decision.ts";
import { createSessionConfigStore } from "../src/session-config.ts";

const hookmap: Hookmap = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");

function preToolUsePayload(command: string): Record<string, unknown> {
  return {
    session_id: "abc123",
    transcript_path: "/path/to/transcript.jsonl",
    cwd: "/current/dir",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
});

afterAll(async () => {
  await guardian.close();
});

describe("guardianClient.post", () => {
  it("posts the envelope as well-formed JSON-RPC 2.0 (jsonrpc, method, id, params) over HTTP", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedContentType: string | null = null;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedContentType = req.headers.get("content-type");
        capturedBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ jsonrpc: "2.0", id: (capturedBody as { id: unknown }).id, result: { decision: "allow" } });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);
      const response = await guardianClient.post(`http://localhost:${mock.port}/acs`, envelope);

      expect(capturedBody).toEqual(envelope as unknown as Record<string, unknown>);
      if (capturedContentType === null) {
        throw new Error("mock server captured no content-type header");
      }
      // Rebind to a plain (non-closure-mutated) const: `capturedContentType`
      // is reassigned inside the fetch handler above, and TS's generic
      // inference for expect<T>() doesn't pick up the flow-narrowing on a
      // variable a closure can still write to, even though the narrowing
      // itself is sound here (the closure has already run by this point).
      const contentType: string = capturedContentType;
      expect(contentType).toContain("application/json");
      expect(response.result?.decision).toBe("allow");
    } finally {
      mock.stop(true);
    }
  });

  it("correlates the response to the request by JSON-RPC id -- buildEnvelope's id equals params.request_id, and that round-trips fine", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    const response = await guardianClient.post(guardian.url, envelope);

    expect(response.id).toBe(envelope.id);
    expect(envelope.id).toBe(envelope.params.request_id);
  });

  it("throws when the response id does not correlate with the request id", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ jsonrpc: "2.0", id: "not-the-request-id", result: { decision: "allow" } });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);
      await expect(guardianClient.post(`http://localhost:${mock.port}/acs`, envelope)).rejects.toThrow();
    } finally {
      mock.stop(true);
    }
  });

  it("against a real Guardian: steps/toolCallRequest for ls -la allows, echoing the request id", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    const response = await guardianClient.post(guardian.url, envelope);

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("allow");
  });
});

describe("handshake (N5)", () => {
  it("sends handshake/hello and stores timeout_config and on_decision_failure into the session config store (S13)", async () => {
    const store = createSessionConfigStore();
    expect(store.get()).toBeUndefined();

    const serverHello = await handshake(
      { url: guardian.url, agentId: "claude-code", sessionId: crypto.randomUUID() },
      store,
    );

    expect(serverHello.on_decision_failure).toBe("proceed");
    expect(serverHello.timeout_config.default_ms).toBeGreaterThan(0);

    const stored = store.get();
    expect(stored).toBeDefined();
    expect(stored?.timeout_config).toEqual(serverHello.timeout_config);
    expect(stored?.on_decision_failure).toBe("proceed");
  });
});

describe("host -> wire -> policy -> host, end to end", () => {
  it("a real rm -rf / tool call denies through the real Guardian, and renders with the reasoning in permissionDecisionReason", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("rm -rf /"), hookmap);

    const response = await guardianClient.post(guardian.url, envelope);
    expect(response.error).toBeUndefined();

    const { hookSpecificOutput } = renderDecision(
      response.result as { decision: string } & Record<string, unknown>,
      hookmap,
    ) as { hookSpecificOutput: Record<string, unknown> };

    expect(hookSpecificOutput.permissionDecision).toBe("deny");
    expect(typeof hookSpecificOutput.permissionDecisionReason).toBe("string");
    expect((hookSpecificOutput.permissionDecisionReason as string).length).toBeGreaterThan(0);
  });

  it("a real ls -la tool call allows through the real Guardian, and renders as a plain allow", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    const response = await guardianClient.post(guardian.url, envelope);
    expect(response.error).toBeUndefined();

    const { hookSpecificOutput } = renderDecision(
      response.result as { decision: string } & Record<string, unknown>,
      hookmap,
    ) as { hookSpecificOutput: Record<string, unknown> };

    // No `hookEventName` here: it is not a function of the decision, so the
    // shim adds it as it wraps (PR #10 review, Critical). What a Claude Code
    // process actually reads back, with that field in place, is pinned in
    // hosts/claude-code/test/wire-shape.test.ts against the real shim.
    expect(hookSpecificOutput).toEqual({ permissionDecision: "allow" });
  });
});
