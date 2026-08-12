import { readFileSync } from "node:fs";
import type { AgtVerdict } from "agt-bridge";

export type AcsDecision = {
  decision: "allow" | "deny" | "modify" | "ask" | "defer";
  reasoning?: string;
  reason_codes?: string[];
  policy_references?: { policy_id: string; policy_version?: string; rule_id: string }[];
};

type VerdictRule = {
  decision: AcsDecision["decision"];
  require_policy_references?: boolean;
};

/** A leaf of field_synthesis that copies a verdict field verbatim. */
type FieldSource = { source: string };
/** A leaf of field_synthesis that wraps a scalar verdict field into a
 * single-element array -- the only shape reason_codes' string verdict
 * field (verdict.reason) can take to satisfy ACS's `string[]`. `wrap` is
 * required here (not optional) precisely so there is no third case to
 * handle: a string source is always wrapped, never cast unsound. */
type WrappedFieldSource = { source: string; wrap: WrapMode };
type FieldLiteral = { literal: string };

/** The wrap modes this mapping can express. One member today; the point of
 * naming the set is that `applyWrap` below refuses everything outside it
 * rather than silently doing the one thing it knows. */
type WrapMode = "array";

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
  };
};

export function loadMapping(path: string): Mapping {
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Mapping;
}

/**
 * Resolves an ACS method to the AGT intervention point that answers it, from
 * mapping.yaml's `intervention_points` table -- the same table V7's
 * conformance matrix publishes.
 *
 * This exists because the table used to be a claim nobody checked: the
 * Guardian hardcoded `"pre_tool_call"` at its one call site, so the
 * declaration was documentation V7 was asked to trust while the runtime
 * ignored it (PR #10 review, Critical, twice -- once against the call site
 * and once against the table). The two could disagree without anything
 * failing. Now the runtime reads it, so a wrong row is a wrong decision,
 * which is the only kind of claim a conformance matrix can safely publish.
 *
 * The direction is deliberately method -> point, not point -> method, even
 * though the YAML is keyed the other way: the runtime is handed an ACS method
 * by the wire and needs the AGT point, and inverting a small declaration here
 * is cheaper than duplicating it in the other order.
 *
 * Every failure is a THROW, and none of them is recoverable-by-guessing.
 * Returning a default point, or falling back to `pre_tool_call`, would
 * evaluate the wrong policy and call the result a decision; that is the
 * fail-open this function is shaped to make impossible. What the Guardian
 * does with the throw is its own concern -- at this slice it becomes a
 * JSON-RPC error in the ACS-reserved range, and turning an evaluation failure
 * into an explicit ACS `deny` is N27, scoped to V3.
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
 * This exists because the declaration used to be one the runtime ignored (PR
 * #10 review, second pass): `wrap: array` was required on the type, written in
 * mapping.yaml, and published by V7's matrix as part of the table -- while
 * `mapVerdict` built `[value]` from a hardcoded literal and never looked. That
 * is the same defect class as the `pre_tool_call` hardcode `resolveInterventionPoint`
 * closed, one table row over: editing the declaration changed nothing, so the
 * mapping could claim a synthesis the code did not perform and nothing would
 * fail.
 *
 * An unrecognised mode is a THROW, and the alternative is worse than a reported
 * failure for the same reason every other failure in this module is. `loadMapping`
 * casts the parsed YAML with `as Mapping` and validates nothing, so `wrap` at
 * runtime is whatever the file says; defaulting an unknown mode to array-wrapping
 * would synthesize a `reason_codes` the mapping did not ask for and hand it to a
 * host as a decision's machine-readable half. The Guardian's evaluation catch
 * turns this into an honoured `deny` (§6.4, R1.5), which is the honest answer to
 * a mapping this code cannot carry out.
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

  return out;
}
