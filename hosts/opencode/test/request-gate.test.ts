/**
 * The request gate, end to end (S2, Task 5): `AcsPlugin`'s
 * `"tool.execute.before"` hook, against a LIVE Guardian -- exactly as
 * hosts/claude-code/test/hook.test.ts proves the wire contract for host #1,
 * not against a hand-copied shape. Everything below the plugin factory
 * itself -- `applyHostOutput` in isolation, the shipped hookmap's static
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
import { buildEnvelope, createGuardianClient, loadHookmap, renderDecision, type Hookmap } from "host-adapter";
import { AcsPlugin } from "../acs-plugin.ts";

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
    // `reason.text`), so applyHostOutput's pass 3 merges nothing -- the live
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

    // Mutated in place -- applyHostOutput's own contract -- not replaced with
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
