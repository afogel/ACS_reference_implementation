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

describe("acs-hook — the negotiated posture, end to end", () => {
  it("handshakes on the first hook and leaves S13 on disk for the next process", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const env = {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      };
      const first = await runShim(payload("ls -la"), env);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "sessions", "sess-1.json"), "utf8")).on_decision_failure)
        .toBe("proceed");
    } finally {
      await guardian.close();
    }
  });

  it("still denies a destructive command — the posture never touches an arriving decision (R1.5)", async () => {
    const dir = scratch();
    const guardian = await startGuardian({ port: 0, manifestPath: MANIFEST });
    try {
      const out = await runShim(payload("rm -rf /"), {
        ACS_GUARDIAN_URL: guardian.url,
        ACS_SESSION_DIR: join(dir, "sessions"),
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toContain("matched pattern");
      // Nothing failed to be delivered, so nothing is audited.
      expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
    } finally {
      await guardian.close();
    }
  });

  it("proceeds and audits when the Guardian is gone under the proceed posture (R1.7, §6.4)", async () => {
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
    expect(out.exitCode).toBe(0);
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
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
    // The assertion fix round 2 adds: a dead Guardian is §6.4's commonest
    // delivery failure, and classifyDeliveryFailure's own fix (Task 4's
    // TypeError assumption did not hold on this runtime) is only real if
    // the durable record actually says "transport" here, not "unknown".
    expect(audit[0].failure.kind).toBe("transport");
  });

  it("blocks when the Guardian is gone under the deny posture", async () => {
    const dir = scratch();
    // This Guardian process under test declares `deny` explicitly, via
    // startGuardian's own option -- not via process.env, which would leak
    // across every other test in this file (plan Risk 7).
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
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
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
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
    expect(existsSync(join(dir, "sessions", "sess-1.json"))).toBe(false);
  });

  // The V1 placeholder exited 1 with empty stdout, which Claude Code reads as
  // "non-blocking error" and proceeds -- an unaudited, undeclared fail-open.
  // That is the shape of every fail-open this project has found. It must be gone.
  it("never exits non-zero with empty stdout once a hook payload has parsed", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.stdout.length).toBeGreaterThan(0);
    expect(out.exitCode).toBe(0);
  });

  // Whole-branch review, M1. Malformed per JSON-RPC (a response carries one of
  // `result`/`error`, never both) and audited whenever it happens, so it was
  // never a silent bypass -- but it was the only expression in the tree where
  // a posture could outrank an arriving decision, and Global Constraint 1 does
  // not have an exception for a malformed envelope.
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
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hook.permissionDecision).toBe("deny");
      expect(hook.permissionDecisionReason).toBe("blocked by policy");
      // A decision arrived, so nothing was a delivery failure and nothing is
      // audited as one.
      expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
    } finally {
      stub.stop(true);
    }
  });

  it("still exits 0 with a decision when the Guardian returns a decision this hookmap cannot render (CRITICAL fix)", async () => {
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
      expect(out.exitCode).toBe(0);
      expect(out.stdout.length).toBeGreaterThan(0);
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
      // The negotiated posture was "proceed", so the undeliverable decision
      // resolves to a plain allow, and it is audited like any other
      // fail-open proceed (§6.4's MUST).
      expect(hook.permissionDecision).toBe("allow");
      const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ posture: "proceed", outcome: "proceeded" });
    } finally {
      stub.stop(true);
    }
  });

  // Whole-branch review, I8: the runbook demonstrates both postures against a
  // *killed* Guardian, so both captures show failure.kind "transport". The
  // case §6.4 actually defines a decision failure by -- a Guardian that
  // accepts the connection and stays silent past the negotiated timeout, which
  // is why the client grew an AbortSignal.timeout at all -- appeared nowhere
  // end to end. This slice has already shipped one classification verified
  // against an assumption instead of the runtime, and it was wrong, so an
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
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");

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

  // Reproduced from the whole-branch review (I3): with ACS_AUDIT_LOG pointing
  // at a path under a regular file, the step used to proceed, exit 0, and
  // write nothing -- the only trace being a stderr line from a subprocess that
  // succeeded. §6.4 makes the entry a MUST for a step that proceeds without a
  // decision, so an unauditable proceed is a silent bypass and blocks instead.
  it("blocks rather than proceeding when the audit entry cannot be written (constraint 3)", async () => {
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
    } finally {
      unlinkSync(blocker);
    }
  });

  // The three members of "this shim cannot read its own input", all of which
  // used to exit 1 -- "non-blocking error", which Claude Code reads as "the
  // hook did not fire" and proceeds past, ungoverned and unaudited. A
  // governance hook that cannot read its own input has no honest reason to
  // prefer proceed to block, and the sibling case (a session_id that IS
  // present but unsafe) already blocked, so the two halves of one class sat
  // on opposite sides of the fail-open line.
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
    // Exit 2 ("blocking error"), not 1: a hook payload DID parse here, so
    // this must not read to Claude Code as the non-blocking "hook didn't
    // fire" that exit 1 means -- an unsafe session_id is a broken
    // deployment, and stops the tool call loudly instead.
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
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
  // Code does not accept. Reproduced against a live Guardian before this
  // gate existed: mutating the real hookmap's `deny` entry to
  // `permissionDecision: dney` made a real policy deny for `rm -rf /` render
  // as {"hookSpecificOutput":{...,"permissionDecision":"dney",
  // "permissionDecisionReason":"matched pattern ... at offset 0"}} with exit
  // 0 -- and Claude Code, which accepts only allow/deny/ask, read that as no
  // decision at all and PROCEEDED. A policy that fired and denied became an
  // allowed tool call behind plausible JSON and a success exit code.
  //
  // loadHookmap cannot catch it: it checks that permissionDecision is a
  // non-empty string and stops there, because the adapter must not know any
  // host's decision enum (R3.2, enforced by test/invariants.test.ts). The
  // check belongs in this shim, which is host-specific by definition.
  it("exits 2 (blocking) on a hookmap permissionDecision Claude Code does not accept, rather than emitting it", async () => {
    const dir = scratch();
    const hookmapPath = join(dir, "typo-hookmap.yaml");
    // Byte-for-byte the real hookmap's decisions block with one character
    // changed in `deny` -- the mutation that was actually reproduced.
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\n" +
        "decisions:\n" +
        "  allow: { permissionDecision: allow, reason_from: reasoning }\n" +
        "  deny: { permissionDecision: dney, reason_from: reasoning }\n",
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
      // The offending entry AND its value are named, so a reader of the
      // stderr line knows which line of YAML to fix.
      expect(out.stderr).toContain("decisions.deny");
      expect(out.stderr).toContain("dney");
      // Nothing was written: the gate runs before the session store is built.
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    } finally {
      unlinkSync(hookmapPath);
    }
  });

  // The other half of the gate: it must not fire on the hookmap this
  // deployment actually ships. Asserted twice over -- against the file's own
  // data (so adding a fourth value, e.g. reinstating `defer:
  // { permissionDecision: defer }`, fails here rather than at runtime) and
  // through a real subprocess run that reaches a decision.
  it("still loads the real hookmap: every value it declares is one Claude Code accepts", async () => {
    const declared = Bun.YAML.parse(readFileSync(REAL_HOOKMAP, "utf8")) as {
      decisions: Record<string, { permissionDecision: string }>;
    };
    const values = Object.entries(declared.decisions).map(([decision, rule]) => ({
      decision,
      accepted: ["allow", "deny", "ask"].includes(rule.permissionDecision),
    }));
    expect(values).toEqual(values.map(({ decision }) => ({ decision, accepted: true })));

    const dir = scratch();
    const out = await runShim(payload("ls -la"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  // Risk row 14, closed here. The handshake reached the Guardian and came
  // back with `on_decision_failure: deny`; only the local WRITE of that
  // ServerHello failed. Before this fix the shim discarded the returned
  // value, `store.get()` stayed undefined, and the ACS default (`proceed`)
  // applied -- so a deployment that declared `deny` failed OPEN on the very
  // step whose posture it had just negotiated, and did so on every hook,
  // forever, because every hook re-handshakes and every write fails again.
  it("applies a ServerHello it could not persist to the step that negotiated it (risk row 14)", async () => {
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
        // decides the outcome (constraint 1 keeps the two domains apart).
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32020, message: "evaluation failed" },
        });
      },
    });
    try {
      const out = await runShim(payload("ls -la"), {
        ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs`,
        ACS_SESSION_DIR: sessionsAsFile,
        ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
      });
      expect(out.exitCode).toBe(0);
      const hook = JSON.parse(out.stdout).hookSpecificOutput;
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
      // over by the value having been usable anyway.
      expect(audit[0].session_failure.message).toContain("could not be stored");
    } finally {
      stub.stop(true);
      unlinkSync(sessionsAsFile);
    }
  });

  it("exits 2 (blocking) when the hookmap's decisions block is malformed, not merely absent (fix round 3)", async () => {
    const dir = scratch();
    // A hookmap that loadHookmap's presence check alone would have let
    // through (before fix round 3): "allow" is a key in `decisions`, but
    // its value is `null`, not a renderable rule. This must fail at load
    // time (exit 2), not at render time deep inside the shim's own
    // fallback (which would have been a THIRD route to exit 1 with empty
    // stdout -- the exact fail-open this task exists to remove).
    const hookmapPath = join(dir, "bad-hookmap.yaml");
    writeFileSync(
      hookmapPath,
      "host: claude-code\n" +
        "hooks:\n" +
        "  PreToolUse: { acs_method: steps/toolCallRequest, tool_name: $.tool_name, arguments: $.tool_input }\n" +
        "decisions:\n" +
        "  allow: null\n" +
        "  deny: { permissionDecision: deny, reason_from: reasoning }\n",
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
