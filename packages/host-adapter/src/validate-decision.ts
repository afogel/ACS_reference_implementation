/**
 * N7 -- validateDecision and applyModifications: the three cases §6 makes
 * mandatory for the *host* (the Observed Agent) to fail closed, plus the
 * apply step that makes a MODIFY's rewrite actually take effect.
 *
 * 1. A `modify` whose `modifications` violates §6.3's composition rules
 *    (`modified_content` combined with structured edits, or a `redactions`
 *    path overlapping a `parameter_overrides` key) cannot be honoured: the
 *    Guardian's intent is undeterminable, so this is DENY, never a
 *    best-effort partial apply.
 * 2. An expired `ask` falls back to `ask_details.timeout_disposition`,
 *    defaulting to `deny`.
 * 3. An expired `defer` falls back to `defer_details.timeout_decision`,
 *    defaulting to `deny`.
 *
 * Both timeout defaults land on `deny`, deliberately the opposite of
 * `on_decision_failure`'s default of `proceed` (§6.4, and see
 * failure-posture.ts): a Guardian that flagged a concern (ASK or DEFER) and
 * then failed to resolve it is a different failure than one that never
 * answered at all, and the two must not collapse to the same posture.
 *
 * Global Constraint 1 (binding on this whole module): no branch here may
 * alter an arriving `deny` -- switching on `decision` below, `deny` has no
 * `case` of its own, so it falls through to the untouched pass-through
 * along with every decision this module doesn't specifically validate.
 * `allow` is the same pass-through, including a warn-derived allow's
 * non-empty `policy_references` -- the only thing distinguishing it from a
 * plain allow, so nothing here may drop or rebuild it.
 *
 * R3.2: this module knows ACS's decision, modifications, ask_details, and
 * defer_details shapes, nothing else -- no policy-runtime vocabulary.
 */

/** Thrown by `applyModifications` when `modifications` violates §6.3's
 * composition rules. The Guardian's intent cannot be determined from a
 * malformed object, so the caller (`validateDecision`) turns this into a
 * DENY rather than applying anything partially. */
export class ModificationsInvalidError extends Error {
  constructor(reason: string) {
    super(`modifications violates §6.3: ${reason}`);
    this.name = "ModificationsInvalidError";
  }
}

/** §6.3's structured-edit shape: one JSON pointer per redaction, an
 * optional replacement defaulting to "[REDACTED]" below. */
type Redaction = { path: string; replacement?: string };

/** §6.3's `modifications` object, loose on `parameter_overrides`' value
 * shape -- this module never inspects what an override replaces a field
 * with, only which field it targets. */
type Modifications = {
  modified_content?: string;
  redactions?: Redaction[];
  parameter_overrides?: Record<string, unknown>;
};

/**
 * Splits a JSON pointer (`/env/TOKEN`) into its segments (`["env",
 * "TOKEN"]`). `parameter_overrides` keys are already single top-level
 * segments (argument names, not pointers), so they need no such split --
 * comparing them requires wrapping in a one-element array instead.
 *
 * No escape handling for `~0`/`~1`: §6.3's paths this module ever sees are
 * plain argument/field names, and the brief's own fixtures use none.
 */
function pointerSegments(pointer: string): string[] {
  return pointer.split("/").filter((segment) => segment !== "");
}

/**
 * True when `a` and `b` are the same target, or one is an ancestor of the
 * other -- i.e. one segment list is a prefix of the other. This single
 * check covers all three overlap kinds §6.3 forbids: exact equality (both
 * prefixes of each other, being equal-length), ancestor (`a` a prefix of
 * `b`), and descendant (`b` a prefix of `a`).
 */
function segmentsOverlap(a: string[], b: string[]): boolean {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((segment, index) => segment === longer[index]);
}

/**
 * Validates a single redaction's `path` and returns it split into segments.
 * Runs unconditionally for every redaction entry -- fix round 1, item 5:
 * this used to run only inside the overlap loop below, which only executes
 * when `parameter_overrides` is also present, so a redactions-only
 * `modifications` with a missing or non-string `path` passed validation
 * here and only blew up later, inside `applyModifications`'s apply loop,
 * as a bare `TypeError` stringified into the deny's `reasoning`. Still
 * fail-closed, but an unusable audit message and an asymmetric validation
 * path -- both fixed by validating every redaction the same way regardless
 * of what else is present.
 *
 * A path that survives the split as `[]` -- `""` or `"/"` -- addresses no
 * field. Applying it would report a successful `modify` while redacting
 * nothing: a policy that fired and the host did not carry out, the exact
 * fail-open shape this project exists to catch (fix round 1, item 4). That
 * case fails closed here too, not silently as a no-op apply.
 */
function assertValidRedactionPath(path: unknown): string[] {
  if (typeof path !== "string") {
    throw new ModificationsInvalidError(`redaction path must be a string JSON pointer, got ${JSON.stringify(path)}`);
  }
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    throw new ModificationsInvalidError(`redaction path ${JSON.stringify(path)} addresses no field`);
  }
  return segments;
}

/**
 * §6.3's mandatory rules, checked in full before anything is applied.
 * Throws `ModificationsInvalidError` on the first violation found; never
 * partially validates. Returns the validated object (narrowed from
 * `unknown`) so the caller doesn't re-derive what was just checked.
 *
 * A `modify` decision carrying no `modifications` at all, or a
 * `modifications` that names none of the three recognized fields, is
 * treated the same as one that violates the composition rules: it has
 * nothing this module can apply, so the Guardian's intent is exactly as
 * undeterminable as it is for a combination §6.3 forbids outright.
 */
function assertValidModifications(modifications: unknown): Modifications {
  if (typeof modifications !== "object" || modifications === null) {
    throw new ModificationsInvalidError(
      "modifications must be an object naming modified_content, redactions, or parameter_overrides",
    );
  }

  const mods = modifications as Modifications;
  const hasModifiedContent = mods.modified_content !== undefined;
  const hasRedactions = (mods.redactions?.length ?? 0) > 0;
  const hasOverrides = Object.keys(mods.parameter_overrides ?? {}).length > 0;

  if (!hasModifiedContent && !hasRedactions && !hasOverrides) {
    throw new ModificationsInvalidError(
      "modifications names neither modified_content, redactions, nor parameter_overrides",
    );
  }

  if (hasModifiedContent && (hasRedactions || hasOverrides)) {
    throw new ModificationsInvalidError(
      "modified_content is exclusive and MUST NOT be combined with redactions or parameter_overrides",
    );
  }

  // Every redaction's path is validated here, unconditionally -- whether or
  // not parameter_overrides is present (item 5 above).
  const redactionTargets = hasRedactions
    ? (mods.redactions ?? []).map((redaction) => assertValidRedactionPath(redaction.path))
    : [];

  if (!hasRedactions || !hasOverrides) {
    return mods;
  }

  const overrideTargets = Object.keys(mods.parameter_overrides ?? {}).map((key) => [key]);

  for (const redactionTarget of redactionTargets) {
    for (const overrideTarget of overrideTargets) {
      if (segmentsOverlap(redactionTarget, overrideTarget)) {
        throw new ModificationsInvalidError(
          `redaction path "/${redactionTarget.join("/")}" and parameter_overrides key "${overrideTarget[0]}" ` +
            "are not disjoint (equal, ancestor, or descendant)",
        );
      }
    }
  }

  return mods;
}

/**
 * Returns a clone of `target` with `segments` (a JSON-pointer's already
 * split path) set to `value` at every level the path descends through.
 * Cloning every level, not just the leaf, is what keeps a depth>1 redaction
 * from mutating a nested object inside the caller's original arguments
 * (Global Constraint 4).
 */
function setAtPath(target: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return target;
  }
  const clone = { ...target };
  if (rest.length === 0) {
    clone[head] = value;
    return clone;
  }
  const child = clone[head];
  clone[head] = setAtPath(typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {}, rest, value);
  return clone;
}

/**
 * Applies §6.3's `modifications` to `originalArguments`, returning a new
 * object -- `originalArguments` is never mutated (Global Constraint 4: a
 * later step reuses the same argument object that went out on the wire).
 * Validates first (`assertValidModifications`); throws
 * `ModificationsInvalidError` rather than applying anything on a violation.
 *
 * `modified_content` (wholesale replacement) has no defined mapping onto an
 * arguments object in this slice -- §6.3 makes it exclusive of
 * `redactions`/`parameter_overrides` by construction, so a valid
 * `modifications` here is always the structured-edit shape.
 */
export function applyModifications(
  originalArguments: Record<string, unknown>,
  modifications: unknown,
): Record<string, unknown> {
  const mods = assertValidModifications(modifications);

  let result: Record<string, unknown> = { ...originalArguments };

  if (mods.parameter_overrides) {
    for (const [key, value] of Object.entries(mods.parameter_overrides)) {
      result = setAtPath(result, [key], value);
    }
  }

  if (mods.redactions) {
    for (const redaction of mods.redactions) {
      result = setAtPath(result, pointerSegments(redaction.path), redaction.replacement ?? "[REDACTED]");
    }
  }

  return result;
}

/** The decision-result shape this module reads. Loose, matching
 * render-decision.ts's own `AcsDecisionResult`: only `decision` is
 * required. */
type DecisionInput = { decision: string } & Record<string, unknown>;

export type ValidateDecisionContext = {
  /** Wall-clock time elapsed since this decision was requested, in
   * milliseconds. Compared against `ask_details.timeout_seconds` (seconds,
   * converted) and `defer_details.resolution_timeout_ms` (already
   * milliseconds) -- the two fields use different units, and getting that
   * conversion wrong would make an expiry test pass for the wrong reason. */
  elapsedMs: number;
  /** The tool-call arguments a `modify` decision's `modifications` apply
   * against. Unused by every other decision. */
  originalArguments: Record<string, unknown>;
};

export type ValidatedDecision = DecisionInput & { applied_input?: Record<string, unknown> };

/**
 * Denies with `reason_codes` set to exactly `[code]` -- every fail-closed
 * substitution in this module reports one specific reason, never a general
 * one, so an audit reader can tell the three mandatory cases apart.
 */
function deny(reasoning: string, code: string): ValidatedDecision {
  return { decision: "deny", reasoning, reason_codes: [code] };
}

/**
 * Validates and, where required, substitutes `decision` per R1.8's three
 * mandatory fail-closed cases. `context.elapsedMs` is compared against
 * `>` (strictly greater than) the timeout, not `>=`: a decision that
 * resolves in exactly the negotiated window has not expired, and the
 * boundary belongs to the decision that arrived, not to expiry.
 *
 * `deny` and every decision besides `modify`/`ask`/`defer` fall through to
 * the pass-through branch untouched (Global Constraint 1, 2).
 */
export function validateDecision(decision: DecisionInput, context: ValidateDecisionContext): ValidatedDecision {
  const { elapsedMs, originalArguments } = context;

  switch (decision.decision) {
    case "modify": {
      try {
        const applied_input = applyModifications(originalArguments, decision.modifications);
        return { ...decision, applied_input };
      } catch (error) {
        const reason = error instanceof ModificationsInvalidError ? error.message : String(error);
        return deny(`guardian's modifications could not be applied: ${reason}`, "modifications_invalid");
      }
    }

    case "ask": {
      const askDetails = decision.ask_details;
      if (
        typeof askDetails !== "object" ||
        askDetails === null ||
        typeof (askDetails as Record<string, unknown>).timeout_seconds !== "number"
      ) {
        return deny("ask decision is missing valid ask_details (approver, question, timeout_seconds)", "ask_details_invalid");
      }
      const details = askDetails as Record<string, unknown>;
      const timeoutMs = (details.timeout_seconds as number) * 1000;
      if (elapsedMs > timeoutMs) {
        const disposition = details.timeout_disposition === "allow" ? "allow" : "deny";
        return {
          decision: disposition,
          reasoning: `ask expired after ${elapsedMs}ms (timeout ${timeoutMs}ms); falling back to timeout_disposition=${disposition}`,
          reason_codes: ["ask_expired"],
        };
      }
      return decision;
    }

    case "defer": {
      const deferDetails = decision.defer_details;
      if (
        typeof deferDetails !== "object" ||
        deferDetails === null ||
        typeof (deferDetails as Record<string, unknown>).resolution_timeout_ms !== "number"
      ) {
        return deny(
          "defer decision is missing valid defer_details (reason, resolution_method, resolution_timeout_ms)",
          "defer_details_invalid",
        );
      }
      const details = deferDetails as Record<string, unknown>;
      const timeoutMs = details.resolution_timeout_ms as number;
      if (elapsedMs > timeoutMs) {
        const timeoutDecision = details.timeout_decision === "ask" ? "ask" : "deny";
        return {
          decision: timeoutDecision,
          reasoning: `defer expired after ${elapsedMs}ms (timeout ${timeoutMs}ms); falling back to timeout_decision=${timeoutDecision}`,
          reason_codes: ["defer_expired"],
        };
      }
      return decision;
    }

    default:
      return decision;
  }
}
