import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope } from "guardian";
import {
  buildEnvelope,
  loadHookmap,
  toSessionUuid,
  unwrapArguments,
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
// (and no code's, in the adapter, above the path level). V4: per hook, because
// the shape a host reads back is a property of the gate.
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

  // Was "PostToolUse" until V4 mapped it. Kept pointed at a hook this fixture
  // genuinely does not map -- SessionStart is a real Claude Code hook and no
  // slice wires it -- because the claim is about an UNMAPPED name, and a name
  // the fixture now maps would go on throwing for an unrelated reason (its
  // paths not resolving against a PreToolUse payload) while reading as
  // coverage of this one.
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

  describe("loadHookmap — every hook's decisions.allow and decisions.deny must be renderable (V3 fix round 1, item 1)", () => {
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
    // were longer than the assertions they set up. V4: `decisions` is indented
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

    // V4, and the whole point of the block moving: the minimum is per HOOK. A
    // delivery failure is answered by the posture at whichever gate suffered it,
    // so a second gate declaring no `deny` is a gate whose fail-closed answer
    // cannot be rendered -- and the first gate having one says nothing about it.
    // Before the move there was one block and this case could not exist.
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

  describe("unwrapArguments", () => {
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

  describe("PostToolUse -> steps/toolCallResult", () => {
    const payload = {
      session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      // The real shape, captured from Claude Code 2.1.227 (Evidence 2).
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

    // Review finding: the early return in `unwrapArguments` that answers a
    // result payload had no test at all, and the two that exist both feed it a
    // PreToolUse envelope. Deleting the guard left the whole suite green while
    // `Object.entries(undefined)` throws -- and it throws inside governStep's
    // "delivery" try, which answers a throw with the deployment's failure
    // posture. So the untested guard was the difference between a step going on
    // to ask for a decision and a step resolved by posture without ever asking,
    // which under a `proceed` posture is the fail-open the guard exists to
    // close. Mutation-tested: with the early return removed, this case fails.
    it("unwrapArguments answers the empty bag for a result envelope, which has no `arguments` member to unwrap", () => {
      const envelope = buildEnvelope("PostToolUse", payload, hookmap);

      expect(unwrapArguments(envelope)).toEqual({});
    });

    // Review finding: every case above builds against the hand-written fixture,
    // so the stanza actually SHIPPED was exercised by nothing. A YAML-level
    // divergence between the two -- indentation, `exit_status` nested one level
    // off -- would be invisible until the shim loaded the real file, and this
    // project has already shipped a hookmap reshape that left one gate reading
    // the old shape. No `validateEnvelope` here on purpose: it payload-checks
    // steps/toolCallRequest only, until Task 3 teaches it the result payload.
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

    // Global Constraint 4: a malformed hookmap entry throws, naming the hook.
    // Never a default method, a default payload shape, or a partial envelope --
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

      // Review finding: `within` was the one declared member nothing checked,
      // while the type makes it mandatory and Global Constraint 3 makes it
      // load-bearing. An entry missing it built a clean envelope and the gap
      // surfaced only at render, where the consequence is the host declining the
      // replacement and delivering the ORIGINAL, unredacted output -- a
      // redaction reported and never landed. Same reasoning, and same place, as
      // assertRenderableDecisions checking what renderDecision will need.
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

      it("throws, naming the hook, when `exit_status` names no literal", () => {
        const broken = withBrokenEntry({
          acs_method: "steps/toolCallResult",
          tool_name: "$.tool_name",
          outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
        });

        expect(() => buildEnvelope("Broken", payload, broken)).toThrow(
          /hook "Broken" declares "outputs" without a non-empty "exit_status\.literal"/,
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
});
