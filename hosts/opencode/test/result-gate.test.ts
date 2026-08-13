/**
 * The result gate, end to end (S2, Task 6): `AcsPlugin`'s
 * `"tool.execute.after"` hook, against a LIVE Guardian -- the same precedent
 * request-gate.test.ts sets for this host's other gate, and
 * hosts/claude-code/test/post-tool-use.test.ts sets for host #1's own result
 * gate. `applyHostOutput` in isolation, the shipped hookmap's static shape,
 * and `AcsPlugin`'s own load-time gate already have their own suites
 * (apply-host-output.test.ts, hookmap.test.ts, acs-plugin.test.ts); this is
 * the first one that calls THIS hook the way OpenCode itself would.
 *
 * THE MIRROR IS THE POINT. `opencode.hookmap.yaml`'s result gate declares
 * `outputs.mirrors: [$.result.metadata.output]` -- `metadata` carries its own
 * copy of the tool's output, and a redaction that patched only the leaf would
 * leave the plaintext sitting in OpenCode's own session record while the
 * model correctly saw the redaction. The whole reason this slice touched the
 * shared adapter a second time is to prove that mirror lands, end to end,
 * through the unmodified adapter, on a second host.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Test-only import: stands up a real Guardian, same precedent as
// request-gate.test.ts and hosts/claude-code/test/post-tool-use.test.ts.
import { startGuardian, type StartedGuardian } from "guardian";
import { AcsPlugin } from "../acs-plugin.ts";

// "bash" (lowercase) -- OpenCode's own real tool name, measured on 1.18.15
// and what opencode.hookmap.yaml's result gate scopes `tools:` to (its own
// comment: `metadata` is per-tool, and only `bash`'s carries `exit`/`output`).
const TOOL = "bash";

// The live object shape OpenCode hands "tool.execute.after" for a `bash`
// call, measured on 1.18.15 (opencode.hookmap.yaml's own header):
// `{title, output, metadata: {output, exit, truncated}, attachments}`.
// `attachments` is present at runtime and absent from the published 1.18.15
// type (@opencode-ai/plugin's own `tool.execute.after` signature) -- this
// suite still carries it, the same way a real invocation would, to prove it
// survives a redaction untouched.
function liveResult(output: string): {
  title: string;
  output: string;
  metadata: { output: string; exit: number; truncated: boolean };
  attachments: unknown[];
} {
  return {
    title: "cat .env",
    output,
    metadata: { output, exit: 0, truncated: false },
    attachments: [{ type: "file", path: "/tmp/note.txt" }],
  };
}

// V3's own precedent, matching hosts/claude-code/test/post-tool-use.test.ts
// and this host's own request-gate.test.ts: redirected regardless of whether
// today's tests reach the fail-open path, because a handshake failure
// mid-run would otherwise append a real secret to the developer's own
// `.acs/audit.jsonl`.
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "acs-result-gate-test-"));
const AUDIT_LOG = join(SCRATCH_DIR, "audit.jsonl");

let guardian: StartedGuardian;

beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  // Read at AcsPlugin's own construction -- has to be set before AcsPlugin
  // runs, not merely before the hook fires. Same precedent as
  // request-gate.test.ts.
  process.env.ACS_GUARDIAN_URL = guardian.url;
  process.env.ACS_AUDIT_LOG = AUDIT_LOG;
});

afterAll(async () => {
  await guardian.close();
  delete process.env.ACS_GUARDIAN_URL;
  delete process.env.ACS_AUDIT_LOG;
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

describe('AcsPlugin\'s "tool.execute.after" hook -- the result gate, against a live Guardian', () => {
  it("redacts the leaf AND its metadata mirror, leaving every other sibling untouched", async () => {
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("TOKEN=ghp_SECRET123456");

    await expect(
      hooks["tool.execute.after"]!(
        { tool: TOOL, sessionID: "ses-result-gate-redact", callID: "c1", args: {} },
        result,
      ),
    ).resolves.toBeUndefined();

    // The leaf.
    expect(result.output).toBe("TOKEN=[REDACTED]");
    expect(result.output).not.toContain("ghp_SECRET123456");
    // The mirror -- the whole reason this slice touched the shared adapter a
    // second time. A redaction that patched only `result.output` and left
    // this plaintext would be a clean-looking leak: the model sees the
    // redaction, OpenCode's own session record does not.
    expect(result.metadata.output).toBe("TOKEN=[REDACTED]");
    expect(result.metadata.output).not.toContain("ghp_SECRET123456");

    // Every sibling this decision does not name, untouched -- V4's clone
    // discipline, which is right for every field that is not a mirror.
    expect(result.title).toBe("cat .env");
    expect(result.metadata.exit).toBe(0);
    expect(result.metadata.truncated).toBe(false);
    expect(result.attachments).toEqual([{ type: "file", path: "/tmp/note.txt" }]);
  });

  it("passes a clean result through untouched, on the same live object", async () => {
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("hello world");
    const originalResult = result;

    await expect(
      hooks["tool.execute.after"]!(
        { tool: TOOL, sessionID: "ses-result-gate-allow", callID: "c1", args: {} },
        result,
      ),
    ).resolves.toBeUndefined();

    // A clean allow renders no `result` field at all (only the
    // declared-inert `reason.text`), so applyHostOutput's pass 3 merges
    // nothing -- the live object is the SAME reference, untouched.
    expect(result).toBe(originalResult);
    expect(result).toEqual(liveResult("hello world"));
    // No audit entry either: a decision arrived, so no fail-open posture was
    // ever consulted.
    expect(existsSync(AUDIT_LOG)).toBe(false);
  });

  it("withholds a denied result by replacing rather than throwing", async () => {
    // "rm -rf /" -- the same destructive-command pattern policy/manifest.yaml
    // configures for the request gate, matched here against the RESULT
    // payload's own text (post_tool_call's policy_target,
    // "$.tool_result.outputs[0].value") -- a genuine `deny` from the real
    // pinned bundle, not a hand-built stub. Measured directly against this
    // Guardian before writing this test.
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("rm -rf /");

    // RESOLVES, does not throw -- opencode.hookmap.yaml's own header states
    // the measurement this pins: OpenCode discards the plugin's mutations on
    // a throw out of "tool.execute.after" and rebuilds `metadata` from its
    // own pre-hook copy, so a secret scrubbed by a throw would not stay
    // scrubbed on disk. The result gate's own deny withholds by REPLACING
    // `result` instead.
    await expect(
      hooks["tool.execute.after"]!(
        { tool: TOOL, sessionID: "ses-result-gate-deny", callID: "c1", args: {} },
        result,
      ),
    ).resolves.toBeUndefined();

    // The withheld marker, on the leaf AND its mirror -- the same pairing the
    // redaction test above pins, now for a deny.
    expect(result.output).toBe("[OUTPUT WITHHELD BY POLICY]");
    expect(result.metadata.output).toBe("[OUTPUT WITHHELD BY POLICY]");
    expect(result.output).not.toContain("rm -rf /");
    expect(result.metadata.output).not.toContain("rm -rf /");

    // Every sibling this decision does not name, still untouched.
    expect(result.title).toBe("cat .env");
    expect(result.metadata.exit).toBe(0);
    expect(result.metadata.truncated).toBe(false);
    expect(result.attachments).toEqual([{ type: "file", path: "/tmp/note.txt" }]);
  });

  it("skips a tool outside this gate's own tools list: no throw, result untouched, and no Guardian request goes out", async () => {
    // "read" -- one of the real tool names measured alongside "bash" that
    // opencode.hookmap.yaml's result gate does NOT list (its own comment:
    // `metadata` is per-tool -- "read"'s carries {display, loaded, preview,
    // truncated}, no `exit`). This gate is never asked to resolve
    // `$.result.metadata.exit` for it at all, so the shape below does not
    // matter to the assertion, only that nothing here touches it.
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("some file preview text");

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await expect(
        hooks["tool.execute.after"]!(
          { tool: "read", sessionID: "ses-result-gate-unlisted", callID: "c1", args: {} },
          result,
        ),
      ).resolves.toBeUndefined();

      expect(result).toEqual(liveResult("some file preview text"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("throws before asking the Guardian anything when sessionID is missing or empty -- a broken deployment, not a policy question", async () => {
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("hello world");

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await expect(
        hooks["tool.execute.after"]!({ tool: TOOL, sessionID: "", callID: "c1", args: {} }, result),
      ).rejects.toThrow(/sessionID/);
      // Nothing half-applied: a broken deployment refuses before any live
      // object could have been touched.
      expect(result).toEqual(liveResult("hello world"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("throws before asking the Guardian anything when `tool` is missing or not a string -- the same broken-deployment refusal `sessionID` gets, not a silent skip", async () => {
    const hooks = await AcsPlugin({} as never);
    const result = liveResult("hello world");

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await expect(
        hooks["tool.execute.after"]!(
          { tool: undefined as unknown as string, sessionID: "ses-result-gate-bad-tool", callID: "c1", args: {} },
          result,
        ),
      ).rejects.toThrow(/tool/i);
      expect(result).toEqual(liveResult("hello world"));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
