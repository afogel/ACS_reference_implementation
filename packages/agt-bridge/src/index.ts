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
 * N31 — construct once at boot. N30 — evaluate per decision.
 * Stateless: nothing is retained between evaluate() calls (R6.1).
 */
export function createBridge(manifestPath: string) {
  if (manifestPath.includes("/./")) {
    throw new Error(
      `manifest path contains "/./": ${manifestPath}. AGT joins this verbatim and OPA ` +
        `then drops the bundle's data document, silently disabling policy. See C2.`,
    );
  }
  const control = AgentControl.fromPath(manifestPath);

  return {
    async evaluate(point: string, snapshot: Record<string, unknown>): Promise<BridgeResult> {
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
