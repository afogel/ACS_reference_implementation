import { AgentControl } from "agent-control-specification";

export type AgtVerdict = {
  decision: "allow" | "deny" | "warn" | "escalate" | "transform";
  reason?: string;
  message?: string;
  transform?: { path: string; value: unknown };
  result_labels?: string[];
};

/**
 * What any snapshot is, structurally: the policy input document, as JSON.
 *
 * A constraint, not a message. Each intervention point has its own snapshot
 * shape (AGT-SNAPSHOT-1.0.md §2.5), which is the assembling caller's knowledge
 * rather than this bridge's, so `PolicyBridge` is parameterised by the
 * snapshot its holder actually sends and this alias is only the bound on that
 * parameter. Used directly as a parameter type it would widen a named snapshot
 * back to "any object" at the one seam it was built to cross.
 */
export type InterventionSnapshot = Record<string, unknown>;

/**
 * The role the Guardian depends on: something you can tell to evaluate a
 * snapshot at an intervention point, which answers with a verdict.
 *
 * AGT stays out of the name deliberately -- the Guardian depends on this role,
 * not on AGT, and an invariant test keeps that honest in the other direction
 * by holding AGT's vocabulary out of the Guardian. `Policy` says which bridge,
 * since "bridge" alone would not survive a second one.
 *
 * `evaluate` answers with the verdict itself, not a result object carrying it:
 * the SDK's `inputIdentity`, `enforcedIdentity` and `transformedPolicyTarget`
 * describe its own evaluation rather than this step's outcome, and are
 * confirmed against the SDK in this package's own test.
 *
 * The snapshot type parameter lets a holder declare which messages it sends
 * (`PolicyBridge<AgtPreToolCallSnapshot>`) and be checked against that shape.
 * `createBridge` answers with the general form, since it can evaluate any point.
 */
export type PolicyBridge<S extends InterventionSnapshot = InterventionSnapshot> = {
  evaluate(point: string, snapshot: S): Promise<AgtVerdict>;
};

/**
 * Construct once at boot, evaluate per decision. Stateless: nothing is
 * retained between evaluate() calls.
 */
export function createBridge(manifestPath: string): PolicyBridge {
  if (manifestPath.includes("/./")) {
    throw new Error(
      `manifest path contains "/./": ${manifestPath}. AGT joins this verbatim and OPA ` +
        `then drops the bundle's data document, silently disabling policy.`,
    );
  }
  const control = AgentControl.fromPath(manifestPath);

  return {
    async evaluate(point: string, snapshot: InterventionSnapshot): Promise<AgtVerdict> {
      const result = await control.evaluateInterventionPoint(point as never, snapshot as never);
      return result.verdict as AgtVerdict;
    },
  };
}
