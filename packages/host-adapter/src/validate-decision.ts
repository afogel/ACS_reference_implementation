/**
 * N7 -- validateDecision: the host's (the Observed Agent's) last word on an
 * arriving decision, and R1.8's three mandatory fail-closed cases.
 *
 * The work itself belongs to collaborators this module is told about (PR #12
 * review, Important). What is left here is knowing which one an arriving
 * decision is for, and being the only place that says what their answers mean
 * as a decision:
 *
 * 1. `modify` -- decision-modify.ts applies §6.3's rewrite if it can be
 *    honoured as written, and denies if it cannot. Never a best-effort
 *    partial apply and never a reported-but-unapplied one.
 * 2. `ask` -- decision-expiry.ts substitutes an expired one with its
 *    `ask_details.timeout_disposition`.
 * 3. `defer` -- decision-expiry.ts substitutes an expired one with its
 *    `defer_details.timeout_decision`.
 *
 * THE THREE ARE PEERS, and now read as three of one thing (PR #12 review,
 * second pass). Each is `resolve<Disposition>(decision, ...) ->
 * ValidatedAcsDecision`, each never throws, and each lives in a module beside
 * the knowledge it needs -- so "all three fail closed" is one property checked
 * one way, rather than three seams with three shapes. `resolveModify` used to
 * be a private function inside THIS module while its two peers were exported
 * from another, which made the trio look like one special case and two
 * siblings.
 *
 * This module used to own all three jobs plus the apply step, in 514 lines
 * under a name that admitted to one of them: "validate" said nothing about
 * *applying* a rewrite to a tool call's arguments, nor about *substituting* a
 * decision for an expired one. Both are things a reader has to know this
 * module does, and neither was discoverable from its name or its size. What is
 * left is a switch and nothing else.
 *
 * No resolver names a decision it was not given: `resolveModify` is the only
 * translation from "this rewrite cannot be honoured" to "deny", and
 * decision-expiry.ts's two resolvers are the only substitutions of an expired
 * outcome. Everything else that arrives leaves untouched.
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

import type { AcsDecision, ValidatedAcsDecision } from "./decision-message.ts";
import { resolveAsk, resolveDefer } from "./decision-expiry.ts";
import { resolveModify } from "./decision-modify.ts";

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
