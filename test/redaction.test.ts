import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
// Relative, not the bare `agt-bridge` specifier: the workspace package is
// linked only into packages/guardian/node_modules (its sole declared
// consumer), so a bare import does not resolve from this directory and would
// fail both `bun test` and `tsc`. Same precedent as
// audit-sink-roundtrip.test.ts reaching packages/inspector/src directly.
import { createBridge } from "../packages/agt-bridge/src/index.ts";

const MANIFEST = fileURLToPath(new URL("../policy/manifest.yaml", import.meta.url));
const budgets = { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } };

describe("the shipped bundle redacts at the result gate", () => {
  it("returns a transform carrying the fully substituted output", async () => {
    const bridge = createBridge(MANIFEST);
    const verdict = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    });
    expect(verdict).toEqual({
      decision: "transform",
      reason: "redaction_applied",
      transform: { path: "$policy_target", value: "TOKEN=[REDACTED]" },
    });
  });

  // Evidence 5. AGT resolves `tool_name_from` before policy runs, so a
  // snapshot with no `tool_call` fails CLOSED rather than evaluating with a
  // missing name. Pinned because the Guardian synthesizes that member from
  // the ACS payload (Task 3) and nothing else would notice if it stopped.
  it("fails closed when the snapshot carries no tool_call", async () => {
    const bridge = createBridge(MANIFEST);
    const verdict = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_result: { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("runtime_error:path_missing");
  });

  it("leaves output with nothing to redact as a clean allow", async () => {
    const bridge = createBridge(MANIFEST);
    const verdict = await bridge.evaluate("post_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "hello world" }] },
    });
    expect(verdict).toEqual({ decision: "allow" });
  });

  // The pre-tool gate must be untouched by adding a point below it in the
  // manifest. This is the assertion that would catch an additive manifest
  // edit turning out not to be additive.
  it("leaves the pre-tool deny exactly as it was", async () => {
    const bridge = createBridge(MANIFEST);
    const verdict = await bridge.evaluate("pre_tool_call", {
      envelope: budgets,
      tool_call: { name: "Bash", args: { command: "rm -rf / " } },
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("destructive_shell_command_blocked");
  });
});
