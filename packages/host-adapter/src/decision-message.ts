/**
 * The ACS decision message this adapter speaks, and the one deny it
 * substitutes. Kept in a module of its own so validate-decision.ts (the
 * orchestrator), decision-expiry.ts (one of the collaborators it sequences),
 * render-decision.ts (which renders one), guardian-client.ts (which receives
 * one off the wire) and failure-posture.ts (which produces one in place of an
 * absent one) can all speak the same message -- and without a `deny` that
 * means something subtly different on each side of a seam.
 *
 * ONE STEM, ADJECTIVES FOR STAGE (PR #10 review, Important; PR #12 review,
 * naming symmetry, which is what added the second and third rows). There is one
 * public noun for "the ACS decision for this step", and every refinement of it
 * still contains that noun:
 *
 *   AcsDecision                 the message as it arrives, and the type every
 *                               path hands the host
 *   ValidatedAcsDecision        after N7's validation and §6.3's apply (below)
 *   FailureResolvedAcsDecision  after N6's posture answered an absent one
 *                               (failure-posture.ts)
 *
 * There used to be four parallel nouns for that one role -- `AcsDecision` on
 * the Guardian's side, `AcsDecisionResult` in render-decision.ts,
 * `DecisionInput` in validate-decision.ts, `PostureDecision` in
 * failure-posture.ts -- so a reader following one decision through the stack
 * learned a new name at every hop while the role never changed. The suffixes
 * described processing stage or origin, not a different message.
 *
 * WHY THIS IS NOT AN IMPORT OF THE GUARDIAN'S OWN `AcsDecision`. The Guardian
 * declares the same message (packages/guardian/src/map-verdict.ts) as a strict
 * union of the five ACS dispositions, because it is the side that *builds*
 * one. This side reads one off HTTP, so it is deliberately loose: only
 * `decision` is required, and everything else a caller touches is named by the
 * hookmap's `from:` declarations rather than assumed to exist under a fixed
 * key. The two are structurally compatible in the direction that matters (the
 * Guardian's is assignable to this one), and they share the NAME rather than
 * an import, because R3.2 forbids this package depending on the Guardian's
 * type graph. Same deliberate structural duplication as the Inspector's
 * AuditEntry and EnvelopeLogEntry, for the same reason.
 *
 * One noun for "the ACS decision for this step", across both sides of the
 * seam. Any later refinement should stay an adjective containing this stem
 * (`ValidatedAcsDecision`), never a parallel noun.
 *
 * ACS's decision vocabulary, nothing else.
 */

/**
 * The ACS decision for one step, as this adapter reads it. Loose on purpose --
 * see the module header: only `decision` is required.
 */
export type AcsDecision = { decision: string } & Record<string, unknown>;

/** An `AcsDecision` after N7 has had its last word on it: §6.3's rewrite
 * applied under the post-validation field name the hookmap renders from, and
 * any expired ask/defer outcome already substituted. */
export type ValidatedAcsDecision = AcsDecision & { applied_input?: Record<string, unknown> };

/**
 * Denies with `reason_codes` set to exactly `[code]` -- every fail-closed
 * substitution across these modules reports one specific reason, never a
 * general one, so an audit reader can tell the mandatory cases apart.
 *
 * Here rather than in one of the two modules that call it, because both do:
 * decision-expiry.ts denies an ask or defer whose window it cannot read, and
 * validate-decision.ts denies a rewrite that could not be honoured. A copy per
 * module is a `deny` free to drift on what it carries, in the one direction
 * that matters -- a deny whose `reason_codes` a machine reads.
 */
export function deny(reasoning: string, code: string): ValidatedAcsDecision {
  return { decision: "deny", reasoning, reason_codes: [code] };
}
