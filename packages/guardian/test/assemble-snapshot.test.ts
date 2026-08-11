import { describe, expect, it } from "bun:test";
import { createBridge } from "agt-bridge";
import { assembleSnapshot, type ToolCallRequestEnvelope } from "../src/assemble-snapshot.ts";

function makeEnvelope(overrides: {
  toolName?: string;
  args?: Record<string, { value: unknown; provenance?: unknown }>;
  requestId?: string;
} = {}): ToolCallRequestEnvelope {
  const {
    toolName = "run_shell",
    args = { command: { value: "ls -la", provenance: { source: "user" } } },
    requestId = "8f14e45f-ceea-467e-bd5f-1d4d9a4e0c8f",
  } = overrides;

  return {
    jsonrpc: "2.0",
    method: "steps/toolCallRequest",
    id: 1,
    params: {
      acs_version: "0.1.0",
      request_id: requestId,
      timestamp: "2026-08-09T12:00:00Z",
      metadata: {
        agent_id: "agent-1",
        session_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
        session_state: { chain_hash: "deadbeef" },
      },
      payload: {
        tool: { name: toolName },
        arguments: args,
      },
    },
  } as unknown as ToolCallRequestEnvelope;
}

describe("assembleSnapshot", () => {
  it("maps params.payload.tool.name to tool_call.name, and unwraps each argument's .value into tool_call.args, dropping provenance", () => {
    const envelope = makeEnvelope({
      toolName: "run_shell",
      args: {
        command: { value: "rm -rf /", provenance: { source: "user", timestamp: "2026-08-09T12:00:00Z" } },
      },
    });

    const snapshot = assembleSnapshot(envelope);

    expect(snapshot.tool_call.name).toBe("run_shell");
    expect(snapshot.tool_call.args).toEqual({ command: "rm -rf /" });
  });

  // C5 — AGT's stock pattern check reads input.policy_target.value and
  // requires is_string. A surviving {value:...} wrapper (or a non-string)
  // makes the check silently never fire, and everything is allowed.
  it("keeps tool_call.args.command a STRING, not a nested wrapper or object", () => {
    const envelope = makeEnvelope({ args: { command: { value: "rm -rf /" } } });

    const snapshot = assembleSnapshot(envelope);

    expect(typeof snapshot.tool_call.args.command).toBe("string");
    expect(snapshot.tool_call.args.command).toBe("rm -rf /");
  });

  it("always emits envelope.budgets with all four counters zeroed, even though the envelope says nothing about budgets", () => {
    const envelope = makeEnvelope();

    const snapshot = assembleSnapshot(envelope);

    expect(snapshot.envelope).toEqual({
      budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 },
    });
  });

  it("carries params.request_id onto tool_call.id", () => {
    const envelope = makeEnvelope({ requestId: "2c3e4f50-1234-4abc-9def-000000000000" });

    const snapshot = assembleSnapshot(envelope);

    expect(snapshot.tool_call.id).toBe("2c3e4f50-1234-4abc-9def-000000000000");
  });

  // Envelope-only (the V1 watch-for): no S3/S4/S5 reads. Session id, chain
  // hash, and every other session-derived key must not survive into the
  // snapshot -- this is the boundary the later V6 slice will cross, on
  // purpose, somewhere else.
  it("reads nothing but the envelope: no session-derived key appears anywhere in the output", () => {
    const envelope = makeEnvelope();

    // No cast: assembleSnapshot returns a named snapshot message now, so what
    // these read is the type it declares rather than an anonymous dict.
    const snapshot = assembleSnapshot(envelope);

    expect(Object.keys(snapshot).sort()).toEqual(["envelope", "tool_call"]);
    expect(Object.keys(snapshot.envelope)).toEqual(["budgets"]);
    expect(Object.keys(snapshot.tool_call).sort()).toEqual(["args", "id", "name"]);

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["session_id", "session_state", "chain_hash", "agent_id", "metadata", "intent", "1b9d6bcd"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // The high-value integration test: this is the first point in the build
  // where the two halves (guardian's snapshot assembly, agt-bridge's real
  // OPA evaluation) meet.
  it("feeds a realistic rm -rf / envelope through the real AGT bridge and gets denied", async () => {
    const envelope = makeEnvelope({
      toolName: "run_shell",
      args: { command: { value: "rm -rf /", provenance: { source: "user" } } },
    });

    const snapshot = assembleSnapshot(envelope);
    const bridge = createBridge("policy/manifest.yaml");
    const result = await bridge.evaluate("pre_tool_call", snapshot);

    expect(result.verdict.decision).toBe("deny");
  });
});
