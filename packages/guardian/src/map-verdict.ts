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

/** A leaf of field_synthesis: either copy a verdict field, or emit a fixed value. */
type FieldSource = { source: string; wrap?: "array" };
type FieldLiteral = { literal: string };

export type Mapping = {
  acs_version: string;
  agt_version: string;
  intervention_points: Record<string, { acs_method: string | null; note?: string }>;
  verdicts: Record<string, VerdictRule>;
  field_synthesis: {
    reasoning: FieldSource;
    reason_codes: FieldSource;
    policy_references: {
      rule_id: FieldSource;
      policy_id: FieldLiteral;
    };
  };
};

export function loadMapping(path: string): Mapping {
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Mapping;
}

/** Resolves a field_synthesis `source: "verdict.<field>"` path against a verdict. */
function readVerdictField(verdict: AgtVerdict, source: FieldSource): unknown {
  const field = source.source.slice("verdict.".length) as keyof AgtVerdict;
  return verdict[field];
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
    out.reason_codes = fs.reason_codes.wrap === "array" ? [reasonForCodes] : (reasonForCodes as unknown as string[]);
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
