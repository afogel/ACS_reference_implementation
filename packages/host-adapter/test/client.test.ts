import { afterAll, beforeAll, describe, expect, it } from "bun:test";
// Test-only import: stands up a real Guardian so these tests prove the
// wire contract for real, not against a hand-copied shape. Never imported
// by packages/host-adapter/src, which must not depend on the Guardian --
// see build-envelope.test.ts for the same arrangement.
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, loadHookmap, type Hookmap } from "../src/build-envelope.ts";
import {
  createGuardianClient,
  GuardianResultCorrelationError,
  GuardianTimeoutError,
} from "../src/guardian-client.ts";
import { negotiateSessionConfig } from "../src/handshake.ts";
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

  it("throws when the transport id correlates but result.request_id names another request", async () => {
    // The one a transport-only check cannot catch: `id` is echoed faithfully,
    // so `fetch`'s own pairing and the JSON-RPC id check both pass, and what
    // comes back is a real, well-formed decision -- about a different step.
    // Answering this tool call with it is answering a question nobody asked.
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { decision: "allow", request_id: crypto.randomUUID() },
        });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("rm -rf /"), hookmap);
      await expect(createGuardianClient(`http://localhost:${mock.port}/acs`).post(envelope)).rejects.toThrow(
        GuardianResultCorrelationError,
      );
    } finally {
      mock.stop(true);
    }
  });

  it("leaves a ServerHello alone -- a result carrying no request_id is not an uncorrelated one", async () => {
    // The check must not fire on the handshake, whose result is a ServerHello
    // and has no request_id at all: `undefined` there means "this result is
    // not about a step", not "this result is about someone else's step".
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { negotiated_version: "0.1.0" } });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("ls -la"), hookmap);
      const response = await createGuardianClient(`http://localhost:${mock.port}/acs`).post(envelope);

      expect(response.result?.negotiated_version).toBe("0.1.0");
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

  it("answers 'no decision' for another request's decision, however well-formed it is", async () => {
    // A decision that names a foreign request_id is not this step's decision,
    // and the dangerous shape of it is `allow`: honouring it would let a
    // benign step's verdict stand in for one this Guardian never ruled on.
    // The throw from post lands in the same "no decision" answer as a dead
    // transport, so the caller's posture path resolves it and nothing here
    // has to invent a taxonomy for it.
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { decision: "allow", request_id: crypto.randomUUID() },
        });
      },
    });

    try {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload("rm -rf /"), hookmap);
      const outcome = await createGuardianClient(`http://localhost:${mock.port}/acs`).requestDecision(envelope);

      expect(outcome.decisionArrived).toBe(false);
    } finally {
      mock.stop(true);
    }
  });
});

describe("GuardianClient.post — the negotiated timeout (§6.4)", () => {
  it("throws GuardianTimeoutError when no response arrives in time", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        // Tied to the request's own signal, not a bare setTimeout: once the
        // client times out and this test's `finally` force-stops the server,
        // Bun aborts the in-flight request and this listener clears the
        // 5-second timer. Without it, the timer would keep the process's
        // event loop alive and the suite would hang for 5 extra seconds on
        // every run of this test.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return Response.json({ jsonrpc: "2.0", id: "1", result: {} });
      },
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      await expect(createGuardianClient(url).post(envelope, { timeoutMs: 25 })).rejects.toThrow(GuardianTimeoutError);
    } finally {
      await server.stop(true);
    }
  });

  it("returns normally when the response beats the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ jsonrpc: "2.0", id: "1", result: { decision: "allow" } }),
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      const response = await createGuardianClient(url).post(envelope, { timeoutMs: 5000 });
      expect(response.result).toEqual({ decision: "allow" });
    } finally {
      await server.stop(true);
    }
  });

  it("still works with no timeout given, exactly as V1 called it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ jsonrpc: "2.0", id: "1", result: { decision: "allow" } }),
    });
    try {
      const url = `http://localhost:${server.port}/acs`;
      const envelope = { jsonrpc: "2.0" as const, method: "steps/toolCallRequest", id: "1", params: {} };
      expect((await createGuardianClient(url).post(envelope)).result).toEqual({ decision: "allow" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("negotiateSessionConfig (N5)", () => {
  it("sends handshake/hello and stores timeout_config and on_decision_failure into the session config store (S13)", async () => {
    const store = createSessionConfigStore();
    expect(store.get()).toBeUndefined();

    const sessionConfig = await negotiateSessionConfig(
      { guardian: createGuardianClient(guardian.url), agentId: "claude-code", sessionId: crypto.randomUUID() },
      store,
    );

    expect(sessionConfig.on_decision_failure).toBe("proceed");
    expect(sessionConfig.timeout_config.default_ms).toBeGreaterThan(0);

    const stored = store.get();
    expect(stored).toBeDefined();
    expect(stored?.timeout_config).toEqual(sessionConfig.timeout_config);
    expect(stored?.on_decision_failure).toBe("proceed");
  });

  // PR #10 review, Important: the ServerHello used to become a SessionConfig by
  // `as unknown as SessionConfig` -- a rename dressed as a type. Now it becomes
  // one by being checked, so a Guardian emitting the wrong shape fails at the
  // handshake instead of writing an unusable config that every later read
  // silently rejects.
  it("refuses a ServerHello that is not a usable session config, rather than casting it into one", async () => {
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { negotiated_version: "0.1.0" } });
      },
    });

    try {
      const store = createSessionConfigStore();

      await expect(
        negotiateSessionConfig(
          {
            guardian: createGuardianClient(`http://localhost:${mock.port}/acs`),
            agentId: "claude-code",
            sessionId: crypto.randomUUID(),
          },
          store,
        ),
      ).rejects.toThrow(/not a usable session config/);

      expect(store.get()).toBeUndefined();
    } finally {
      mock.stop(true);
    }
  });
});

describe("handshake (N5) — the negotiated timeout (§6.4)", () => {
  it("throws GuardianTimeoutError when the Guardian accepts the connection and never answers, and stores nothing", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        // Tied to the request's own signal, not a bare setTimeout -- see
        // guardianClient.post's own timeout test above for why: without
        // this, the timer outlives the client's abort and this test's
        // `finally` force-stop, keeping the event loop alive for 5 extra
        // seconds on every run.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return Response.json({ jsonrpc: "2.0", id: "1", result: {} });
      },
    });
    try {
      const store = createSessionConfigStore();
      const url = `http://localhost:${server.port}/acs`;
      await expect(
        handshake({ url, agentId: "claude-code", sessionId: crypto.randomUUID(), timeoutMs: 25 }, store),
      ).rejects.toThrow(GuardianTimeoutError);
      expect(store.get()).toBeUndefined();
    } finally {
      await server.stop(true);
    }
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
