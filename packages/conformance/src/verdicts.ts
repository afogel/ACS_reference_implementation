/**
 * AGT verdict -> ACS decision -> AGT verdict, at every intervention point,
 * asserting the verdict that comes back is the one that went in.
 *
 * The forward leg is `mapVerdict`, the runtime's own -- so this measures what
 * the Guardian does rather than what mapping.yaml says it should. The reverse
 * leg is derived from the same declaration by `invertVerdicts` below, and
 * that is the part worth stating: an inverse written by hand here would agree
 * with mapping.yaml because the same hand wrote both, and would go on
 * agreeing after mapping.yaml changed. A round trip through two independent
 * spellings of one table is not a round trip.
 *
 * The mapping is not injective. `allow` and `warn` both become ACS `allow`,
 * discriminated by whether `policy_references` is non-empty: `warn` is allow
 * with a non-empty one. But mapVerdict synthesizes policy_references from
 * verdict.reason for any decision that carries one (map-verdict.ts,
 * unconditionally) -- not only where require_policy_references is declared.
 * A real, reason-carrying `deny` or `escalate` (policy/lib/agt_default.rego
 * synthesizes a `pattern_reason`, defaulting to "pattern_blocked", for deny)
 * therefore produces non-empty policy_references too, and that emptiness
 * means nothing there: deny and escalate are each the only AGT verdict on
 * their ACS decision, so nothing needs discriminating from anything else.
 * The inverse keys emptiness only where mapping.yaml sends more than one AGT
 * verdict to the same ACS decision -- `allow`'s group today -- and keys
 * every other decision by itself.
 *
 * `defer` has no AGT verdict behind it at all and therefore never appears
 * here: this walks AGT's five, not ACS's.
 */
import { mapVerdict, type AcsDecision, type Mapping } from "guardian";
import type { AgtVerdict } from "agt-bridge";
import { everyCell, type CoverageCell } from "./cells.ts";

/** The `warn` column's own reason. Attached to `warn` at every point with a
 * non-null acs_method (six of the eight), because the fact it states -- no
 * v0.1.0 method payload carries a field a drift score could be derived from
 * -- holds at all six, not only the request gate. */
const WARN_GUARDIAN_ONLY =
  "AGT's only stock warn gate reads input.annotations.drift_score, which reaches the policy input from a " +
  "manifest-declared annotator and never from the snapshot; no ACS v0.1.0 method payload carries a field a " +
  "drift score could be derived from, so the Guardian must originate it";

/**
 * Inverts mapping.yaml's `verdicts` table: ACS decision -> AGT verdict. Two
 * key grammars, by design and not by accident: a decision reached by exactly
 * one AGT verdict is keyed by the decision alone (e.g. `"deny"`); a decision
 * two or more verdicts share is keyed by
 * `` `${decision}|${require_policy_references === true}` `` (e.g.
 * `"allow|true"`), because only there does emptiness have anything to
 * discriminate.
 *
 * A caller looks up the bare decision first and falls back to the qualified
 * key -- `inverse.get(decision) ?? inverse.get(\`${decision}|${hasReferences}\`)`
 * -- exactly as `roundTrip` below does. This is the whole contract of the
 * returned `Map`, stated here because `invertVerdicts` is re-exported from
 * `src/index.ts` and a caller outside this file has no other place to read
 * it from.
 */
export function invertVerdicts(mapping: Mapping): Map<string, string> {
  // How many AGT verdicts land on each ACS decision. A count of one means
  // the decision alone already answers "which AGT verdict was this" --
  // emptiness has nothing to add and must not be asked to discriminate a
  // group of one, or a real, reason-carrying deny or escalate (see the file
  // comment) would misread as an inversion failure that isn't one.
  const decisionCounts = new Map<string, number>();
  for (const rule of Object.values(mapping.verdicts)) {
    decisionCounts.set(rule.decision, (decisionCounts.get(rule.decision) ?? 0) + 1);
  }

  const inverse = new Map<string, string>();
  for (const [agtVerdict, rule] of Object.entries(mapping.verdicts)) {
    const key =
      decisionCounts.get(rule.decision) === 1
        ? rule.decision
        : `${rule.decision}|${rule.require_policy_references === true}`;
    const existing = inverse.get(key);
    if (existing !== undefined) {
      // Two AGT verdicts on one ACS decision with no discriminator between
      // them: picking either would make the answer depend on YAML key order,
      // which is the same reason resolveInterventionPoint throws on an
      // ambiguous table rather than taking the first row.
      throw new Error(
        `mapping.yaml's verdicts table maps both "${existing}" and "${agtVerdict}" to ACS ` +
          `"${rule.decision}" with the same policy_references requirement, so the mapping is not invertible`,
      );
    }
    inverse.set(key, agtVerdict);
  }
  return inverse;
}

export function checkVerdicts(mapping: Mapping): CoverageCell[] {
  const inverse = invertVerdicts(mapping);
  return everyCell().map(({ point, verdict }) => ({
    point,
    verdict,
    ...roundTrip(verdict, point, mapping, inverse),
    measuredBy: ["N42"],
  }));
}

function roundTrip(
  verdict: string,
  point: string,
  mapping: Mapping,
  inverse: Map<string, string>,
): { status: CoverageCell["status"]; reason?: string } {
  // mapVerdict does not consult acs_method -- it answers "what ACS decision
  // would this AGT verdict become AT this point", which is a real question
  // for a point mapping.yaml wires to a method and a fiction for one it does
  // not. pre_model_call and post_model_call carry acs_method: null: no ACS
  // method ever resolves to either (resolveInterventionPoint has nothing to
  // return), so no verdict fired there could reach a wire consumer to
  // round-trip through. Left unguarded, mapVerdict would answer every
  // non-transform verdict at these points as if the round trip held --
  // reporting a round trip the runtime is never asked to perform -- so this
  // reads the same row the intervention-point check reads and stops before
  // asking the question.
  const row = mapping.intervention_points[point];
  if (row === undefined) {
    return {
      status: "unexpressed",
      reason: `mapping.yaml's intervention_points table has no row for AGT point "${point}"`,
    };
  }
  if (row.acs_method === null) {
    return {
      status: "unexpressed",
      reason: row.note ?? "mapping.yaml declares no ACS method for this point",
    };
  }

  // A verdict AGT would actually emit for this decision, not a stub shaped
  // by this check. The pinned bundle's stock emitters, verdict by verdict:
  //   allow      {"decision":"allow"[,"result_labels":[...]]}                    (policy/lib/ifc.rego:104)      -- no reason, no message
  //   deny       reason + message                                               (policy/lib/patterns.rego:103-107, policy/lib/ifc.rego:81-85)
  //   escalate   reason + message                                               (policy/lib/approval.rego:24-31)
  //   warn       reason + message                                               (policy/lib/drift.rego:27-31)
  //   transform  {"decision":"transform","reason":"redaction_applied","transform":{...}} (policy/lib/redact.rego:38-47) -- reason, no message
  // `allow` and `transform` are both exceptions to "every verdict gets a
  // message" -- one by omitting reason too, the other by omitting only
  // message. `message` is what field_synthesis.reasoning reads, `reason` is
  // what field_synthesis.reason_codes and .policy_references both read, and
  // `transform` is what the modifications rule reads. A probe that gave a
  // verdict a field its stock emitter does not send would measure this
  // harness's own construction instead of the table.
  const agt: AgtVerdict = {
    decision: verdict as AgtVerdict["decision"],
    ...(verdict === "allow" ? { result_labels: ["probe"] } : { reason: "conformance_probe" }),
    ...(verdict === "deny" || verdict === "escalate" || verdict === "warn" ? { message: "conformance probe" } : {}),
    ...(verdict === "transform"
      ? { transform: { path: "$policy_target", value: "probe" } }
      : {}),
  };

  let acs: AcsDecision;
  try {
    acs = mapVerdict(agt, mapping, point);
  } catch (error) {
    return { status: "unexpressed", reason: error instanceof Error ? error.message : String(error) };
  }

  const hasReferences = (acs.policy_references?.length ?? 0) > 0;
  // A decision reached by exactly one AGT verdict inverts on the decision
  // alone (see invertVerdicts); only a decision two verdicts share needs the
  // emptiness-qualified key.
  const back = inverse.get(acs.decision) ?? inverse.get(`${acs.decision}|${hasReferences}`);
  if (back !== verdict) {
    return {
      status: "unexpressed",
      reason: `AGT "${verdict}" becomes ACS "${acs.decision}", which reads back as "${back ?? "nothing"}"`,
    };
  }

  if (verdict === "warn") {
    return { status: "guardian_only", reason: WARN_GUARDIAN_ONLY };
  }
  return { status: "expressed" };
}
