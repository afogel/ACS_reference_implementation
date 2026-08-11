import { afterAll, beforeAll, describe, expect, it } from "bun:test";
// Test-only import: stands up a real Guardian so these tests prove the
// wire contract for real, not against a hand-copied shape. Never imported
// by packages/host-adapter/src (R3.2) -- see build-envelope.test.ts for
// the precedent (Task 7).
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, loadHookmap, type Hookmap } from "../src/build-envelope.ts";
import { createGuardianClient } from "../src/guardian-client.ts";
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

describe("GuardianClient.post", () => {
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
      const response = await createGuardianClient(`http://localhost:${mock.port}/acs`).post(envelope);

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

    const response = await createGuardianClient(guardian.url).post(envelope);

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
      await expect(createGuardianClient(`http://localhost:${mock.port}/acs`).post(envelope)).rejects.toThrow();
    } finally {
      mock.stop(true);
    }
  });

  it("against a real Guardian: steps/toolCallRequest for ls -la allows, echoing the request id", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    const response = await createGuardianClient(guardian.url).post(envelope);

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("allow");
  });
});

// PR #10 review, Important: the shim used to receive a raw JSON-RPC response
// and work out for itself whether a decision was in it. These are the branches
// it no longer owns -- and the last of them is the one a copy of that
// inspection would get wrong.
describe("GuardianClient.requestDecision", () => {
  it("answers with the decision when one arrives", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    const outcome = await createGuardianClient(guardian.url).requestDecision(envelope);

    expect(outcome.decisionArrived).toBe(true);
    expect(outcome.decisionArrived && outcome.decision.decision).toBe("allow");
  });

  it("answers 'no decision' with the Guardian's own JSON-RPC error as the failure, rather than throwing", async () => {
    // A method this Guardian dispatches no handler for.
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);
    const unknownMethod = { ...envelope, method: "steps/sessionStart" };

    const outcome = await createGuardianClient(guardian.url).requestDecision(unknownMethod);

    expect(outcome.decisionArrived).toBe(false);
    expect((outcome.decisionArrived === false ? outcome.failure : undefined) as { code?: number }).toHaveProperty(
      "code",
    );
  });

  it("answers 'no decision' when the transport itself fails, rather than throwing", async () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);

    // Port 1 with nothing listening: a refused connection, not a slow one.
    const outcome = await createGuardianClient("http://localhost:1/acs").requestDecision(envelope);

    expect(outcome.decisionArrived).toBe(false);
  });

  it("honours a decision that arrives alongside a malformed `error`, never letting the failure outrank it", async () => {
    // A response carrying both is malformed per JSON-RPC, but a decision is in
    // it -- and a caller that checked `error` first would answer a real deny
    // with a delivery-failure path instead of honouring it.
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { decision: "deny", reasoning: "blocked" },
          error: { code: -32020, message: "something also went wrong" },
        });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("rm -rf /"), hookmap);
      const outcome = await createGuardianClient(`http://localhost:${mock.port}/acs`).requestDecision(envelope);

      expect(outcome.decisionArrived).toBe(true);
      expect(outcome.decisionArrived && outcome.decision.decision).toBe("deny");
    } finally {
      mock.stop(true);
    }
  });

  it("answers 'no decision' for a result naming none, rather than passing an undecided bag on to be rendered", async () => {
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { type: "final" } });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);
      const outcome = await createGuardianClient(`http://localhost:${mock.port}/acs`).requestDecision(envelope);

      expect(outcome.decisionArrived).toBe(false);
    } finally {
      mock.stop(true);
    }
  });
});

describe("handshake (N5)", () => {
  it("sends handshake/hello and stores timeout_config and on_decision_failure into the session config store (S13)", async () => {
    const store = createSessionConfigStore();
    expect(store.get()).toBeUndefined();

    const serverHello = await handshake(
      { guardian: createGuardianClient(guardian.url), agentId: "claude-code", sessionId: crypto.randomUUID() },
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

    const response = await createGuardianClient(guardian.url).post(envelope);
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

    const response = await createGuardianClient(guardian.url).post(envelope);
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
