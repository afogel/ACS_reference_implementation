import { AgentControl, type JsonValue } from "agent-control-specification";

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
 * A host-supplied annotator, called by name for every `annotators.<name>`
 * entry a manifest's intervention point declares via `annotations`. Its
 * return value lands at `input.annotations.<name>` for policy to read --
 * this is the only way `annotations` reaches policy input at all (five
 * other placements were tried against the snapshot and all were dropped;
 * see the drift manifest's own header). Deliberately a plain function, not
 * the SDK's own `AnnotatorDispatcher` interface: that shape is an
 * AGT-specific type this package's own callers should not have to import,
 * per R3.3 (this bridge carries no host-specific code, and by the same
 * token should not force a host-shaped caller to reach into AGT's types
 * either).
 */
export type Annotator = (name: string, config: unknown, preliminary: unknown) => unknown;

export type CreateBridgeOptions = {
  annotator?: Annotator;
};

/**
 * N31 — construct once at boot. N30 — evaluate per decision.
 * Stateless: nothing is retained between evaluate() calls (R6.1).
 */
export function createBridge(manifestPath: string, options?: CreateBridgeOptions): PolicyBridge {
  if (manifestPath.includes("/./")) {
    throw new Error(
      `manifest path contains "/./": ${manifestPath}. AGT joins this verbatim and OPA ` +
        `then drops the bundle's data document, silently disabling policy.`,
    );
  }

  // Adapts the caller's plain function into the SDK's AnnotatorDispatcher
  // shape ({ dispatch(...) }), wrapped in `async` so a throw inside the
  // caller's function -- synchronous or not -- always arrives at the SDK
  // as a rejected promise rather than a synchronous exception escaping this
  // call directly. The SDK's own dispatcher contract already turns a throw
  // or a rejected promise into its own `runtime_error:annotation_failed`
  // fail-closed verdict; this wrapping is what makes sure every failure
  // shape actually reaches that handling, rather than some throwing one way
  // this project happens to exercise today and some other way it doesn't.
  const annotatorDispatcher = options?.annotator
    ? {
        // The cast at the return is the one place this function's result
        // meets the SDK's own `JsonValue`-shaped contract -- `Annotator`
        // itself stays `unknown` so nothing about AGT's types leaks into
        // this option's public shape. A caller returning something that
        // genuinely isn't JSON-shaped (a function, a class instance) is a
        // caller bug this cast does not catch; it exists to satisfy the
        // SDK's declared parameter type, not to validate the return value.
        async dispatch(name: string, config: unknown, preliminary: unknown): Promise<JsonValue> {
          return (await options.annotator!(name, config, preliminary)) as JsonValue;
        },
      }
    : undefined;

  const control = AgentControl.fromPath(manifestPath, annotatorDispatcher);

  return {
    async evaluate(point: string, snapshot: InterventionSnapshot): Promise<AgtVerdict> {
      const result = await control.evaluateInterventionPoint(point as never, snapshot as never);
      return result.verdict as AgtVerdict;
    },
  };
}
