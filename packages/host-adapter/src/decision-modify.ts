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
import { appliedOutput, type HostOutputTarget } from "./result-output.ts";

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
 *
 * THE PROJECTION IS INSIDE THIS TRY, and deliberately so. At a result gate the
 * applied document still has to be projected onto the output object the host
 * holds (`appliedOutput`), and that projection can fail for reasons of exactly
 * the same kind as the apply itself -- a leaf the payload does not have, a
 * replacement of a type the host's output shape does not admit. Both are a
 * rewrite that did not land, so both belong to the same sentence: `deny`,
 * `modifications_invalid`. Projecting AFTER this function returns would put
 * those failures outside the only catch that can answer them with a decision,
 * where a caller's delivery-failure posture would answer them instead -- and a
 * `proceed` posture there is an unredacted output delivered because a redaction
 * could not be expressed. Fail-closed by construction, not by posture.
 *
 * That it happens HERE and not in `validateDecision` is what keeps the
 * orchestrator a switch (PR #13 review, Important). V4 gave this resolver a
 * second job, and doing it one level up would have grown a third silent job
 * under a name that already understates the two it has -- "validate" says
 * nothing about applying a rewrite, and less than nothing about projecting one
 * onto a host's own output shape.
 */
export function resolveModify(
  decision: AcsDecision,
  modificationDocument: Record<string, unknown>,
  outputTarget: HostOutputTarget | undefined,
): ValidatedAcsDecision {
  try {
    const applied = applyModifications(modificationDocument, decision.modifications);
    if (outputTarget === undefined) {
      return { ...decision, applied_input: applied };
    }
    return { ...decision, applied_output: appliedOutput(applied, outputTarget) };
  } catch (error) {
    const reason = error instanceof ModificationsInvalidError ? error.message : String(error);
    return deny(`guardian's modifications could not be applied: ${reason}`, "modifications_invalid");
  }
}
