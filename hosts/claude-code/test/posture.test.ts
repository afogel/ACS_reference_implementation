import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
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

  it("still fails loudly on a payload that is not a hook payload at all", async () => {
    const out = await runShim("{not json", { ACS_SESSION_DIR: scratch() });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
  });

  it("rejects a traversal-shaped session_id without writing outside the session dir", async () => {
    const dir = scratch();
    const out = await runShim(payload("ls -la", "../escape"), {
      ACS_GUARDIAN_URL: "http://127.0.0.1:1/acs",
      ACS_SESSION_DIR: join(dir, "sessions"),
      ACS_AUDIT_LOG: join(dir, "audit.jsonl"),
    });
    expect(out.exitCode).toBe(1);
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
  });
});
