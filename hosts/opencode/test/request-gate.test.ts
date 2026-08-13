/**
 * The request gate, end to end (S2, Task 5): `AcsPlugin`'s
 * `"tool.execute.before"` hook, against a LIVE Guardian -- exactly as
 * hosts/claude-code/test/hook.test.ts proves the wire contract for host #1,
 * not against a hand-copied shape. Everything below the plugin factory
 * itself -- `applyOpenCodeOutput` in isolation, the shipped hookmap's static
 * shape, `AcsPlugin`'s own load-time gate -- already has its own suite
 * (apply-host-output.test.ts, hookmap.test.ts, acs-plugin.test.ts); this is
 * the first one that calls the hook OpenCode itself would call.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Test-only import: stands up a real Guardian, same precedent as
// hosts/claude-code/test/hook.test.ts:11 and hosts/opencode/test/
// apply-host-output.test.ts's own `renderDecision`-through-the-real-adapter
// test.
import { startGuardian, type StartedGuardian } from "guardian";
import {
  buildEnvelope,
  createGuardianClient,
  governsTool,
  createSessionConfigStore,
  DEFAULT_TIMEOUT_MS,
  governStep,
  loadHookmap,
  NULL_AUDIT_SINK,
  renderDecision,
  resolveSessionConfig,
  toSessionUuid,
  type Hookmap,
} from "host-adapter";
import { AcsPlugin } from "../acs-plugin.ts";
import { applyOpenCodeOutput } from "../apply-host-output.ts";

const HOOKMAP_PATH = fileURLToPath(new URL("../opencode.hookmap.yaml", import.meta.url));

// "bash" (lowercase) -- OpenCode's own real tool name, measured on 1.18.15
// and what opencode.hookmap.yaml's request gate now scopes `tools:` to
// (§V5 review, Task 5, fix round 1, priority item). This suite used to test
// against "Bash" (Claude Code's name, capitalised): that hid a slice-level
// defect -- policy/manifest.yaml's fixed policy_target denies every tool it
// has not registered, unconditionally, before any authored rule runs, and
// "bash" was not registered -- because "Bash" happened to already be
// registered for host #1's own suite. policy/manifest.yaml now registers
// "bash" too (additive), so this suite exercises the name the host actually
// sends.
const TOOL = "bash";

// V3's own precedent, matching hosts/claude-code/test/hook.test.ts's own
// ACS_AUDIT_LOG redirect: every test below expects a real decision to
// arrive, so nothing here should ever write an entry -- but a handshake
// failure mid-run would append raw tool arguments (a destructive command,
// among them) to the developer's own real `.acs/audit.jsonl`, the exact file
// `.gitignore` exists for because it carries them. Redirected regardless of
// whether today's tests reach that path.
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "acs-request-gate-test-"));
const AUDIT_LOG = join(SCRATCH_DIR, "audit.jsonl");

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  // Read at AcsPlugin's own construction, per hosts/opencode/acs-plugin.ts's
  // own header ("the plugin reads ACS_GUARDIAN_URL when it is constructed") --
  // so this has to be set before AcsPlugin runs, not merely before the hook
  // fires. Same precedent as hosts/claude-code/test/hook.test.ts:84.
  process.env.ACS_GUARDIAN_URL = guardian.url;
  process.env.ACS_AUDIT_LOG = AUDIT_LOG;
});

afterAll(async () => {
  await guardian.close();
  delete process.env.ACS_GUARDIAN_URL;
  delete process.env.ACS_AUDIT_LOG;
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

describe('AcsPlugin\'s "tool.execute.before" hook -- the request gate, against a live Guardian', () => {
  it("allows a clean command: no throw, and args untouched", async () => {
    const hooks = await AcsPlugin({} as never);
    const output = { args: { command: "ls -la" } };

    await expect(
      hooks["tool.execute.before"]!({ tool: TOOL, sessionID: "ses-request-gate-allow", callID: "c1" }, output),
    ).resolves.toBeUndefined();

    // A clean allow renders no `args` field at all (only the declared-inert
    // `reason.text`), so applyOpenCodeOutput's pass 3 merges nothing -- the live
    // object is the SAME reference, untouched.
    expect(output.args).toEqual({ command: "ls -la" });
    // No audit entry either: a decision arrived, so no fail-open posture was
    // ever consulted.
    expect(existsSync(AUDIT_LOG)).toBe(false);
  });

  it("denies a destructive command by throwing, with the Guardian's own reason, and applies nothing first", async () => {
    const sessionID = "ses-request-gate-deny";
    const command = "rm -rf /";

    const hooks = await AcsPlugin({} as never);
    const output = { args: { command } };

    let thrown: unknown;
    try {
      await hooks["tool.execute.before"]!({ tool: TOOL, sessionID, callID: "c1" }, output);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Nothing half-applied: the live object this call was handed is
    // untouched, the same all-or-nothing guarantee apply-host-output.test.ts
    // pins in isolation, now proven through governStep and a real deny.
    expect(output.args.command).toBe(command);

    // Cross-check against the real Guardian's own decision for the identical
    // tool call, obtained independently of the hook (the same composition
    // acs-plugin.ts's own "tool.execute.before" performs, called directly
    // rather than through the hook) -- proves the thrown message is the
    // policy's actual text, not a hardcoded placeholder. Same precedent as
    // hosts/claude-code/test/hook.test.ts's own cross-check.
    const hookmap: Hookmap = loadHookmap(HOOKMAP_PATH);
    const envelope = buildEnvelope(
      "tool.execute.before",
      { tool: TOOL, session_id: sessionID, callID: "c1", args: { command } },
      hookmap,
    );
    const response = await createGuardianClient(guardian.url).post(envelope);
    expect(response.error).toBeUndefined();
    const expected = renderDecision(
      "tool.execute.before",
      response.result as { decision: string } & Record<string, unknown>,
      hookmap,
    ) as { refuse?: { denied?: unknown; reason?: unknown } };

    expect(expected.refuse?.denied).toBe(true);
    expect(typeof expected.refuse?.reason).toBe("string");
    expect((thrown as Error).message).toBe(expected.refuse!.reason as string);
  });

  it("applies a rewrite to the live args in place, for a command a redaction rewrites", async () => {
    const hooks = await AcsPlugin({} as never);
    const output = { args: { command: "echo ghp_ABCDEF123456" } };
    const originalArgs = output.args;

    await expect(
      hooks["tool.execute.before"]!(
        { tool: TOOL, sessionID: "ses-request-gate-modify", callID: "c1" },
        output,
      ),
    ).resolves.toBeUndefined();

    // Mutated in place -- applyOpenCodeOutput's own contract -- not replaced with
    // a new object.
    expect(output.args).toBe(originalArgs);
    expect(output.args.command).toBe("echo [REDACTED]");
  });

  it("throws before asking the Guardian anything when sessionID is missing or empty -- a broken deployment, not a policy question", async () => {
    const hooks = await AcsPlugin({} as never);
    const output = { args: { command: "ls -la" } };

    await expect(
      hooks["tool.execute.before"]!({ tool: TOOL, sessionID: "", callID: "c1" }, output),
    ).rejects.toThrow(/sessionID/);
    // Nothing half-applied here either: a broken deployment refuses before
    // any live object could have been touched.
    expect(output.args.command).toBe("ls -la");
  });

  it("skips a tool outside this gate's own tools list: no throw, args untouched, and no Guardian request goes out (§V5 review, Task 5, fix round 1, priority item)", async () => {
    // "read" -- one of the real tool names measured alongside "bash" that
    // opencode.hookmap.yaml's request gate does NOT list. Args shaped the
    // way OpenCode's own "read" tool call actually is (the coordinator's own
    // measurement): {filePath}, not {command} -- this gate is never asked to
    // resolve `$.args` for it at all, so the shape does not matter to the
    // assertion, only that nothing here touches it.
    const hooks = await AcsPlugin({} as never);
    const output = { args: { filePath: "/etc/passwd" } };

    // If the skip did not run before any envelope was built, a request would
    // go out over `fetch` (createGuardianClient's own wire primitive) --
    // spied here, not mocked, so a call that DOES happen still reaches the
    // real Guardian rather than hanging; the assertion below is on whether
    // it was called at all, not on what it returned.
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await expect(
        hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses-request-gate-unlisted", callID: "c1" }, output),
      ).resolves.toBeUndefined();

      expect(output.args).toEqual({ filePath: "/etc/passwd" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not crash on a bare `tools:` key (YAML null) -- read as \"every tool\", not a TypeError (§V5 review, Task 5, fix round 2, Important 1)", async () => {
    // `tools:` with nothing after it parses to YAML null -- present and
    // unusable, not absent. Before the shim's own `?? undefined` fix, EVERY
    // call through this gate threw `TypeError: null is not an object
    // (evaluating 'tools.includes')`, naming neither the hookmap nor the
    // field: assertToolsWellFormed (build-envelope.ts) normalised that key to
    // "absent" for ITS OWN validation only, and the Hookmap object
    // loadHookmap handed back still carried the raw `null` on this entry.
    // NEITHER HALF OF THAT SENTENCE IS STILL TRUE, and this test outlived
    // both: `loadHookmap` now returns a normalised hookmap with the key
    // OMITTED (`normalizeTools`, §V5 review round 3, Task 1), and the shim
    // function that carried the compensation is gone, replaced by the
    // adapter's own `governsTool` (Task 2), which carries none. What this
    // test still pins is the BEHAVIOUR both changes have to preserve -- a
    // bare `tools:` means "every tool" -- through whichever of them is
    // responsible for it next.
    const hookmapPath = join(SCRATCH_DIR, "bare-tools.hookmap.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    tools:\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );

    const previousHookmapPath = process.env.ACS_HOOKMAP_PATH;
    process.env.ACS_HOOKMAP_PATH = hookmapPath;
    try {
      const hooks = await AcsPlugin({} as never);
      const output = { args: { command: "ls -la" } };
      await expect(
        hooks["tool.execute.before"]!({ tool: TOOL, sessionID: "ses-request-gate-bare-tools", callID: "c1" }, output),
      ).resolves.toBeUndefined();
      // Governed, not skipped: a bare `tools:` means "every tool", the same
      // as an undeclared one -- a clean allow, so args is untouched.
      expect(output.args).toEqual({ command: "ls -la" });
    } finally {
      if (previousHookmapPath === undefined) {
        delete process.env.ACS_HOOKMAP_PATH;
      } else {
        process.env.ACS_HOOKMAP_PATH = previousHookmapPath;
      }
    }
  });

  it("throws before asking the Guardian anything when `tool` is missing or not a string -- the same broken-deployment refusal `sessionID` gets, not a silent skip (§V5 review, Task 5, fix round 2, Important 2)", async () => {
    // Before this fix, the gate's own `tools.includes(undefined)` read as
    // `false` -- "not in this gate's tools list" -- and the hook returned
    // cleanly: no throw, no fetch, no audit line. Measured against
    // the PRIOR gate (before `tools` scoping existed at all): a malformed
    // `tool` reached `buildEnvelope`, which throws, caught by `governStep`'s
    // stage-"request" catch and answered by the negotiated posture --
    // AUDITED regardless of which way the posture resolved. This asserts
    // the fix restores an ungoverned-but-loud stop, closer to (loud stop
    // beats silent proceed) rather than exactly reproducing the posture
    // path -- no fetch at all, the same "broken deployment" shape
    // `sessionID`'s own missing-value test already gets.
    const hooks = await AcsPlugin({} as never);
    const output = { args: { command: "ls -la" } };

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await expect(
        hooks["tool.execute.before"]!(
          { tool: undefined as unknown as string, sessionID: "ses-request-gate-bad-tool", callID: "c1" },
          output,
        ),
      ).rejects.toThrow(/tool/i);
      // Nothing half-applied, and nothing asked: the same discipline the
      // sessionID refusal already gets.
      expect(output.args.command).toBe("ls -la");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * THE REQUEST GATE'S OWN MEMBER OF THE CLASS §V5 review round 3, Task 5 closed
 * at the result gate (fix round 1, Important 2) -- a `modify` the hookmap gives
 * nowhere to land.
 *
 * Task 5's first round named this in a doc comment and explicitly did NOT claim
 * to have measured it ("NOT MEASURED AT THIS GATE, and not claimed as if it
 * were"). This is that measurement, and it is worse than the comment guessed:
 * the step is not merely ungoverned, it is recorded as governed. `governStep`
 * returns `stage: "honoured"` -- a decision arrived and was honoured -- while
 * the rewrite it carried landed nowhere.
 *
 * Routed around `AcsPlugin` for the same reason the result gate's own fail-open
 * block is (result-gate.test.ts): the fix is a load-time refusal, so a test
 * driven through the factory would stop measuring the hazard the moment the
 * gate lands. This calls `loadHookmap` -> `resolveSessionConfig` -> `governStep`
 * -> `applyOpenCodeOutput`, exactly what the hook calls, with the factory out of
 * the path.
 */
describe("a request-gate modify the hookmap gives no way to land -- the measured fail-open", () => {
  // The shipped request gate up to (but not including) its `modify` block --
  // every line the shipped file's. Each test below appends one `modify` block,
  // so the shapes are compared on exactly one variable.
  const REQUEST_GATE_HEAD_FOR_FAILOPEN =
    "host: opencode\n" +
    "hooks:\n" +
    "  tool.execute.before:\n" +
    "    acs_method: steps/toolCallRequest\n" +
    "    tool_name: $.tool\n" +
    "    arguments: $.args\n" +
    "    tools: [bash]\n" +
    "    decisions:\n" +
    "      allow:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n" +
    "      deny:\n" +
    "        output:\n" +
    "          refuse.denied: { value: true }\n" +
    "          refuse.reason: { from: reasoning, type: string }\n";

  const MODIFY_WITHOUT_A_SINK =
    REQUEST_GATE_HEAD_FOR_FAILOPEN +
    "      modify:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n";

  it("renders nothing, applies nothing, and is audited as HONOURED while the secret survives in live.args", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-without-a-sink.yaml");
    writeFileSync(hookmapPath, MODIFY_WITHOUT_A_SINK);
    // Loads clean: `assertRenderableDecisions` requires only a non-empty
    // `output` block whose every field names a `value` or a `from`.
    const hookmap: Hookmap = loadHookmap(hookmapPath);

    const sessionID = "ses-request-gate-modify-no-sink";
    // The same command the shipped-hookmap `modify` test above rewrites to
    // "echo [REDACTED]" -- so the Guardian's answer here is that identical
    // decision, carrying that identical `applied_input`.
    const SECRET_COMMAND = "echo ghp_ABCDEF123456";
    const args = { command: SECRET_COMMAND };

    const client = createGuardianClient(guardian.url);
    const session = await resolveSessionConfig(
      { guardian: client, agentId: hookmap.host, sessionId: toSessionUuid(sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
      createSessionConfigStore(),
    );
    const governed = await governStep({
      hookEventName: "tool.execute.before",
      payload: { tool: TOOL, session_id: sessionID, callID: "c1", args },
      hookmap,
      guardian: client,
      session,
      sessionId: sessionID,
      audit: NULL_AUDIT_SINK,
    });

    // A REAL modify, and the rewrite it carries is right there on the decision.
    expect(governed.decision?.decision).toBe("modify");
    expect((governed.decision as { applied_input?: Record<string, unknown> }).applied_input).toEqual({
      command: "echo [REDACTED]",
    });

    // THE PART THAT MAKES THIS WORSE THAN SILENT. `stage: "honoured"` is what
    // an audit entry for this step would record -- a decision that arrived and
    // was honoured -- and nothing was applied. The audit trail is not merely
    // missing the fault; it asserts the opposite of it.
    expect(governed.stage).toBe("honoured");

    // LITERALLY `{}`: this modify carries no `reasoning`, so `reason.text`
    // renders nothing either, and no other field is declared.
    expect(governed.output).toEqual({});

    expect(() => applyOpenCodeOutput(governed.output, { gate: "request", args })).not.toThrow();
    // The command runs unredacted.
    expect(args.command).toBe(SECRET_COMMAND);
  });

  /**
   * Runs the same chain for one `modify` output block, and reports what the
   * applier did to the live args -- so the three shapes below are compared on
   * exactly one variable.
   */
  async function modifyThrough(
    modifyBlock: string,
    fixtureName: string,
    sessionID: string,
  ): Promise<{ output: Record<string, unknown>; args: { command: string }; threw: unknown }> {
    const hookmapPath = join(SCRATCH_DIR, fixtureName);
    writeFileSync(hookmapPath, REQUEST_GATE_HEAD_FOR_FAILOPEN + modifyBlock);
    const hookmap: Hookmap = loadHookmap(hookmapPath);
    const args = { command: "echo ghp_ABCDEF123456" };
    const client = createGuardianClient(guardian.url);
    const session = await resolveSessionConfig(
      { guardian: client, agentId: hookmap.host, sessionId: toSessionUuid(sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
      createSessionConfigStore(),
    );
    const governed = await governStep({
      hookEventName: "tool.execute.before",
      payload: { tool: TOOL, session_id: sessionID, callID: "c1", args },
      hookmap,
      guardian: client,
      session,
      sessionId: sessionID,
      audit: NULL_AUDIT_SINK,
    });
    expect(governed.decision?.decision).toBe("modify");
    let threw: unknown;
    try {
      applyOpenCodeOutput(governed.output, { gate: "request", args });
    } catch (error) {
      threw = error;
    }
    return { output: governed.output as Record<string, unknown>, args, threw };
  }

  // §V5 review round 3, Task 5, FIX ROUND 2, CRITICAL -- the request gate's own
  // copies of the two shapes `declaresSinkFrom` accepted while checking only
  // what the sink NAMED, never whether the field could RENDER.
  it("modify declaring args with type: string renders {} -- applied_input is an object, so the type filter drops it", async () => {
    const { output, args, threw } = await modifyThrough(
      "      modify:\n" + "        output:\n" + "          args: { from: applied_input, type: string }\n",
      "request-modify-type-string.yaml",
      "ses-request-gate-modify-type-string",
    );
    expect(output).toEqual({});
    expect(threw).toBeUndefined();
    expect(args.command).toBe("echo ghp_ABCDEF123456");
  });

  it("modify declaring a literal args BESIDE the right from: lands the author's own command on every rewrite", async () => {
    // Worse than a no-op at this gate: `renderDecision` prefers `value` and
    // never reads `applied_input`, so the applier merges a command the
    // Guardian never chose -- identical on every modify this deployment ever
    // sees, and the actual rewrite never lands.
    const { output, args, threw } = await modifyThrough(
      "      modify:\n" +
        "        output:\n" +
        '          args: { value: { command: "echo pwned" }, from: applied_input }\n',
      "request-modify-value-beside-from.yaml",
      "ses-request-gate-modify-value-beside-from",
    );
    expect(output).toEqual({ args: { command: "echo pwned" } });
    expect(threw).toBeUndefined();
    expect(args.command).toBe("echo pwned");
    expect(args.command).not.toBe("echo [REDACTED]");
  });

  // THE OTHER DIRECTION (§V5 review round 3, Task 5, fix round 2, Minor): a
  // `modify` an author chose to map to a refusal instead of a rewrite. Blocking
  // the tool is strictly MORE conservative than rewriting its arguments -- the
  // command never runs at all -- and it is the shipped hookmap's own idiom for
  // `ask`/`defer` at this gate. Not a silent no-op, so not this gate's to
  // refuse.
  // §V5 review round 3, Task 5, FIX ROUND 4, CRITICAL 7B -- the request gate's
  // own table entry is WRONG whenever the entry declares `outputs:` instead of
  // `arguments:`. `governStep` builds its output location off the ENTRY'S
  // SHAPE, so a request hook declaring `outputs:` gets one -- and `resolveModify`
  // (decision-modify.ts) then fills `applied_output` instead of `applied_input`.
  // The sink this gate demands (`args: { from: applied_input }`) is correct,
  // declared, and unfillable.
  it("a request hook declaring outputs: gets applied_output, not applied_input -- the mandated args sink renders nothing", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-hook-with-outputs.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallResult\n" +
        "    tool_name: $.tool\n" +
        "    outputs:\n" +
        "      from: $.args.command\n" +
        "      within: $.args\n" +
        "    exit_status: { literal: success }\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          args: { from: applied_input }\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    const hookmap: Hookmap = loadHookmap(hookmapPath);
    const sessionID = "ses-request-hook-with-outputs";
    const args = { command: "echo ghp_ABCDEF123456" };
    const client = createGuardianClient(guardian.url);
    const session = await resolveSessionConfig(
      { guardian: client, agentId: hookmap.host, sessionId: toSessionUuid(sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
      createSessionConfigStore(),
    );
    const governed = await governStep({
      hookEventName: "tool.execute.before",
      payload: { tool: TOOL, session_id: sessionID, callID: "c1", args },
      hookmap,
      guardian: client,
      session,
      sessionId: sessionID,
      audit: NULL_AUDIT_SINK,
    });

    expect(governed.decision?.decision).toBe("modify");
    // The rewrite arrived on the OTHER field.
    const decision = governed.decision as { applied_input?: unknown; applied_output?: unknown };
    expect(decision.applied_input).toBeUndefined();
    expect(decision.applied_output).toBeDefined();

    // So the mandated sink renders nothing, and the audit says honoured.
    expect(Object.hasOwn(governed.output, "args")).toBe(false);
    expect(governed.stage).toBe("honoured");
    expect(() => applyOpenCodeOutput(governed.output, { gate: "request", args })).not.toThrow();
    expect(args.command).toBe("echo ghp_ABCDEF123456");
  });

  // §V5 review round 3, Task 5, FIX ROUND 4 -- NOT on the directed list. The
  // shim asks `governsTool(hookmap, hook, input.tool)` while `governStep` asks
  // the same function with whatever this entry's `tool_name` path resolves to.
  // acs-plugin.ts's own header records that they can diverge and that "nothing
  // detects that". This measures what the divergence actually costs.
  it("a tool_name path pointing away from $.tool makes governStep skip a governed tool entirely -- silent and unaudited", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-tool-name-diverges.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.args.command\n" +
        "    arguments: $.args\n" +
        "    tools: [bash]\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    const hookmap: Hookmap = loadHookmap(hookmapPath);
    const sessionID = "ses-request-tool-name-diverges";
    const args = { command: "rm -rf /" };
    const client = createGuardianClient(guardian.url);
    const session = await resolveSessionConfig(
      { guardian: client, agentId: hookmap.host, sessionId: toSessionUuid(sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
      createSessionConfigStore(),
    );

    // The shim's own early check says this tool IS governed -- it passes
    // `input.tool`, which the `tools` list names.
    expect(governsTool(hookmap, "tool.execute.before", TOOL)).toBe(true);

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const governed = await governStep({
        hookEventName: "tool.execute.before",
        payload: { tool: TOOL, session_id: sessionID, callID: "c1", args },
        hookmap,
        guardian: client,
        session,
        sessionId: sessionID,
        audit: NULL_AUDIT_SINK,
      });
      // But governStep resolves `tool_name` to the COMMAND, which the `tools`
      // list does not name -- so it skips: ungoverned, no decision, no
      // Guardian request, and nothing for an audit entry to record.
      expect(governed.stage).toBe("ungoverned");
      expect(governed.decision).toBeNull();
      expect(governed.output).toEqual({});
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(() => applyOpenCodeOutput(governed.output, { gate: "request", args })).not.toThrow();
      expect(args.command).toBe("rm -rf /");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // §V5 review round 3, Task 5, FIX ROUND 4, IMPORTANT 7A -- a DECLARED
  // decision name the tables do not know is silently unchecked, because
  // `assertDecisionsCanAct` iterates the TABLE and not the hookmap's own
  // declared decisions. `expectationFor` throws on an unknown HOOK; the
  // identical skip one level down was silent.
  //
  // Needs a non-conformant Guardian to reach at runtime, which is why it ranks
  // below the others -- but declaring the inert entry is strictly WORSE than
  // not declaring it: without the entry `renderDecision` throws, `governStep`
  // catches it, and the posture answers it, audited. With it, nothing happens
  // and nothing is recorded. Constructed decision, same reason as the
  // `ask`/`defer` cases in result-gate.test.ts.
  it("a declared decision name the gate's tables do not know renders an inert reason and applies nothing", () => {
    const hookmapPath = join(SCRATCH_DIR, "request-unknown-decision.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "      block:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    const hookmap: Hookmap = loadHookmap(hookmapPath);
    const args = { command: "rm -rf /" };

    const rendered = renderDecision(
      "tool.execute.before",
      { decision: "block", reasoning: "blocked" } as unknown as Parameters<typeof renderDecision>[1],
      hookmap,
    );
    expect(rendered).toEqual({ reason: { text: "blocked" } });
    expect(() => applyOpenCodeOutput(rendered, { gate: "request", args })).not.toThrow();
    expect(args.command).toBe("rm -rf /");

    // WITHOUT the inert entry the same decision fails loudly instead -- which
    // is what makes declaring it strictly worse than leaving it out.
    const withoutPath = join(SCRATCH_DIR, "request-no-unknown-decision.yaml");
    writeFileSync(
      withoutPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n",
    );
    expect(() =>
      renderDecision(
        "tool.execute.before",
        { decision: "block", reasoning: "blocked" } as unknown as Parameters<typeof renderDecision>[1],
        loadHookmap(withoutPath),
      ),
    ).toThrow(/no decisions entry for ACS decision "block"/);
  });

  it("a request-gate modify mapped to an unconditional refusal THROWS before the tool runs, and applies nothing", async () => {
    const { output, args, threw } = await modifyThrough(
      "      modify:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
      "request-modify-as-refusal.yaml",
      "ses-request-gate-modify-as-refusal",
    );
    expect(output).toEqual({ refuse: { denied: true } });
    expect(threw).toBeInstanceOf(Error);
    // Nothing half-applied: pass 2a throws before any assignment.
    expect(args.command).toBe("echo ghp_ABCDEF123456");
  });
});
