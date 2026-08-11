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
  // Unread by buildEnvelope, which owns the `hooks` half of a hookmap --
  // present so a hookmap this file passes around is a whole one. The host
  // field names live in the output paths, which is render-decision.ts's
  // business (and no code's, in the adapter, above the path level).
  decisions: {
    allow: { output: { "hookSpecificOutput.permissionDecision": { value: "allow" } } },
    deny: {
      output: {
        "hookSpecificOutput.permissionDecision": { value: "deny" },
        "hookSpecificOutput.permissionDecisionReason": { from: "reasoning", type: "string" },
      },
    },
    ask: { output: { "hookSpecificOutput.permissionDecision": { value: "ask" } } },
    defer: { output: { "hookSpecificOutput.permissionDecision": { value: "deny" } } },
    modify: {
      output: {
        "hookSpecificOutput.permissionDecision": { value: "allow" },
        "hookSpecificOutput.updatedInput": { from: "applied_input" },
      },
    },
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

    // The `hooks` half every case below shares, and two renderable entries to
    // build cases out of. Named rather than repeated inline, because after
    // each decision entry gained a full `output` block the inline strings
    // were longer than the assertions they set up.
    const HOOKS =
      "host: claude-code\nhooks:\n  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\n";
    const ALLOW = "  allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n";
    const DENY = "  deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n";

    it("throws when the decisions block is missing entirely", () => {
      withHookmapFile(HOOKS, (path) => {
        expect(() => loadHookmap(path)).toThrow(/decisions/);
      });
    });

    it("throws when decisions is missing deny (allow alone is not enough)", () => {
      withHookmapFile(`${HOOKS}decisions:\n${ALLOW}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/deny/);
      });
    });

    it("throws when decisions is missing allow (deny alone is not enough)", () => {
      withHookmapFile(`${HOOKS}decisions:\n${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/allow/);
      });
    });

    it("accepts decisions with at least allow and deny, extra entries and all", () => {
      withHookmapFile(`${HOOKS}decisions:\n${ALLOW}${DENY}`, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });

    // Fix round 3: presence alone let both of these through. `allow: null`
    // satisfies `"allow" in decisions` but is not an entry renderDecision can
    // read an output block off -- it would throw at render time, past every
    // guard, exiting 1 with empty stdout (a third route to the fail-open this
    // task exists to remove). `allow: {}` also satisfies presence, and used to
    // render an output whose one field was `undefined`, which JSON.stringify
    // drops -- stdout would carry a wrapper with no decision in it at all.
    // Both must be rejected at load time instead.
    it("throws when allow is present but not an object (null)", () => {
      withHookmapFile(`${HOOKS}decisions:\n  allow: null\n${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/decisions\.allow/);
      });
    });

    // Was "names no permissionDecision" before S1's output block became
    // declarative. The claim it can still make is the one the adapter is
    // allowed to make: an entry that renders NOTHING is rejected. Which host
    // field a renderable entry has to name is no longer this module's business
    // -- R3.2 forbids it naming one -- and the `permissionDecision` half of
    // the old claim now lives in the shim's own gate
    // (assertHostAcceptsEveryDecision, hosts/claude-code/acs-hook.ts), where
    // hosts/claude-code/test/posture.test.ts exercises it end to end.
    it("throws when allow is an object but declares no output block", () => {
      withHookmapFile(`${HOOKS}decisions:\n  allow: {}\n${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"decisions\.allow" entry needs a non-empty "output" block/);
      });
    });

    it("throws when a THIRD entry (not allow or deny) is malformed -- every declared entry is checked", () => {
      // Malformed the second way an entry can be, now that entries carry an
      // output block: the block is there and non-empty, but its one field
      // names neither a literal `value` nor a `from` to copy -- a hookmap typo
      // that would render `modify` as an output missing the field its author
      // believes is there.
      withHookmapFile(
        `${HOOKS}decisions:\n${ALLOW}${DENY}  modify: { output: { hookSpecificOutput.updatedInput: { type: string } } }\n`,
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
