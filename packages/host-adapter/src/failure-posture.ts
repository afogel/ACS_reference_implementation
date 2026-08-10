/**
 * N6 -- applyFailurePosture. The delivery half of the two failure domains
 * (Global Constraint 1).
 *
 * This function is only ever reached when NO usable decision arrived: the
 * Guardian stayed silent past the negotiated timeout, the transport died, or
 * an error response carried no decision. §6.4 says all three resolve the
 * same way -- apply the deployment's declared posture -- and that every step
 * which proceeds without a decision MUST be audited.
 *
 * It is NOT reached when a decision arrived. A `deny` that arrives is
 * honoured regardless of posture (R1.5), and that is enforced by the caller
 * never calling this on a decision, plus the end-to-end assertions in Task 9.
 *
 * R3.2: nothing here knows the policy runtime behind the wire. A delivery
 * failure is a property of the wire, not of whatever evaluates policy on
 * the other side of it.
 */
import type { AuditSink } from "./audit-sink.ts";
import { GuardianTimeoutError } from "./guardian-client.ts";
import type { SessionConfig } from "./session-config.ts";

/** handshake.json's own default, and R1.7's (D8 closed here). */
export const DEFAULT_POSTURE = "proceed" as const;

/** Used when no handshake completed, so no timeout was negotiated either.
 * Matches the Guardian's declared default so the two agree by value. */
export const DEFAULT_TIMEOUT_MS = 5000;

export type DeliveryFailureKind = "timeout" | "transport" | "error_without_decision" | "unknown";

/** A JSON-RPC error object, as it arrives in a response that carried no decision. */
type ErrorLike = { code?: unknown; message?: unknown };

/**
 * Names which of §6.4's failure modes happened, for the audit entry. Total:
 * an unrecognised shape is "unknown", never a throw -- this runs while the
 * host is already handling a failure.
 */
export function classifyDeliveryFailure(failure: unknown): { kind: DeliveryFailureKind; message: string } {
  try {
    if (failure instanceof GuardianTimeoutError) {
      return { kind: "timeout", message: failure.message };
    }
    if (failure instanceof Error) {
      // fetch rejects with a TypeError for a refused connection, DNS
      // failure, or TLS failure -- §6.4's "the transport fails".
      const kind: DeliveryFailureKind = failure instanceof TypeError ? "transport" : "unknown";
      return { kind, message: failure.message };
    }
    if (typeof failure === "object" && failure !== null && "code" in failure) {
      const { code, message } = failure as ErrorLike;
      return {
        kind: "error_without_decision",
        message: `guardian returned error ${String(code)}: ${String(message)}`,
      };
    }
    return { kind: "unknown", message: String(failure) };
  } catch {
    return { kind: "unknown", message: "<unprintable failure>" };
  }
}

export type ApplyFailurePostureInput = {
  /** Whatever the delivery attempt threw, or the JSON-RPC error it returned. */
  failure: unknown;
  /** S13's contents, or undefined when no handshake ever completed. */
  sessionConfig: SessionConfig | undefined;
  sessionId: string;
  method: string;
  rpcId: string | number | null;
  /** Required, not optional: constraint 3 makes auditing non-skippable. */
  audit: AuditSink;
};

export type PostureDecision = {
  decision: "allow" | "deny";
  reasoning: string;
  reason_codes: string[];
};

export function applyFailurePosture({
  failure,
  sessionConfig,
  sessionId,
  method,
  rpcId,
  audit,
}: ApplyFailurePostureInput): PostureDecision {
  const posture = sessionConfig?.on_decision_failure ?? DEFAULT_POSTURE;
  const classified = classifyDeliveryFailure(failure);
  const outcome = posture === "proceed" ? "proceeded" : "blocked";

  // §6.4's MUST. Wrapped because the decision must survive a sink that
  // breaks its own totality contract -- the posture is the load-bearing
  // half, the record is the accountability half, and losing the record must
  // not lose the posture.
  try {
    audit.write({ session_id: sessionId, method, rpc_id: rpcId, posture, outcome, failure: classified });
  } catch {
    // The sink is documented total; if it throws anyway, there is nowhere
    // left to report it that would not have the same problem.
  }

  // Honest about where the posture came from: a negotiated deployment
  // choice reads very differently from a session that never got that far.
  const postureOrigin =
    sessionConfig === undefined
      ? `no session was ever negotiated, so the ACS default posture (${DEFAULT_POSTURE}) applies`
      : "the session's negotiated posture applies";

  return {
    decision: posture === "proceed" ? "allow" : "deny",
    reasoning:
      `no decision arrived from the guardian for ${method} (${classified.kind}: ${classified.message}); ` +
      `${postureOrigin} -- on_decision_failure=${posture}, so this step was ${outcome}.`,
    reason_codes: ["decision_failure"],
  };
}
