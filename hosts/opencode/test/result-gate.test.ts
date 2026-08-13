/**
 * The result gate, end to end (S2, Task 6): `AcsPlugin`'s
 * `"tool.execute.after"` hook, against a LIVE Guardian -- the same precedent
 * request-gate.test.ts sets for this host's other gate, and
 * hosts/claude-code/test/post-tool-use.test.ts sets for host #1's own result
 * gate. `applyOpenCodeOutput` in isolation, the shipped hookmap's static shape,
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Test-only import: stands up a real Guardian, same precedent as
// request-gate.test.ts and hosts/claude-code/test/post-tool-use.test.ts.
import { startGuardian, type StartedGuardian } from "guardian";
import { buildEnvelope, createGuardianClient, loadHookmap, type Hookmap } from "host-adapter";
import { AcsPlugin } from "../acs-plugin.ts";

const HOOKMAP_PATH = fileURLToPath(new URL("../opencode.hookmap.yaml", import.meta.url));

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

// The same shape, with `metadata.exit` absent -- §V5 review, Task 6 fix
// round 1, Important 1's own probe payload, not a hand-waved "missing
// field". Real OpenCode never sends this for a `bash` call (see the "posture
// -proceeds" test below for the two measurements that pin that), but the
// gate's own behaviour for it is still real and still worth pinning.
function liveResultMissingExit(output: string): {
  title: string;
  output: string;
  metadata: { output: string; truncated: boolean };
  attachments: unknown[];
} {
  return {
    title: "cat .env",
    output,
    metadata: { output, truncated: false },
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

/**
 * A scratch audit path unique to one call, so an assertion about whether
 * THAT call wrote an audit entry does not depend on this file's own test
 * order, or on what an earlier test happened to write to the shared
 * `AUDIT_LOG` (§V5 review, Task 6 fix round 1, Minor 4).
 */
function freshAuditLogPath(): string {
  return join(SCRATCH_DIR, `audit-${crypto.randomUUID()}.jsonl`);
}

/**
 * Runs `body` with `ACS_AUDIT_LOG` pointed at `path` for its duration, then
 * restores whatever was there before. `AcsPlugin` reads `ACS_AUDIT_LOG` at
 * its own construction (this file's own header note, and acs-plugin.ts's),
 * so the override has to be in place before `AcsPlugin({})` runs, not merely
 * before the hook fires -- every caller below constructs its own `hooks`
 * from inside `body` for exactly that reason.
 */
async function withAuditLog<T>(path: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.ACS_AUDIT_LOG;
  process.env.ACS_AUDIT_LOG = path;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.ACS_AUDIT_LOG;
    } else {
      process.env.ACS_AUDIT_LOG = previous;
    }
  }
}

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
    // Captured BEFORE the hook runs, so the `toBe` checks below the
    // assertions are IDENTITY checks, not value checks (§V5 review, Task 6
    // fix round 1, Minor 1) -- the request gate's own `originalArgs` pin
    // (request-gate.test.ts) is meaningful because the applier COULD replace
    // that reference; this is its result-gate counterpart, for the two
    // fields the deep in-place merge (mergeInPlace, acs-plugin.ts) exists to
    // spare.
    const originalMetadata = result.metadata;
    const originalAttachments = result.attachments;

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

    // OBJECT IDENTITY survives the merge, not merely equal content:
    // `result.metadata` is the SAME object mergeInPlace recursed into and
    // mutated in place (this applier's own contract with OpenCode -- "mutate
    // what you were handed"), and `result.attachments` is the SAME array
    // `patchedClone` (result-output.ts) never touched, because it sits
    // outside the path to both the leaf and the mirror. A shallow
    // `Object.assign`-based merge would have replaced `result.metadata` with
    // a new object and failed this.
    expect(result.metadata).toBe(originalMetadata);
    expect(result.attachments).toBe(originalAttachments);
  });

  it("passes a clean result through untouched, on the same live object", async () => {
    const auditPath = freshAuditLogPath();
    const result = liveResult("hello world");

    await withAuditLog(auditPath, async () => {
      const hooks = await AcsPlugin({} as never);
      await expect(
        hooks["tool.execute.after"]!(
          { tool: TOOL, sessionID: "ses-result-gate-allow", callID: "c1", args: {} },
          result,
        ),
      ).resolves.toBeUndefined();
    });

    // A clean allow renders no `result` field at all (only the
    // declared-inert `reason.text`), so applyOpenCodeOutput's pass 3 merges
    // nothing -- the tool's own output survives exactly as produced.
    expect(result).toEqual(liveResult("hello world"));
    // No audit entry either: a decision arrived, so no fail-open posture was
    // ever consulted. Its own scratch path, not the shared `AUDIT_LOG` (§V5
    // review, Task 6 fix round 1, Minor 4) -- this assertion no longer
    // depends on this test running before any test that DOES write one.
    expect(existsSync(auditPath)).toBe(false);
  });

  it("withholds a denied result by replacing rather than throwing", async () => {
    // "rm -rf /" -- the same destructive-command pattern policy/manifest.yaml
    // configures for the request gate, matched here against the RESULT
    // payload's own text (post_tool_call's policy_target,
    // "$.tool_result.outputs[0].value") -- confirmed genuinely policy-
    // produced, below, not assumed from the withheld marker alone.
    const auditPath = freshAuditLogPath();
    const sessionID = "ses-result-gate-deny";
    const result = liveResult("rm -rf /");

    // RESOLVES, does not throw -- opencode.hookmap.yaml's own header states
    // the measurement this pins: OpenCode discards the plugin's mutations on
    // a throw out of "tool.execute.after" and rebuilds `metadata` from its
    // own pre-hook copy, so a secret scrubbed by a throw would not stay
    // scrubbed on disk. The result gate's own deny withholds by REPLACING
    // `result` instead.
    await withAuditLog(auditPath, async () => {
      const hooks = await AcsPlugin({} as never);
      await expect(
        hooks["tool.execute.after"]!({ tool: TOOL, sessionID, callID: "c1", args: {} }, result),
      ).resolves.toBeUndefined();
    });

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

    // GENUINELY POLICY-PRODUCED, NOT A POSTURE DENY (§V5 review, Task 6 fix
    // round 1, Minor 2) -- the withheld marker alone cannot tell the two
    // apart, since a fail-closed posture would render byte-identically. Two
    // independent checks close that:
    //
    //   1. No audit entry: a posture is only ever consulted, and only ever
    //      audited, when a decision FAILED to arrive -- a real decision
    //      arriving is not that.
    expect(existsSync(auditPath)).toBe(false);
    //   2. A cross-check against the real Guardian's own decision for the
    //      identical result payload, obtained independently of the hook (the
    //      same composition acs-plugin.ts's own "tool.execute.after"
    //      performs, called directly rather than through the hook) -- the
    //      same precedent request-gate.test.ts sets for its own deny test.
    const hookmap: Hookmap = loadHookmap(HOOKMAP_PATH);
    const crossCheckPayload = {
      tool: TOOL,
      session_id: sessionID,
      callID: "c1",
      args: {},
      result: liveResult("rm -rf /"),
    };
    const envelope = buildEnvelope("tool.execute.after", crossCheckPayload, hookmap);
    const response = await createGuardianClient(guardian.url).post(envelope);
    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("deny");
    // The stock pattern rule's own reason code -- proves this is the
    // destructive-command rule, not a differently-shaped deny that happens
    // to render the same withheld marker.
    expect(response.result?.reason_codes).toEqual(["destructive_shell_command_blocked"]);
  });

  it("skips a tool outside this gate's own tools list: no throw, result untouched, and no Guardian request goes out", async () => {
    // "read" -- one of the real tool names measured alongside "bash" that
    // opencode.hookmap.yaml's result gate does NOT list (its own comment:
    // `metadata` is per-tool -- "read"'s carries {display, loaded, preview,
    // truncated}, no `exit`). This gate is never asked to resolve
    // `$.result.metadata.exit` for it at all, so the shape below does not
    // matter to the assertion, only that nothing here touches it.
    const auditPath = freshAuditLogPath();
    const result = liveResult("some file preview text");

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await withAuditLog(auditPath, async () => {
        const hooks = await AcsPlugin({} as never);
        await expect(
          hooks["tool.execute.after"]!(
            { tool: "read", sessionID: "ses-result-gate-unlisted", callID: "c1", args: {} },
            result,
          ),
        ).resolves.toBeUndefined();
      });

      expect(result).toEqual(liveResult("some file preview text"));
      expect(fetchSpy).not.toHaveBeenCalled();
      // No audit line either (§V5 review, Task 6 fix round 1, Minor 4) --
      // sound by construction (this skip returns before
      // resolveSessionConfig/governStep are ever asked, so there is nothing
      // for a posture to answer or an entry to record), pinned rather than
      // left implicit.
      expect(existsSync(auditPath)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // §V5 review, Task 6 fix round 1, Important 1. See acs-plugin.ts's own
  // "tool.execute.after" doc comment for the two measurements pinning this
  // as unreachable through `bash`, the only tool this gate governs -- real
  // in principle, and correctly left to the posture rather than closed here.
  it("posture-proceeds, audited, when metadata.exit is missing -- real in principle, not reachable through bash", async () => {
    const auditPath = freshAuditLogPath();
    const result = liveResultMissingExit("TOKEN=ghp_SECRET123456");

    await withAuditLog(auditPath, async () => {
      const hooks = await AcsPlugin({} as never);
      await expect(
        hooks["tool.execute.after"]!(
          { tool: TOOL, sessionID: "ses-result-gate-missing-exit", callID: "c1", args: {} },
          result,
        ),
      ).resolves.toBeUndefined();
    });

    // A host_configuration failure at stage "request" -- exitStatusOf's own
    // throw, caught by governStep before the Guardian is ever asked -- is
    // answered by this deployment's negotiated posture, which defaults to
    // "proceed" (handshake.ts's own spec default). A posture "allow" renders
    // no `result` field, so applyOpenCodeOutput merges nothing: the tool's own
    // output -- secret included -- is delivered exactly as produced, in both
    // the leaf and the mirror. Correct per this slice's own rule (the fault
    // is payload-dependent, so `resolveByPosture` is the right seam), and
    // pinned here so the behaviour is a recorded decision, not an accident.
    expect(result.output).toBe("TOKEN=ghp_SECRET123456");
    expect(result.metadata.output).toBe("TOKEN=ghp_SECRET123456");

    // AUDITED -- this is the whole point of a posture-routed proceed: it is
    // visible, not silent (§6.4).
    expect(existsSync(auditPath)).toBe(true);
    const entries = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { outcome: string; failure: { kind: string } });
    expect(
      entries.some((entry) => entry.outcome === "proceeded" && entry.failure.kind === "host_configuration"),
    ).toBe(true);
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
