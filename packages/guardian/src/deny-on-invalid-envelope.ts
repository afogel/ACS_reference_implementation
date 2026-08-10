/**
 * N27 -- denyOnInvalidEnvelope.
 *
 * A Guardian-side failure (the envelope failed validation, or evaluation
 * threw) is a governance outcome, not a transport accident. §6.4 says a
 * decision that arrives MUST be honoured regardless of posture, so
 * delivering these as decisions keeps them in the honoured path instead of
 * routing them into the host's fail-open posture -- which for a governance
 * tool is the difference between "blocked" and "silently allowed".
 *
 * That is the whole two-failure-domain rule (Global Constraint 1): AGT's
 * evaluation layer fails CLOSED, the wire's delivery layer applies the
 * negotiated posture, and the two must not be conflated.
 *
 * Constraint 10 (P5): response-envelope.json's AcsResult REQUIRES
 * request_id, and an envelope that failed validation may carry none. Rather
 * than invent one -- which would hand the host a decision it cannot
 * correlate -- this reports `unaddressable` and the caller returns a bare
 * JSON-RPC error. A parse failure never reaches here at all: there is no
 * envelope.
 *
 * Total: never throws, whatever shape it is handed.
 */
const ACS_VERSION_FALLBACK = "0.1.0";

export type DenyOnInvalidEnvelopeOptions = { reasonCode: string; message: string };

export type DenyOnInvalidEnvelopeResult =
  | { kind: "decision"; result: Record<string, unknown> }
  | { kind: "unaddressable" };

function readString(container: unknown, key: string): string | undefined {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function denyOnInvalidEnvelope(
  raw: unknown,
  { reasonCode, message }: DenyOnInvalidEnvelopeOptions,
): DenyOnInvalidEnvelopeResult {
  try {
    const params = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).params : undefined;

    // Preference order is deliberate: the ACS request_id is what a host
    // correlates a decision by; the JSON-RPC id is the fallback because it is
    // what the transport correlates by, and buildEnvelope sets them equal.
    let requestId = readString(params, "request_id");
    if (requestId === undefined) {
      const rpcId = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).id : undefined;
      if (typeof rpcId === "string" && rpcId.length > 0) {
        requestId = rpcId;
      } else if (typeof rpcId === "number") {
        requestId = String(rpcId);
      }
    }
    if (requestId === undefined) {
      return { kind: "unaddressable" };
    }

    return {
      kind: "decision",
      result: {
        type: "final",
        acs_version: readString(params, "acs_version") ?? ACS_VERSION_FALLBACK,
        request_id: requestId,
        decision: "deny",
        reasoning: message,
        reason_codes: [reasonCode],
        // Empty on purpose, and load-bearing: R1.2 makes a NON-empty
        // policy_references the marker of a policy-fired allow (AGT's warn).
        // A Guardian-side failure fired no policy, so this stays empty.
        policy_references: [],
      },
    };
  } catch {
    return { kind: "unaddressable" };
  }
}
