import { describe, expect, it } from "bun:test";
import { createBridge } from "agt-bridge";
import {
  assemblePostToolCallSnapshot,
  assemblePreToolCallSnapshot,
  type ToolCallRequestEnvelope,
  type ToolCallResultEnvelope,
} from "../src/assemble-snapshot.ts";
import { isToolCallRequest, isToolCallResult, validateEnvelope } from "../src/validate-envelope.ts";

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

describe("assemblePreToolCallSnapshot", () => {
  it("maps params.payload.tool.name to tool_call.name, and unwraps each argument's .value into tool_call.args, dropping provenance", () => {
    const envelope = makeEnvelope({
      toolName: "run_shell",
      args: {
        command: { value: "rm -rf /", provenance: { source: "user", timestamp: "2026-08-09T12:00:00Z" } },
      },
    });

    const snapshot = assemblePreToolCallSnapshot(envelope);

    expect(snapshot.tool_call.name).toBe("run_shell");
    expect(snapshot.tool_call.args).toEqual({ command: "rm -rf /" });
  });

  // AGT's stock pattern check reads input.policy_target.value and
  // requires is_string. A surviving {value:...} wrapper (or a non-string)
  // makes the check silently never fire, and everything is allowed.
  it("keeps tool_call.args.command a STRING, not a nested wrapper or object", () => {
    const envelope = makeEnvelope({ args: { command: { value: "rm -rf /" } } });

    const snapshot = assemblePreToolCallSnapshot(envelope);

    expect(typeof snapshot.tool_call.args.command).toBe("string");
    expect(snapshot.tool_call.args.command).toBe("rm -rf /");
  });

  it("always emits envelope.budgets with all four counters zeroed, even though the envelope says nothing about budgets", () => {
    const envelope = makeEnvelope();

    const snapshot = assemblePreToolCallSnapshot(envelope);

    expect(snapshot.envelope).toEqual({
      budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 },
    });
  });

  it("carries params.request_id onto tool_call.id", () => {
    const envelope = makeEnvelope({ requestId: "2c3e4f50-1234-4abc-9def-000000000000" });

    const snapshot = assemblePreToolCallSnapshot(envelope);

    expect(snapshot.tool_call.id).toBe("2c3e4f50-1234-4abc-9def-000000000000");
  });

  // Envelope-only: nothing is read from session state. Session id, chain
  // hash, and every other session-derived key must not survive into the
  // snapshot.
  it("reads nothing but the envelope: no session-derived key appears anywhere in the output", () => {
    const envelope = makeEnvelope();

    // No cast: assemblePreToolCallSnapshot returns a named snapshot message now, so what
    // these read is the type it declares rather than an anonymous dict.
    const snapshot = assemblePreToolCallSnapshot(envelope);

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

    const snapshot = assemblePreToolCallSnapshot(envelope);
    const bridge = createBridge("policy/manifest.yaml");
    const verdict = await bridge.evaluate("pre_tool_call", snapshot);

    expect(verdict.decision).toBe("deny");
  });
});

/**
 * A raw steps/toolCallResult envelope, as JSON, exactly as it arrives on the
 * wire -- and taken through the real door on the way in: validateEnvelope,
 * then the isToolCallResult narrowing. Not a cast. A result envelope does not
 * typecheck against `assemblePreToolCallSnapshot`'s parameter, and a cast that hid that
 * would hide the one property this pair of assemblers exists for.
 *
 * `metadata.agent_id` is here because request-envelope.json's Metadata $def
 * requires it. Going through validateEnvelope rather than around it is what
 * makes that a compile-and-run fact rather than a detail a cast could skip.
 */
function rawResultEnvelope(
  overrides: { toolName?: string; outputs?: { value: unknown; provenance?: unknown }[] } = {},
): unknown {
  const { toolName = "Bash", outputs = [{ value: "TOKEN=ghp_ABCDEF123456" }] } = overrides;

  return {
    jsonrpc: "2.0",
    method: "steps/toolCallResult",
    id: "r1",
    params: {
      acs_version: "0.1.0",
      request_id: "6ba59b01-1493-4f4c-af22-8a36eeca4651",
      timestamp: "2026-08-11T00:00:00Z",
      metadata: { agent_id: "agent-1", session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5" },
      payload: { tool: { name: toolName }, exit_status: "success", outputs },
    },
  };
}

function makeResultEnvelope(
  overrides: { toolName?: string; outputs?: { value: unknown; provenance?: unknown }[] } = {},
): ToolCallResultEnvelope {
  const validated = validateEnvelope(rawResultEnvelope(overrides));
  if (!isToolCallResult(validated)) {
    throw new Error(`validateEnvelope returned a non-result envelope: ${validated.method}`);
  }
  return validated;
}

/** The request-side twin of `rawResultEnvelope`, for the both-directions
 * assertions below: two predicates, and neither may answer the other's
 * method. */
function rawRequestEnvelope(): unknown {
  return {
    jsonrpc: "2.0",
    method: "steps/toolCallRequest",
    id: 1,
    params: {
      acs_version: "0.1.0",
      request_id: "8f14e45f-ceea-467e-bd5f-1d4d9a4e0c8f",
      timestamp: "2026-08-11T00:00:00Z",
      metadata: { agent_id: "agent-1", session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5" },
      payload: { tool: { name: "Bash" }, arguments: { command: { value: "ls -la" } } },
    },
  };
}

// V4 (slice #5), N23's result-side sibling. Everything here is the
// post_tool_call half of the pair the PR #10 review's ruling asked for: its
// own envelope type, its own predicate, its own snapshot type, its own
// assembler. Nothing in this block reads or widens the pre_tool_call half --
// the two snapshots share no member but envelope.budgets.
describe("assemblePostToolCallSnapshot -- the post_tool_call sibling", () => {
  it("assembles the post-tool snapshot, synthesizing tool_call.name", () => {
    const snapshot = assemblePostToolCallSnapshot(makeResultEnvelope());

    // tool_call.name is synthesized from payload.tool.name. ACS's result
    // payload has no tool_call member of its own, and AGT resolves
    // tool_name_from BEFORE policy runs -- without this the whole gate fails
    // closed on every call (Evidence 5, pinned in test/redaction.test.ts).
    expect(snapshot).toEqual({
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    });
  });

  // C5. The wire cannot supply the arguments at this step, and pretending
  // otherwise (by carrying the request's args forward) would be inventing
  // state this slice does not have. Correlation via request_id_ref is V6's.
  it("carries no tool_call.args -- the result payload has none to carry", () => {
    const snapshot = assemblePostToolCallSnapshot(makeResultEnvelope());

    expect("args" in snapshot.tool_call).toBe(false);
    expect(Object.keys(snapshot.tool_call)).toEqual(["name"]);
    expect(Object.keys(snapshot).sort()).toEqual(["envelope", "tool_call", "tool_result"]);
  });

  // The same rule the request side applies to its arguments (C5): AGT reads
  // raw values -- policy_target "$.tool_result.outputs[0].value" -- and ACS's
  // {value, provenance} wrapper does not survive into the snapshot.
  it("drops each output's provenance, keeping the raw value alone", () => {
    const snapshot = assemblePostToolCallSnapshot(
      makeResultEnvelope({
        outputs: [{ value: "TOKEN=ghp_ABCDEF123456", provenance: { provenance_id: "p1", origin: "tool_output" } }],
      }),
    );

    expect(snapshot.tool_result.outputs).toEqual([{ value: "TOKEN=ghp_ABCDEF123456" }]);
  });

  // budgets.rego fails closed on a present-but-wrong-typed counter (V1's
  // C-note), and that hazard is not specific to the request gate.
  it("always emits envelope.budgets with all four counters zeroed, as real zeros", () => {
    const snapshot = assemblePostToolCallSnapshot(makeResultEnvelope());

    for (const counter of Object.values(snapshot.envelope.budgets)) {
      expect(typeof counter).toBe("number");
    }
    expect(snapshot.envelope).toEqual({
      budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 },
    });
  });

  // One predicate per assembler, asserted in BOTH directions: a predicate
  // that answers `true` too readily is invisible otherwise. This is the
  // assertion that fails if the two predicates are ever replaced by one that
  // answers for both methods.
  it("answers no to a request envelope, and isToolCallRequest answers no to a result envelope", () => {
    const request = validateEnvelope(rawRequestEnvelope());
    const result = validateEnvelope(rawResultEnvelope());

    expect(isToolCallRequest(request)).toBe(true);
    expect(isToolCallResult(request)).toBe(false);

    expect(isToolCallResult(result)).toBe(true);
    expect(isToolCallRequest(result)).toBe(false);
  });

  // The precondition this assembler reads unconditionally: outputs. The
  // result payload's schema (hooks/tool-call-result.json) is checked by
  // validateEnvelope for this method exactly as the request payload's is for
  // its own, so assembly is never reached with the member ABSENT -- which is
  // as far as the schema goes, and no further: see the empty-array case below.
  it("is never reached with outputs absent: validateEnvelope rejects the payload first", () => {
    const raw = rawResultEnvelope() as { params: { payload: Record<string, unknown> } };
    delete raw.params.payload.outputs;

    expect(() => validateEnvelope(raw)).toThrow(/\/params\/payload\/outputs/);
  });

  // hooks/tool-call-result.json sets no `minItems`, so `outputs: []` is a
  // schema-VALID result payload: it passes validateEnvelope, narrows, and
  // reaches this assembler, which assembles an empty outputs array honestly
  // rather than inventing an element. AGT then finds nothing at
  // $.tool_result.outputs[0].value and fails CLOSED. Pinned because it is
  // wire-reachable and because "empty output" is exactly the shape someone
  // might later be tempted to answer with an allow -- a tenth fail-open.
  it("assembles an empty outputs array, and AGT fails closed on it", async () => {
    const snapshot = assembleResultSnapshot(makeResultEnvelope({ outputs: [] }));
    expect(snapshot.tool_result.outputs).toEqual([]);

    const bridge = createBridge("policy/manifest.yaml");
    const result = await bridge.evaluate("post_tool_call", snapshot);

    expect(result.verdict.decision).toBe("deny");
    expect(result.verdict.reason).toBe("runtime_error:path_missing");
  });

  // The high-value integration test, the result-gate twin of the pre-tool one
  // above: this snapshot is fed to the real AGT bridge at the point
  // mapping.yaml names for this method, and the stock redact rule fires. It
  // also proves the synthesized tool_call.name is doing its job -- without it
  // AGT answers deny/runtime_error:path_missing instead of a transform.
  it("feeds a secret-bearing output through the real AGT bridge and gets the redaction transform", async () => {
    const snapshot = assemblePostToolCallSnapshot(makeResultEnvelope());
    const bridge = createBridge("policy/manifest.yaml");

    const result = await bridge.evaluate("post_tool_call", snapshot);

    expect(result.verdict.decision).toBe("transform");
    expect(result.verdict.reason).toBe("redaction_applied");
    expect(result.verdict.transform?.value).toBe("TOKEN=[REDACTED]");
  });
});
