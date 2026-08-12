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
import { applyModifications } from "./modifications.ts";
import { projectAppliedOutput, type HostOutputLocation } from "./result-output.ts";

/**
 * Applies a `modify`'s rewrite to the ACS-side document the decision's pointers
 * address, or denies.
 *
 * Its own module, beside decision-expiry.ts's two resolvers, because R1.8's
 * three cases are peers (PR #12 review, second pass) -- see this module's
 * header. What follows is what the resolver itself has to get right.
 *
 * `applyModifications` throws rather than half-applying, and this
 * is the one place that turns such a throw into a decision -- deliberately
 * here rather than in modifications.ts, which owns §6.3 and owns no decision
 * vocabulary at all.
 *
 * A throw that is *not* a `ModificationsInvalidError` becomes the same deny
 * rather than escaping: an unexpected failure inside the apply step is still a
 * rewrite that did not happen, and letting it propagate would leave the host
 * with a `modify` it never applied, or with no decision at all. Fail closed
 * either way, with whatever the failure said as the audited reason.
 *
 * ITS MESSAGE, NEVER ITS `toString()`, whatever class it is. This used to strip
 * the class name for a `ModificationsInvalidError` and keep it for everything
 * else, so once V4 gave the apply step a projection to fail at, a failed
 * projection rendered its reason as "guardian's modifications could not be
 * applied: Error: result-output: ..." -- a milder form of the raw-JS-error-text
 * defect modifications.ts's own header records fixing, reintroduced by the one
 * branch that had not been asked the same question. What lands here is read in
 * the transcript and written to the audit trail, and a deny is only as useful as
 * its stated reason.
 *
 * WHAT NEITHER GATE ASKS IS WHETHER THE APPLIED DOCUMENT DIFFERS FROM THE ONE IT
 * WAS APPLIED TO, and at the request gate nothing downstream asks either. A
 * `modify` whose `parameter_overrides` set an argument to the value it already
 * held, or whose redaction replaces one with itself, applies cleanly and returns
 * an `applied_input` identical to what went out on the wire. Measured:
 * `parameter_overrides: {command: "cat .env"}` against `{command: "cat .env"}`
 * returns `modify` with `applied_input {"command":"cat .env"}` -- the policy said
 * rewrite, nothing was rewritten, the original command runs, and the audit trail
 * says the decision was honoured. That is this branch's own fail-open family, one
 * gate over from the result gate, where `projectAppliedOutput`'s landing check now
 * refuses the same shape.
 *
 * NOT CLOSED HERE, and the reason is that the honest repair is bigger than the
 * hole. A leaf-shaped check has no analogue at this gate: a request payload has no
 * single leaf, so "did anything change" would have to be "did every modification
 * change the document at its OWN target" -- a per-modification comparison, in
 * `modifications.ts`'s apply step where both documents and every target are in
 * hand. That check would also close the result gate's remaining bundled case (see
 * `projectAppliedOutput`), which is the argument for doing it once, there, rather than
 * twice by gate. What makes it safe to defer rather than urgent: `mapVerdict`
 * synthesizes one override from the bound `$policy_target` and throws otherwise,
 * so no Guardian in this deployment emits a no-change rewrite, and the failure is
 * a false record rather than a bypass of a decision that arrived.
 *
 * THE PROJECTION IS INSIDE THIS TRY, and deliberately so. At a result gate the
 * applied document still has to be projected onto the output object the host
 * holds (`projectAppliedOutput`), and that projection can fail for reasons of exactly
 * the same kind as the apply itself -- a leaf the payload does not have, a
 * replacement of a type the host's output shape does not admit. Both are a
 * rewrite that did not land, so both belong to the same sentence: `deny`,
 * `modifications_invalid`. Projecting AFTER this function returns would put
 * those failures outside the only catch that can answer them with a decision,
 * where a caller's delivery-failure posture would answer them instead -- and a
 * `proceed` posture there is an unredacted output delivered because a redaction
 * could not be expressed. Fail-closed by construction, not by posture.
 */
export function resolveModify(
  decision: AcsDecision,
  modificationDocument: Record<string, unknown>,
  outputLocation: HostOutputLocation | undefined,
): ValidatedAcsDecision {
  try {
    const applied = applyModifications(modificationDocument, decision.modifications);
    if (outputLocation === undefined) {
      return { ...decision, applied_input: applied };
    }
    return { ...decision, applied_output: projectAppliedOutput(applied, outputLocation) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return deny(`guardian's modifications could not be applied: ${reason}`, "modifications_invalid");
  }
}
