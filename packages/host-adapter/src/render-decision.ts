/**
 * renderDecision (N3) turns an ACS decision result into Claude Code's
 * `hookSpecificOutput`, driven entirely by the hookmap's `decisions` block
 * (S1) -- never by a hardcoded decision -> output dispatch table in this
 * module. Which host output field a decision maps to, and which decision
 * field (if any) feeds a human-readable reason or an updated-input payload,
 * are both read off `hookmap.decisions[decision]`; changing the YAML
 * changes the render with no code change here.
 *
 * The single load-bearing behaviour: a `deny` decision's `reasoning`
 * string must land in `permissionDecisionReason` -- that's what a human
 * reads in the Claude Code transcript, and it's the entire payoff of the
 * slice's demo. This module gets there generically: `deny`'s hookmap entry
 * names `reason_from: reasoning`, and renderDecision copies whatever field
 * that names -- it never assumes "reasoning" is the field in code.
 *
 * R3.2: this module knows ACS decisions and Claude Code's hookSpecificOutput
 * shape, nothing else. No policy-runtime vocabulary appears here -- an
 * observe-only upstream signal has already become an ACS `allow` (with
 * policy_references) by the time a decision result reaches this module,
 * and it renders as a plain allow like any other, per R1.2: there is no
 * separate rendering path for it to invent.
 */
import type { Hookmap } from "./build-envelope.ts";

/** One decision's hookmap-declared rendering rule (S1's `decisions.<decision>` entry). */
type DecisionRenderRule = {
  permissionDecision: string;
  reason_from?: string;
  updatedInput_from?: string;
};

/**
 * The ACS decision-result shape renderDecision reads from. Deliberately
 * loose: only `decision` is required, because everything else this module
 * touches is named by the hookmap (`reason_from`, `updatedInput_from`), not
 * assumed to exist under a fixed key.
 */
export type AcsDecisionResult = { decision: string } & Record<string, unknown>;

export type HookSpecificOutput = { hookEventName: string; permissionDecision: string } & Record<string, unknown>;

/**
 * Renders `decisionResult` per `hookmap.decisions[decisionResult.decision]`.
 * `hookEventName` is the raw host hook name that produced the original
 * request (e.g. "PreToolUse", the same string passed to buildEnvelope),
 * carried through unchanged into the shape Claude Code expects.
 *
 * Throws if the hookmap has no `decisions` block, or no entry for this
 * decision -- there is no default rendering and no partial output.
 */
export function renderDecision(
  hookEventName: string,
  decisionResult: AcsDecisionResult,
  hookmap: Hookmap,
): { hookSpecificOutput: HookSpecificOutput } {
  const rules = hookmap.decisions as Record<string, DecisionRenderRule> | undefined;
  if (!rules) {
    throw new Error("renderDecision: hookmap has no decisions block");
  }

  const rule = rules[decisionResult.decision];
  if (!rule) {
    throw new Error(`renderDecision: hookmap has no decisions entry for ACS decision "${decisionResult.decision}"`);
  }

  const hookSpecificOutput: HookSpecificOutput = {
    hookEventName,
    permissionDecision: rule.permissionDecision,
  };

  if (rule.reason_from) {
    const reason = decisionResult[rule.reason_from];
    if (typeof reason === "string") {
      hookSpecificOutput.permissionDecisionReason = reason;
    }
  }

  if (rule.updatedInput_from) {
    const updatedInput = decisionResult[rule.updatedInput_from];
    if (updatedInput !== undefined) {
      hookSpecificOutput.updatedInput = updatedInput;
    }
  }

  return { hookSpecificOutput };
}
