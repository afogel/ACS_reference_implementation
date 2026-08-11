import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Test-only import, the precedent hook.test.ts and packages/host-adapter/test/
// already set: stands up a REAL Guardian, over real HTTP, against the real
// pinned policy bundle, so the claim below is about what a Claude Code process
// actually reads back rather than about a hand-copied decision shape.
import { startGuardian, type StartedGuardian } from "guardian";

/**
 * The result gate, end to end: a real Claude Code `PostToolUse` payload on
 * stdin, a real Guardian in front of the real pinned AGT bundle, and the exact
 * JSON the shim writes on stdout.
 *
 * WHY THE ASSERTIONS HERE ARE WHOLE-OBJECT LITERALS. Claude Code SILENTLY
 * DISCARDS a replacement that does not match the tool's own output schema and
 * delivers the ORIGINAL (verified by hand against 2.1.227 during V4's
 * planning). A hook that answered `updatedToolOutput: "[REDACTED]"` -- a plain
 * string, the natural reading of "redact the output" -- produced
 *
 *   PostToolUse hook returned updatedToolOutput that does not match Bash's
 *   output shape; using original output. [{"expected":"object", ...}]
 *
 * on stderr while the model received the real secret. So a redaction is only a
 * redaction if EVERY SIBLING FIELD SURVIVES, and a test that asserted only
 * `updatedToolOutput.stdout` would pass while the replacement was declined and
 * the token delivered. That single whole-object assertion is what stands
 * between this deployment and Claude Code quietly handing the secret to the
 * model.
 *
 * The shape below is `Bash`'s real one, captured from a live 2.1.227 payload:
 * `{stdout, stderr, interrupted, isImage, noOutputExpected}`.
 */
const SHIM_PATH = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));

/**
 * The scratch tree this suite is allowed to touch. The shim negotiates a
 * session (S13) and can audit a fail-open (S14), both of which default under
 * the process cwd -- which would scatter real files into the repo on every
 * run. Every test here uses one session id, so `sessions/<id>.json` is the only
 * file any of them can create; an `audit.jsonl` would mean a delivery failure
 * happened, and the test that saw it should fail on its own assertions rather
 * than on a leftover file.
 */
const SESSION = "post-1";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-post-tool-use-"));
  dirs.push(dir);
  return dir;
}

/** Removes exactly what a run can leave behind, by name, never recursively --
 * the cleanup posture of posture.test.ts and wire-shape.test.ts next door. */
function cleanupScratch(dir: string): void {
  const sessionsDir = join(dir, "sessions");
  for (const file of [join(dir, "audit.jsonl"), join(sessionsDir, `${SESSION}.json`)]) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
  if (existsSync(sessionsDir)) {
    rmdirSync(sessionsDir);
  }
  rmdirSync(dir);
}

afterEach(() => {
  while (dirs.length > 0) {
    cleanupScratch(dirs.pop() as string);
  }
});

/** The real `tool_response` object Claude Code 2.1.227 delivers for `Bash`. */
function toolResponse(stdout: string): Record<string, unknown> {
  return { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
}

/** The real `PostToolUse` payload shape, with `tool_name: "Bash"` -- what
 * Claude Code sends and what policy/manifest.yaml registers. */
function postToolUsePayload(stdout: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: "/path/to/transcript.jsonl",
    cwd: "/current/dir",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
    tool_response: toolResponse(stdout),
  };
}

/** Spawns the real shim as a subprocess -- exactly how Claude Code invokes it
 * -- feeds it `payload` on stdin, and returns what it wrote. */
async function runHook(
  payload: Record<string, unknown>,
  guardianUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = scratch();
  const proc = Bun.spawn({
    cmd: ["bun", "run", SHIM_PATH],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ACS_GUARDIAN_URL: guardianUrl,
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    },
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

/**
 * A stub Guardian that negotiates a real session and then answers the step
 * call with `decision`.
 *
 * Used only for the two decisions the shipped bundle does not produce at this
 * gate -- a result-gate `deny`, and a `modify` whose redaction addresses a
 * field the result payload does not have. Both are decisions this host must
 * answer correctly, and a suite that could only exercise the bundle's own
 * `allow` and `modify` would leave them unpinned. Same precedent, and the same
 * `handshake/hello` branch, as wire-shape.test.ts.
 */
async function answering<T>(decision: Record<string, unknown>, body: (url: string) => Promise<T>): Promise<T> {
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const rpc = (await req.json()) as { id: string | number; method: string };
      if (rpc.method === "handshake/hello") {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            negotiated_version: "0.1.0",
            methods_evaluated: ["steps/toolCallResult"],
            selected_transport: "http",
            timeout_config: { default_ms: 5000 },
            on_decision_failure: "proceed",
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: decision });
    },
  });
  try {
    return await body(`http://localhost:${stub.port}/acs`);
  } finally {
    stub.stop(true);
  }
}

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
});

afterAll(async () => {
  await guardian.close();
});

describe("the result gate, end to end through the real shim and a real Guardian", () => {
  it("redacts a secret out of tool output, preserving every sibling field", async () => {
    const out = await runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), guardian.url);

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });

    // Every sibling survives. This is the assertion that stands between a
    // redaction and Claude Code silently restoring the original: a replacement
    // carrying `stdout` alone is not the tool's output shape, so it would be
    // discarded and the token delivered, with only a warning line to show it.
    //
    // Pinned as the WHOLE stdout object, not just the replacement: a
    // `permissionDecision` leaking in from the request gate's rule, or a stray
    // `decision: block` beside the wrapper, are both changes a
    // replacement-only assertion would not see.
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          stdout: "TOKEN=[REDACTED]",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
    });

    // The redaction is only real if the original does not survive anywhere in
    // what the host is told to deliver -- including in a field nothing above
    // names.
    expect(out.stdout).not.toContain("ghp_ABCDEF123456");
  });

  it("leaves clean output alone, with no updatedToolOutput at all", async () => {
    // An `allow` must not emit an `updatedToolOutput` key: an unnecessary
    // replacement is a chance to get the shape wrong for no benefit, and the
    // hookmap's `allow` entry declares only a conditional `additionalContext`,
    // so a clean result renders an empty wrapper and the output is delivered
    // exactly as the tool produced it.
    const out = await runHook(postToolUsePayload("total 0\n"), guardian.url);

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const wrapper = (JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
    expect("updatedToolOutput" in wrapper).toBe(false);
    expect(JSON.parse(out.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  });

  // The result gate's `deny`, and the reason it needs a test of its own:
  // `decision: block` ALONE injects a reason and suppresses nothing. The tool
  // has already run and its result has already formed, so a deny that carries
  // no replacing output reports a withholding that never happened while the
  // secret is delivered -- the same "reported but never took effect" shape V3
  // found when V1 copied a raw `modifications` object into `updatedInput`.
  //
  // So the withholding is itself a shape-preserving replacement, built the same
  // way the redaction above is: a clone of the object the host handed us, with
  // the one leaf the hookmap named replaced. A withheld output that Claude Code
  // declines is not a withholding at all.
  it("withholds the output on a deny, with every sibling field still in place", async () => {
    const out = await answering({ decision: "deny", reasoning: "secret in output" }, (url) =>
      runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), url),
    );

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(out.stdout)).toEqual({
      decision: "block",
      reason: "secret in output",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          stdout: "[OUTPUT WITHHELD BY POLICY]",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
    });
    expect(out.stdout).not.toContain("ghp_ABCDEF123456");
  });

  // The two halves composed, which is where a result-gate deny stops being
  // hypothetical: a `modify` whose redaction addresses a field the result
  // payload does not have cannot be applied, so N7 substitutes
  // `deny(modifications_invalid)` -- and THAT deny has to withhold the output
  // too, or a rewrite the host refused becomes an unredacted delivery with a
  // block reason attached. Fail-closed all the way to the bytes on stdout.
  it("refuses a redaction it cannot apply, and the refusal still withholds the output", async () => {
    const out = await answering(
      {
        decision: "modify",
        reasoning: "redaction_applied",
        modifications: { redactions: [{ path: "/outputs/9/value", replacement: "TOKEN=[REDACTED]" }] },
      },
      (url) => runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), url),
    );

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(out.stdout) as { decision: string; reason: string; hookSpecificOutput: Record<string, unknown> };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("modifications");
    expect(parsed.hookSpecificOutput.updatedToolOutput).toEqual({
      stdout: "[OUTPUT WITHHELD BY POLICY]",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    expect(out.stdout).not.toContain("ghp_ABCDEF123456");
  });
});
