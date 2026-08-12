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
 * A CONSTRAINT, NOT A MESSAGE, and the distinction is this alias's whole job
 * (PR #10 review, second pass). It used to be `evaluate`'s parameter type, so
 * an assembler's named snapshot -- `AgtPreToolCallSnapshot` -- widened back
 * into an anonymous dict at the one seam it was built to cross, and the seam
 * would then accept literally any object. Each intervention point has its own
 * snapshot shape (AGT-SNAPSHOT-1.0.md §2.5) and that shape is the assembling
 * caller's knowledge rather than this bridge's, so this package cannot name
 * the messages -- but it can refuse to erase them: `PolicyBridge` below is
 * parameterised by the snapshot its holder actually sends, and this alias is
 * the bound that parameter satisfies.
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
 *
 * ANSWERS WITH A VERDICT, not with a bag carrying one (PR #10 review, second
 * pass). `evaluate` used to return a `BridgeResult` -- the verdict plus
 * `inputIdentity`, `enforcedIdentity` and `transformedPolicyTarget` -- and its
 * only production caller destructured `{ verdict }` off it and dropped the
 * rest. Three fields nothing read, on every answer, so the collaboration read
 * as "here is a result, go and ask it what you wanted" rather than "here is the
 * verdict you asked for". Those three are facts about the SDK's own evaluation
 * rather than about this step's outcome, and the correction that made them
 * worth confirming (C1) is confirmed where it belongs, against the SDK
 * directly, in this package's own test.
 *
 * PARAMETERISED BY THE SNAPSHOT, so a holder's named message survives the seam.
 * `createBridge` answers with the general `PolicyBridge`, since it can evaluate
 * any point; a holder that assembles particular snapshots declares which ones
 * it sends (`PolicyBridge<AgtPreToolCallSnapshot>`), and its own call sites are
 * then checked against that message instead of against "any object at all".
 */
export type PolicyBridge<S extends InterventionSnapshot = InterventionSnapshot> = {
  evaluate(point: string, snapshot: S): Promise<AgtVerdict>;
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
    async evaluate(point: string, snapshot: InterventionSnapshot): Promise<AgtVerdict> {
      const result = await control.evaluateInterventionPoint(point as never, snapshot as never);
      return result.verdict as AgtVerdict;
    },
  };
}
