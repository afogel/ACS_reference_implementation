/**
 * §6.3's `modifications`: what makes one honourable, and what applying it
 * does to the arguments that actually went out on the wire. Extracted from
 * validate-decision.ts (N7), which now sequences this job rather than owning
 * it.
 *
 * A `modify` whose `modifications` cannot be applied exactly as written is a
 * DENY at the caller, never a best-effort partial apply and never a
 * reported-but-unapplied one. This module's half of that contract is to throw
 * rather than return something half-done. That covers §6.3's composition
 * rules (`modified_content` combined with structured edits, or a `redactions`
 * path overlapping a `parameter_overrides` key) and, just as load-bearing,
 * every way a target can fail to be there: a pointer that addresses no field,
 * a path or override key naming an argument the Guardian never saw, a path
 * descending through an array, and a prototype-reserved segment. Each of
 * those would otherwise report a successful `modify` while the original
 * argument -- the un-redacted one -- is what the host actually runs.
 *
 * R3.2: this module knows ACS's `modifications` shape and a tool call's
 * arguments object, nothing else -- no policy-runtime vocabulary, and no
 * decision vocabulary either. What an unhonourable `modifications` means for
 * the *decision* is validate-decision.ts's sentence to say, which is why
 * nothing here returns a decision or names one.
 */

/** Thrown by `applyModifications` when `modifications` cannot be honoured
 * exactly as the Guardian specified it -- a violation of §6.3's composition
 * rules, an entry of the wrong shape, or a target that is not in the
 * arguments the Guardian saw. In every case the Guardian's intent cannot be
 * carried out as written, so the caller (`validateDecision`) turns this into
 * a DENY rather than applying part of it, or applying nothing while
 * reporting success. */
export class ModificationsInvalidError extends Error {
  constructor(reason: string) {
    super(`modifications cannot be honoured as specified (§6.3): ${reason}`);
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
 * Path segments that address a JavaScript object's prototype machinery
 * rather than a tool-call argument. No global pollution is reachable today
 * -- `setAtPath` assigns into a fresh clone of the caller's arguments, never
 * into a shared prototype -- but none of these three names a field a tool
 * call actually has, so a modification aiming at one is another silent
 * no-op `modify`, and the guard is one line.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function assertNoReservedSegments(segments: string[], label: string): void {
  for (const segment of segments) {
    if (RESERVED_SEGMENTS.has(segment)) {
      throw new ModificationsInvalidError(
        `${label} names the reserved segment "${segment}", which addresses no tool-call argument`,
      );
    }
  }
}

/**
 * Walks `segments` through the arguments that actually went out on the wire
 * and throws unless every segment names a field that is really there.
 *
 * This is the absent-target half of the same defect the empty-pointer check
 * below closes, and it is the one that mattered in practice: `setAtPath` has
 * no existence check, so an absent target was *created* rather than
 * rejected. The decision stayed `modify`, the host rendered
 * `permissionDecision: allow` with an `updatedInput` carrying both the
 * invented field and the untouched original, and the original -- the
 * unredacted secret -- is what ran. A rewrite reported as applied and not
 * applied is the exact fail-open shape this project exists to catch, and
 * §6.3 is explicit that an Observed Agent which cannot determine the
 * Guardian's intent MUST fail closed.
 *
 * Descending into an array is rejected for the same reason rather than a
 * different one: `{items: ["a", "b"]}` with `/items/0` would silently
 * rewrite the array as the object `{"0": "[REDACTED]", "1": "b"}`, which is
 * not the edit that was asked for. Replacing an array wholesale (a
 * single-segment `/items`) is still fine -- only descending *through* one
 * is refused.
 */
function assertTargetExists(originalArguments: Record<string, unknown>, segments: string[], label: string): void {
  let current: unknown = originalArguments;
  for (const [index, segment] of segments.entries()) {
    if (Array.isArray(current)) {
      throw new ModificationsInvalidError(
        `${label} descends through the array at "/${segments.slice(0, index).join("/")}", ` +
          "which would rewrite that array as an object rather than edit it",
      );
    }
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new ModificationsInvalidError(
        `${label} addresses "/${segments.slice(0, index + 1).join("/")}", which is not present in the arguments ` +
          "this tool call sent -- applying it would add a field and leave the original value in place",
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }
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
  assertNoReservedSegments(segments, `redaction path ${JSON.stringify(path)}`);
  return segments;
}

/**
 * Validates one `redactions` entry before anything reads `.path` off it.
 *
 * Without this, `redactions: [null]` threw a raw `TypeError` from the
 * property access and `redactions: "abc"` threw
 * `"(mods.redactions ?? []).map is not a function"` -- both fail closed, so
 * neither was a bypass, but the JS error text is what landed in the deny's
 * `reasoning` and therefore in the audit trail a human reads. A deny is only
 * as useful as its stated reason.
 */
function assertValidRedactionEntry(entry: unknown): Redaction {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ModificationsInvalidError(
      `each redactions entry must be an object with a string "path", got ${JSON.stringify(entry)}`,
    );
  }
  return entry as Redaction;
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
 *
 * `originalArguments` is a parameter of this function and not only of the
 * apply step because half of what makes a `modifications` object honourable
 * is whether its targets exist in the arguments the Guardian evaluated. A
 * rule about the object alone cannot see that.
 */
export function assertValidModifications(
  modifications: unknown,
  originalArguments: Record<string, unknown>,
): Modifications {
  if (typeof modifications !== "object" || modifications === null) {
    throw new ModificationsInvalidError(
      "modifications must be an object naming modified_content, redactions, or parameter_overrides",
    );
  }

  const mods = modifications as Modifications;

  // Container shapes first: everything below reads `.length` or
  // `Object.keys` off these, and a non-array `redactions` (`"abc"` has a
  // `.length` of 3) used to reach `.map` and throw raw JS error text into
  // the deny's reasoning.
  if (mods.redactions !== undefined && !Array.isArray(mods.redactions)) {
    throw new ModificationsInvalidError(
      `redactions must be an array of {path, replacement?} objects, got ${JSON.stringify(mods.redactions)}`,
    );
  }
  if (
    mods.parameter_overrides !== undefined &&
    (typeof mods.parameter_overrides !== "object" ||
      mods.parameter_overrides === null ||
      Array.isArray(mods.parameter_overrides))
  ) {
    throw new ModificationsInvalidError(
      `parameter_overrides must be an object keyed by argument name, got ${JSON.stringify(mods.parameter_overrides)}`,
    );
  }

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

  // `modified_content` alone is not a partial apply -- it is a *complete*
  // no-op: the apply step below has no defined mapping from a wholesale
  // content replacement onto a tool-call arguments object, so it would
  // return the arguments untouched and still report `modify`. Same shape as
  // the empty-pointer and absent-target cases: a rewrite reported as
  // applied that was not applied. Fails closed here instead.
  if (hasModifiedContent) {
    throw new ModificationsInvalidError(
      "modified_content asks for a wholesale content replacement, which has no defined mapping onto this tool " +
        "call's arguments object -- applying nothing while reporting a successful modify is not available",
    );
  }

  // Every redaction's entry and path is validated here, unconditionally --
  // whether or not parameter_overrides is present (item 5 above).
  const redactionTargets = (mods.redactions ?? []).map((redaction) =>
    assertValidRedactionPath(assertValidRedactionEntry(redaction).path),
  );

  const overrideKeys = Object.keys(mods.parameter_overrides ?? {});
  for (const key of overrideKeys) {
    assertNoReservedSegments([key], `parameter_overrides key "${key}"`);
  }

  if (hasRedactions && hasOverrides) {
    for (const redactionTarget of redactionTargets) {
      for (const key of overrideKeys) {
        if (segmentsOverlap(redactionTarget, [key])) {
          throw new ModificationsInvalidError(
            `redaction path "/${redactionTarget.join("/")}" and parameter_overrides key "${key}" ` +
              "are not disjoint (equal, ancestor, or descendant)",
          );
        }
      }
    }
  }

  // Two redactions must be disjoint from EACH OTHER as well. §6.3 spells out
  // only the redaction-vs-override rule, but the reason it gives -- that
  // overlapping edits have no apply order the Guardian can observe -- applies
  // identically here, and the consequence of not checking is the same
  // reported-as-applied partial rewrite the existence check above rejects.
  //
  // Concretely, before this check `{a: {b: 1, keep: "x"}}` with redactions
  // `/a` then `/a/b` yielded `{a: {b: "[REDACTED]"}}`: the first redaction
  // was discarded, `keep` was silently dropped from the arguments the host
  // was about to run, and the decision still rendered as an applied `modify`.
  // Losing an argument is worse than not redacting one, and both are worse
  // than a deny.
  for (let i = 0; i < redactionTargets.length; i += 1) {
    for (let j = i + 1; j < redactionTargets.length; j += 1) {
      const [first, second] = [redactionTargets[i] as string[], redactionTargets[j] as string[]];
      if (segmentsOverlap(first, second)) {
        throw new ModificationsInvalidError(
          `redaction paths "/${first.join("/")}" and "/${second.join("/")}" ` +
            "are not disjoint (equal, ancestor, or descendant)",
        );
      }
    }
  }

  // Last, because it is the only rule that needs the wire's own arguments:
  // every target must already be there. See assertTargetExists.
  for (const redactionTarget of redactionTargets) {
    assertTargetExists(originalArguments, redactionTarget, `redaction path "/${redactionTarget.join("/")}"`);
  }
  for (const key of overrideKeys) {
    assertTargetExists(originalArguments, [key], `parameter_overrides key "${key}"`);
  }

  return mods;
}

/**
 * Returns a clone of `target` with `segments` (a JSON-pointer's already
 * split path) set to `value` at every level the path descends through.
 * Cloning every level, not just the leaf, is what keeps a depth>1 redaction
 * from mutating a nested object inside the caller's original arguments
 * (Global Constraint 4).
 *
 * Every path reaching here has been checked against these same arguments by
 * `assertTargetExists`, and every pair of paths has been checked against each
 * other for overlap, so within one `applyModifications` call nothing should
 * reach the `{}` fallback below.
 *
 * That is a statement about the current callers, NOT a guarantee about this
 * function. An earlier version of this comment claimed the fallback was
 * unreachable while two overlapping redaction paths reached it and produced a
 * partial rewrite reported as applied -- the exact shape this module exists
 * to reject. The fallback stays because this function is total by
 * construction and a future caller must not be able to make it throw; do not
 * upgrade this note back into a guarantee without a check that earns it.
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
 * Validates first (`assertValidModifications`, which also checks every
 * target against these same arguments); throws `ModificationsInvalidError`
 * rather than applying anything on a violation.
 *
 * `modified_content` (wholesale replacement) has no defined mapping onto an
 * arguments object in this slice, so validation refuses it outright -- a
 * valid `modifications` reaching the apply loops below is always the
 * structured-edit shape, with every target already known to exist.
 */
export function applyModifications(
  originalArguments: Record<string, unknown>,
  modifications: unknown,
): Record<string, unknown> {
  const mods = assertValidModifications(modifications, originalArguments);

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
