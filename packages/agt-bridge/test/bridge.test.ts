import { describe, expect, it, beforeAll } from "bun:test";
import { AgentControl } from "agent-control-specification";
import { createBridge, type PolicyBridge } from "../src/index.ts";
import { buildConfigBundle, buildManifest } from "../../../test/helpers/config-bundle.ts";

const snapshotFor = (command: string) => ({
  envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
  tool_call: { name: "run_shell", args: { command }, id: "t1" },
});

// The label the Guardian's own session seed would have supplied (Task 4, fix
// round 3), spread into `snapshotFor`'s result only where a test evaluates
// against `policy/manifest.yaml`'s live IFC config and checks more than
// `.decision`. AGT's severity ranking checks IFC first -- ahead of
// confidence, budgets, content_hash, egress, and pattern
// (policy/lib/agt_default.rego's header: "IFC deny > confidence deny >
// budget deny > content_hash deny > egress deny > pattern deny > drift warn
// > allow") -- so an unlabelled snapshot no longer reaches the rule below
// that ranking a test is actually about; it denies with
// `ifc_clearance_violation` instead. Added at the two call sites that
// measurably needed it, not inside `snapshotFor` itself: that helper's own
// key set is asserted verbatim by "a caller that never touches createBridge
// can satisfy the role too" below, and widening it there would have broken
// an unrelated, currently-passing test for no reason connected to IFC.
const publicLabel = { input: { ifc: { source_labels: ["public"] } } };

let bridge: PolicyBridge;
beforeAll(() => { bridge = createBridge("policy/manifest.yaml"); });

describe("agt-bridge", () => {
  it("denies a destructive shell command using the stock bundle", async () => {
    const verdict = await bridge.evaluate("pre_tool_call", { ...snapshotFor("rm -rf /"), ...publicLabel });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("destructive_shell_command_blocked");
    expect(verdict.message).toContain("matched pattern");
  });

  it("denies the -fr spelling too", async () => {
    const verdict = await bridge.evaluate("pre_tool_call", snapshotFor("rm -fr / --no-preserve-root"));
    expect(verdict.decision).toBe("deny");
  });

  it("allows benign commands", async () => {
    for (const cmd of ["ls -la", "git status"]) {
      expect((await bridge.evaluate("pre_tool_call", { ...snapshotFor(cmd), ...publicLabel })).decision).toBe("allow");
    }
  });

  // The failure mode this catches is a SILENT fail-open: a manifest path
  // containing "/./" makes OPA drop the bundle's data document.
  it("surfaces the policy config to Rego (guards the ./ bundle-path landmine)", async () => {
    const verdict = await bridge.evaluate("pre_tool_call", snapshotFor("rm -rf /"));
    expect(verdict.decision).not.toBe("allow");
  });

  // Why the bridge is Node, not Python.
  //
  // Asserted against the SDK DIRECTLY, not through `evaluate`. The claim is
  // about what the Node SDK computes, and `PolicyBridge.evaluate` answers with
  // a verdict rather than a bag carrying it, so routing this through the
  // bridge would mean keeping three fields on every answer that nothing reads,
  // just to assert one of them here. The subject of the claim is the SDK, so
  // the subject of the test is too --
  // which is a stronger test, not a weaker one: it fails if the SDK stops
  // returning distinct identities, where the old one could also fail for a
  // change in this package's own pass-through.
  it("the Node SDK returns input and enforced identity as distinct fields", async () => {
    const control = AgentControl.fromPath("policy/manifest.yaml");
    const result = await control.evaluateInterventionPoint("pre_tool_call" as never, snapshotFor("ls -la") as never);

    expect(result.inputIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.enforcedIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("createBridge's result satisfies the role", async () => {
    // The `let bridge: PolicyBridge` annotation above is already the
    // compile-time half of this claim; this is the runtime half, asserting the
    // role's one method is the one being called throughout.
    const asRole: PolicyBridge = createBridge("policy/manifest.yaml");

    expect(typeof asRole.evaluate).toBe("function");
    expect((await asRole.evaluate("pre_tool_call", snapshotFor("rm -rf /"))).decision).toBe("deny");
  });

  it("a caller that never touches createBridge can satisfy the role too", async () => {
    // The property that matters: the Guardian depends on something it can be
    // told to evaluate, not on this package's factory. A stand-in written by
    // hand type-checks and answers, with no AGT in it -- which is what makes
    // `PolicyBridge` a role rather than a synonym for
    // `ReturnType<typeof createBridge>`.
    const standIn: PolicyBridge = {
      async evaluate(point, snapshot) {
        return { decision: "deny", reason: `${point}:${Object.keys(snapshot).sort().join(",")}` };
      },
    };

    const verdict = await standIn.evaluate("pre_tool_call", snapshotFor("ls -la"));
    expect(verdict.reason).toBe("pre_tool_call:envelope,tool_call");
  });
});

// The bridge's annotator wiring, tested directly against createBridge rather
// than through the Guardian (test/dispositions.test.ts covers the wire-level
// round trip for all five verdicts, including this one) -- these two cases
// belong here because they are about the bridge's own contract for its
// `annotator` option, not about how a verdict maps onto an ACS decision.
describe("agt-bridge — the optional annotator dispatcher", () => {
  it("a successful annotator's return value reaches policy input, producing the verdict the config predicts", async () => {
    const bundle = buildConfigBundle({ drift: { warn_threshold: 0.5 } });
    try {
      const manifestPath = buildManifest({ bundleDir: bundle.dir, annotator: true });
      const bridge = createBridge(manifestPath, { annotator: () => 0.9 });
      const verdict = await bridge.evaluate("pre_tool_call", snapshotFor("ls -la"));
      expect(verdict).toMatchObject({ decision: "warn", reason: "drift_detected" });
    } finally {
      bundle.cleanup();
    }
  });

  // Confirmed empirically against the real SDK (not assumed): a throw
  // inside the caller's annotator function surfaces as AGT's OWN
  // fail-closed handling -- a `deny` verdict reasoned
  // "runtime_error:annotation_failed" -- never as an uncaught exception out
  // of `bridge.evaluate`. That is the whole point of wrapping the caller's
  // function before handing it to the SDK (see index.ts's own comment).
  it("a throwing annotator surfaces as AGT's own annotation_failed deny, not an uncaught exception", async () => {
    const bundle = buildConfigBundle({ drift: { warn_threshold: 0.5 } });
    try {
      const manifestPath = buildManifest({ bundleDir: bundle.dir, annotator: true });
      const bridge = createBridge(manifestPath, {
        annotator: () => {
          throw new Error("boom");
        },
      });
      const verdict = await bridge.evaluate("pre_tool_call", snapshotFor("ls -la"));
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toBe("runtime_error:annotation_failed");
    } finally {
      bundle.cleanup();
    }
  });
});
