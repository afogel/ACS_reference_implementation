import { describe, expect, it, beforeAll } from "bun:test";
import { createBridge } from "../src/index.ts";

const snapshotFor = (command: string) => ({
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "run_shell", args: { command }, id: "t1" },
});

let bridge: ReturnType<typeof createBridge>;
beforeAll(() => { bridge = createBridge("policy/manifest.yaml"); });

describe("agt-bridge", () => {
  it("denies a destructive shell command using the stock bundle", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -rf /"));
    expect(r.verdict.decision).toBe("deny");
    expect(r.verdict.reason).toBe("destructive_shell_command_blocked");
    expect(r.verdict.message).toContain("matched pattern");
  });

  it("denies the -fr spelling too", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -fr / --no-preserve-root"));
    expect(r.verdict.decision).toBe("deny");
  });

  it("allows benign commands", async () => {
    for (const cmd of ["ls -la", "git status"]) {
      expect((await bridge.evaluate("pre_tool_call", snapshotFor(cmd))).verdict.decision).toBe("allow");
    }
  });

  // Guards Correction C2 — the failure mode this catches is a SILENT fail-open.
  it("surfaces the policy config to Rego (guards the ./ bundle-path landmine)", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("rm -rf /"));
    expect(r.verdict.decision).not.toBe("allow");
  });

  // Guards Correction C1 — this is why the bridge is Node, not Python.
  it("returns input and enforced identity as distinct fields", async () => {
    const r = await bridge.evaluate("pre_tool_call", snapshotFor("ls -la"));
    expect(r.inputIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.enforcedIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
