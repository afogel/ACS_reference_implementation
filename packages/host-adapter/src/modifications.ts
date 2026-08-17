/**
 * §6.3's `modifications`: what makes one honourable, and what applying it
 * does to the ACS document that actually went out on the wire. Extracted from
 * validate-decision.ts's `validateDecision`, which sequences this job rather
 * than owning it.
 *
 * Which document that is belongs to the caller and never to this module:
 * the arguments a step was asked to run with at a gate that decides whether it
 * runs, the result payload it produced at a gate that sees what it produced --
 * `modificationDocumentOf` is where the choice is made. Everything here is the same
 * job either way, because a JSON pointer against a structured document does not
 * care which document it is. The parameter is still called `modificationDocument`,
 * which is the narrower of the two; the refusals it produces are worded for
 * both, because those are read by a human in an audit trail.
 *
 * A `modify` whose `modifications` cannot be applied exactly as written is a
 * DENY at the caller, never a best-effort partial apply and never a
 * reported-but-unapplied one. This module's half of that contract is to throw
 * rather than return something half-done. That covers §6.3's composition
 * rules (`modified_content` combined with structured edits, or a `redactions`
 * path overlapping a `parameter_overrides` key) and, just as load-bearing,
 * every way a target can fail to be there: a pointer that addresses no field,
 * a path or override key naming an argument the Guardian never saw, a path
 * descending through an array at anything other than one of its real
 * elements, and a prototype-reserved segment. Each of those would otherwise
 * report a successful `modify` while the original argument -- the
 * un-redacted one -- is what the host actually runs.
 *
 * This module knows ACS's `modifications` shape and the ACS document its
 * pointers address, nothing else -- no policy-runtime vocabulary, no host
 * vocabulary, and no decision vocabulary either. What an unhonourable `modifications` means for
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
 * A JSON-pointer segment addressing a real element of an array of `length`
 * items: all digits, no leading zero unless the segment is exactly "0", and
 * strictly less than `length`. RFC 6901 reserves "-" as the append token,
 * and appending is not redacting, so it is rejected here along with any
 * other non-canonical or out-of-range segment.
 *
 * This is deliberately not `Object.prototype.hasOwnProperty.call(array,
 * segment)`. That check is true for `"length"` -- arrays own that property
 * -- so a bare existence check would let a redaction target an array's
 * length instead of an element, the same class of mistake as an
 * index-shaped segment reaching a prototype property. Requiring the
 * canonical digit form excludes it along with every other non-index own or
 * inherited property (`"toString"`, etc.).
 */
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

function isArrayIndex(segment: string, length: number): boolean {
  return ARRAY_INDEX_PATTERN.test(segment) && Number(segment) < length;
}

/**
 * Walks `segments` through the ACS document that actually went out on the wire
 * and throws unless every segment names a field that is really there.
 *
 * WHICH document is the caller's to say (`modificationDocumentOf`): the arguments a
 * step was asked to run with at a gate that decides whether it runs, the result
 * payload it produced at a gate that sees what it produced. The refusal below
 * names neither, and that is deliberate rather than vague -- this text is
 * rendered as the deny's stated reason and written to the audit trail, and at the
 * result gate the sentence it used to carry ("not present in the arguments this
 * tool call sent") named a thing that does not exist at that gate for a pointer
 * that was never about one.
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
 * Descending into an array is allowed only when the segment is a real
 * index of that array (`isArrayIndex` above); every other segment into an
 * array -- past the end, non-numeric, or the RFC 6901 append token `"-"` --
 * falls through to the same "not present" rejection below as any other
 * absent target. This is what keeps `{items: ["a", "b"]}` with `/items/0`
 * from being confused with `/items/2` or `/items/length`: only a real
 * element is a target at all. Replacing an array wholesale (a
 * single-segment `/items`) is separately, and still, fine.
 */
function assertTargetExists(modificationDocument: Record<string, unknown>, segments: string[], label: string): void {
  const absent = (index: number): ModificationsInvalidError =>
    new ModificationsInvalidError(
      `${label} addresses "/${segments.slice(0, index + 1).join("/")}", which is not present in the ACS document ` +
        "these pointers address (this step's own request or result payload) -- applying it would add a field and " +
        "leave the original value in place",
    );

  let current: unknown = modificationDocument;
  for (const [index, segment] of segments.entries()) {
    if (Array.isArray(current)) {
      if (!isArrayIndex(segment, current.length)) {
        throw absent(index);
      }
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw absent(index);
    }
    current = (current as Record<string, unknown>)[segment];
  }
}

/**
 * Validates a single redaction's `path` and returns it split into segments.
 * Runs unconditionally for every redaction entry, regardless of whether
 * `parameter_overrides` is also present: a redactions-only `modifications`
 * with a missing or non-string `path` must fail here, with a clear message,
 * rather than surfacing later as a bare `TypeError` stringified into the
 * deny's `reasoning`.
 *
 * A path that survives the split as `[]` -- `""` or `"/"` -- addresses no
 * field. Applying it would report a successful `modify` while redacting
 * nothing: a policy that fired and the host did not carry out, the exact
 * fail-open shape this project exists to catch. That case fails closed here
 * too, not silently as a no-op apply.
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
 * `modificationDocument` is a parameter of this function and not only of the
 * apply step because half of what makes a `modifications` object honourable
 * is whether its targets exist in the arguments the Guardian evaluated. A
 * rule about the object alone cannot see that.
 */
export function assertValidModifications(
  modifications: unknown,
  modificationDocument: Record<string, unknown>,
): Modifications {
  if (typeof modifications !== "object" || modifications === null) {
    throw new ModificationsInvalidError(
      "modifications must be an object naming modified_content, redactions, or parameter_overrides",
    );
  }

  const mods = modifications as Modifications;

  // Container shapes first: everything below reads `.length` or
  // `Object.keys` off these, and a non-array `redactions` (`"abc"` has a
  // `.length` of 3) would otherwise reach `.map` and throw raw JS error text
  // into the deny's reasoning.
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
  // no-op: the apply step below has nowhere to put a wholesale content
  // replacement, so it would return the document untouched and still report
  // `modify`. Same shape as the empty-pointer and absent-target cases: a rewrite
  // reported as applied that was not applied. Fails closed here instead.
  //
  // The reason is not that this apply step lacks a mapping. Both documents a
  // step's modifications can address are field-addressed structures -- the
  // arguments it was asked to run with, and the outputs it produced -- and an
  // opaque replacement string is a field of neither, so there is no target for it
  // to be applied at. That is true at both gates and true independently of what
  // this module can do.
  //
  // It is also not a gap in §6.3. `modified_content` is a legal disposition shape,
  // and a step whose payload IS an opaque body -- a document, a prompt, a message
  // -- has an obvious target for it. What decides whether one exists is the shape
  // of the payload a gate governs, and both of these are structures addressed by
  // pointer.
  if (hasModifiedContent) {
    throw new ModificationsInvalidError(
      "modified_content asks for a wholesale content replacement, and neither structured ACS document a " +
        "step's modifications can address -- the arguments it was asked to run with, or the outputs it " +
        "produced -- has a field for an opaque replacement string to land in, so there is no target for it " +
        "at either gate. Applying nothing while reporting a successful modify is not available",
    );
  }

  // Every redaction's entry and path is validated here, unconditionally --
  // whether or not parameter_overrides is present.
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
  // Concretely, without this check, `{a: {b: 1, keep: "x"}}` with redactions
  // `/a` then `/a/b` would yield `{a: {b: "[REDACTED]"}}`: the first
  // redaction would be discarded, `keep` would be silently dropped from the
  // arguments the host was about to run, and the decision would still
  // render as an applied `modify`. Losing an argument is worse than not
  // redacting one, and both are worse than a deny.
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
    assertTargetExists(modificationDocument, redactionTarget, `redaction path "/${redactionTarget.join("/")}"`);
  }
  for (const key of overrideKeys) {
    assertTargetExists(modificationDocument, [key], `parameter_overrides key "${key}"`);
  }

  return mods;
}

/**
 * Returns a clone of `target` with `segments` (a JSON-pointer's already
 * split path) set to `value` at every level the path descends through.
 * Cloning every level, not just the leaf, is what keeps a depth>1 redaction
 * from mutating a nested object inside the caller's original arguments.
 *
 * `target` may be an array at any level the path descends through --
 * `assertTargetExists` has already confirmed every such segment is a real
 * index, on the same caller-dependent basis the paragraph below states
 * explicitly. The array branch below clones with `slice()` and assigns the
 * index, rather than spreading into `{...target}` as the object branch
 * does: spreading an array into an object literal is exactly the
 * `["a","b"]` → `{"0":"a","1":"b"}` rewrite this module exists to refuse,
 * so a redaction that resolves an array-shaped target must not take the
 * object branch.
 *
 * Every path reaching here has been checked against these same arguments by
 * `assertTargetExists`, and every pair of paths has been checked against each
 * other for overlap, so within one `applyModifications` call nothing should
 * reach the `{}` fallback below.
 *
 * Both of the last two claims -- every segment above is a real array index,
 * and nothing reaches the `{}` fallback -- are statements about the current
 * callers, not a guarantee about this function. If that assumption ever
 * stopped holding, the array branch's unguarded `Number(head)` is exactly
 * what would turn an unreal segment into a stray numeric-string-keyed write
 * instead of a caught error. The fallback stays because this function is
 * total by construction and a future caller must not be able to make it
 * throw; do not upgrade this note back into a guarantee without a check
 * that earns it.
 */
function setAtPath(target: unknown, segments: string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return target;
  }

  if (Array.isArray(target)) {
    const clone = target.slice();
    const index = Number(head);
    const child = clone[index];
    clone[index] = rest.length === 0 ? value : setAtPath(typeof child === "object" && child !== null ? child : {}, rest, value);
    return clone;
  }

  const clone: Record<string, unknown> = { ...(typeof target === "object" && target !== null ? (target as Record<string, unknown>) : {}) };
  if (rest.length === 0) {
    clone[head] = value;
    return clone;
  }
  const child = clone[head];
  clone[head] = setAtPath(typeof child === "object" && child !== null ? child : {}, rest, value);
  return clone;
}

/**
 * Applies §6.3's `modifications` to `modificationDocument`, returning a new
 * object -- `modificationDocument` is never mutated, since a later step
 * reuses the same argument object that went out on the wire.
 * Validates first (`assertValidModifications`, which also checks every
 * target against these same arguments); throws `ModificationsInvalidError`
 * rather than applying anything on a violation.
 *
 * `modified_content` (wholesale replacement) has no target in either structured
 * document a step's modifications can address, so validation refuses it outright
 * -- a valid `modifications` reaching the apply loops below is always the
 * structured-edit shape, with every target already known to exist.
 */
export function applyModifications(
  modificationDocument: Record<string, unknown>,
  modifications: unknown,
): Record<string, unknown> {
  const mods = assertValidModifications(modifications, modificationDocument);

  let result: Record<string, unknown> = { ...modificationDocument };

  // The top-level target is always `result` itself, never an array: the
  // line above builds `result` with an object-literal spread
  // (`{ ...modificationDocument }`), and `Array.isArray()` of that is false at
  // runtime no matter what `modificationDocument` was -- a compile-time type
  // annotation could not make this true if the runtime shape disagreed.
  // `setAtPath`'s `unknown` return is therefore always the object branch
  // here; the cast reflects that runtime fact, not a new assumption.
  if (mods.parameter_overrides) {
    for (const [key, value] of Object.entries(mods.parameter_overrides)) {
      result = setAtPath(result, [key], value) as Record<string, unknown>;
    }
  }

  if (mods.redactions) {
    for (const redaction of mods.redactions) {
      result = setAtPath(result, pointerSegments(redaction.path), redaction.replacement ?? "[REDACTED]") as Record<
        string,
        unknown
      >;
    }
  }

  return result;
}
