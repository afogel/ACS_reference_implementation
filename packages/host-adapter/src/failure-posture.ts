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
import type { AuditEvent, AuditSink } from "./audit-sink.ts";
import type { AcsDecision } from "./decision-message.ts";
import { GuardianTimeoutError } from "./guardian-client.ts";
import { SessionConfigNotStoredError, type ResolvedSessionConfig } from "./handshake.ts";

/** handshake.json's own default, and R1.7's (D8 closed here). */
export const DEFAULT_POSTURE = "proceed" as const;

/** Used when no handshake completed, so no timeout was negotiated either.
 * Matches the Guardian's declared default so the two agree by value. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * What went wrong ON THE WIRE: a request went out and no usable decision came
 * back. §6.4's own case, and the only kinds `classifyDeliveryFailure` can
 * produce.
 *
 * Narrow, and the narrowing IS the fix (PR #12 review, Critical). This type
 * used to carry `host_configuration` and `decision_unrenderable` too, each
 * under its own comment admitting it was "not a delivery failure at all" -- so
 * `failure.kind` presented two precisely-known, entirely host-side causes under
 * a delivery-shaped name, and `classifyDeliveryFailure` advertised a return it
 * never actually produced. A type that lies is a lie the type system then
 * teaches every reader. The two live in `HostFailureKind` below.
 */
export type DeliveryFailureKind = "timeout" | "transport" | "error_without_decision" | "unknown";

/**
 * What went wrong ON THIS SIDE of the wire, when the wire was never the
 * problem. Neither of these is reachable from `classifyDeliveryFailure`: the
 * stage already knows which one happened (see `classifyStepFailure`), because
 * for these two the failure object is the detail, not the diagnosis.
 */
export type HostFailureKind =
  /**
   * The request was never sent, because this host could not build one. Its own
   * kind because "unknown" was actively misleading for it -- the cause is
   * precisely known and entirely host-side, and an audit entry that files a
   * host misconfiguration under an unknown delivery failure sends an incident
   * review to the wrong process.
   */
  | "host_configuration"
  /**
   * A decision DID arrive and was honoured in principle -- what failed was
   * this host expressing it (a decision string no hookmap entry names, or a
   * hookmap gap). Same misattribution as `host_configuration` fixed one step
   * earlier in the exchange: auditing it as "no decision arrived from the
   * guardian" tells an incident reviewer to go and look at a Guardian that
   * answered correctly, when the fault is in this host's own rendering table.
   */
  | "decision_unrenderable";

/**
 * Everything `AuditEntry.failure.kind` can name about one step: the wire's
 * failures and this host's own.
 *
 * A union rather than one widened `DeliveryFailureKind`, so the honest half
 * stays honest. A reader asking "what can a delivery failure be?" gets four
 * answers; a reader asking "what can an audit entry say about a step?" gets
 * six; and neither question is answered with the other one's list.
 */
export type StepFailureKind = DeliveryFailureKind | HostFailureKind;

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
 * Names which of §6.4's DELIVERY failure modes happened, for the audit entry.
 * Total: an unrecognised shape is "unknown", never a throw -- this runs while
 * the host is already handling a failure.
 *
 * Half of the `classify<Role>Failure` pair, with `classifySessionFailure`: same
 * verb, and now two accurate role nouns (PR #12 review, naming symmetry ×2).
 * The review offered two routes to that and this is the second one -- rename
 * the function until the name covers the kinds, or narrow the kinds until the
 * name is true. The role here really is delivery (every kind it can return is a
 * property of the wire, R3.2), so widening the name would have preserved the
 * lie under better spelling. `classifyStepFailure` below is the genuinely wider
 * role, and it stays private because nothing outside this module chooses a
 * stage.
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
  | "session_config_unstored"
  /**
   * A ServerHello arrived and was not a usable session config at all. No
   * posture was negotiated, so -- unlike the case above -- there is nothing
   * to apply to this step either; the ACS default governs. Its own kind
   * because the remedy is entirely different: this one is a Guardian
   * emitting the wrong shape, not a host that cannot write to its own disk.
   */
  | "server_hello_invalid";

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
  /**
   * This session's config and whatever went wrong establishing it, exactly as
   * `resolveSessionConfig` (N5) answers -- the message, not its halves.
   *
   * It used to be two fields, `sessionConfig` and `sessionFailure`, so every
   * caller unpacked one message to hand this one two loose values and this
   * function read them back as a pair. The two are read for two unrelated
   * purposes and that is exactly why they travel together:
   *
   *   - `config` decides the posture (its `on_decision_failure`, or the ACS
   *     default when nothing was negotiated) and, on the audit entry,
   *     `posture_source`.
   *   - `failure` never becomes this step's failure. It is recorded beside it as
   *     `session_failure`, because a session config that cannot be persisted
   *     means every hook re-negotiates and the declared posture never applies --
   *     which is how a deployment that asked to fail closed quietly fails open
   *     (see AuditEntry.session_failure).
   */
  session: ResolvedSessionConfig;
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
};

/**
 * The ACS decision this function answers an absent one with -- the same
 * `AcsDecision` message every other path hands the host (decision-message.ts),
 * refined by what is additionally known about one that came from here.
 *
 * It used to be called `PostureDecision`, which named the wrong message (PR #12
 * review, Important, twice): a posture is `proceed|deny` and this payload is
 * `allow|deny`, so every reader had to translate a noun that said "posture"
 * into a value that was a decision. The refinement is real and worth keeping
 * typed, though, and it is the two facts a caller relies on:
 *
 *   - `decision` is `allow` or `deny` and never anything else, which is what
 *     lets a caller's fallback render of it be unfailing (a hookmap that
 *     loadHookmap accepted declares a renderable entry for both).
 *   - `reasoning` and `reason_codes` are always present -- a step that ran
 *     without a policy decision behind it must always say so, in prose a human
 *     reads and in a code a machine reads.
 */
export type FailureResolvedAcsDecision = AcsDecision & {
  decision: "allow" | "deny";
  reasoning: string;
  reason_codes: string[];
};

export function applyFailurePosture({
  failure,
  session,
  sessionId,
  method,
  rpcId,
  audit,
  stage = "delivery",
}: ApplyFailurePostureInput): FailureResolvedAcsDecision {
  const { config: sessionConfig, failure: sessionFailure } = session;
  const posture = sessionConfig?.on_decision_failure ?? DEFAULT_POSTURE;
  // One resolution, read once, in the three vocabularies it is expressed in --
  // see RESOLUTION_BY_POSTURE.
  const { decision, outcome } = RESOLUTION_BY_POSTURE[posture];
  const classified = classifyStepFailure(stage, failure);

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
    decision,
    reasoning: `${cause};${sessionNote} ${postureOrigin} -- on_decision_failure=${posture}, so this step was ${outcome}.`,
    reason_codes: [REASON_CODE_BY_STAGE[stage]],
  };
}

/**
 * The one place a posture becomes the other two vocabularies this resolution is
 * expressed in: the ACS decision the host is handed, and the outcome the audit
 * entry records.
 *
 * One declaration, read once (PR #12 review, Important). It used to be two
 * open-coded translations in the middle of `applyFailurePosture` -- the posture
 * re-encoded as an outcome on one line and as a decision seventy lines later --
 * which is three encodings of a single resolution inside one body, with nothing
 * but proximity keeping them in step. Now they agree by construction.
 *
 * The three vocabularies are deliberately NOT collapsed into one; the note on
 * `AuditEntry.outcome` is where that was weighed and why the audit rail keeps
 * its own. Both of this table's value types are read off `AuditEvent`'s own
 * declarations, so the table and the artifact cannot drift apart.
 */
const RESOLUTION_BY_POSTURE: Record<
  AuditEvent["posture"],
  { decision: "allow" | "deny"; outcome: AuditEvent["outcome"] }
> = {
  proceed: { decision: "allow", outcome: "proceeded" },
  deny: { decision: "deny", outcome: "blocked" },
};

/** One reason code per stage, so the machine-readable half of the decision
 * carries the same distinction the prose does. */
const REASON_CODE_BY_STAGE: Record<FailureStage, string> = {
  delivery: "decision_failure",
  request: "host_configuration",
  render: "decision_unrenderable",
};

/**
 * The classified `{kind, message}` for one step, at the stage that failed --
 * the whole role, of which delivery is one third. Only "delivery" consults the
 * failure value itself: the other two stages KNOW what happened -- the
 * failure object is the detail, not the diagnosis -- and running them
 * through classifyDeliveryFailure is what produced "unknown" for two
 * precisely-known, entirely host-side causes.
 *
 * `classifyStepFailure`, not `classifyByStage`: same `classify<Role>Failure`
 * shape as the two exported classifiers, and it names what it returns rather
 * than how it dispatches.
 */
function classifyStepFailure(stage: FailureStage, failure: unknown): { kind: StepFailureKind; message: string } {
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
