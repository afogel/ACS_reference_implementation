import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope } from "guardian";
import { buildEnvelope, loadHookmap, toSessionUuid, unwrapArguments, type Hookmap } from "../src/build-envelope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The real PreToolUse payload shape Claude Code delivers on stdin, per the
// Task 7 brief -- not a sketch.
const preToolUsePayload = {
  session_id: "abc123",
  transcript_path: "/path/to/transcript.jsonl",
  cwd: "/current/dir",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /", description: "clean up" },
};

const hookmap: Hookmap = {
  host: "claude-code",
  hooks: {
    PreToolUse: {
      acs_method: "steps/toolCallRequest",
      tool_name: "$.tool_name",
      arguments: "$.tool_input",
    },
  },
  decisions: {
    allow: { permissionDecision: "allow" },
    deny: { permissionDecision: "deny", reason_from: "reasoning" },
    ask: { permissionDecision: "ask" },
    defer: { permissionDecision: "defer" },
    modify: { permissionDecision: "allow", updatedInput_from: "modifications" },
  },
};

describe("buildEnvelope", () => {
  it("produces an envelope that validates against the real ACS v0.1.0 request-envelope + tool-call-request schemas", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    // guardian's own validateEnvelope (Task 5) -- imported here, in the
    // TEST file only, so the runtime adapter stays dependency-free while
    // this proves the two sides genuinely agree on the wire format.
    expect(() => validateEnvelope(envelope)).not.toThrow();
  });

  it("takes method from the hookmap's acs_method, never hardcoded", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(envelope.method).toBe("steps/toolCallRequest");
  });

  it("wraps each tool_input argument as {value: ...} per ACS", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(envelope.params.payload.arguments.command).toEqual({ value: "rm -rf /" });
    expect(envelope.params.payload.arguments.description).toEqual({ value: "clean up" });
  });

  it("carries tool_name into params.payload.tool.name", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(envelope.params.payload.tool.name).toBe("Bash");
  });

  it("assigns a fresh uuid request_id per call", () => {
    const first = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);
    const second = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(first.params.request_id).toMatch(UUID_RE);
    expect(second.params.request_id).toMatch(UUID_RE);
    expect(first.params.request_id).not.toBe(second.params.request_id);
  });

  it("stamps an ISO 8601 timestamp", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(new Date(envelope.params.timestamp).toISOString()).not.toBe("Invalid Date");
    expect(envelope.params.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("carries the host's session_id, derived deterministically into a uuid (session_id must be a uuid on the wire)", () => {
    const first = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);
    const second = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    expect(first.params.metadata.session_id).toMatch(UUID_RE);
    // Deterministic: the same host session_id always derives the same uuid,
    // even though request_id (above) is fresh every call.
    expect(first.params.metadata.session_id).toBe(second.params.metadata.session_id);
  });

  it("preserves an already-valid uuid session_id rather than re-deriving it", () => {
    const realUuid = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    const payload = { ...preToolUsePayload, session_id: realUuid };

    const envelope = buildEnvelope("PreToolUse", payload, hookmap);

    expect(envelope.params.metadata.session_id).toBe(realUuid);
  });

  it("toSessionUuid is deterministic and produces a valid uuid for a non-uuid input", () => {
    expect(toSessionUuid("abc123")).toMatch(UUID_RE);
    expect(toSessionUuid("abc123")).toBe(toSessionUuid("abc123"));
    expect(toSessionUuid("abc123")).not.toBe(toSessionUuid("xyz789"));
  });

  it("throws on an unmapped hook name, rather than defaulting or producing a partial envelope", () => {
    expect(() => buildEnvelope("PostToolUse", preToolUsePayload, hookmap)).toThrow();
  });

  it("is hookmap-driven: changing the hookmap's acs_method changes the envelope's method", () => {
    const alternateHookmap: Hookmap = {
      host: "claude-code",
      hooks: {
        PreToolUse: {
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          arguments: "$.tool_input",
        },
      },
    };

    const original = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);
    const changed = buildEnvelope("PreToolUse", preToolUsePayload, alternateHookmap);

    expect(original.method).toBe("steps/toolCallRequest");
    expect(changed.method).toBe("steps/toolCallResult");
  });

  it("loadHookmap parses the real claude-code.hookmap.yaml and buildEnvelope drives off it end to end", () => {
    const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");

    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, parsed);

    expect(envelope.method).toBe("steps/toolCallRequest");
    expect(() => validateEnvelope(envelope)).not.toThrow();
  });

  describe("loadHookmap — decisions.allow and decisions.deny must both be renderable (V3 fix round 1, item 1)", () => {
    // Guards against the residual case a shim could otherwise only trust:
    // applyFailurePosture (N6) never returns anything but "allow" or
    // "deny", so a shim falling back to the posture because the ORIGINAL
    // decision could not be rendered needs the posture's own output to be
    // guaranteed renderable too, or the fallback itself can throw. Enforced
    // once, at load time, so every hookmap this project ships is checked
    // the same way, not trusted by convention.
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }

    it("throws when the decisions block is missing entirely", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/decisions/);
        },
      );
    });

    it("throws when decisions is missing deny (allow alone is not enough)", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  allow: { permissionDecision: allow }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/deny/);
        },
      );
    });

    it("throws when decisions is missing allow (deny alone is not enough)", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  deny: { permissionDecision: deny, reason_from: reasoning }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/allow/);
        },
      );
    });

    it("accepts decisions with at least allow and deny, extra entries and all", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  allow: { permissionDecision: allow }\n  deny: { permissionDecision: deny, reason_from: reasoning }\n",
        (path) => {
          expect(() => loadHookmap(path)).not.toThrow();
        },
      );
    });

    // Fix round 3: presence alone let both of these through. `allow: null`
    // satisfies `"allow" in decisions` but is not an object renderDecision
    // can read a permissionDecision off -- it would throw at render time,
    // past every guard, exiting 1 with empty stdout (a third route to the
    // fail-open this task exists to remove). `allow: {}` also satisfies
    // presence, renderDecision does NOT throw for it, but
    // `permissionDecision` comes out `undefined`, which JSON.stringify
    // drops -- stdout would carry hookSpecificOutput with no decision in
    // it at all. Both must be rejected at load time instead.
    it("throws when allow is present but not an object (null)", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  allow: null\n  deny: { permissionDecision: deny, reason_from: reasoning }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/decisions\.allow/);
        },
      );
    });

    it("throws when allow is an object but names no permissionDecision", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  allow: {}\n  deny: { permissionDecision: deny, reason_from: reasoning }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/permissionDecision/);
        },
      );
    });

    it("throws when a THIRD entry (not allow or deny) is malformed -- every declared entry is checked", () => {
      withHookmapFile(
        "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\ndecisions:\n  allow: { permissionDecision: allow }\n  deny: { permissionDecision: deny, reason_from: reasoning }\n  modify: { updatedInput_from: applied_input }\n",
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/decisions\.modify/);
        },
      );
    });
  });

  describe("unwrapArguments (V3 fix round 1, item 6)", () => {
    it("unwraps the {value, provenance?} shape buildEnvelope just wrote, keyed by argument name", () => {
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload, parsed);

      expect(unwrapArguments(envelope)).toEqual({ command: "rm -rf /", description: "clean up" });
    });

    it("returns an empty object for an envelope with no arguments", () => {
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");
      const envelope = buildEnvelope("PreToolUse", { ...preToolUsePayload, tool_input: {} }, parsed);

      expect(unwrapArguments(envelope)).toEqual({});
    });
  });
});
