/**
 * The two expiry substitutions §6 makes mandatory for the *host* (the
 * Observed Agent), extracted from validate-decision.ts (N7), which now
 * sequences them rather than owning them:
 *
 * 1. An expired `ask` falls back to `ask_details.timeout_disposition`,
 *    defaulting to `deny`.
 * 2. An expired `defer` falls back to `defer_details.timeout_decision`,
 *    defaulting to `deny`.
 *
 * Both timeout defaults land on `deny`, deliberately the opposite of
 * `on_decision_failure`'s default of `proceed` (§6.4, and see
 * failure-posture.ts): a Guardian that flagged a concern (ASK or DEFER) and
 * then failed to resolve it is a different failure than one that never
 * answered at all, and the two must not collapse to the same posture.
 *
 * Both resolvers compare `elapsedMs` against `>` (strictly greater than) the
 * timeout, not `>=`: a decision that resolves in exactly the negotiated
 * window has not expired, and the boundary belongs to the decision that
 * arrived, not to expiry. Both boundaries are pinned by their own test.
 *
 * The two timeouts are NOT in the same unit, and nothing about their names
 * makes that survive a careless edit: `ask_details.timeout_seconds` is
 * seconds and is converted here, `defer_details.resolution_timeout_ms` is
 * already milliseconds and must not be. Dropping the ASK conversion leaves
 * every obvious test still passing (1s against 2000ms reads "expired" either
 * way), which is why validate-decision.test.ts carries a case chosen to read
 * the opposite way without it -- 500ms against a 1-second timeout.
 *
 * Neither resolver may turn an arriving decision into anything but its own
 * substitution: an `ask` or `defer` inside its window is returned as it
 * arrived, by identity, not rebuilt.
 *
 * R3.2: this module knows ACS's ask_details and defer_details shapes,
 * nothing else -- no policy-runtime vocabulary.
 */

import { deny, type AcsDecision, type ValidatedAcsDecision } from "./decision-message.ts";

/**
 * Substitutes an expired `ask` with its `ask_details.timeout_disposition`,
 * defaulting to `deny`; returns the decision untouched while it is still
 * inside its window.
 *
 * An `ask_details` that carries no numeric `timeout_seconds` is a deny of
 * its own rather than a pass-through: the host cannot tell when the window
 * closes, so it cannot tell whether it has closed, and an ASK whose expiry
 * is unknowable must not be handed to the host as a live question.
 */
export function resolveAsk(decision: AcsDecision, elapsedMs: number): ValidatedAcsDecision {
  const askDetails = decision.ask_details;
  if (
    typeof askDetails !== "object" ||
    askDetails === null ||
    typeof (askDetails as Record<string, unknown>).timeout_seconds !== "number"
  ) {
    return deny("ask decision is missing valid ask_details (approver, question, timeout_seconds)", "ask_details_invalid");
  }
  const details = askDetails as Record<string, unknown>;
  const timeoutMs = (details.timeout_seconds as number) * 1000;
  if (elapsedMs > timeoutMs) {
    const disposition = details.timeout_disposition === "allow" ? "allow" : "deny";
    return {
      decision: disposition,
      reasoning: `ask expired after ${elapsedMs}ms (timeout ${timeoutMs}ms); falling back to timeout_disposition=${disposition}`,
      reason_codes: ["ask_expired"],
    };
  }
  return decision;
}

/**
 * Substitutes an expired `defer` with its `defer_details.timeout_decision`,
 * defaulting to `deny`; returns the decision untouched while it is still
 * inside its window.
 *
 * `resolution_timeout_ms` is already milliseconds -- the missing `* 1000`
 * below is deliberate and is the difference between this resolver and
 * `resolveAsk`, not an omission.
 *
 * A `defer_details` that carries no numeric `resolution_timeout_ms` denies
 * for the same reason an unreadable `ask_details` does.
 */
export function resolveDefer(decision: AcsDecision, elapsedMs: number): ValidatedAcsDecision {
  const deferDetails = decision.defer_details;
  if (
    typeof deferDetails !== "object" ||
    deferDetails === null ||
    typeof (deferDetails as Record<string, unknown>).resolution_timeout_ms !== "number"
  ) {
    return deny(
      "defer decision is missing valid defer_details (reason, resolution_method, resolution_timeout_ms)",
      "defer_details_invalid",
    );
  }
  const details = deferDetails as Record<string, unknown>;
  const timeoutMs = details.resolution_timeout_ms as number;
  if (elapsedMs > timeoutMs) {
    const timeoutDecision = details.timeout_decision === "ask" ? "ask" : "deny";
    return {
      decision: timeoutDecision,
      reasoning: `defer expired after ${elapsedMs}ms (timeout ${timeoutMs}ms); falling back to timeout_decision=${timeoutDecision}`,
      reason_codes: ["defer_expired"],
    };
  }
  return decision;
}
