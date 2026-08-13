/**
 * S2's own load-time contract: `opencode.hookmap.yaml` loads, maps both
 * gates onto the right ACS method, declares the metadata mirror the result
 * gate needs (Task 2's `outputs.mirrors`), and expresses a request-gate deny
 * as a refusal but a result-gate deny as a replacement -- never a throw,
 * because a throw at the result gate discards the plugin's mutations and
 * OpenCode rebuilds `metadata` from its own pre-hook copy (measured).
 *
 * Same shape as hosts/claude-code/test/hook.test.ts's own hookmap coverage;
 * this file is scoped to the hookmap alone, not the (later) plugin shim.
 */
import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildEnvelope, loadHookmap } from "host-adapter";
import { validateEnvelope } from "guardian";

const HOOKMAP = fileURLToPath(new URL("../opencode.hookmap.yaml", import.meta.url));

// `Hookmap.decisions` is deliberately typed `Record<string, unknown>` (R3.2:
// the adapter names no decision vocabulary), so indexing into a specific
// decision's `output` block needs a local, test-only shape -- the same move
// hosts/claude-code/test/posture.test.ts makes when it reads a hookmap's
// decisions directly.
type DecisionsShape = Record<string, { output: Record<string, unknown> }>;

describe("opencode.hookmap.yaml", () => {
  it("loads, and maps both gates", () => {
    const hookmap = loadHookmap(HOOKMAP);
    expect(hookmap.host).toBe("opencode");
    expect(hookmap.hooks["tool.execute.before"]?.acs_method).toBe("steps/toolCallRequest");
    expect(hookmap.hooks["tool.execute.after"]?.acs_method).toBe("steps/toolCallResult");
  });

  it("declares the metadata mirror at the result gate", () => {
    const after = loadHookmap(HOOKMAP).hooks["tool.execute.after"];
    expect(after?.outputs?.mirrors).toEqual(["$.result.metadata.output"]);
  });

  it("expresses a request-gate deny as a refusal and a result-gate deny as a replacement", () => {
    const hooks = loadHookmap(HOOKMAP).hooks;
    const requestDecisions = hooks["tool.execute.before"]!.decisions as DecisionsShape;
    expect(Object.keys(requestDecisions.deny!.output)).toContain("refuse.reason");
    // §V5 review, fix round 1, Critical 1, closed as a pin gap in fix round
    // 2: `refuse.reason` alone is a `from:` field and renders NOTHING when
    // the arriving decision carries no (or the wrong type of) `reasoning` --
    // `refuse.denied: { value: true }` is the unconditional sibling that
    // keeps `deny`/`ask`/`defer` from ever rendering `{}`. Declared on all
    // three; asserted on all three here, not only `deny`.
    for (const decisionName of ["deny", "ask", "defer"] as const) {
      expect(Object.keys(requestDecisions[decisionName]!.output)).toContain("refuse.denied");
    }
    // Measured: a throw at the result gate discards the mutation channel, so the
    // mirror keeps the secret. Deny there withholds by replacing, never by throwing.
    //
    // §V5 review, fix round 1, Critical 1: the sink is `result`, the
    // CONTAINER at `outputs.within` -- not `result.output`, a leaf. `result`
    // is a string on this host; `applied_output` is the whole patched clone
    // of the `outputs.within` object, mirror included, so naming the leaf
    // would assign an object to a string field and bury the mirror's own
    // patched copy one level too deep for OpenCode to ever apply.
    const resultDecisions = hooks["tool.execute.after"]!.decisions as DecisionsShape;
    const resultDeny = Object.keys(resultDecisions.deny!.output);
    expect(resultDeny).toContain("result");
    expect(resultDeny).not.toContain("result.output");
    expect(resultDeny).not.toContain("refuse.reason");
  });

  it("scopes the result gate to bash, and leaves the request gate scoped to every tool", () => {
    // §V5 review, fix round 1, Important 1: OpenCode fires this hook for
    // every tool with no matcher, and `metadata` is per-tool -- only `bash`
    // carries `metadata.exit`/`metadata.output`, which this gate's `outputs`
    // and `exit_status` paths are shaped for. Host #1 gets the equivalent
    // scoping for free from settings.json's anchored `^Bash$` matcher; host
    // #2 has none, so it is declared here instead.
    const hooks = loadHookmap(HOOKMAP).hooks;
    expect(hooks["tool.execute.after"]?.tools).toEqual(["bash"]);
    // The request gate's own paths ($.tool, $.args) resolve for every tool,
    // so it must not be scoped at all -- undeclared `tools` means "every
    // tool", the same as host #1's hookmap, which declares none.
    expect(hooks["tool.execute.before"]?.tools).toBeUndefined();
  });

  it("builds a wire payload of exactly {tool, exit_status, outputs:[{value}]}, with no mirrors anywhere in it", () => {
    // Task 2's deferred finding, closed here: this is the FIRST hookmap that
    // actually declares `outputs.mirrors`, so this is the first place a
    // mirror leaking onto the wire could be caught. `buildPayload` never
    // reads `mirrors` -- this asserts the envelope it produces proves that,
    // not just that the function doesn't.
    const hookmap = loadHookmap(HOOKMAP);
    const payload = {
      tool: "bash",
      // buildEnvelope reads `session_id` directly (not hookmap-driven, the
      // same ACS-side convention every host's assembled payload supplies) --
      // `sessionID` is OpenCode's own field name, carried alongside it the way
      // Task 4's shim will actually assemble this object.
      sessionID: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
      session_id: "6c616a11-495a-4f05-878a-c1bfaa29f0e5",
      callID: "call-1",
      args: { command: "cat .env" },
      result: {
        title: "bash",
        output: "TOKEN=ghp_ABCDEF123456",
        metadata: { output: "TOKEN=ghp_ABCDEF123456", exit: 0, truncated: false },
        attachments: [],
      },
    };

    const envelope = buildEnvelope("tool.execute.after", payload, hookmap);

    expect(() => validateEnvelope(envelope)).not.toThrow();
    expect(envelope.params.payload).toEqual({
      tool: { name: "bash" },
      exit_status: "success",
      outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }],
    });
    expect(JSON.stringify(envelope.params.payload)).not.toContain("mirrors");
  });
});
