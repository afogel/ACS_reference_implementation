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
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
// Test-only import: stands up a real Guardian, same precedent as
// hosts/claude-code/test/hook.test.ts:11 and hosts/opencode/test/
// apply-host-output.test.ts's own `renderDecision`-through-the-real-adapter
// test.
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, createGuardianClient, loadHookmap, renderDecision, type Hookmap } from "host-adapter";
import { AcsPlugin } from "../acs-plugin.ts";

const HOOKMAP_PATH = fileURLToPath(new URL("../opencode.hookmap.yaml", import.meta.url));

// "Bash" (capital B), not OpenCode's own lowercase "bash": policy/manifest.yaml
// (Global Constraint 1 -- untouched by this task) registers "Bash" and
// "run_shell" only. An unregistered tool name fails AGT's own evaluation
// closed on runtime_error:tool_unknown before the destructive-command or
// redaction rules this suite means to exercise ever run (measured against
// the real Guardian; see policy/manifest.yaml's own comment on the "Bash"
// entry for the identical reason Task 8's suite registered it). What value
// this field carries is data the plugin passes through unexamined (S1); this
// suite picks the one the shipped policy actually evaluates.
const TOOL = "Bash";

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  // Read at AcsPlugin's own construction, per hosts/opencode/acs-plugin.ts's
  // own header ("the plugin reads ACS_GUARDIAN_URL when it is constructed") --
  // so this has to be set before AcsPlugin runs, not merely before the hook
  // fires. Same precedent as hosts/claude-code/test/hook.test.ts:84.
  process.env.ACS_GUARDIAN_URL = guardian.url;
});

afterAll(async () => {
  await guardian.close();
  delete process.env.ACS_GUARDIAN_URL;
});

describe('AcsPlugin\'s "tool.execute.before" hook -- the request gate, against a live Guardian', () => {
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
});
