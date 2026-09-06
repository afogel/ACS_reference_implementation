import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
// Test-only import: stands up a real Guardian so this test proves the wire
// contract for real, not against a hand-copied shape -- same precedent as
// packages/host-adapter/test/client.test.ts. `host-adapter` here
// is used the same way the shim itself uses it, so this test also proves
// what a subprocess sees is what the adapter would have produced directly.
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, createGuardianClient, loadHookmap, renderDecision, type Hookmap } from "host-adapter";

const SHIM_PATH = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));
const HOOKMAP_PATH = fileURLToPath(new URL("../claude-code.hookmap.yaml", import.meta.url));

/** The real PreToolUse payload shape Claude Code delivers on stdin, with
 * `tool_name: "Bash"` -- what Claude Code actually sends, and what
 * `policy/manifest.yaml` registers. */
function preToolUsePayload(command: string): Record<string, unknown> {
  return {
    session_id: "abc123",
    transcript_path: "/path/to/transcript.jsonl",
    cwd: "/current/dir",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

/** Spawns the real shim as a subprocess -- exactly how Claude Code invokes
 * it -- feeds it `payload` on stdin, and returns what it wrote once it has
 * run to completion. */
async function runHook(
  payload: Record<string, unknown>,
  guardianUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SHIM_PATH],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ACS_GUARDIAN_URL: guardianUrl },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
});

afterAll(async () => {
  await guardian.close();
});

describe("acs-hook.ts -- the Claude Code hook shim, run as a real subprocess", () => {
  it("denies a real rm -rf / tool call: exit 0, clean JSON on stdout, and the policy's own reasoning in permissionDecisionReason", async () => {
    const payload = preToolUsePayload("rm -rf /");

    const { stdout, stderr, exitCode } = await runHook(payload, guardian.url);

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> };

    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(typeof reason).toBe("string");
    expect((reason as string).length).toBeGreaterThan(0);

    // Cross-check against the real Guardian's own decision for the
    // identical tool call, obtained independently of the subprocess (the
    // exact composition the shim itself performs, called directly rather
    // than through stdin/stdout) -- proves the shim relays the policy's
    // actual text rather than a hardcoded placeholder, which a suite that
    // only checked "reason is a non-empty string" would miss. This is the
    // demo's entire payoff: what a human reads in the transcript.
    const hookmap: Hookmap = loadHookmap(HOOKMAP_PATH);
    const envelope = buildEnvelope("PreToolUse", payload, hookmap);
    const response = await createGuardianClient(guardian.url).post(envelope);
    expect(response.error).toBeUndefined();
    const expected = renderDecision(
      response.result as { decision: string } & Record<string, unknown>,
      hookmap,
    ) as { hookSpecificOutput: Record<string, unknown> };

    expect(reason).toBe(expected.hookSpecificOutput.permissionDecisionReason);
    expect(stderr).toBe("");
  });

  it("allows a real ls -la tool call: exit 0, and clean JSON on stdout with a plain allow", async () => {
    const payload = preToolUsePayload("ls -la");

    const { stdout, stderr, exitCode } = await runHook(payload, guardian.url);

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> };

    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    });
    expect(stderr).toBe("");
  });
});
