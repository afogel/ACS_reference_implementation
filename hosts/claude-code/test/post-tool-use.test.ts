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
 *
 * MEASURED, not assumed. The mutation that isolates these tests: make
 * `result-output.ts`'s `patchedClone` build a fresh object (`{}`) instead of
 * spreading the container it was handed -- i.e. construct a new output object
 * rather than patch a clone, which is the one thing that module forbids.
 * `updatedToolOutput` comes back as `{"stdout": "TOKEN=[REDACTED]"}` with all
 * four siblings gone: the exact shape Claude Code discards, so the model would
 * receive the real token.
 *
 * RE-MEASURED as the file grew, because the count is the part of a claim like
 * this that rots. Task 7 recorded "465 pass / 4 fail, three of the four here"
 * against a 470-test suite; every test added since that asserts the whole
 * five-field object is another the mutation fails, so the figure was stale
 * within the same slice. Against 492 tests it is **478 pass / 13 fail, six of
 * them in this file** -- every test here except the `allow` one, which
 * deliberately asserts that no replacement is emitted at all and so has no
 * object to lose siblings from. The other seven are `validate-decision.test.ts`'s
 * projection cases and `govern-step.test.ts`'s preflight case, which assert the
 * same whole object one and two seams earlier.
 *
 * What still does NOT notice, which was Task 7's real point and survives the
 * arithmetic: the per-hook render literals in
 * packages/host-adapter/test/render-decision.test.ts, which assert hand-written
 * `applied_output` fixtures and so cannot tell a projection from a construction.
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
    //
    // NO `additionalContext` HERE, and it is the hookmap that is right rather
    // than this literal. The `modify` entry declares one (`from: reasoning`), and
    // the field is conditional; the pinned bundle's own redaction verdict comes
    // back carrying `reason_codes` and `policy_references` and NO `reasoning`
    // string, so there is nothing for it to carry. The mechanism is pinned in
    // render-decision.test.ts and, end to end, by the test below -- so this
    // literal records what this deployment actually produces today: a redaction
    // the model reads with nothing in the transcript explaining it.
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

  // The reason a redaction gives for itself, end to end through the real shim.
  // V3 closed exactly this asymmetry for `PreToolUse`'s `modify`, on the grounds
  // that a rewrite is the only decision that changes what runs while the
  // transcript says nothing -- and at this gate the stakes are higher, because
  // what the model reads IS the rewritten text. Without a reason it is handed
  // altered output with nothing saying it was altered, and `[REDACTED]` reads as
  // the command's own answer.
  //
  // A stub Guardian, because the pinned bundle's redaction verdict carries no
  // `reasoning` for the conditional field to render (see the first test): the
  // hookmap entry is what is under test here, not what this bundle happens to
  // send.
  it("says why it redacted, in the field this event reads a reason from", async () => {
    const out = await answering(
      {
        decision: "modify",
        reasoning: "token pattern matched in tool output",
        modifications: { redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }] },
      },
      (url) => runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), url),
    );

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
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
        additionalContext: "token pattern matched in tool output",
      },
    });
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

    // THE STATED REASON, not merely that there is one. `reason` is what Claude
    // Code shows in the transcript and what the audit trail records, and this
    // assertion used to be `toContain("modifications")` -- which passed while the
    // sentence read "not present in the arguments this tool call sent". There are
    // no arguments at a gate where the step has already run, and the pointer that
    // failed was never about one: a deny is only as useful as its stated reason,
    // so the reason is pinned rather than the fact of one.
    expect(parsed.reason).toContain('redaction path "/outputs/9/value" addresses "/outputs/9"');
    expect(parsed.reason).toContain("this step's own request or result payload");
    // Nothing in this sentence may name a thing this gate does not have. The
    // negative is the half that would have caught the original wording.
    expect(parsed.reason).not.toContain("arguments this tool call sent");
    // And no raw JS error text: `Error:` in a rendered reason is a stringified
    // exception leaking into the transcript.
    expect(parsed.reason).not.toContain("Error:");
    expect(parsed.hookSpecificOutput.updatedToolOutput).toEqual({
      stdout: "[OUTPUT WITHHELD BY POLICY]",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    expect(out.stdout).not.toContain("ghp_ABCDEF123456");
  });

  // A MODIFICATION THIS HOST HAS NO TARGET FOR, at either gate -- and the
  // sentence is about the host, not about §6.3 and not about this adapter's
  // apply step. `modified_content` is a legal §6.3 shape: one opaque body
  // replacing the whole payload, exclusive of the structured edits. A host whose
  // gate accepted an opaque body could apply it as it arrives.
  //
  // This host accepts a STRUCTURED object at both of its gates -- the arguments
  // a step is to run with where it decides whether the step runs, and the tool's
  // own output object where it sees what the step produced -- and an opaque
  // replacement string is a field of neither. So there is no target for it here,
  // which is the stronger statement §V3's note deserves ("this adapter has no
  // mapping" was the request gate's half of it).
  //
  // AND HANDING THIS GATE ONE ANYWAY IS EXACTLY THE HAZARD IN THIS FILE'S
  // HEADER: a plain string where the tool's output shape is expected is
  // discarded, and the ORIGINAL output is delivered with a warning line. So the
  // only honest answer is a withholding deny -- never a `modify` reported as
  // applied while the token reaches the model.
  //
  // MEASURED, and the measurement found something worth knowing: with
  // `assertValidModifications`' `modified_content` refusal made a silent
  // pass-through, this gate STILL fails closed -- the apply step returns the
  // document untouched, so the projection's landing check (the test below)
  // catches it and withholds. 483 pass / 3 fail, and this test fails on its
  // `reason` assertion rather than on a delivered token. At the request gate
  // there is no such backstop: the same mutation renders an applied rewrite
  // carrying `{command: "cat .env"}`, the original, which is what runs. Both
  // refusals passed through together: 478 pass / 8 fail, and this gate hands the
  // model `stdout: "TOKEN=ghp_ABCDEF123456"` beside
  // `additionalContext: "redaction_applied"` -- the real secret, with an
  // explanation saying it was redacted.
  it("refuses a modified_content result modification as a withholding deny", async () => {
    const out = await answering(
      {
        decision: "modify",
        reasoning: "redaction_applied",
        modifications: { modified_content: "wholesale replacement" },
      },
      (url) => runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), url),
    );

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(out.stdout) as {
      decision: string;
      reason: string;
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(parsed.decision).toBe("block");
    // The stated reason has to be true AT THIS GATE. There are no arguments
    // where the step has already run, so a refusal naming only them would send
    // an incident reviewer to a document this exchange never carried.
    expect(parsed.reason).toContain("modified_content asks for a wholesale content replacement");
    expect(parsed.reason).toContain("the outputs it produced");
    expect(parsed.reason).not.toContain("arguments this tool call sent");
    expect(parsed.reason).not.toContain("Error:");
    expect(parsed.hookSpecificOutput.updatedToolOutput).toEqual({
      stdout: "[OUTPUT WITHHELD BY POLICY]",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    // The assertion the brief asks for by name, and the one that fails the
    // moment the refusal becomes a pass-through: a reported-as-applied
    // `modified_content` renders no replacement at all, so the host delivers the
    // output the tool produced.
    expect(out.stdout).not.toContain("ghp_");
  });

  // THE HAZARD IN ITS PUREST FORM. A redaction path that resolves in the ACS
  // payload and names a field this host has no way to read back: `/exit_status`
  // is really there in the result payload (a hookmap literal put it there), so
  // §6.3's apply step honours it exactly as written and nothing is malformed.
  // But the ACS payload carries ONE leaf of the host's output object, and the
  // rewrite did not touch it -- so the replacement projected from the applied
  // document is the output the host already holds, byte for byte.
  //
  // Reporting `modify` there is the worst outcome this slice can produce: the
  // audit trail records a redaction, the transcript says the output was
  // rewritten, and the model reads the real token. Refused as a withholding
  // deny instead.
  //
  // MEASURED, on the tree before the refusal existed and again by mutating it
  // away (delete the landing check in `result-output.ts`'s `appliedOutput` and
  // return the projection unconditionally): 481 pass / 5 fail, and this gate
  // writes
  //
  //   {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":
  //     {"stdout":"TOKEN=ghp_ABCDEF123456","stderr":"","interrupted":false,
  //      "isImage":false,"noOutputExpected":false},
  //     "additionalContext":"redaction_applied"}}
  //
  // -- a perfectly well-formed replacement in the tool's own output shape, so
  // nothing is discarded and nothing warns: the model reads the real token and
  // is told in the same breath that it was redacted. Four of the five failures
  // are validate-decision.test.ts's, which assert the same thing one seam
  // earlier; nothing else in 487 tests notices.
  it("refuses a redaction whose path has no host-side target", async () => {
    const out = await answering(
      {
        decision: "modify",
        reasoning: "redaction_applied",
        modifications: { redactions: [{ path: "/exit_status" }] },
      },
      (url) => runHook(postToolUsePayload("TOKEN=ghp_ABCDEF123456"), url),
    );

    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(out.stdout) as {
      decision: string;
      reason: string;
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("exactly as the step produced it");
    expect(parsed.reason).not.toContain("Error:");
    expect(parsed.hookSpecificOutput.updatedToolOutput).toEqual({
      stdout: "[OUTPUT WITHHELD BY POLICY]",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
    // The whole point. Before the refusal existed this line was the only one
    // that failed: everything above it was already true of a `modify` whose
    // projected replacement was identical to the original, because a decision
    // that changes nothing renders perfectly well.
    expect(out.stdout).not.toContain("ghp_");
  });
});
