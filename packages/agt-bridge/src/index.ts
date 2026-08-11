import { AgentControl } from "agent-control-specification";

export type AgtVerdict = {
  decision: "allow" | "deny" | "warn" | "escalate" | "transform";
  reason?: string;
  message?: string;
  transform?: { path: string; value: unknown };
  result_labels?: string[];
};

export type BridgeResult = {
  verdict: AgtVerdict;
  inputIdentity?: string;
  enforcedIdentity?: string;
  transformedPolicyTarget?: unknown;
};

/**
 * The snapshot a caller hands an intervention point: the policy input
 * document, as JSON. Deliberately as open as the wire it models -- each
 * intervention point has its own snapshot shape (AGT-SNAPSHOT-1.0.md), and the
 * shape for a given point is the assembling caller's knowledge, not this
 * bridge's. What the alias buys is that the seam names the message rather than
 * passing an anonymous dict: a caller reading `evaluate(point, snapshot:
 * InterventionSnapshot)` is told what to build.
 */
export type InterventionSnapshot = Record<string, unknown>;

/**
 * The role the Guardian actually depends on: something you can tell to
 * evaluate a snapshot at an intervention point and that answers with a
 * verdict. `createBridge` returned an anonymous object before, so the
 * Guardian's own signatures read `ReturnType<typeof createBridge>` -- a
 * dependency on a factory's implementation rather than on a role (PR #10
 * review).
 *
 * Named `PolicyBridge`, not `InterventionEvaluator`, on the same principle as
 * `loadHookmap` ∥ `loadMapping`: the factory verb and the role noun should
 * rhyme. `createBridge` makes a bridge, every call site already calls its
 * variable `bridge`, and the package is `agt-bridge` -- a third noun for the
 * same collaborator would cost a reader a translation at every seam it appears
 * at. `Policy` says which bridge, since "bridge" alone would not survive a
 * second one.
 *
 * The AGT half of the name stays out of the type, which matters: the Guardian
 * depends on this role, not on AGT, and R3.3's gate is what keeps that honest
 * in the other direction.
 */
export type PolicyBridge = {
  evaluate(point: string, snapshot: InterventionSnapshot): Promise<BridgeResult>;
};

/**
 * N31 — construct once at boot. N30 — evaluate per decision.
 * Stateless: nothing is retained between evaluate() calls (R6.1).
 */
export function createBridge(manifestPath: string): PolicyBridge {
  if (manifestPath.includes("/./")) {
    throw new Error(
      `manifest path contains "/./": ${manifestPath}. AGT joins this verbatim and OPA ` +
        `then drops the bundle's data document, silently disabling policy. See C2.`,
    );
  }
  const control = AgentControl.fromPath(manifestPath);

  return {
    async evaluate(point: string, snapshot: InterventionSnapshot): Promise<BridgeResult> {
      const result = await control.evaluateInterventionPoint(point as never, snapshot as never);
      return {
        verdict: result.verdict as AgtVerdict,
        inputIdentity: result.inputIdentity,
        enforcedIdentity: result.enforcedIdentity,
        transformedPolicyTarget: result.transformedPolicyTarget,
      };
    },
  };
}
