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
 * never calling this on a decision, plus the end-to-end assertions in Task 8.
 *
 * One place two of this slice's global constraints genuinely disagree, and
 * how it is resolved: constraint 2 says a sink that cannot write "degrades
 * observability and nothing else", while constraint 3 says every fail-open
 * proceed is audited and "a proceed with no audit entry is a silent bypass
 * and is the one outcome this slice exists to make impossible". Constraint 3
 * governs, because §6.4 makes the entry a MUST for a step that proceeds
 * without a decision -- an unauditable bypass is not a bypass the spec
 * permits. So a `proceed` this function could not audit is downgraded to
 * `deny`, with its own reason code. What constraint 2 was protecting is
 * untouched: the sink still never throws, never delays a decision, and never
 * changes one -- the change is entirely in what this caller does with a
 * write it was told did not happen.
 *
 * R3.2: nothing here knows the policy runtime behind the wire. A delivery
 * failure is a property of the wire, not of whatever evaluates policy on
 * the other side of it.
 */
import type { AuditSink } from "./audit-sink.ts";
import { GuardianTimeoutError } from "./guardian-client.ts";
import { SessionConfigNotStoredError } from "./handshake.ts";
import type { SessionConfig } from "./session-config.ts";

/** handshake.json's own default, and R1.7's (D8 closed here). */
export const DEFAULT_POSTURE = "proceed" as const;

/** Used when no handshake completed, so no timeout was negotiated either.
 * Matches the Guardian's declared default so the two agree by value. */
export const DEFAULT_TIMEOUT_MS = 5000;

export type DeliveryFailureKind =
  | "timeout"
  | "transport"
  | "error_without_decision"
  | "unknown"
  /**
   * Not a delivery failure at all: the request was never sent, because this
   * host could not build one. Its own kind because "unknown" was actively
   * misleading for it -- the cause is precisely known and entirely host-side,
   * and an audit entry that files a host misconfiguration under an unknown
   * delivery failure sends an incident review to the wrong process.
   */
  | "host_configuration"
  /**
   * Also not a delivery failure: a decision DID arrive and was honoured in
   * principle -- what failed was this host expressing it (a decision string
   * no hookmap entry names, or a hookmap gap). Same misattribution as
   * `host_configuration` fixed one step earlier in the exchange: auditing it
   * as "no decision arrived from the guardian" tells an incident reviewer to
   * go and look at a Guardian that answered correctly, when the fault is in
   * this host's own rendering table.
   */
  | "decision_unrenderable";

/**
 * WHERE in the exchange the failure happened. Three materially different
 * incidents, and the audit record has to tell them apart -- an entry that
 * confuses them sends an incident review to the wrong process, which is the
 * defect this type replaced a boolean to fix:
 *
 *   "delivery" -- a request went out and no usable decision came back.
 *                 §6.4's own case, and the default for every ordinary call
 *                 site.
 *   "request"  -- no request was ever built, so nothing was asked of
 *                 anything. Host-side configuration, and the reasoning must
 *                 not name a Guardian that was never contacted.
 *   "render"   -- a decision arrived and was honoured in principle; this
 *                 host could not express it.
 *
 * A boolean could only express two of the three, and a second boolean would
 * have admitted a combination that means nothing ("nothing was sent, and a
 * decision arrived").
 */
export type FailureStage = "delivery" | "request" | "render";

/** A JSON-RPC error object, as it arrives in a response that carried no decision. */
type ErrorLike = { code?: unknown; message?: unknown };

/**
 * Connection-level `.code` values fetch can throw with, confirmed against
 * THIS runtime (Bun) rather than assumed from the WHATWG fetch spec -- see
 * the correction below, fix round 2 of Task 8's review. Bun's fetch throws
 * a plain `Error` (name "Error", not "TypeError") carrying one of these on
 * `.code` for a failure below the HTTP layer: refused, closed, never
 * opened, or a DNS lookup or TLS handshake that failed. Confirmed two ways:
 * reading Bun's own src/http/error.rs (the `Error` enum's `.name()` is what
 * becomes `.code`), and, for `ConnectionRefused` specifically, provoking it
 * directly (`fetch` against a reliably-refused port, port 1) and
 * inspecting the thrown value.
 *
 * Deliberately NOT exhaustive: Bun's TLS certificate-validation failures
 * fan out into a further ~70 more specific X.509 codes (a nested
 * `CertError` enum -- `CERT_HAS_EXPIRED`, `UNABLE_TO_GET_ISSUER_CERT`, and
 * so on) not enumerated here, because which of those actually surface as a
 * flat `.code` string (versus some other shape) is not confirmed --
 * enumerating them anyway would be exactly the mistake this fix undoes.
 * `ERR_TLS_CERT_ALTNAME_INVALID` is the one TLS-related code confirmed as
 * its own top-level enum member, so it is the one line "the TLS
 * equivalent" below commits to.
 */
const TRANSPORT_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "DNSResolveFailed",
  "DNSResolutionFailed",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

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
      // Two independent routes to "transport", because no single one is
      // reliable across runtimes -- Task 4's original assumption (that
      // fetch always throws a TypeError for this) was wrong for the
      // runtime this project actually runs on:
      //   1. The WHATWG fetch spec's own route: a TypeError for a network
      //      error. Other runtimes take this one, and a future Bun might.
      //   2. This runtime's actual route: a plain Error whose `.code`
      //      names a connection-level failure. Read defensively --
      //      `.code` is not a property of the `Error` type.
      const code = (failure as { code?: unknown }).code;
      const isTransport =
        failure instanceof TypeError || (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code));
      return { kind: isTransport ? "transport" : "unknown", message: failure.message };
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

/** What went wrong establishing this session's negotiated config, for
 * `AuditEntry.session_failure`. */
export type SessionFailureKind =
  /**
   * The handshake never came back with a ServerHello: the Guardian was
   * unreachable, timed out, or answered with a JSON-RPC error. Nothing was
   * negotiated, so there is no posture to lose -- `posture_source: "default"`
   * on the same entry already says the ACS default applied, and in a
   * Guardian-down session EVERY entry carries this.
   */
  | "handshake_failed"
  /**
   * A ServerHello arrived and this host could not keep it. Materially
   * different from the above and the reason this field is not one constant:
   * a posture WAS negotiated. It is applied to the step that negotiated it,
   * and every LATER hook in the session re-handshakes because the file the
   * next subprocess would have read is not there -- so a store that stays
   * unwritable is a deployment quietly paying a round trip per hook, and one
   * whose declared posture depends on that round trip continuing to succeed.
   */
  | "session_config_unstored";

/**
 * Names which of the two session-establishment failures happened. Total, for
 * the same reason classifyDeliveryFailure is: this runs while the host is
 * already handling a failure.
 *
 * The two used to share one constant (`"session_config"`), separated only by
 * free text -- so in a Guardian-down session every entry carried the note and
 * the one occurrence that actually costs something was buried in it.
 */
export function classifySessionFailure(failure: unknown): { kind: SessionFailureKind; message: string } {
  return {
    kind: failure instanceof SessionConfigNotStoredError ? failure.kind : "handshake_failed",
    message: messageOf(failure),
  };
}

export type ApplyFailurePostureInput = {
  /** Whatever the delivery attempt threw, or the JSON-RPC error it returned. */
  failure: unknown;
  /** S13's contents, or undefined when no handshake ever completed. */
  sessionConfig: SessionConfig | undefined;
  sessionId: string;
  /** The ACS method, or null when no request was built and so none is
   * knowable. Never a host's own event name -- see AuditEntry.method. */
  method: string | null;
  rpcId: string | number | null;
  /** Required, not optional: constraint 3 makes auditing non-skippable. */
  audit: AuditSink;
  /**
   * Where in the exchange this failure happened -- see FailureStage. Both
   * the classified kind and the reasoning follow from it, so that neither
   * blames a Guardian that was never contacted ("request") nor tells an
   * incident reviewer no decision arrived when one did ("render"). Defaults
   * to "delivery", which is every ordinary call site and §6.4's own case.
   */
  stage?: FailureStage;
  /**
   * Whatever went wrong establishing this session's negotiated config, if
   * anything did: a handshake that failed, or a ServerHello that could not
   * be stored. Recorded alongside the step's own failure rather than merged
   * into it (see AuditEntry.session_failure) -- a session config that cannot
   * be persisted means every hook re-negotiates and the declared posture
   * never applies, which is how a deployment that asked to fail closed
   * quietly fails open.
   */
  sessionFailure?: unknown;
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
  stage = "delivery",
  sessionFailure,
}: ApplyFailurePostureInput): PostureDecision {
  const posture = sessionConfig?.on_decision_failure ?? DEFAULT_POSTURE;
  const classified = classifyByStage(stage, failure);
  const outcome = posture === "proceed" ? "proceeded" : "blocked";

  // Computed before the audit write, and written into it: "the guardian was
  // down for this whole session" (default) and "this deployment chose to
  // fail open" (negotiated) are different incidents, and the durable record
  // -- not just the ephemeral `reasoning` string below -- has to be able to
  // tell them apart.
  const postureSource: "negotiated" | "default" = sessionConfig === undefined ? "default" : "negotiated";

  // §6.4's MUST. Wrapped because the decision must survive a sink that
  // breaks its own totality contract -- the posture is the load-bearing
  // half, the record is the accountability half, and losing the record must
  // not lose the posture.
  let audited = false;
  try {
    audited =
      audit.write({
        session_id: sessionId,
        method,
        rpc_id: rpcId,
        posture,
        posture_source: postureSource,
        outcome,
        failure: classified,
        ...(sessionFailure === undefined ? {} : { session_failure: classifySessionFailure(sessionFailure) }),
      }) === true;
  } catch {
    // The sink is documented total; if it throws anyway, there is nowhere
    // left to report it that would not have the same problem. It counts as
    // unaudited, which is the only thing the decision below needs from it.
  }

  // Honest about where the posture came from: a negotiated deployment
  // choice reads very differently from a session that never got that far.
  const postureOrigin =
    postureSource === "default"
      ? `no session was ever negotiated, so the ACS default posture (${DEFAULT_POSTURE}) applies`
      : "the session's negotiated posture applies";

  // Never names a Guardian for a request that never reached one (whole-branch
  // review, I2): a `host_configuration` failure is this host's own, and an
  // audit trail that blames the policy runtime for it sends an incident
  // review to the wrong process. `render` is the same misattribution read
  // the other way round -- a decision genuinely did arrive, so saying none
  // did would send that reviewer to the wrong process too, just a different
  // wrong one.
  //
  // The "delivery" wording below is quoted verbatim in four v3-runbook
  // captures reproduced against a live Guardian. It is not to be reworded
  // without re-capturing them.
  const cause =
    stage === "request"
      ? `this host could not build a request for this step, so no decision was ever sought ` +
        `(${classified.kind}: ${classified.message})`
      : stage === "render"
        ? `a decision arrived from the guardian for ${method ?? "this step"} and was honoured, but this host ` +
          `could not express it (${classified.kind}: ${classified.message})`
        : `no decision arrived from the guardian for ${method ?? "this step"} (${classified.kind}: ${classified.message})`;

  const sessionNote =
    sessionFailure === undefined
      ? ""
      : ` this session's negotiated configuration could not be established or stored ` +
        `(${messageOf(sessionFailure)}), so any posture this deployment declared was unavailable to this step;`;

  // Constraint 3 outranks the posture here, and this is the one place the two
  // can disagree. §6.4 makes the audit entry a MUST for a step that proceeds
  // without a decision, so a proceed that could not be recorded is not a
  // proceed this deployment is entitled to take: an unauditable bypass is
  // exactly the silent bypass this slice exists to make impossible. The sink
  // stays total (it never threw and never will); what changes is what the
  // caller does with a failed write. A `deny` needs no such downgrade -- the
  // step is blocked either way, and the failed write is already reported by
  // the sink's own error path.
  if (posture === "proceed" && !audited) {
    return {
      decision: "deny",
      reasoning:
        `${cause};${sessionNote} ${postureOrigin} -- on_decision_failure=proceed, but the audit entry §6.4 ` +
        "requires for a step that proceeds without a decision could not be recorded, so this step was blocked " +
        "instead: a bypass that cannot be recorded is not one this deployment can take.",
      reason_codes: ["decision_failure", "audit_unavailable"],
    };
  }

  return {
    decision: posture === "proceed" ? "allow" : "deny",
    reasoning: `${cause};${sessionNote} ${postureOrigin} -- on_decision_failure=${posture}, so this step was ${outcome}.`,
    reason_codes: [REASON_CODE_BY_STAGE[stage]],
  };
}

/** One reason code per stage, so the machine-readable half of the decision
 * carries the same distinction the prose does. */
const REASON_CODE_BY_STAGE: Record<FailureStage, string> = {
  delivery: "decision_failure",
  request: "host_configuration",
  render: "decision_unrenderable",
};

/**
 * The classified `{kind, message}` for a stage. Only "delivery" consults the
 * failure value itself: the other two stages KNOW what happened -- the
 * failure object is the detail, not the diagnosis -- and running them
 * through classifyDeliveryFailure is what produced "unknown" for two
 * precisely-known, entirely host-side causes.
 */
function classifyByStage(stage: FailureStage, failure: unknown): { kind: DeliveryFailureKind; message: string } {
  switch (stage) {
    case "request":
      return { kind: "host_configuration", message: messageOf(failure) };
    case "render":
      return { kind: "decision_unrenderable", message: messageOf(failure) };
    default:
      return classifyDeliveryFailure(failure);
  }
}

/** The message of whatever was thrown, without assuming it was an Error. */
function messageOf(failure: unknown): string {
  try {
    return failure instanceof Error ? failure.message : String(failure);
  } catch {
    return "<unprintable failure>";
  }
}
