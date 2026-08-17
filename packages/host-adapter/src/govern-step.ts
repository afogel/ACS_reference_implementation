/**
 * `governStep` -- the exchange that governs one step, for any host.
 *
 * A host shim tells this "resolve this attempt" and is told back what it
 * should write: the output, the decision that output renders, and which stage
 * of the exchange produced that decision. It asks nothing on the way, and it
 * holds no intermediate flags.
 *
 * This lives outside any host shim so the stage-tracking it does is not
 * something every host has to reproduce: each `try`/`catch` below knows its
 * own stage directly, rather than a shim re-deriving which stage failed by
 * inspecting boolean flags after something has already gone wrong.
 *
 * This exchange is where a fail-open can hide: something throws, silently
 * no-ops, or emits an output the host does not recognise, letting the tool
 * call run ungoverned and unaudited. This function is the single place that
 * closes each of those paths:
 *
 *   - A decision that ARRIVED always outranks a posture. A response carrying
 *     both an `error` and a `result` that names a decision means a decision
 *     arrived. `GuardianClient.requestDecision` is the one place that
 *     judgement is made, and it is made before any posture is consulted.
 *   - An evaluation failure and a DELIVERY failure never merge. A `deny` the
 *     policy runtime produced -- including one it produced because its own
 *     evaluation failed -- is a decision, and travels the decision path. A
 *     silent Guardian, a dead transport, or an error carrying no decision is a
 *     delivery failure, and gets §6.4's negotiated `on_decision_failure`.
 *     Conflating them either breaks the policy layer's fail-closed invariant
 *     or halts production on a network blip.
 *   - Every step that proceeds without a decision is audited (§6.4 MUST), and a
 *     `proceed` that could not be audited is downgraded to `deny`. That is
 *     `applyFailurePosture`'s job, and every path here that has no decision
 *     goes through it -- there is no route to an output that skips it.
 *   - The audit entry names the RIGHT incident. "No request was ever built",
 *     "a request went out and nothing came back", and "a decision arrived and
 *     this host could not express it" are three different incidents, filed
 *     under three `FailureStage`s. They are told apart by WHERE in this
 *     function the failure was caught, not by re-reading flags after the fact:
 *     each stage has its own `try`, and each `catch` knows its own stage
 *     because that is the only stage it can be reached from.
 *   - There are exactly two ways out: a `GovernedStep`, or a throw. A throw
 *     means the fallback render of a posture decision itself failed, which
 *     `loadHookmap` makes unreachable (see `resolveByPosture` below) -- and it
 *     is left as a throw rather than repaired, because half an output is the
 *     one thing a governance hook must never write.
 *
 * This module knows ACS and hookmaps, and nothing else: no policy-runtime
 * vocabulary, and no host vocabulary -- it never names a field of the output
 * it returns, which is what lets the same function serve a second host with a
 * different wire shape (see render-decision.ts).
 */
import { buildEnvelope, unwrapArguments, type AcsRequestEnvelope, type Hookmap } from "./build-envelope.ts";
import type { AuditSink } from "./audit-sink.ts";
import {
  applyFailurePosture,
  DEFAULT_TIMEOUT_MS,
  type FailureResolvedAcsDecision,
  type FailureStage,
} from "./failure-posture.ts";
import type { GuardianClient } from "./guardian-client.ts";
import type { ValidatedAcsDecision } from "./decision-message.ts";
import { renderDecision, type HostOutput } from "./render-decision.ts";
import type { ResolvedSessionConfig } from "./handshake.ts";
import { validateDecision } from "./validate-decision.ts";

/**
 * What became of this step's decision -- one axis, four values.
 *
 * `"honoured"` means no stage failed: a decision arrived from the Guardian and
 * this host acted on it. The other three are `FailureStage`, the stage whose
 * failure the deployment's posture answered instead, and each is a different
 * audit incident.
 *
 * All four values sit on one axis: what happened to the decision, not who
 * sent it. This is not a directory of participants, it is the fate of one
 * step's decision.
 */
export type DecisionStage = "honoured" | FailureStage;

export type GovernStepInput = {
  /** The host's own event name, as `buildEnvelope` reads it against the hookmap. */
  hookEventName: string;
  /** The raw host payload for that event. */
  payload: Record<string, unknown>;
  /** The hookmap: the hook -> ACS method table and the decision -> output table. */
  hookmap: Hookmap;
  /** The Guardian this step's decision is sought from. */
  guardian: GuardianClient;
  /**
   * This session's negotiated config and whatever went wrong establishing it,
   * as `resolveSessionConfig` answers. The config decides the timeout and
   * the failure posture; the failure travels onto the audit entry beside the
   * step's own, never merged into it.
   */
  session: ResolvedSessionConfig;
  /** The host's own session identifier, for the audit entry. */
  sessionId: string;
  /** Required, not optional: §6.4 makes auditing a fail-open non-skippable. */
  audit: AuditSink;
};

/**
 * What a host is told once a step has been governed: the output to write, the
 * decision it renders, and what became of that decision.
 *
 * A discriminated union, so the refinement each path produced survives the
 * seam. The public story these modules tell is one stem with adjectives for
 * stage -- `AcsDecision` off the wire, `ValidatedAcsDecision` after
 * `validateDecision` has applied §6.3 and substituted any expired outcome,
 * `FailureResolvedAcsDecision` after `applyFailurePosture` answered an absent
 * one -- and a caller narrowing on `stage` needs the specific type, not the
 * widened base: a caller holding a `stage: "honoured"` step needs to see that
 * `applied_input` is the field to read; a caller holding a failure-resolved
 * one needs to see that `reasoning` and `reason_codes` are guaranteed
 * present.
 *
 * Discriminating on `stage` rather than declaring a bare union of the two,
 * because the correspondence is exact and is a property of `governStep`'s
 * control flow: the only route that returns `"honoured"` is the one that
 * rendered a validated decision, and every other route came from
 * `resolveByPosture`. Stating it here is what lets a caller narrow with the
 * field it already reads.
 */
export type GovernedStep =
  | {
      /**
       * The host output to write, rendered from `decision` through the hookmap.
       * Its keys are the hookmap's, never this module's.
       */
      output: HostOutput;
      /** A decision that arrived and was honoured, after `validateDecision`'s last word on it. */
      decision: ValidatedAcsDecision;
      stage: "honoured";
    }
  | {
      output: HostOutput;
      /** The decision `applyFailurePosture` answered an absent one with. */
      decision: FailureResolvedAcsDecision;
      /** The stage whose failure the posture answered -- see DecisionStage. */
      stage: FailureStage;
    };

/**
 * Governs one step: build the ACS request, ask the Guardian for a decision,
 * honour it, and render it -- answering any failure along the way with the
 * deployment's negotiated posture, audited, at the stage that failed.
 */
export async function governStep({
  hookEventName,
  payload,
  hookmap,
  guardian,
  session,
  sessionId,
  audit,
}: GovernStepInput): Promise<GovernedStep> {
  const timeoutMs = session.config?.timeout_config.default_ms ?? DEFAULT_TIMEOUT_MS;

  /**
   * The posture's answer to a failure, rendered. Every stage's catch ends here
   * and nowhere else, which is what makes "no decision without an audit entry"
   * a property of the control flow rather than of remembering to write one.
   *
   * The render here cannot fail: `loadHookmap` does not merely check that
   * `allow` and `deny` are present in the `decisions` block, it shape-checks
   * every entry it accepts (`assertRenderableDecisions`), and
   * `applyFailurePosture` never returns any decision but those two. So this
   * cannot recurse into itself, and a throw escaping it means the hookmap
   * bypassed the loader -- which is the caller's problem to fail loudly on, not
   * something to paper over.
   *
   * `method` is the ACS method or null, never the host's own event name: an
   * envelope that could not be built has no ACS method to report, and the audit
   * log is read by consumers that know only ACS. Putting a host event name here
   * made `bun run inspector` -- whose whole claim is that it names no host --
   * print one at runtime.
   */
  function resolveByPosture(
    failure: unknown,
    stage: FailureStage,
    envelope: AcsRequestEnvelope | undefined,
  ): GovernedStep {
    const decision = applyFailurePosture({
      failure,
      session,
      sessionId,
      method: envelope?.method ?? null,
      rpcId: envelope?.id ?? null,
      audit,
      stage,
    });
    return { output: renderDecision(decision, hookmap), decision, stage };
  }

  const startedAt = performance.now();

  // Stage "request": nothing has been asked of anything yet. A hookmap with no
  // entry for this event, or a payload the hookmap's paths do not resolve
  // against, is a host-side configuration fault -- so the audit reasoning must
  // not blame a Guardian that was never contacted, which is what this stage
  // records.
  let envelope: AcsRequestEnvelope;
  try {
    envelope = buildEnvelope(hookEventName, payload, hookmap);
  } catch (failure) {
    return resolveByPosture(failure, "request", undefined);
  }

  // Stage "delivery": a request exists and no decision is in hand yet. §6.4's
  // own case, and everything between those two points belongs to it -- the
  // round trip, and the host's last word on what came back. `requestDecision`
  // never throws, so the `if` below (not a catch) is the delivery failure this
  // stage exists for; the `try` covers the rest, which cannot throw today and
  // would still be a request that produced no decision if it ever did.
  let decision: ValidatedAcsDecision;
  try {
    // The same values that just went out on the wire, unwrapped from ACS's
    // `{value, provenance?}` argument shape -- so a `modify` decision's
    // `parameter_overrides` apply lands on exactly what the Guardian saw.
    const originalArguments = unwrapArguments(envelope);

    const answer = await guardian.requestDecision(envelope, { timeoutMs });
    const elapsedMs = performance.now() - startedAt;

    if (answer.decisionArrived === false) {
      return resolveByPosture(answer.failure, "delivery", envelope);
    }

    // A decision arrived, so no posture may touch this step's outcome.
    // validateDecision is the host's own last word on it -- §6.3's rewrite,
    // and any expired ask/defer outcome -- and it substitutes only
    // decisions, never failures.
    decision = validateDecision(answer.decision, { elapsedMs, originalArguments });
  } catch (failure) {
    return resolveByPosture(failure, "delivery", envelope);
  }

  // Stage "render": a decision is in hand and has been honoured in principle;
  // the only thing that can still fail is this host expressing it (a decision
  // string no hookmap entry names, or a gap in the entry that does). That is as
  // undeliverable as a timeout and gets the same posture -- but it is a
  // different incident, and auditing it as "no decision arrived" would send an
  // incident reviewer to a Guardian that answered correctly.
  try {
    return { output: renderDecision(decision, hookmap), decision, stage: "honoured" };
  } catch (failure) {
    return resolveByPosture(failure, "render", envelope);
  }
}
