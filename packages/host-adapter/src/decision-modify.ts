/**
 * The third of R1.8's mandatory fail-closed resolvers, beside
 * decision-expiry.ts's two: what an arriving `modify` becomes once this host
 * has had its last word on it.
 *
 * A PEER, IN ITS OWN MODULE (PR #12 review, second pass). R1.8 names three
 * cases and this project handles all three, but they did not read as three of
 * anything: `resolveAsk` and `resolveDefer` were exported resolvers in a module
 * of their own, while `resolveModify` was a private function inside the
 * orchestrator that sequences them, and `applyModifications` -- the §6.3
 * collaborator underneath it -- throws. Three seams for one job family, so a
 * reader checking that all three fail closed had to establish it three
 * different ways.
 *
 * Now all three have the same shape: `resolve<Disposition>(decision, ...) ->
 * ValidatedAcsDecision`, never throwing, each in a module beside the knowledge
 * it needs, and `validateDecision` is the switch that dispatches to them and
 * nothing else.
 *
 * The translation from "this rewrite cannot be honoured" to "deny" stays HERE
 * rather than moving down into modifications.ts, which owns §6.3 and owns no
 * decision vocabulary at all. That separation is unchanged; what moved is only
 * which side of the orchestrator this function sits on.
 *
 * R3.2: this module knows ACS's decision vocabulary and §6.3's apply step.
 * No policy-runtime vocabulary.
 */

import { deny, type AcsDecision, type ValidatedAcsDecision } from "./decision-message.ts";
import { applyModifications, ModificationsInvalidError } from "./modifications.ts";

/**
 * Applies a `modify`'s rewrite to the arguments that went out on the wire, or
 * denies. `applyModifications` throws rather than half-applying, and this is the
 * one place that turns such a throw into a decision.
 *
 * A throw that is *not* a `ModificationsInvalidError` is stringified into the
 * same deny rather than escaping: an unexpected failure inside the apply step is
 * still a rewrite that did not happen, and letting it propagate would leave the
 * host with a `modify` it never applied, or with no decision at all. Fail closed
 * either way, with whatever the failure said as the audited reason.
 */
export function resolveModify(
  decision: AcsDecision,
  originalArguments: Record<string, unknown>,
): ValidatedAcsDecision {
  try {
    const applied_input = applyModifications(originalArguments, decision.modifications);
    return { ...decision, applied_input };
  } catch (error) {
    const reason = error instanceof ModificationsInvalidError ? error.message : String(error);
    return deny(`guardian's modifications could not be applied: ${reason}`, "modifications_invalid");
  }
}
