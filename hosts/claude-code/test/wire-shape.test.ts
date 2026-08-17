import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * The regression pin for what this deployment actually puts on stdout.
 *
 * Every other test in this directory asserts one field at a time ("the
 * decision is deny", "the reason is a non-empty string"), which is exactly the
 * shape of assertion that survives an output quietly gaining, losing or moving
 * a field. This file asserts the WHOLE JSON object, as a literal, for every
 * decision the shipped hookmap declares -- allow, deny, ask, defer and modify
 * -- so that any change to the rendered wire shape has to be a deliberate edit
 * to the literals below rather than something a refactor can do by accident.
 *
 * It is written against the shim as a subprocess, the way Claude Code invokes
 * it, and against the real hosts/claude-code/claude-code.hookmap.yaml. That is
 * deliberate: it makes this pin independent of how the rendering is factored
 * internally -- which module names the host's fields, which layer assembles
 * the wrapper -- and dependent only on what a host process reads back. It is
 * the contract; the factoring behind it is not.
 *
 * The Guardian here is a stub rather than the real one. The five decisions
 * below are the five the hookmap knows how to render, and the shipped policy
 * bundle only ever produces two of them; a pin that could only cover `allow`
 * and `deny` would leave the three rarest renderings -- the ones nobody looks
 * at, and the ones a careless change breaks first -- unpinned.
 *
 * The shim makes exactly one call, the step call. It does not handshake --
 * that is exercised from packages/host-adapter/test/client.test.ts instead --
 * so the stub answers one method and needs no ServerHello. If the shim is ever
 * made to negotiate first, this stub grows a `handshake/hello` branch, and the
 * assertions below should not move.
 */
const SHIM = fileURLToPath(new URL("../acs-hook.ts", import.meta.url));

/**
 * Runs the real shim as a subprocess against a stub Guardian that answers the
 * step call with `decision`, and returns the parsed JSON it wrote to stdout.
 *
 * Asserts exit 0 and a silent stderr first: a decision that renders correctly
 * while the process also prints a stack trace, or exits non-zero, is not a
 * pass -- and a failure there prints what was actually on stderr rather than
 * an opaque JSON.parse error.
 */
async function renderedBy(decision: Record<string, unknown>, command: string): Promise<unknown> {
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: string | number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: decision });
    },
  });
  try {
    const proc = Bun.spawn(["bun", "run", SHIM], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
      ),
      env: { ...process.env, ACS_GUARDIAN_URL: `http://localhost:${stub.port}/acs` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally {
    stub.stop(true);
  }
}

describe("the wire shape this host writes to stdout, pinned decision by decision", () => {
  it("renders a plain allow as a bare allow with no other field", async () => {
    expect(await renderedBy({ decision: "allow", reason_codes: [], policy_references: [] }, "ls -la")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("renders an allow that carries reasoning as a bare allow too -- this hookmap's allow names no reason field", async () => {
    // The shape an observe-only upstream signal produces: an ACS allow with a
    // synthesized explanation and non-empty policy_references. This hookmap's
    // `allow` entry declares no reason source, so neither the
    // explanation nor the references reach the transcript, and this rendering
    // is indistinguishable from a plain allow. Pinned as it IS, not as it
    // arguably should be: giving `allow` a reason is a behaviour change, and
    // whichever slice decides to make it has to edit this literal to say so.
    expect(
      await renderedBy(
        {
          decision: "allow",
          reasoning: "drift_score 0.9 reached threshold 0.5",
          reason_codes: ["drift_detected"],
          policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }],
        },
        "ls -la",
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("renders a deny with the policy's own reasoning -- the demo's entire payoff", async () => {
    expect(
      await renderedBy({ decision: "deny", reasoning: "blocked by policy", reason_codes: ["destructive"] }, "rm -rf /"),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked by policy",
      },
    });
  });

  it("renders an ask as an ask, carrying its reasoning", async () => {
    expect(
      await renderedBy({ decision: "ask", reasoning: "this needs a human" }, "curl example.com"),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "this needs a human",
      },
    });
  });

  it("renders a defer as a deny -- this host has no deferral state", async () => {
    expect(
      await renderedBy({ decision: "defer", reasoning: "waiting on an out-of-band approval" }, "curl example.com"),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "waiting on an out-of-band approval",
      },
    });
  });

  it("renders a modify as an allow carrying the ACS modifications object verbatim as updatedInput", async () => {
    // Verbatim, and that is a known V1 gap rather than a target: Claude Code's
    // `updatedInput` is a tool-input object, and what lands here is ACS's
    // `modifications` shape. The hookmap's `modify` entry names no reason
    // source either, so a policy-ordered rewrite says nothing in the
    // transcript. Both are pinned as they are; V3 owns the disposition work
    // that would change them, and changing them means editing this literal.
    expect(
      await renderedBy(
        {
          decision: "modify",
          reasoning: "redaction_applied",
          modifications: { parameter_overrides: { command: "echo [REDACTED]" } },
        },
        "echo ghp_SECRET123456",
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { parameter_overrides: { command: "echo [REDACTED]" } },
      },
    });
  });
});
