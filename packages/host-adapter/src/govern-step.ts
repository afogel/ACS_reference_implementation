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
 * This is the one place the following properties are guaranteed. Each guards
 * against the same shape of fail-open -- something throws, silently no-ops, or
 * emits an output the host does not recognise, so the tool call runs
 * ungoverned and unaudited -- and each has a test that fails if it reopens:
 *
 *   - A decision that arrived always outranks a posture. A response carrying
 *     both an `error` and a `result` that names a decision means a decision
 *     arrived. `GuardianClient.requestDecision` is the one place that
 *     judgement is made, and it is made before any posture is consulted.
 *   - An evaluation failure and a delivery failure never merge. A `deny` the
 *     policy runtime produced -- including one it produced because its own
 *     evaluation failed -- is a decision, and travels the decision path. A
 *     silent Guardian or a dead transport is a delivery failure, and gets
 *     §6.4's negotiated `on_decision_failure`. Conflating them either breaks
 *     the policy layer's fail-closed invariant or halts production on a
 *     network blip.
 *   - An error carrying no decision is one or the other, and which one is not
 *     this function's call. A code meaning the Guardian was alive and refused
 *     the envelope fails closed regardless of posture; any other error is the
 *     wire's business and gets the posture. `applyFailurePosture` makes that
 *     distinction (see failure-kinds.ts), and every path here reaches it,
 *     which is why nothing here has to know the difference.
 *   - Every step that proceeds without a decision is audited (§6.4 MUST), and a
 *     `proceed` that could not be audited is downgraded to `deny`. That is
 *     `applyFailurePosture`'s job, and every path here that has no decision
 *     goes through it -- there is no route to an output that skips it.
 *   - The audit entry names the right incident. "No request was ever built",
 *     "a request went out and nothing came back", and "a decision arrived and
 *     this host could not express it" are three different incidents, filed
 *     under three `FailureStage`s. They are told apart by where in this
 *     function the failure was caught, not by re-reading flags after the fact:
 *     each stage has its own `try`, and each `catch` knows its own stage
 *     because that is the only stage it can be reached from.
 *   - There are exactly two ways out: a `GovernedStep`, or a throw. A throw
 *     means this hookmap does not map the hook that fired (see the guard at the
 *     top of `governStep`), that it maps a result gate whose named output no
 *     replacement can be built for (see `assertOutputIsReplaceable`, asked
 *     before any decision is sought), or that the fallback render of a posture
 *     decision itself failed, which `loadHookmap` makes unreachable for a hook
 *     it does map (see `resolveByPosture` below) -- and all three are left as
 *     throws rather than repaired, because half an output is the one thing a
 *     governance hook must never write. The middle one is closed by ordering:
 *     asked any later it arrives with a decision in hand, and the posture
 *     answers a question the decision had already answered.
 *
 * This module knows ACS and hookmaps, and nothing else: no policy-runtime
 * vocabulary, and no host vocabulary -- it never names a field of the output
 * it returns, which is what lets the same function serve a second host with a
 * different wire shape (see render-decision.ts).
 */
import { buildEnvelope, modificationDocumentOf, type AcsRequestEnvelope, type Hookmap } from "./build-envelope.ts";
import type { AuditSink } from "./audit-sink.ts";
import {
  applyFailurePosture,
  DEFAULT_TIMEOUT_MS,
  type FailureResolvedAcsDecision,
  type FailureStage,
} from "./failure-posture.ts";
import type { GuardianClient } from "./guardian-client.ts";
import type { AcsDecision, ValidatedAcsDecision } from "./decision-message.ts";
import { renderDecision, type HostOutput } from "./render-decision.ts";
import type { ResolvedSessionConfig } from "./handshake.ts";
import { assertOutputIsReplaceable, withResultOutput, type HostOutputLocation } from "./result-output.ts";
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
  // Every render below -- the arriving decision's and the posture's -- goes
  // through the hook's own decisions block, so a hook this hookmap does not map
  // has nothing to express either answer through. Checked before this step is
  // asked about or audited, because the alternative is worse than a throw:
  // letting it reach the posture would write an audit entry recording a
  // fail-open proceed, and then fail to render it -- a durable record of a
  // bypass that never happened, in the one log an incident review trusts. (The
  // session handshake has already run by the time a host shim calls this; what
  // this ordering protects is the audit log and the step call, not "nothing at
  // all".) A hookmap missing the hook that fired is a broken deployment, the
  // same class as a hookmap that will not load, and a caller answers it the same
  // way.
  //
  // `hasOwnProperty`, not a bare index: `hookEventName` is host-supplied (it
  // arrives on stdin), and `hooks["toString"]` resolves to an inherited
  // Object.prototype function, which is not `undefined`. A bare index therefore
  // passes this guard for a prototype-named event, `buildEnvelope` throws,
  // `resolveByPosture` writes `outcome: "proceeded"`, and only then does
  // `renderDecision` throw -- the exact durable-false-record outcome this guard
  // exists to prevent, reachable without touching the hookmap. Same reasoning as
  // render-decision.ts's RESERVED_SEGMENTS and acs-hook.ts's `expectationFor`.
  if (!Object.prototype.hasOwnProperty.call(hookmap.hooks ?? {}, hookEventName)) {
    throw new Error(
      `governStep: hookmap has no entry for hook "${hookEventName}", so neither an arriving decision nor a ` +
        `posture's answer to an absent one could be expressed for it`,
    );
  }

  const timeoutMs = session.config?.timeout_config.default_ms ?? DEFAULT_TIMEOUT_MS;

  // Which kind of gate this hook is, read off the entry's own shape and never
  // off the event name -- the same rule `buildPayload` states for choosing a
  // payload shape, and for the same reason: an event name is a string a hookmap
  // author types, and branching on one would make a typo in it silently select
  // the wrong behaviour. An entry declaring `outputs` is a gate that sees what a
  // step produced, so a decision there is answered by replacing that output;
  // an entry declaring `arguments` is a gate that decides whether a step runs,
  // and has no output to replace.
  //
  // `?? undefined` because a hookmap is YAML: a key written with nothing after
  // it parses to null, which is a key present and unusable, not a key absent.
  //
  // A bare index is safe here and only here: the guard above has already
  // established `hookEventName` is an own property of `hooks`, so this cannot
  // resolve to an inherited `Object.prototype` member the way the guard's own
  // lookup could have.
  const outputs = hookmap.hooks[hookEventName]?.outputs ?? undefined;
  const outputLocation: HostOutputLocation | undefined = outputs === undefined ? undefined : { payload, outputs };

  /**
   * Every render in this function, and the one thing every render at a result
   * gate has to do first: a `deny` there withholds the output, and withholding
   * it means carrying a shape-preserving replacement (`withResultOutput`).
   *
   * One function rather than three call sites, because the three denies that can
   * reach a render here arrive by different routes -- one the policy runtime
   * sent, one `validateDecision` substituted for a rewrite it could not apply,
   * one a negotiated fail-closed posture produced -- and all three are
   * withholdings. A route that
   * rendered a block without a replacement would report a withholding that never
   * happened while the original output was delivered, and it would be the same
   * defect whichever route reached it.
   */
  function render(decision: AcsDecision): HostOutput {
    return renderDecision(hookEventName, withResultOutput(decision, outputLocation), hookmap);
  }

  /**
   * `applyFailurePosture`'s answer to a failure, rendered. Every stage's catch
   * ends here and nowhere else, which is what makes "no decision without an
   * audit entry" a property of the control flow rather than of remembering to
   * write one.
   *
   * Named for the posture because that is what answers almost every failure
   * that reaches it, and the one exception is deliberately not this function's
   * business: a Guardian that refused the envelope fails closed regardless of
   * posture, decided inside `applyFailurePosture`, so nothing here branches on
   * it and nothing here can forget to.
   *
   * The rendering here cannot fail: `loadHookmap` does not merely check that
   * `allow` and `deny` are present in every hook's `decisions` block, it
   * shape-checks every entry it accepts (`assertRenderableDecisions`), and
   * `applyFailurePosture` never returns any decision but those two -- and the
   * guard at the top of `governStep` has already established that this hook has
   * a block at all. So this cannot recurse into itself, and a throw escaping it
   * means the hookmap bypassed the loader -- which is the caller's problem to
   * fail loudly on, not something to paper over.
   *
   * There is one way this can throw beyond the rendering itself: a negotiated
   * fail-closed `deny` at a result gate has to withhold the output, and building
   * the replacement that withholds it can fail (see `replacingOutput`). Exactly
   * one route reaches that, and it is the one route where a posture is consulted
   * before `assertOutputIsReplaceable` has run: a stage-"request" failure, i.e. a
   * payload that does not carry what this hook's `outputs` block describes at
   * all. That is a posture deny this host cannot carry out, and the honest
   * answers are a loud stop or a block that withholds nothing while claiming to.
   * It throws, and the caller turns that into a blocking stop. Every other route
   * -- a leaf that is present and is not prose above all -- is refused before a
   * decision is sought rather than answered here, because there it would be
   * answering with a posture something a decision had already answered.
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
    return { output: render(decision), decision, stage };
  }

  const startedAt = performance.now();

  // Stage "request": nothing has been asked of anything yet. A payload the
  // hookmap's paths do not resolve against, or an entry naming no single payload
  // shape, is a host-side configuration fault -- so the audit reasoning must not
  // blame a Guardian that was never contacted, which is what this stage records.
  //
  // A hookmap with no entry for this event never reaches this stage: the guard
  // at the top of this function throws on it and audits nothing, because the
  // posture's answer to it could not be rendered either. Every other way
  // `buildEnvelope` can fail still lands here.
  let envelope: AcsRequestEnvelope;
  try {
    envelope = buildEnvelope(hookEventName, payload, hookmap);
  } catch (failure) {
    return resolveByPosture(failure, "request", undefined);
  }

  // Between the two stages, and deliberately in neither: at a gate that sees
  // what a step produced, a decision has to be able to replace that output,
  // and this is where that is established -- once, before anything is asked
  // of a Guardian and before anything is audited.
  //
  // This ordering is what closes a fail-open: building the replacement is
  // what a `deny` at a result gate withholds with (see `withResultOutput`),
  // and it can fail -- a payload whose named leaf is not prose is a leaf no
  // replacement can be expressed for at all. Asked at the render instead,
  // that failure would arrive with a decision already in hand and land in
  // the render stage's catch, so the deployment's delivery posture would
  // answer it: under `proceed` the full unredacted output would be
  // delivered, the Guardian's `deny` dropped, and the audit entry would say
  // the decision "was honoured" -- both "a decision that arrived always
  // outranks a posture" and "where it cannot express the edit in the host's
  // shape it fails closed" made false on that one route. Asked here there is
  // no decision to drop and no record to falsify: the hookmap either can
  // express a withholding for this payload or this deployment stops.
  //
  // A throw rather than a posture, for the same reason the guard at the top
  // of this function is one: a hookmap whose declared output this host
  // cannot replace is a broken deployment, the same class as a hookmap that
  // will not load, and a caller answers it the same way -- a loud, blocking
  // stop. What stays with the posture is the other failure: `buildEnvelope`
  // failing above means the payload does not carry what this hook's
  // `outputs` block describes, which a host may cause legitimately by firing
  // one hook for several tools, so it remains the deployment's own
  // negotiated question.
  //
  // What separates them is what each failure leaves this gate able to do,
  // not whose fault it is -- a non-prose leaf is not a permanent property of
  // the tool's own output shape, since for a hook mapped to several tools it
  // is a property of only one of them, and this refusal then blocks that
  // tool's calls rather than the deployment's configuration. A payload with
  // no such leaf leaves the gate with no ACS request either -- nothing was
  // asked, so there is a posture's question to answer and answering it drops
  // no decision. A leaf that is present and unpatchable leaves the gate able
  // to ask and unable to act on any answer it gets, and no posture makes it
  // patchable: the only choices there are stopping before asking, or asking
  // and dropping what comes back. It stops. Over-blocking on the safe side,
  // deliberately -- including for a decision that would have been an `allow`
  // -- because the alternative is a policy decision arriving and being
  // discarded.
  if (outputLocation !== undefined) {
    try {
      assertOutputIsReplaceable(outputLocation);
    } catch (failure) {
      throw new Error(
        `governStep: hook "${hookEventName}" is a gate whose output an arriving decision has to be able to ` +
          `replace, and no replacement can be built for the output its hookmap entry names: ` +
          `${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  // Stage "delivery": a request exists and no decision is in hand yet. §6.4's
  // own case, and everything between those two points belongs to it -- the
  // round trip, and the host's last word on what came back. `requestDecision`
  // never throws, so the `if` below (not a catch) is the delivery failure this
  // stage exists for; the `try` covers the rest, which cannot throw today and
  // would still be a request that produced no decision if it ever did.
  let decision: ValidatedAcsDecision;
  try {
    // The same document that just went out on the wire -- so a `modify`
    // decision's §6.3 pointers apply against exactly the structure the Guardian
    // saw and addressed. At a gate that decides whether a step runs that is the
    // arguments bag, unwrapped from ACS's `{value, provenance?}` shape; at a gate
    // that sees what a step produced it is the result payload, because that is
    // what a result-gate pointer names (`/outputs/0/value` addresses no argument,
    // and there are no arguments at that step). `modificationDocumentOf` reads which
    // from the envelope it just built.
    const modificationDocument = modificationDocumentOf(envelope);

    const answer = await guardian.requestDecision(envelope, { timeoutMs });
    const elapsedMs = performance.now() - startedAt;

    if (answer.decisionArrived === false) {
      return resolveByPosture(answer.failure, "delivery", envelope);
    }

    // A decision arrived, so no posture may touch this step's outcome.
    // `validateDecision` is the host's own last word on it -- §6.3's
    // rewrite, and any expired ask/defer outcome -- and it substitutes only
    // decisions, never failures.
    decision = validateDecision(answer.decision, { elapsedMs, modificationDocument, outputLocation });
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
    return { output: render(decision), decision, stage: "honoured" };
  } catch (failure) {
    return resolveByPosture(failure, "render", envelope);
  }
}
