import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope } from "guardian";
import {
  buildEnvelope,
  loadHookmap,
  toSessionUuid,
  modificationDocumentOf,
  type Hookmap,
  type HookmapHookEntry,
} from "../src/build-envelope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The real PreToolUse payload shape Claude Code delivers on stdin.
const preToolUsePayload = {
  session_id: "abc123",
  transcript_path: "/path/to/transcript.jsonl",
  cwd: "/current/dir",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /", description: "clean up" },
};

// Unread by buildEnvelope, which owns the `acs_method`/path half of a hook
// entry -- present so a hookmap this file passes around is a whole one. The host
// field names live in the output paths, which is render-decision.ts's business
// (and no code's, in the adapter, above the path level). Declared per hook,
// because the shape a host reads back is a property of the gate.
const PRE_TOOL_USE_DECISIONS = {
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
};

const POST_TOOL_USE_DECISIONS = {
  allow: { output: { "hookSpecificOutput.additionalContext": { from: "reasoning", type: "string" } } },
  deny: {
    output: {
      decision: { value: "block" },
      reason: { from: "reasoning", type: "string" },
      "hookSpecificOutput.updatedToolOutput": { from: "applied_output" },
    },
  },
  modify: { output: { "hookSpecificOutput.updatedToolOutput": { from: "applied_output" } } },
};

const hookmap: Hookmap = {
  host: "claude-code",
  hooks: {
    PreToolUse: {
      acs_method: "steps/toolCallRequest",
      tool_name: "$.tool_name",
      arguments: "$.tool_input",
      decisions: PRE_TOOL_USE_DECISIONS,
    },
    // The result gate, mirroring the real hookmap's own entry. `within` is
    // declared and deliberately unread here: buildEnvelope puts only the leaf
    // `from` names on the wire, and the object around it is the render side's
    // business.
    PostToolUse: {
      acs_method: "steps/toolCallResult",
      tool_name: "$.tool_name",
      outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
      exit_status: { literal: "success" },
      decisions: POST_TOOL_USE_DECISIONS,
    },
  },
};

describe("buildEnvelope", () => {
  it("produces an envelope that validates against the real ACS v0.1.0 request-envelope + tool-call-request schemas", () => {
    const envelope = buildEnvelope("PreToolUse", preToolUsePayload, hookmap);

    // guardian's own validateEnvelope -- imported here, in the
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

    // `arguments?.` because `params.payload` is now the union of the two ACS
    // payload shapes and only the request member has an `arguments` bag at all
    // -- the optional access IS the claim that this envelope carries that
    // member, since an envelope carrying the result shape reads `undefined`
    // here and fails both assertions.
    expect(envelope.params.payload.arguments?.command).toEqual({ value: "rm -rf /" });
    expect(envelope.params.payload.arguments?.description).toEqual({ value: "clean up" });
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

  // Kept pointed at a hook this fixture genuinely does not map -- SessionStart
  // is a real Claude Code hook this hookmap does not wire -- because the claim
  // is about an unmapped name, and a name the fixture now maps would go on
  // throwing for an unrelated reason (its paths not resolving against a
  // PreToolUse payload) while reading as coverage of this one.
  it("throws on an unmapped hook name, rather than defaulting or producing a partial envelope", () => {
    expect(() => buildEnvelope("SessionStart", preToolUsePayload, hookmap)).toThrow(/no entry for hook/);
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

  describe("loadHookmap — every hook's decisions.allow and decisions.deny must be renderable", () => {
    // Guards against the residual case a shim could otherwise only trust:
    // applyFailurePosture never returns anything but "allow" or
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
    // were longer than the assertions they set up. `decisions` is indented
    // under the hook that owns it, so DECISIONS is its own fragment.
    const HOOKS =
      "host: claude-code\nhooks:\n  PreToolUse:\n    acs_method: steps/toolCallRequest\n    tool_name: $.tool_name\n    arguments: $.tool_input\n";
    const DECISIONS = "    decisions:\n";
    const ALLOW = "      allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n";
    const DENY = "      deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n";

    it("throws when the decisions block is missing entirely", () => {
      withHookmapFile(HOOKS, (path) => {
        expect(() => loadHookmap(path)).toThrow(/decisions/);
      });
    });

    it("throws when decisions is missing deny (allow alone is not enough)", () => {
      withHookmapFile(`${HOOKS}${DECISIONS}${ALLOW}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/deny/);
      });
    });

    it("throws when decisions is missing allow (deny alone is not enough)", () => {
      withHookmapFile(`${HOOKS}${DECISIONS}${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/allow/);
      });
    });

    it("accepts decisions with at least allow and deny, extra entries and all", () => {
      withHookmapFile(`${HOOKS}${DECISIONS}${ALLOW}${DENY}`, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });

    // The minimum is applied per hook: a delivery failure is answered by the
    // posture at whichever gate suffered it, so a second gate declaring no
    // `deny` is a gate whose fail-closed answer cannot be rendered -- and the
    // first gate having one says nothing about it.
    it("throws, naming the hook, when a SECOND hook's block is missing deny", () => {
      const secondHook =
        "  PostToolUse:\n    acs_method: steps/toolCallResult\n    tool_name: $.tool_name\n" +
        "    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
        "    exit_status: { literal: success }\n" +
        `${DECISIONS}${ALLOW}`;

      withHookmapFile(`${HOOKS}${DECISIONS}${ALLOW}${DENY}${secondHook}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"hooks\.PostToolUse\.decisions" block has no "deny" entry/);
      });
    });

    // The same claim from the other side: one hook carrying a whole block does
    // not excuse a hook carrying none. A hook mapped but undecided would reach
    // renderDecision with nothing to render through, at whatever step first
    // fired it.
    it("throws, naming the hook, when a SECOND hook declares no decisions block at all", () => {
      const secondHook =
        "  PostToolUse:\n    acs_method: steps/toolCallResult\n    tool_name: $.tool_name\n" +
        "    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
        "    exit_status: { literal: success }\n";

      withHookmapFile(`${HOOKS}${DECISIONS}${ALLOW}${DENY}${secondHook}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/hook "PostToolUse" has no "decisions" block/);
      });
    });

    // A gate that iterates hooks passes vacuously on a hookmap with none, and a
    // gate that cannot fail reads as enforcement while enforcing nothing.
    it("throws on a hookmap that maps no hooks at all, rather than passing vacuously", () => {
      withHookmapFile("host: claude-code\nhooks: {}\n", (path) => {
        expect(() => loadHookmap(path)).toThrow(/maps no hooks/);
      });
    });

    // Fix round 3: presence alone let both of these through. `allow: null`
    // satisfies `"allow" in decisions` but is not an entry renderDecision can
    // read an output block off -- it would throw at render time, past every
    // guard, exiting 1 with empty stdout (a third route to the fail-open
    // this project exists to remove). `allow: {}` also satisfies presence,
    // and would render an output whose one field was `undefined`, which
    // JSON.stringify drops -- stdout would carry a wrapper with no decision
    // in it at all. Both must be rejected at load time instead.
    it("throws when allow is present but not an object (null)", () => {
      withHookmapFile(`${HOOKS}${DECISIONS}      allow: null\n${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(/decisions\.allow/);
      });
    });

    // The claim this test makes is the one the adapter is allowed to make:
    // an entry that renders NOTHING is rejected. Which host field a
    // renderable entry has to name is not this module's business -- it
    // knows nothing about any particular host's field names -- and the
    // `permissionDecision`-specific check lives in the shim's own gate
    // (assertHostAcceptsEveryDecision, hosts/claude-code/acs-hook.ts), where
    // hosts/claude-code/test/posture.test.ts exercises it end to end.
    it("throws when allow is an object but declares no output block", () => {
      withHookmapFile(`${HOOKS}${DECISIONS}      allow: {}\n${DENY}`, (path) => {
        expect(() => loadHookmap(path)).toThrow(
          /"hooks\.PreToolUse\.decisions\.allow" entry needs a non-empty "output" block/,
        );
      });
    });

    it("throws when a THIRD entry (not allow or deny) is malformed -- every declared entry is checked", () => {
      // Malformed the second way an entry can be, now that entries carry an
      // output block: the block is there and non-empty, but its one field
      // names neither a literal `value` nor a `from` to copy -- a hookmap typo
      // that would render `modify` as an output missing the field its author
      // believes is there.
      withHookmapFile(
        `${HOOKS}${DECISIONS}${ALLOW}${DENY}      modify: { output: { hookSpecificOutput.updatedInput: { type: string } } }\n`,
        (path) => {
          expect(() => loadHookmap(path)).toThrow(/decisions\.modify/);
        },
      );
    });
  });

  // `modificationDocumentOf` is the public collaborator apply work goes
  // through. `unwrapArguments` is module-private and takes a request payload
  // only, so answering an empty bag for an envelope with no arguments is
  // unrepresentable rather than merely discouraged.
  describe("loadHookmap — outputs.mirrors is validated at load time too (§V5 review, Important 1)", () => {
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-mirrors-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }
    const POST_TOOL_USE =
      "host: claude-code\nhooks:\n  PostToolUse:\n    acs_method: steps/toolCallResult\n" +
      "    tool_name: $.tool_name\n    exit_status: { literal: success }\n" +
      "    decisions:\n" +
      "      allow: { output: { x: { value: y } } }\n" +
      "      deny: { output: { x: { value: y } } }\n";
    it("throws, at load time, when `outputs.mirrors` is not a list of strings", () => {
      const broken =
        `${POST_TOOL_USE}    outputs: { from: $.tool_response.stdout, within: $.tool_response, mirrors: 42 }\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"hooks\.PostToolUse\.outputs\.mirrors" is 42/);
      });
    });
    it("throws, at load time, when a declared mirror is not a field inside `outputs.within`", () => {
      const broken =
        `${POST_TOOL_USE}    outputs: { from: $.tool_response.stdout, within: $.tool_response, ` +
        `mirrors: [$.tool_input.command] }\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(
          /"hooks\.PostToolUse\.outputs\.mirrors" entry .* is not a field inside "outputs\.within"/,
        );
      });
    });
    it("accepts a well-formed `outputs.mirrors` list", () => {
      const ok =
        `${POST_TOOL_USE}    outputs: { from: $.tool_response.stdout, within: $.tool_response, ` +
        `mirrors: [$.tool_response.stderr] }\n`;
      withHookmapFile(ok, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });
    it("buildEnvelope itself no longer refuses a malformed `outputs.mirrors` -- only loadHookmap does", () => {
      const broken: HookmapHookEntry = {
        acs_method: "steps/toolCallResult",
        tool_name: "$.tool_name",
        outputs: { from: "$.tool_response.stdout", within: "$.tool_response", mirrors: 42 as unknown as string[] },
        exit_status: { literal: "success" },
      };
      const withBroken: Hookmap = { ...hookmap, hooks: { ...hookmap.hooks, PostToolUse: broken } };
      const postToolUsePayload = {
        session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: "TOKEN=ghp_ABCDEF123456", stderr: "" },
      };
      expect(() => buildEnvelope("PostToolUse", postToolUsePayload, withBroken)).not.toThrow();
    });
  });
  //
  // The hookmap path language's reserved-segment guard lives in one
  // collaborator (hookmap-path.ts), so it is a property of the notation
  // itself rather than of whichever module remembers to apply it.
  //
  // The failure this closes on this side is not a crash. `$.tool_input.__proto__`
  // resolves through inherited lookup, so it satisfies every "is it present?"
  // check and answers with `Object.prototype` -- which buildEnvelope then walks
  // as if it were the tool's own argument bag, putting prototype members on the
  // wire as ACS arguments. Verified directly: an envelope whose
  // `arguments` carried the prototype's members, sent to a Guardian, and
  // governed as though the tool had asked for them.
  describe("a hookmap path naming a reserved segment", () => {
    const reserved = (path: string): Hookmap => ({
      ...hookmap,
      hooks: {
        ...hookmap.hooks,
        PreToolUse: {
          acs_method: "steps/toolCallRequest",
          tool_name: "$.tool_name",
          arguments: path,
          decisions: PRE_TOOL_USE_DECISIONS,
        },
      },
    });

    it("throws rather than resolving through the prototype chain", () => {
      expect(() => buildEnvelope("PreToolUse", preToolUsePayload, reserved("$.tool_input.__proto__"))).toThrow(
        /reserved segment "__proto__"/,
      );
    });

    it("refuses the other two beside it", () => {
      for (const segment of ["prototype", "constructor"]) {
        expect(() => buildEnvelope("PreToolUse", preToolUsePayload, reserved(`$.tool_input.${segment}`))).toThrow(
          /addresses no field a host or tool produced/,
        );
      }
    });

    it("still resolves an ordinary path", () => {
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload, reserved("$.tool_input"));
      expect(envelope.params.payload.arguments).toEqual({
        command: { value: "rm -rf /" },
        description: { value: "clean up" },
      });
    });
  });

  describe("modificationDocumentOf", () => {
    it("unwraps the {value, provenance?} shape buildEnvelope just wrote, keyed by argument name", () => {
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload, parsed);

      expect(modificationDocumentOf(envelope)).toEqual({ command: "rm -rf /", description: "clean up" });
    });

    it("answers the empty bag for a request envelope that genuinely carries no arguments", () => {
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");
      const envelope = buildEnvelope("PreToolUse", { ...preToolUsePayload, tool_input: {} }, parsed);

      expect(modificationDocumentOf(envelope)).toEqual({});
    });

    it("does not reach back into the envelope it read", () => {
      // The apply step reads this document, and an envelope is also what
      // the audit and envelope logs record.
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");
      const envelope = buildEnvelope("PreToolUse", preToolUsePayload, parsed);

      const document = modificationDocumentOf(envelope);
      document.command = "mutated";

      expect(envelope.params.payload.arguments?.command).toEqual({ value: "rm -rf /" });
    });
  });

  describe("PostToolUse -> steps/toolCallResult", () => {
    const payload = {
      session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      // The real shape, captured from Claude Code 2.1.227.
      tool_response: {
        stdout: "TOKEN=ghp_ABCDEF123456",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    };

    it("builds the result payload the ACS schema requires", () => {
      const envelope = buildEnvelope("PostToolUse", payload, hookmap);
      expect(envelope.method).toBe("steps/toolCallResult");
      expect(envelope.params.payload).toEqual({
        tool: { name: "Bash" },
        exit_status: "success",
        outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }],
      });
    });

    // The request payload wraps arguments as {value, provenance?}; the result
    // payload wraps outputs the same way but is a different member entirely.
    // Asserted so a refactor cannot quietly reuse the request path here.
    it("carries no `arguments` member -- the result schema has none", () => {
      const envelope = buildEnvelope("PostToolUse", payload, hookmap);
      expect("arguments" in (envelope.params.payload as object)).toBe(false);
    });

    it("still builds the request payload unchanged for PreToolUse", () => {
      const envelope = buildEnvelope(
        "PreToolUse",
        { session_id: payload.session_id, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
        hookmap,
      );
      expect(envelope.method).toBe("steps/toolCallRequest");
      expect(envelope.params.payload.arguments).toEqual({ command: { value: "ls" } });
    });

    // The document a result-gate pointer is resolved against is the result
    // payload, never an arguments bag. `/outputs/0/value` names nothing in
    // one, and there are no arguments at this step -- so answering with an
    // empty bag instead would make every result-gate `modify` fail closed as
    // `deny(modifications_invalid)`: a deny where a redaction was asked for,
    // which is the one thing this gate exists to do. That shape is
    // unrepresentable here: `unwrapArguments` takes a request payload and
    // does not compile for this envelope. This test pins the answer this
    // module gives instead.
    it("answers with the result payload itself, which is what a result-gate pointer addresses", () => {
      const envelope = buildEnvelope("PostToolUse", payload, hookmap);

      const document = modificationDocumentOf(envelope);

      expect(document).toEqual(envelope.params.payload as unknown as Record<string, unknown>);
      expect(document.outputs).toBeDefined();
      expect(document).not.toBe(envelope.params.payload);
    });

    // Every case above builds against the hand-written fixture, so the
    // stanza actually shipped is exercised by nothing on its own. A
    // YAML-level divergence between the two -- indentation, `exit_status`
    // nested one level off -- would be invisible until the shim loaded the
    // real file. This test builds from the shipped hookmap directly, to
    // close that gap.
    it("builds the same result payload from the shipped claude-code.hookmap.yaml, not just the fixture", () => {
      const parsed = loadHookmap("hosts/claude-code/claude-code.hookmap.yaml");

      const envelope = buildEnvelope("PostToolUse", payload, parsed);

      expect(envelope.method).toBe("steps/toolCallResult");
      expect(envelope.params.payload).toEqual({
        tool: { name: "Bash" },
        exit_status: "success",
        outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }],
      });
    });

    // A malformed hookmap entry throws, naming the hook. Never a default
    // method, a default payload shape, or a partial envelope --
    // each of those hands the far end a step described wrongly, and a step
    // described wrongly is one governance cannot see what it is being asked
    // about.
    describe("an entry names exactly one payload shape, or throws", () => {
      // The cast is how a hookmap actually arrives: `loadHookmap` parses YAML
      // and asserts a `Hookmap`, so the entry type's exactly-one-of guarantee
      // holds for hookmaps written in TypeScript and is unenforced for the
      // parsed ones. These cases are the runtime half that closes that.
      function withBrokenEntry(entry: Record<string, unknown>): Hookmap {
        return { ...hookmap, hooks: { Broken: entry as unknown as HookmapHookEntry } };
      }

      it("throws, naming the hook, when an entry declares both `arguments` and `outputs`", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallRequest",
          tool_name: "$.tool_name",
          arguments: "$.tool_input",
          outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(/"Broken" declares both/);
      });

      it("throws, naming the hook, when an entry declares neither", () => {
        const broken = withBrokenEntry({ acs_method: "steps/toolCallResult", tool_name: "$.tool_name" });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(/"Broken" declares neither/);
      });

      // This typo is plausible because the entry type has a sibling
      // `outputs:` map beside the scalar `arguments:`, so `arguments: {from:
      // ...}` written by analogy is a realistic hookmap mistake. Unchecked it
      // dies inside `resolvePath` as a bare `TypeError: path.replace is not a
      // function` -- fail-closed, so not a fail-open, but the only throw in
      // this function that named neither the hook nor the member at fault.
      // The hook name is asserted explicitly here, not just the phrase,
      // because the check's whole promise is naming the hook.
      it("throws, naming the hook, when `arguments` is a map rather than a path", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallRequest",
          tool_name: "$.tool_name",
          arguments: { from: "$.tool_input" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "arguments" as \{"from":"\$\.tool_input"\}/,
        );
      });

      it("throws, naming the hook, when `outputs` carries no `from` path", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          outputs: { within: "$.tool_response" },
          exit_status: { literal: "success" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "outputs" without a non-empty "outputs\.from"/,
        );
      });

      // `within` is the one declared member nothing checks structurally,
      // though the type makes it mandatory and losing it is load-bearing: an
      // entry missing it builds a clean envelope and the gap surfaces only
      // at render, where the consequence is the host declining the
      // replacement and delivering the original, unredacted output -- a
      // redaction reported and never landed. Same reasoning, and same place,
      // as assertRenderableDecisions checking what renderDecision will need.
      it("throws, naming the hook, when `outputs` carries no `within` path", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          outputs: { from: "$.tool_response.stdout" },
          exit_status: { literal: "success" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "outputs" without a non-empty "outputs\.within"/,
        );
      });

      // The other half of what makes `within` usable, and the half a
      // present-and-non-empty check cannot see: the two paths have to describe
      // ONE leaf inside ONE object, because the replacement is a clone of that
      // object patched at that leaf. An entry whose paths point into different
      // objects satisfies both checks above, builds a clean envelope, and gets a
      // correct decision back -- and the gap surfaces at the one moment it
      // matters, as a replacement the host declines and an original delivered.
      it.each([
        ["names a leaf outside `within`", "$.tool_input.command"],
        ["names `within` itself, so there is no leaf to patch", "$.tool_response"],
        ["stops at a trailing dot, naming an empty segment", "$.tool_response."],
      ])("throws, naming the hook, when `outputs.from` %s", (_name, from) => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          outputs: { from, within: "$.tool_response" },
          exit_status: { literal: "success" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "outputs\.from" .* which is not a field inside "outputs\.within"/,
        );
      });

      // `outputs.mirrors` is deliberately NOT covered here (§V5 review,
      // Important 1, fix round 2). `buildEnvelope` no longer validates it at
      // all -- a malformed `mirrors` reaching this function is a hookmap that
      // should never have loaded, and asserting that here would test a
      // behaviour this function no longer has. See the
      // "loadHookmap -- outputs.mirrors is validated at load time too"
      // describe block below for the check's new (and only) home, and that
      // block's own comment for why living only here was the fault.

      it("throws, naming the hook, when `exit_status` names neither a literal nor a path", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
        });

        // §V5 review, fix round 1, Minor 2: the message now names BOTH legal
        // forms -- before this fix a `from`-shaped typo (`fromm:`, say) was
        // told to add a literal, which was never the actual fix for it.
        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "outputs" without a non-empty "exit_status\.literal" or "exit_status\.from"/,
        );
      });

      // Not a hookmap fault but the same fail-closed reason: an unresolved
      // `from` would put `outputs: [{}]` on the wire, and a result payload with
      // no output in it asks a redaction gate to inspect nothing -- which it
      // would find nothing wrong with.
      it("throws, naming the hook, when the `outputs.from` path does not resolve against this payload", () => {
        const noResponse = { session_id: payload.session_id, hook_event_name: "PostToolUse", tool_name: "Bash" };

        expect(() => buildEnvelope("PostToolUse", noResponse, hookmap)).toThrow(
          /for hook "PostToolUse" did not resolve/,
        );
      });
    });
  });

  /**
   * V5 (slice #6, Task 3): `exit_status` learns a second form. V4 shipped only
   * `HookmapLiteral` because Claude Code's PostToolUse payload carries no exit
   * code -- `PostToolUse` fires for the success case only, so `{literal: success}`
   * was the whole truth, not a gap papered over. Host #2's result gate reports a
   * real `metadata.exit` number, so the hookmap now can name a PATH instead of a
   * constant. `"0 means success"` is a fact about process exit codes, decided
   * once here rather than per-host, which is why the mapping lives in this
   * function rather than in host #2's hookmap.
   */
  describe("exit_status: field-read form (V5, host #2)", () => {
    // Mirrors host #2's own tool.execute.after entry (Task 3's
    // opencode.hookmap.yaml) closely enough to exercise the new form, without
    // depending on that file existing yet.
    function fieldReadHookmap(exitStatus: unknown): Hookmap {
      return {
        host: "opencode",
        hooks: {
          "tool.execute.after": {
            acs_method: "steps/toolCallResult",
            tool_name: "$.tool",
            outputs: { from: "$.result.output", within: "$.result" },
            exit_status: exitStatus,
            decisions: POST_TOOL_USE_DECISIONS,
          } as unknown as HookmapHookEntry,
        },
      };
    }

    function resultPayload(exit: unknown): Record<string, unknown> {
      return {
        session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
        tool: "bash",
        result: { output: "x", metadata: { exit } },
      };
    }

    it("reads exit_status from the payload when the hookmap names a path", () => {
      const envelope = buildEnvelope("tool.execute.after", resultPayload(0), fieldReadHookmap({ from: "$.result.metadata.exit" }));

      expect(envelope.params.payload.exit_status).toBe("success");
    });

    it("maps a non-zero exit to failure", () => {
      const envelope = buildEnvelope("tool.execute.after", resultPayload(1), fieldReadHookmap({ from: "$.result.metadata.exit" }));

      expect(envelope.params.payload.exit_status).toBe("failure");
    });

    it("still accepts the literal form -- Claude Code's hookmap is unchanged", () => {
      const postToolUsePayload = {
        session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: "ok", stderr: "" },
      };

      const envelope = buildEnvelope("PostToolUse", postToolUsePayload, hookmap);

      expect(envelope.params.payload.exit_status).toBe("success");
    });

    it("throws, naming the path, when a field-read `exit_status` resolves to no value in this payload", () => {
      const noMetadata = {
        session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
        tool: "bash",
        result: { output: "x" },
      };

      expect(() =>
        buildEnvelope("tool.execute.after", noMetadata, fieldReadHookmap({ from: "$.result.metadata.exit" })),
      ).toThrow(/"\$\.result\.metadata\.exit"/);
    });

    it("still throws the pre-existing message when `exit_status` is missing entirely, now naming both legal forms", () => {
      expect(() => buildEnvelope("tool.execute.after", resultPayload(0), fieldReadHookmap(undefined))).toThrow(
        /declares "outputs" without a non-empty "exit_status\.literal" or "exit_status\.from"/,
      );
    });

    // §V5 review, fix round 1, Minor 1 introduced this refusal; fix round 2,
    // Important 1 MOVED it to `loadHookmap` (see the "loadHookmap --
    // hooks.<name>.exit_status is validated at load time" describe block
    // below) for the same reason `outputs.mirrors`' own check lives there and
    // not in `buildPayload`: a throw reachable only from `buildEnvelope` is
    // caught by `governStep` and answered with the deployment's negotiated
    // posture, which can be `proceed` -- measured, under that posture, as the
    // tool's output delivered UNGOVERNED. `buildEnvelope` itself no longer
    // refuses this shape at all -- proven directly, so a future re-addition
    // of the per-invocation check does not silently duplicate this one
    // without anyone noticing the two had drifted (the same proof the
    // mirrors describe block makes for its own check).
    it("buildEnvelope itself no longer refuses a both-forms `exit_status` -- only loadHookmap does", () => {
      const envelope = buildEnvelope(
        "tool.execute.after",
        resultPayload(1),
        fieldReadHookmap({ literal: "success", from: "$.result.metadata.exit" }),
      );

      expect(envelope.params.payload.exit_status).toBe("success");
    });
  });

  /**
   * §V5 review, fix round 2, Important 1: fix round 1's both-forms refusal
   * lived inside `exitStatusOf`, reached only from `buildEnvelope` --
   * measured, under the deployment's negotiated `proceed` posture, as the
   * tool's output delivered UNGOVERNED rather than refused. A both-forms
   * entry needs no payload to detect, exactly like `outputs.mirrors` and
   * `tools`, so it is a load-time hard stop here instead.
   */
  describe("loadHookmap — hooks.<name>.exit_status is validated at load time (§V5 review, fix round 2, Important 1)", () => {
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-exit-status-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }

    const POST_TOOL_USE =
      "host: opencode\nhooks:\n  PostToolUse:\n    acs_method: steps/toolCallResult\n" +
      "    tool_name: $.tool_name\n    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
      "    decisions:\n" +
      "      allow: { output: { x: { value: y } } }\n" +
      "      deny: { output: { x: { value: y } } }\n";

    it("throws, at load time, when `exit_status` declares both `literal` and `from`", () => {
      const broken = `${POST_TOOL_USE}    exit_status: { literal: success, from: $.tool_response.exit }\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(
          /"hooks\.PostToolUse\.exit_status" declares both "literal" and "from"/,
        );
      });
    });

    it("accepts a well-formed literal-only `exit_status`", () => {
      const ok = `${POST_TOOL_USE}    exit_status: { literal: success }\n`;
      withHookmapFile(ok, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });

    it("accepts a well-formed field-read-only `exit_status`", () => {
      const ok = `${POST_TOOL_USE}    exit_status: { from: $.tool_response.exit }\n`;
      withHookmapFile(ok, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });
  });

  /**
   * §V5 review, fix round 2, Important 2, NARROWED in §V5 review, Task 5, fix
   * round 1 (priority item): the request gate still cannot be given an
   * `outputs` declaration -- it builds no result payload for one to
   * describe -- but it CAN now declare `tools`, reversing what this describe
   * block used to pin. See `HookmapHookEntryCommon.tools`'s own doc comment
   * (build-envelope.ts) for the measurement that reversed it: a request
   * gate's own paths resolving for every tool is not the same fact as a
   * deployment's policy configuration being able to evaluate one, and the
   * shipped configuration denies every unregistered tool unconditionally,
   * before any authored rule runs.
   *
   * `outputs?: never`/`exit_status?: never` on `HookmapRequestHookEntry` say
   * the `outputs` half at the type level, but a hookmap arrives as
   * `Bun.YAML.parse(...) as Hookmap`, a cast TypeScript never checks against
   * parsed YAML. Measured: an entry declaring `arguments` alongside
   * `outputs` loaded clean before this fix existed.
   */
  describe("loadHookmap — the request gate's own scoping rule (§V5 review, fix round 2 / Task 5 fix round 1)", () => {
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-request-scope-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }

    const PRE_TOOL_USE =
      "host: opencode\nhooks:\n  PreToolUse:\n    acs_method: steps/toolCallRequest\n" +
      "    tool_name: $.tool_name\n    arguments: $.tool_input\n" +
      "    decisions:\n" +
      "      allow: { output: { x: { value: y } } }\n" +
      "      deny: { output: { x: { value: y } } }\n";

    it("accepts a request-gate entry declaring `tools` -- no longer refused", () => {
      const withTools = `${PRE_TOOL_USE}    tools: [bash]\n`;
      withHookmapFile(withTools, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
        expect(loadHookmap(path).hooks.PreToolUse?.tools).toEqual(["bash"]);
      });
    });

    it("throws, at load time, when a request-gate entry also declares `outputs`", () => {
      const broken =
        `${PRE_TOOL_USE}    outputs: { from: $.tool_input.command, within: $.tool_input, ` +
        `mirrors: [$.tool_input.other] }\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(
          /"hooks\.PreToolUse" declares "arguments" \(a request-gate shape\) and also declares "outputs"/,
        );
      });
    });

    it("a request-gate entry declaring neither loads unaffected", () => {
      withHookmapFile(PRE_TOOL_USE, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
      });
    });

    it("loads the real opencode.hookmap.yaml's request gate, now scoped to `bash`", () => {
      const parsed = loadHookmap("hosts/opencode/opencode.hookmap.yaml");
      expect(parsed.hooks["tool.execute.before"]?.outputs).toBeUndefined();
      expect(parsed.hooks["tool.execute.before"]?.tools).toEqual(["bash"]);
    });
  });

  /**
   * §V5 review, fix round 1, Important 1: host #2's result gate fires for
   * every tool with no matcher, and `metadata` is per-tool -- so the gate
   * has to declare which tool its own `outputs`/`exit_status` paths are
   * actually shaped for. This task ships the SHAPE check only, at the same
   * load-time seam `assertMirrorsWellFormed` uses and for the identical
   * reason: a hookmap that cannot express its own scope must not get to
   * govern a step via a posture-answered `buildEnvelope` throw. Nothing in
   * this module reads `tools` yet -- Task 6 wires the shim to honour it.
   */
  describe("loadHookmap — hooks.<name>.tools is validated at load time (§V5 review, fix round 1, Important 1)", () => {
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-tools-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }

    // A minimal, otherwise well-formed PostToolUse entry -- `decisions`
    // included, so a throw pins the `tools` check specifically.
    const POST_TOOL_USE =
      "host: opencode\nhooks:\n  PostToolUse:\n    acs_method: steps/toolCallResult\n" +
      "    tool_name: $.tool_name\n    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
      "    exit_status: { literal: success }\n" +
      "    decisions:\n" +
      "      allow: { output: { x: { value: y } } }\n" +
      "      deny: { output: { x: { value: y } } }\n";

    it("loads a result-gate entry that declares `tools`", () => {
      const ok = `${POST_TOOL_USE}    tools: [bash]\n`;
      withHookmapFile(ok, (path) => {
        const loaded = loadHookmap(path);
        expect(loaded.hooks.PostToolUse?.tools).toEqual(["bash"]);
      });
    });

    it("throws, at load time, when `tools` is not an array", () => {
      const broken = `${POST_TOOL_USE}    tools: bash\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"hooks\.PostToolUse\.tools" is "bash"/);
      });
    });

    it("throws, at load time, when `tools` is an empty array", () => {
      const broken = `${POST_TOOL_USE}    tools: []\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"hooks\.PostToolUse\.tools" is \[\]/);
      });
    });

    it("throws, at load time, when `tools` contains an empty string", () => {
      const broken = `${POST_TOOL_USE}    tools: [bash, ""]\n`;
      withHookmapFile(broken, (path) => {
        expect(() => loadHookmap(path)).toThrow(/"hooks\.PostToolUse\.tools" is/);
      });
    });

    it("a hook declaring no `tools` at all loads unaffected -- undeclared means every tool", () => {
      withHookmapFile(POST_TOOL_USE, (path) => {
        expect(() => loadHookmap(path)).not.toThrow();
        expect(loadHookmap(path).hooks.PostToolUse?.tools).toBeUndefined();
      });
    });
  });

  /**
   * §V5 review round 3, Important: `assertToolsWellFormed`, above, already
   * treats a bare `tools:` line (YAML's own parse for it is `null` -- a key
   * present and unusable, not a key absent) as "no tools declared", but only
   * inside its own local variable. Before this fix, the `Hookmap` object
   * `loadHookmap` actually returned still carried `tools: null` on that
   * entry, so every CONSUMER had to repeat the same `?? undefined` dance --
   * `hosts/opencode/acs-plugin.ts`'s `isGovernedTool` does, and its own doc
   * comment records the crash (`TypeError: null is not an object`) that
   * happened when an earlier version read `tools !== undefined` instead.
   * `normalizeTools` (build-envelope.ts) closes that: `loadHookmap` now
   * hands back a hookmap whose entries never carry a present-but-`null`
   * `tools`, so a caller reading `tools === undefined` -- the natural,
   * un-defensive reading -- gets the right answer.
   */
  describe("loadHookmap — a present-but-null `tools` normalises to absent (§V5 review round 3, Important)", () => {
    function withHookmapFile(content: string, fn: (path: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "acs-hookmap-tools-normalise-"));
      const path = join(dir, "hookmap.yaml");
      writeFileSync(path, content);
      try {
        fn(path);
      } finally {
        unlinkSync(path);
        rmdirSync(dir);
      }
    }

    // The same otherwise-well-formed entry the sibling "tools is validated
    // at load time" describe block above uses, minus its own `tools` line --
    // each case here adds its own.
    const POST_TOOL_USE =
      "host: opencode\nhooks:\n  PostToolUse:\n    acs_method: steps/toolCallResult\n" +
      "    tool_name: $.tool_name\n    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
      "    exit_status: { literal: success }\n" +
      "    decisions:\n" +
      "      allow: { output: { x: { value: y } } }\n" +
      "      deny: { output: { x: { value: y } } }\n";

    it("a bare `tools:` key loads and comes back with `tools` absent, not `null`", () => {
      const bare = `${POST_TOOL_USE}    tools:\n`;
      withHookmapFile(bare, (path) => {
        const loaded = loadHookmap(path);
        expect(loaded.hooks.PostToolUse?.tools).toBeUndefined();
        // `toBeUndefined()` alone would also pass for a key present and set
        // to literal `undefined` -- impossible from parsed YAML, but this
        // pins the stronger claim the brief asks for: the key itself is
        // OMITTED, not merely read back as `undefined`.
        expect(Object.prototype.hasOwnProperty.call(loaded.hooks.PostToolUse, "tools")).toBe(false);
      });
    });

    it("`tools: null` and no `tools` key at all are indistinguishable to a consumer", () => {
      const bare = `${POST_TOOL_USE}    tools:\n`;
      withHookmapFile(bare, (barePath) => {
        withHookmapFile(POST_TOOL_USE, (noKeyPath) => {
          const fromBareNull = loadHookmap(barePath);
          const fromNoKey = loadHookmap(noKeyPath);
          expect(fromBareNull.hooks.PostToolUse).toEqual(fromNoKey.hooks.PostToolUse);
        });
      });
    });

    // The existing malformed-`tools` throw tests (sibling describe block,
    // above) are unaffected by this change -- they run before
    // `normalizeTools` is ever reached (loadHookmap calls it last, after
    // every check has passed) and continue to throw the same messages.
    // Not re-asserted here; this comment records that they were re-run, not
    // rewritten, for this task.
  });
});
