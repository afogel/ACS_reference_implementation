import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGuardian } from "guardian";

const SHIM = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../../policy/manifest.yaml", import.meta.url));
/** The hookmap this deployment actually ships -- the same default the shim
 * resolves when ACS_HOOKMAP_PATH is unset. */
const REAL_HOOKMAP = fileURLToPath(new URL("../claude-code.hookmap.yaml", import.meta.url));

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-posture-"));
  dirs.push(dir);
  return dir;
}

/**
 * Removes exactly the files/directories a run of this suite can produce
 * under a scratch dir -- by name, never recursively. Every test in this
 * file uses the session id "sess-1" (the `payload()` default), so the only
 * paths any test can leave behind are `<dir>/audit.jsonl` and
 * `<dir>/sessions/sess-1.json`; each is removed only if it exists. Anything
 * left over after that is unexpected, and `rmdirSync` below throws loudly on
 * it rather than swallowing the failure the way a blanket try/catch would --
 * a real leak (e.g. a stray temp file from a crashed `set()`) should fail
 * the test, not vanish.
 */
function cleanupScratch(dir: string): void {
  const sessionsDir = join(dir, "sessions");
  for (const file of [join(dir, "audit.jsonl"), join(sessionsDir, "sess-1.json")]) {
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

function payload(command: string, sessionId = "sess-1"): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

async function runShim(
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SHIM], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

type ShimRun = { exitCode: number; stdout: string; stderr: string };

/**
 * Asserts the successful shape in full -- exit 0, a decision on stdout, and
 * NOTHING on stderr -- and returns the parsed hookSpecificOutput.
 *
 * The stderr half is the part that was missing. Every exit-0 test asserted
 * the exit code and the decision and said nothing about stderr, so a shim
 * that started printing a warning (or a stack trace) on every hook would
 * have gone unnoticed by the whole suite. This hook runs as a Claude Code
 * subprocess whose stderr a human sees, and "the decision was right and it
 * also printed something alarming" is not a pass. Exactly one test here
 * legitimately writes to stderr -- the one whose audit sink cannot be
 * written -- and it asserts what it prints rather than using this helper.
 *
 * `toEqual` on both fields at once, so a failure prints the offending
 * stderr text instead of only "expected 0, got 2".
 */
function expectQuietDecision(out: ShimRun): Record<string, unknown> {
  expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(out.stdout).hookSpecificOutput as Record<string, unknown>;
}

describe("acs-hook — the negotiated posture, end to end", () => {
  it("handshakes on the first hook and leaves the negotiated session config on disk for the next process", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const env = {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      };
      const first = await runShim(payload("ls -la"), env);
      expect(expectQuietDecision(first).permissionDecision).toBe("allow");
      expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "sessions", "sess-1.json"), "utf8")).on_decision_failure)
        .toBe("proceed");
    } finally {
      await guardian.close();
    }
  });

  it("still denies a destructive command — the posture never touches an arriving decision", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      const hook = expectQuietDecision(out);
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toContain("matched pattern");
      // Nothing failed to be delivered, so nothing is audited.
      expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
    } finally {
      await guardian.close();
    }
  });

  it("proceeds and audits when the Guardian is gone under the proceed posture (§6.4)", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    const env = {
      ACS_GUARDIAN_URL: guardian.url,
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    };
    try {
      // Hook 1 negotiates while the Guardian is alive...
      await runShim(payload("ls -la"), env);
    } finally {
      // ...then the Guardian dies, and hook 2 is a fresh process with only the file.
      await guardian.close();
    }

    const out = await runShim(payload("rm -rf /"), env);
    const hook = expectQuietDecision(out);
    expect(hook.permissionDecision).toBe("allow");
    // Byte-for-byte what docs/demos/v3-runbook.md captures for this step. The
    // session note added for an unpersistable config must not leak into the
    // healthy path, where hook 2 reads the config hook 1 stored and never
    // re-handshakes at all.
    expect(hook.permissionDecisionReason).toBe(
      "no decision arrived from the guardian for steps/toolCallRequest (transport: Unable to connect. Is the " +
        "computer able to access the url?); the session's negotiated posture applies -- " +
        "on_decision_failure=proceed, so this step was proceeded.",
    );

    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ session_id: "sess-1", posture: "proceed", outcome: "proceeded" });
    // A dead Guardian is §6.4's commonest delivery failure, so the durable
    // record must actually say "transport" here, not "unknown".
    expect(audit[0].failure.kind).toBe("transport");
  });

  it("blocks when the Guardian is gone under the deny posture", async () => {
    const dir = scratch();
    // This Guardian process under test declares `deny` explicitly, via
    // startGuardian's own option -- not via process.env, which would leak
    // across every other test in this file.
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST, onDecisionFailure: "deny" });
    const env = {
      ACS_GUARDIAN_URL: guardian.url,
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    };
    try {
      await runShim(payload("ls -la"), env);
    } finally {
      await guardian.close();
    }

    const out = await runShim(payload("ls -la"), env);
    expect(expectQuietDecision(out).permissionDecision).toBe("deny");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ posture: "deny", outcome: "blocked" });
  });

  it("applies the ACS default when the Guardian was never reachable at all", async () => {
    const dir = scratch();
    const out = await runShim(payload("rm -rf /"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(expectQuietDecision(out).permissionDecision).toBe("allow");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
    expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(false);
  });

  // Exiting non-zero with empty stdout is the shape of a fail-open: Claude
  // Code reads it as "non-blocking error" and proceeds, unaudited and
  // undeclared. It must never happen once a hook payload has parsed.
  it("never exits non-zero with empty stdout once a hook payload has parsed", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.stdout.length).toBeGreaterThan(0);
    expect({ exitCode: out.exitCode, stderr: out.stderr }).toEqual({ exitCode: 0, stderr: "" });
  });

  // Malformed per JSON-RPC (a response carries one of `result`/`error`, never
  // both), and audited whenever it happens, so this was never a silent
  // bypass -- but it was the one path in the tree where a posture could
  // outrank an arriving decision, and a malformed envelope gets no exception
  // from that rule: a decision that arrives is always honoured over the
  // posture.
  it("honours a deny that arrives alongside an error, rather than answering with the posture", async () => {
    const dir = scratch();
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number; method: string };
        if (body.method === "handshake/hello") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              negotiated_version: "0.1.0",
              methods_evaluated: ["steps/toolCallRequest"],
              selected_transport: "http",
              timeout_config: { default_ms: 5000 },
              // The posture that would have answered instead, had the error
              // branch won: a plain allow.
              on_decision_failure: "proceed",
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32020, message: "evaluation failed" },
          result: { decision: "deny", reasoning: "blocked by policy" },
        });
      },
    });
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      const hook = expectQuietDecision(out);
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toBe("blocked by policy");
      // A decision arrived, so nothing was a delivery failure and nothing is
      // audited as one.
      expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
    } finally {
      stub.stop(true);
    }
  });

  it("still exits 0 with a decision when the Guardian returns a decision this hookmap cannot render", async () => {
    const dir = scratch();
    // A stub, not a real Guardian: answers handshake/hello honestly (so
    // this hook negotiates a real "proceed" posture), then answers
    // steps/toolCallRequest with a decision no hookmap entry names.
    // validateDecision passes an unrecognised decision through unchanged,
    // so without the fix this makes renderDecision throw *after* the
    // shim's last try/catch, main().catch exits 1 with empty stdout, and
    // Claude Code proceeds -- ungoverned and unaudited. Same shape as
    // every other fail-open this project has found.
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number; method: string };
        if (body.method === "handshake/hello") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              negotiated_version: "0.1.0",
              methods_evaluated: ["steps/toolCallRequest"],
              selected_transport: "http",
              timeout_config: { default_ms: 5000 },
              on_decision_failure: "proceed",
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { decision: "quarantine" } });
      },
    });
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      expect(out.stdout.length).toBeGreaterThan(0);
      const hook = expectQuietDecision(out);
      // The negotiated posture was "proceed", so the undeliverable decision
      // resolves to a plain allow, and it is audited like any other
      // fail-open proceed (§6.4's MUST).
      expect(hook.permissionDecision).toBe("allow");
      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
      // A decision did arrive here and was honoured in principle -- only this
      // host's rendering of it failed. Auditing that as a delivery failure
      // ("no decision arrived from the guardian", kind "unknown") told an
      // incident reviewer to go and look at a Guardian that answered
      // correctly, which is the same misattribution `host_configuration`
      // fixed one step earlier in the exchange.
      expect(audit[0].failure.kind).toBe("decision_unrenderable");
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason)
        .toMatch(/a decision arrived from the guardian .* and was honoured/i);
    } finally {
      stub.stop(true);
    }
  });

  /** A stub Guardian that negotiates `proceed` and then answers every step
   * with `error` and no result -- nothing that names a decision. The code is
   * the variable, because whether the host reads it as the Guardian refusing
   * this envelope or as an error it does not recognise is the whole
   * distinction under test. */
  function refusingStub(code: number) {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number; method: string };
        if (body.method === "handshake/hello") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              negotiated_version: "0.1.0",
              methods_evaluated: ["steps/toolCallRequest"],
              selected_transport: "http",
              timeout_config: { default_ms: 5000 },
              on_decision_failure: "proceed",
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code, message: "evaluation failed" } });
      },
    });
  }

  // The finding this test exists for, end to end through a real subprocess:
  // the Guardian is UP and refusing, the deployment declared `proceed`, and
  // the step must still be denied. Before the refusal axis, this exact
  // exchange let `rm -rf /` through -- the Guardian's own "no" classified as
  // a delivery failure and answered with the fail-open posture. Run under
  // `proceed` deliberately: under `deny` it would pass unfixed.
  it("denies a step the Guardian refused, even though the negotiated posture is proceed", async () => {
    const dir = scratch();
    const stub = refusingStub(-32020);
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      expect(expectQuietDecision(out).permissionDecision).toBe("deny");

      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      // `posture: "proceed"` beside `outcome: "blocked"` is the pair no
      // posture-driven entry can produce, and `refused` names it outright.
      expect(audit[0]).toMatchObject({
        posture: "proceed",
        posture_source: "negotiated",
        outcome: "blocked",
        failure: { kind: "refused" },
      });
      // The Guardian's own error code and message survive into the record,
      // which is the only thing that makes the entry actionable.
      expect(audit[0].failure.message).toContain("-32020");
      expect(audit[0].failure.message).toContain("evaluation failed");
    } finally {
      stub.stop(true);
    }
  });

  // The other side of the split, end to end for the same reason: an error
  // code the host does not recognise as a refusal is still the wire's
  // business, so the negotiated posture still answers it. This is what stops
  // the fix above from having been "fail closed on every JSON-RPC error" --
  // and a delivery-failure classification is only trustworthy once it has
  // been verified against the runtime rather than reasoned about.
  it("audits an unrecognised error code as error_without_decision, and applies the posture", async () => {
    const dir = scratch();
    const stub = refusingStub(-32601);
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      // The negotiated posture applied -- and it is the fail-open half, so
      // the audit entry below is §6.4's MUST rather than a nicety.
      expect(expectQuietDecision(out).permissionDecision).toBe("allow");

      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        posture: "proceed",
        posture_source: "negotiated",
        outcome: "proceeded",
        failure: { kind: "error_without_decision" },
      });
      expect(audit[0].failure.message).toContain("-32601");
    } finally {
      stub.stop(true);
    }
  });

  // The runbook demonstrates both postures against a killed Guardian, so both
  // captures show failure.kind "transport". The case §6.4 actually defines a
  // decision failure by -- a Guardian that accepts the connection and stays
  // silent past the negotiated timeout, which is why the client grew an
  // AbortSignal.timeout at all -- appears nowhere else end to end, and an
  // unexercised classification path is not something to take on trust.
  it("classifies a Guardian that accepts and never answers as a timeout, not a transport failure", async () => {
    const dir = scratch();
    // Answers the handshake honestly -- declaring a short negotiated timeout,
    // so this test costs milliseconds rather than the ACS default's 5s -- then
    // accepts the step request and never answers it.
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number; method: string };
        if (body.method === "handshake/hello") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              negotiated_version: "0.1.0",
              methods_evaluated: ["steps/toolCallRequest"],
              selected_transport: "http",
              timeout_config: { default_ms: 120 },
              on_decision_failure: "proceed",
            },
          });
        }
        // Tied to the request's own signal, never a bare timer: once the hook
        // times out and `stub.stop(true)` aborts the in-flight request, this
        // clears the timer instead of holding the event loop open past the
        // test.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { decision: "allow" } });
      },
    });
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      expect(expectQuietDecision(out).permissionDecision).toBe("allow");

      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        posture: "proceed",
        posture_source: "negotiated",
        outcome: "proceeded",
        failure: { kind: "timeout" },
      });
      // The negotiated timeout, not the ACS default -- which is also what
      // proves the bound came from the handshake rather than from anywhere
      // else this hook could have got a number.
      expect(audit[0].failure.message).toContain("120ms");
    } finally {
      stub.stop(true);
    }
  });

  // With ACS_AUDIT_LOG pointing at a path under a regular file, both mkdir
  // and append fail. §6.4 makes the entry a MUST for a step that proceeds
  // without a decision, so an unauditable proceed is a silent bypass and
  // blocks instead.
  it("blocks rather than proceeding when the audit entry cannot be written", async () => {
    const dir = scratch();
    // Parent path is a regular file, so both mkdir and append fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(blocker, "audit.jsonl"),
      });
      expect(out.exitCode).toBe(0);
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toMatch(/could not be recorded/i);
      // The one exit-0 case in this file that legitimately writes to stderr,
      // so it says what it writes rather than using `expectQuietDecision`.
      // The sink's default reporter is the only voice here, and a human
      // watching a Claude Code session needs to see it: the entry §6.4
      // requires could not be written, which is why the step blocked.
      expect(out.stderr).toContain("audit sink disabled");
    } finally {
      unlinkSync(blocker);
    }
  });

  // The three members of "this shim cannot read its own input" all exit 2,
  // never 1: exit 1 is "non-blocking error", which Claude Code reads as "the
  // hook did not fire" and proceeds past, ungoverned and unaudited. A
  // governance hook that cannot read its own input has no honest reason to
  // prefer proceed to block, and the sibling case -- a session_id that is
  // present but unsafe -- already blocks, so treating these differently
  // would put two halves of one class on opposite sides of the fail-open
  // line.
  it("exits 2 (blocking) on a payload that is not JSON at all", async () => {
    const out = await runShim("{not json", { ACS_SESSION_DIR: scratch() });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr.length).toBeGreaterThan(0);
  });

  it("exits 2 (blocking) on a payload with no session_id", async () => {
    const out = await runShim(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      { ACS_SESSION_DIR: scratch() },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("session_id");
  });

  it("exits 2 (blocking) on a session_id that is not a string", async () => {
    const out = await runShim(
      JSON.stringify({ session_id: 17, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }),
      { ACS_SESSION_DIR: scratch() },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("session_id");
  });

  it("exits 2 (blocking) on a payload with no hook_event_name", async () => {
    const out = await runShim(JSON.stringify({ session_id: "sess-1", tool_name: "Bash", tool_input: {} }), {
      ACS_SESSION_DIR: scratch(),
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("hook_event_name");
  });

  it("rejects a traversal-shaped session_id without writing outside the session dir, exiting 2 (blocking) not 1", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la", "../escape"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    // Exit 2 ("blocking error"), not 1: a hook payload did parse here, so
    // this must not read to Claude Code as the non-blocking "hook didn't
    // fire" that exit 1 means -- an unsafe session_id is a broken
    // deployment, and stops the tool call loudly instead.
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
    // Asserting only the exit code left the diagnostic untested: exit 2 with
    // an empty or unhelpful stderr blocks the tool call and tells the human
    // nothing about why. The rejected value has to appear, since the point of
    // blocking here is that the deployment's `session_id` is unusable.
    expect(out.stderr).toContain("../escape");
    expect(out.stderr).toMatch(/not a safe path segment/i);
  });

  it("exits 2 (blocking) when the hookmap itself fails to load, with a message on stderr and nothing on stdout", async () => {
    const dir = scratch();
    // The same exit-2 mechanism as the session_id case above, reached from
    // a different throw site: loadHookmap (not createFileSessionConfigStore)
    // fails first here, before this shim can trust its own configuration
    // enough to make a governed decision at all. ACS_HOOKMAP_PATH points at
    // a file that does not exist -- no separate fixture needed.
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      ACS_HOOKMAP_PATH: join(dir, "does-not-exist.yaml"),
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr.length).toBeGreaterThan(0);
    // Nothing was written either -- the hookmap failed before the session
    // store was ever built.
    expect(existsSync(join(dir, "sessions"))).toBe(false);
  });

  // A hookmap whose `permissionDecision` is a well-formed string that Claude
  // Code does not accept. Mutating the real hookmap's `deny` entry to
  // declare `{ value: dney }` renders a real policy deny for `rm -rf /` as
  // {"hookSpecificOutput":{...,"permissionDecision":"dney",
  // "permissionDecisionReason":"matched pattern ... at offset 0"}} with exit
  // 0 -- and Claude Code, which accepts only allow/deny/ask, reads that as no
  // decision at all and proceeds. A policy that fired and denied becomes an
  // allowed tool call behind plausible JSON and a success exit code.
  //
  // loadHookmap cannot catch it: it checks that every entry renders
  // something and stops there, because the adapter must not know any host's
  // decision enum -- or, since the output shape is generic, any host's field
  // names at all. That boundary is enforced by test/invariants.test.ts's
  // vocabulary gate. The check belongs in this shim, which is host-specific
  // by definition.
  it("exits 2 (blocking) on a hookmap permissionDecision Claude Code does not accept, rather than emitting it", async () => {
    const dir = scratch();
    const hookmapPath = join(dir, "typo-hookmap.yaml");
    // The real hookmap's decisions block with one character changed in
    // `deny`'s literal -- the mutation that was actually reproduced.
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool_name\n" +
        "    arguments: $.tool_input\n" +
        "    decisions:\n" +
        "      allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n" +
        "      deny: { output: { hookSpecificOutput.permissionDecision: { value: dney } } }\n",
    );
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
        ACS_HOOKMAP_PATH: hookmapPath,
      });
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe("");
      // The offending entry and its value are both named, so a reader of the
      // stderr line knows which line of YAML to fix.
      expect(out.stderr).toContain("decisions.deny");
      expect(out.stderr).toContain("dney");
      // Nothing was written: the gate runs before the session store is built.
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      unlinkSync(hookmapPath);
    }
  });

  // The result gate's own arm of the same gate, and the fail-open it closes is
  // the one V4's planning reproduced by hand: rendering deny as Claude Code's
  // documented {"decision":"block","reason":…} delivered the real stdout to the
  // model AND the block reason. The tool has already run at this event, so
  // `block` alone REPORTS a withholding that did not happen -- the same
  // "reported but never took effect" shape V3 found when V1 copied a raw
  // modifications object into updatedInput. Only the replacing output withholds.
  //
  // loadHookmap cannot catch this either: the entry below is perfectly
  // renderable, and which host field a renderable entry has to name is not the
  // adapter's business (R3.2).
  it("exits 2 (blocking) on a PostToolUse deny that declares block without a replacing output", async () => {
    const dir = scratch();
    const hookmapPath = join(dir, "reports-a-withholding.yaml");
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool_name\n" +
        "    arguments: $.tool_input\n" +
        "    decisions:\n" +
        "      allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n" +
        "      deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n" +
        "  PostToolUse:\n" +
        "    acs_method: steps/toolCallResult\n" +
        "    tool_name: $.tool_name\n" +
        "    outputs: { from: $.tool_response.stdout, within: $.tool_response }\n" +
        "    exit_status: { literal: success }\n" +
        "    decisions:\n" +
        "      allow: { output: { hookSpecificOutput.additionalContext: { from: reasoning, type: string } } }\n" +
        // Renderable, plausible, and a log line pretending to be a suppression.
        "      deny: { output: { decision: { value: block }, reason: { from: reasoning, type: string } } }\n",
    );
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
        ACS_HOOKMAP_PATH: hookmapPath,
      });
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("hooks.PostToolUse.decisions.deny");
      expect(out.stderr).toContain("updatedToolOutput");
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      unlinkSync(hookmapPath);
    }
  });

  // Global Constraint 4, at the gate: an unexpected hookmap entry throws. A hook
  // this shim has no expectation for is a hook whose declared decisions nothing
  // checks and whose rendered output nothing checks, at an event whose semantics
  // this shim has never been taught -- so it is refused rather than skipped. A
  // skip here would be a tenth fail-open of exactly the established shape: the
  // hook fires, the host reads no honoured decision, and the step runs
  // ungoverned.
  it("exits 2 (blocking) on a hookmap mapping a hook this shim has no expectation for, rather than skipping it", async () => {
    const dir = scratch();
    const hookmapPath = join(dir, "unknown-hook.yaml");
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool_name\n" +
        "    arguments: $.tool_input\n" +
        "    decisions:\n" +
        "      allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n" +
        "      deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n" +
        // Everything loadHookmap asks of a hook, at an event nothing here knows.
        "  SessionStart:\n" +
        "    acs_method: steps/sessionStart\n" +
        "    tool_name: $.tool_name\n" +
        "    arguments: $.tool_input\n" +
        "    decisions:\n" +
        "      allow: { output: { hookSpecificOutput.permissionDecision: { value: allow } } }\n" +
        "      deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n",
    );
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
        ACS_HOOKMAP_PATH: hookmapPath,
      });
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("SessionStart");
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      unlinkSync(hookmapPath);
    }
  });

  // The other half of the gate: it must not fire on the hookmap this
  // deployment actually ships. Asserted twice over -- against the file's own
  // data (so adding a fourth value, e.g. reinstating a `defer` entry that
  // declares `{ value: defer }`, fails here rather than at runtime) and
  // through a real subprocess run that reaches a decision.
  //
  // Reading the literal out of the output path is the same reach the shim's
  // own gate makes, and it now also covers an entry that declares no
  // permission field at all: `value` comes back undefined, which is not one
  // of the three, so the entry fails here exactly as the shim would fail it.
  //
  // V4: per hook, and the two gates are checked against DIFFERENT expectations,
  // because Claude Code accepts different things at them. `PostToolUse` has no
  // permission to grant -- the tool has already run -- so requiring a
  // permissionDecision of it would be requiring a field that event does not
  // have. What its `deny` needs instead is both halves of a withholding.
  it("still loads the real hookmap: every value each hook declares is one Claude Code accepts at that event", async () => {
    const declared = Bun.YAML.parse(readFileSync(REAL_HOOKMAP, "utf8")) as {
      hooks: Record<string, { decisions?: Record<string, { output?: Record<string, { value?: unknown }> }> }>;
    };

    // Pinned to the exact hook list, so a hook added to the shipped hookmap
    // without an expectation in this file (and in the shim's own
    // HOOK_EXPECTATIONS) fails here rather than going unchecked.
    expect(Object.keys(declared.hooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);

    const preToolUse = Object.entries(declared.hooks.PreToolUse?.decisions ?? {}).map(([decision, rule]) => ({
      decision,
      accepted: ["allow", "deny", "ask"].includes(
        rule.output?.["hookSpecificOutput.permissionDecision"]?.value as string,
      ),
    }));
    expect(preToolUse).toEqual(preToolUse.map(({ decision }) => ({ decision, accepted: true })));
    expect(preToolUse.length).toBeGreaterThan(0);

    const postToolUseDeny = declared.hooks.PostToolUse?.decisions?.deny?.output ?? {};
    // `block` alone reports a withholding that did not happen -- the tool has
    // already run. Both halves, or the entry is a log line pretending to be a
    // suppression (Evidence 3).
    expect(postToolUseDeny.decision?.value).toBe("block");
    expect(postToolUseDeny["hookSpecificOutput.updatedToolOutput"]).toBeDefined();

    const dir = scratch();
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(expectQuietDecision(out).permissionDecision).toBe("allow");
  });

  // The handshake reaches the Guardian and returns `on_decision_failure:
  // deny`, but the local write of that ServerHello fails. The negotiated
  // posture must still govern the very step that negotiated it: if the write
  // failure silently discarded the value, `store.get()` would stay
  // undefined, the ACS default (`proceed`) would apply instead, and a
  // deployment that declared `deny` would fail open on every hook, forever,
  // since every hook re-handshakes and every write fails again.
  it("applies a ServerHello it could not persist to the step that negotiated it", async () => {
    const dir = scratch();
    // A regular file where the session directory should be: `mkdirSync`
    // throws ENOTDIR, reliably and cross-platform, so `set()` throws while
    // `get()` (total by design) still returns undefined.
    const sessionsAsFile = join(dir, "sessions");
    writeFileSync(sessionsAsFile, "x");
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { id: string | number; method: string };
        if (body.method === "handshake/hello") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              negotiated_version: "0.1.0",
              methods_evaluated: ["steps/toolCallRequest"],
              selected_transport: "http",
              timeout_config: { default_ms: 5000 },
              // The posture the deployment declared, and the whole point of
              // the test: it must reach this step, not just the next one.
              on_decision_failure: "deny",
            },
          });
        }
        // A delivery failure for the step itself, so the posture is what
        // decides the outcome. The code matters: it must be one the host does
        // NOT read as the Guardian refusing this envelope, or the step would
        // be denied whatever the posture said and this test would pass
        // without the negotiated `deny` ever reaching it -- which is the one
        // thing it exists to prove.
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      },
    });
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: sessionsAsFile,
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      const hook = expectQuietDecision(out);
      // Denied, not proceeded: the negotiated posture applied.
      expect(hook.permissionDecision).toBe("deny");

      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        posture: "deny",
        // Negotiated, not defaulted -- the distinction the durable record
        // exists to carry.
        posture_source: "negotiated",
        outcome: "blocked",
        failure: { kind: "error_without_decision" },
      });
      // And the persistence failure stays visible rather than being papered
      // over by the value having been usable anyway -- under its own kind,
      // not the one a Guardian-down session stamps on every single entry.
      expect(audit[0].session_failure.kind).toBe("session_config_unstored");
      expect(audit[0].session_failure.message).toContain("could not be stored");
    } finally {
      stub.stop(true);
      unlinkSync(sessionsAsFile);
    }
  });

  it("exits 2 (blocking) when the hookmap's decisions block is malformed, not merely absent", async () => {
    const dir = scratch();
    // A hookmap where "allow" is a key in `decisions`, but its value is
    // `null`, not a renderable rule: loadHookmap's presence check alone
    // would let this through. It must fail at load time (exit 2), not at
    // render time deep inside the shim's own fallback, which would be a
    // third route to exit 1 with empty stdout -- the exact fail-open this
    // file exists to prevent.
    const hookmapPath = join(dir, "bad-hookmap.yaml");
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool_name\n" +
        "    arguments: $.tool_input\n" +
        "    decisions:\n" +
        "      allow: null\n" +
        "      deny: { output: { hookSpecificOutput.permissionDecision: { value: deny } } }\n",
    );
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
        ACS_HOOKMAP_PATH: hookmapPath,
      });
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("decisions.allow");
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      unlinkSync(hookmapPath);
    }
  });
});
