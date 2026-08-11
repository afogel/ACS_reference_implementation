/**
 * N7 -- validateDecision: the host's (the Observed Agent's) last word on an
 * arriving decision, and R1.8's three mandatory fail-closed cases.
 *
 * The work itself belongs to collaborators this module is told about (PR #12
 * review, Important). What is left here is knowing which one an arriving
 * decision is for, and being the only place that says what their answers mean
 * as a decision:
 *
 * 1. `modify` -- modifications.ts decides whether §6.3's rewrite can be
 *    honoured as written and applies it, or throws. A throw is a DENY,
 *    never a best-effort partial apply and never a reported-but-unapplied
 *    one.
 * 2. `ask` -- decision-expiry.ts substitutes an expired one with its
 *    `ask_details.timeout_disposition`.
 * 3. `defer` -- decision-expiry.ts substitutes an expired one with its
 *    `defer_details.timeout_decision`.
 *
 * This module used to own all three jobs plus the apply step, in 514 lines
 * under a name that admitted to one of them: "validate" said nothing about
 * *applying* a rewrite to a tool call's arguments, nor about *substituting* a
 * decision for an expired one. Both are things a reader has to know this
 * module does, and neither was discoverable from its name or its size.
 *
 * Neither collaborator names a decision it was not given: `resolveModify`
 * below is the only translation from "this rewrite cannot be honoured" to
 * "deny", and decision-expiry.ts's two resolvers are the only substitutions
 * of an expired outcome. Everything else that arrives leaves untouched.
 *
 * Global Constraint 1 (binding on this whole module): no branch here may
 * alter an arriving `deny` -- switching on `decision` below, `deny` has no
 * `case` of its own, so it falls through to the untouched pass-through
 * along with every decision this module doesn't specifically validate.
 * `allow` is the same pass-through, including a warn-derived allow's
 * non-empty `policy_references` -- the only thing distinguishing it from a
 * plain allow, so nothing here may drop or rebuild it.
 *
 * That constraint is also why this stays a `switch` rather than a table of
 * handlers keyed by decision: the `default` arm *is* the constraint, and a
 * reader checking that nothing can touch an arriving `deny` should be able
 * to see every arm that touches anything without leaving the function.
 *
 * R3.2: this module knows ACS's decision vocabulary, nothing else -- no
 * policy-runtime vocabulary. What each collaborator knows is stated in its
 * own header.
 */

import { deny, type AcsDecision, type ValidatedAcsDecision } from "./decision-message.ts";
import { resolveAsk, resolveDefer } from "./decision-expiry.ts";
import { applyModifications, ModificationsInvalidError } from "./modifications.ts";

export type { ValidatedAcsDecision };

export type ValidateDecisionContext = {
  /** Wall-clock time elapsed since this decision was requested, in
   * milliseconds. Compared by decision-expiry.ts against
   * `ask_details.timeout_seconds` (seconds, converted there) and
   * `defer_details.resolution_timeout_ms` (already milliseconds) -- the two
   * fields use different units, and getting that conversion wrong would make
   * an expiry test pass for the wrong reason. */
  elapsedMs: number;
  /** The tool-call arguments a `modify` decision's `modifications` apply
   * against. Unused by every other decision. */
  originalArguments: Record<string, unknown>;
};

/**
 * Applies a `modify`'s rewrite to the arguments that went out on the wire,
 * or denies. `applyModifications` throws rather than half-applying, and this
 * is the one place that turns such a throw into a decision -- deliberately
 * here rather than in modifications.ts, which owns §6.3 and owns no decision
 * vocabulary at all.
 *
 * A throw that is *not* a `ModificationsInvalidError` is stringified into
 * the same deny rather than escaping: an unexpected failure inside the apply
 * step is still a rewrite that did not happen, and letting it propagate
 * would leave the host with a `modify` it never applied, or with no decision
 * at all. Fail closed either way, with whatever the failure said as the
 * audited reason.
 */
function resolveModify(decision: AcsDecision, originalArguments: Record<string, unknown>): ValidatedAcsDecision {
  try {
    const applied_input = applyModifications(originalArguments, decision.modifications);
    return { ...decision, applied_input };
  } catch (error) {
    const reason = error instanceof ModificationsInvalidError ? error.message : String(error);
    return deny(`guardian's modifications could not be applied: ${reason}`, "modifications_invalid");
  }
}

/**
 * Sequences R1.8's three mandatory fail-closed cases: each recognized
 * decision goes to the collaborator that owns it, and the result is what the
 * host renders.
 *
 * `deny` and every decision besides `modify`/`ask`/`defer` fall through to
 * the pass-through branch untouched (Global Constraint 1, 2).
 */
export function validateDecision(decision: AcsDecision, context: ValidateDecisionContext): ValidatedAcsDecision {
  const { elapsedMs, originalArguments } = context;

  switch (decision.decision) {
    case "modify":
      return resolveModify(decision, originalArguments);

    case "ask":
      return resolveAsk(decision, elapsedMs);

    case "defer":
      return resolveDefer(decision, elapsedMs);

    default:
      return decision;
  }
}
