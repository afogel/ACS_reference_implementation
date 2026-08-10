import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGuardian } from "guardian";

const SHIM = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../../policy/manifest.yaml", import.meta.url));

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
    expect(hook.permissionDecisionReason).toMatch(/no decision/i);

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
