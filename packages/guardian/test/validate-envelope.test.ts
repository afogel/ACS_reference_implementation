import { describe, expect, it } from "bun:test";
import { EnvelopeValidationError, validateEnvelope } from "../src/validate-envelope.ts";

function makeEnvelope(overrides: {
  method?: string;
  toolName?: string;
  args?: Record<string, { value: unknown; provenance?: unknown }>;
  omitSessionId?: boolean;
  omitToolName?: boolean;
} = {}): unknown {
  const {
    method = "steps/toolCallRequest",
    toolName = "run_shell",
    args = { command: { value: "ls -la", provenance: { provenance_id: "p1", origin: "user_input" } } },
    omitSessionId = false,
    omitToolName = false,
  } = overrides;

  const metadata: Record<string, unknown> = { agent_id: "agent-1" };
  if (!omitSessionId) {
    metadata.session_id = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
  }

  const tool: Record<string, unknown> = {};
  if (!omitToolName) {
    tool.name = toolName;
  }

  return {
    jsonrpc: "2.0",
    method,
    id: 1,
    params: {
      acs_version: "0.1.0",
      request_id: "8f14e45f-ceea-467e-bd5f-1d4d9a4e0c8f",
      timestamp: "2026-08-09T12:00:00Z",
      metadata,
      payload: {
        tool,
        arguments: args,
      },
    },
  };
}

describe("validateEnvelope", () => {
  it("passes a well-formed steps/toolCallRequest envelope", () => {
    const envelope = makeEnvelope();

    const validated = validateEnvelope(envelope) as { params: { payload: { tool: { name: string } } } };

    expect(validated.params.payload.tool.name).toBe("run_shell");
  });

  it("throws EnvelopeValidationError naming /params/metadata/session_id when session_id is missing", () => {
    const envelope = makeEnvelope({ omitSessionId: true });

    expect(() => validateEnvelope(envelope)).toThrow(EnvelopeValidationError);
    try {
      validateEnvelope(envelope);
      throw new Error("expected validateEnvelope to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeValidationError);
      expect((error as EnvelopeValidationError).pointer).toBe("/params/metadata/session_id");
      expect((error as EnvelopeValidationError).message).toContain("/params/metadata/session_id");
    }
  });

  it("throws EnvelopeValidationError naming /params/payload/tool/name when the tool name is missing", () => {
    const envelope = makeEnvelope({ omitToolName: true });

    expect(() => validateEnvelope(envelope)).toThrow(EnvelopeValidationError);
    try {
      validateEnvelope(envelope);
      throw new Error("expected validateEnvelope to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeValidationError);
      expect((error as EnvelopeValidationError).pointer).toBe("/params/payload/tool/name");
      expect((error as EnvelopeValidationError).message).toContain("/params/payload/tool/name");
    }
  });

  it("throws EnvelopeValidationError naming /method when method does not match the required prefix pattern", () => {
    const envelope = makeEnvelope({ method: "notARealPrefix/toolCallRequest" });

    expect(() => validateEnvelope(envelope)).toThrow(EnvelopeValidationError);
    try {
      validateEnvelope(envelope);
      throw new Error("expected validateEnvelope to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeValidationError);
      expect((error as EnvelopeValidationError).pointer).toBe("/method");
      expect((error as EnvelopeValidationError).message).toContain("/method");
    }
  });

  // Scope boundary (N27 is V3, not this task): a rejection is a thrown
  // error, never a returned {decision: "deny"} object.
  it("throws rather than returning a decision object", () => {
    const envelope = makeEnvelope({ omitSessionId: true });

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = validateEnvelope(envelope);
    } catch (error) {
      thrown = error;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(EnvelopeValidationError);
    expect((thrown as Record<string, unknown>).decision).toBeUndefined();
  });
});
