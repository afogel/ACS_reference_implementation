import { readFileSync } from "node:fs";
import type { AgtVerdict } from "agt-bridge";

export type AcsModifications = {
  modified_content?: string;
  redactions?: { path: string; replacement?: string }[];
  parameter_overrides?: Record<string, unknown>;
};

export type AcsDecision = {
  decision: "allow" | "deny" | "modify" | "ask" | "defer";
  reasoning?: string;
  reason_codes?: string[];
  policy_references?: { policy_id: string; policy_version?: string; rule_id: string }[];
  modifications?: AcsModifications;
};

type VerdictRule = {
  decision: AcsDecision["decision"];
  require_policy_references?: boolean;
};

/** A leaf of field_synthesis that copies a verdict field verbatim. */
type FieldSource = { source: string };
/** A leaf of field_synthesis that wraps a scalar verdict field into a
 * single-element array -- the only shape `verdict.reason` can take to satisfy
 * ACS's `string[]`. `wrap` is required, not optional, so a string source is
 * always wrapped and never cast. */
type WrappedFieldSource = { source: string; wrap: WrapMode };
type FieldLiteral = { literal: string };

/** The wrap modes this mapping can express. Named as a set so `applyWrap`
 * can refuse everything outside it. */
type WrapMode = "array";
/** The mapping's declaration of how an AGT transform becomes ACS
 * modifications. `when_path` is the only transform path this mapping can
 * express; anything else is a mapping gap and must fail loudly rather than
 * silently drop a rewrite. */
type ModificationsRule = {
  from: string;
  when_path: string;
  into: "parameter_overrides";
  policy_target_argument: string;
};

export type Mapping = {
  acs_version: string;
  agt_version: string;
  intervention_points: Record<string, { acs_method: string | null; note?: string }>;
  verdicts: Record<string, VerdictRule>;
  field_synthesis: {
    reasoning: FieldSource;
    reason_codes: WrappedFieldSource;
    policy_references: {
      rule_id: FieldSource;
      policy_id: FieldLiteral;
    };
    modifications: ModificationsRule;
  };
};

export function loadMapping(path: string): Mapping {
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Mapping;
}

/**
 * Resolves an ACS method to the AGT intervention point that answers it.
 *
 * mapping.yaml lists these the other way round: each entry is keyed by the AGT
 * intervention point and names the ACS method it answers. This searches that
 * table backwards, because a request arriving off the wire tells us its ACS
 * method, and what we need in order to evaluate it is the AGT point.
 *
 * If the table names no point for the method, or names more than one, this
 * throws rather than picking one. Falling back to a default would mean
 * evaluating the wrong policy and then returning that answer as this step's
 * decision.
 */
export function resolveInterventionPoint(acsMethod: string, mapping: Mapping): string {
  const table = mapping.intervention_points;
  if (typeof table !== "object" || table === null) {
    throw new Error(
      `mapping.yaml declares no intervention_points table, so ACS method "${acsMethod}" ` +
        `cannot be resolved to an AGT intervention point`,
    );
  }

  const points = Object.entries(table)
    .filter(([, entry]) => typeof entry === "object" && entry !== null && entry.acs_method === acsMethod)
    .map(([point]) => point);

  const [point, ...ambiguous] = points;
  if (point === undefined) {
    throw new Error(
      `mapping.yaml's intervention_points table maps no AGT intervention point to ACS method "${acsMethod}"`,
    );
  }
  if (ambiguous.length > 0) {
    // A table that answers one method with two points has no single right
    // answer, and picking the first would make the choice depend on YAML key
    // order. Loud beats arbitrary.
    throw new Error(
      `mapping.yaml's intervention_points table maps ACS method "${acsMethod}" to more than one ` +
        `AGT intervention point: ${[point, ...ambiguous].join(", ")}`,
    );
  }
  return point;
}

/** Resolves a field_synthesis `source: "verdict.<field>"` path against a verdict. */
function readVerdictField(verdict: AgtVerdict, source: { source: string }): unknown {
  const field = source.source.slice("verdict.".length) as keyof AgtVerdict;
  return verdict[field];
}

/**
 * Applies a field_synthesis leaf's declared `wrap` to the string it read.
 *
 * An unrecognised mode throws rather than falling back to array-wrapping.
 * `loadMapping` parses the YAML without validating it, so `wrap` can be
 * anything the file happens to say; wrapping it anyway would build a
 * `reason_codes` list the mapping never asked for and hand it to the host as
 * the machine-readable half of the decision. The Guardian catches the throw
 * and denies the step instead, which is the honest answer when it cannot carry
 * out the mapping it was given.
 */
function applyWrap(value: string, wrap: WrapMode, leaf: string): string[] {
  if (wrap !== "array") {
    throw new Error(
      `mapping.yaml declares field_synthesis.${leaf}.wrap as ${JSON.stringify(wrap)}, but this mapping can ` +
        `only express "array"`,
    );
  }
  return [value];
}

/**
 * R1.6 -- the $policy_target bound survives as ACS modifications.
 *
 * AGT's transform names the leaf it rewrote by the literal "$policy_target",
 * resolved against the manifest's intervention point. ACS expresses a
 * rewritten tool argument as parameter_overrides keyed by argument name, so
 * the mapping declares which argument that is and this copies the value in.
 *
 * Note what is NOT here: re-applying the substitution. The SDK already
 * returns the transformed value (verified: transformedPolicyTarget carries
 * the applied string alongside the verdict), so this moves a value rather
 * than recomputing one.
 */
function synthesizeModifications(verdict: AgtVerdict, rule: ModificationsRule): AcsModifications {
  const transform = verdict.transform;
  if (!transform || typeof transform !== "object") {
    throw new Error(
      `mapping.yaml maps this verdict to ACS "modify", which requires modifications, ` +
        `but the verdict carries no ${rule.from}`,
    );
  }
  if (transform.path !== rule.when_path) {
    throw new Error(
      `mapping.yaml can express a transform of ${JSON.stringify(rule.when_path)} only, ` +
        `but the verdict rewrote ${JSON.stringify(transform.path)}`,
    );
  }
  return { parameter_overrides: { [rule.policy_target_argument]: transform.value } };
}

export function mapVerdict(verdict: AgtVerdict, mapping: Mapping): AcsDecision {
  const rule = mapping.verdicts[verdict.decision];
  if (!rule) {
    throw new Error(`mapping.yaml has no verdict rule for AGT decision "${verdict.decision}"`);
  }

  const fs = mapping.field_synthesis;
  const out: AcsDecision = { decision: rule.decision };

  const reasoning = readVerdictField(verdict, fs.reasoning);
  if (typeof reasoning === "string") {
    out.reasoning = reasoning;
  }

  const reasonForCodes = readVerdictField(verdict, fs.reason_codes);
  if (typeof reasonForCodes === "string") {
    out.reason_codes = applyWrap(reasonForCodes, fs.reason_codes.wrap, "reason_codes");
  }

  const ruleId = readVerdictField(verdict, fs.policy_references.rule_id);
  if (typeof ruleId === "string") {
    out.policy_references = [{ policy_id: fs.policy_references.policy_id.literal, rule_id: ruleId }];
  }

  if (rule.require_policy_references && !(out.policy_references && out.policy_references.length > 0)) {
    throw new Error(
      `mapping.yaml declares require_policy_references for AGT decision "${verdict.decision}", ` +
        `but no policy_references could be synthesized (verdict.reason was empty)`,
    );
  }

  if (rule.decision === "modify") {
    out.modifications = synthesizeModifications(verdict, fs.modifications);
  }

  return out;
}
