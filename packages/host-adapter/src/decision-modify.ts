/**
 * One of three mandatory fail-closed resolvers, beside decision-expiry.ts's
 * two: what an arriving `modify` becomes once this host has had its last
 * word on it.
 *
 * A peer, in its own module: `resolveAsk`, `resolveDefer`, and
 * `resolveModify` all share the same shape --
 * `resolve<Disposition>(decision, ...) -> ValidatedAcsDecision`, never
 * throwing, each in a module beside the knowledge it needs -- and
 * `validateDecision` is the switch that dispatches to them and nothing else.
 *
 * The translation from "this rewrite cannot be honoured" to "deny" stays
 * here rather than moving down into modifications.ts, which owns §6.3 and
 * owns no decision vocabulary at all.
 *
 * This module knows ACS's decision vocabulary and §6.3's apply step. No
 * policy-runtime vocabulary.
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
