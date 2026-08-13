/**
 * The three JavaScript prototype-machinery names this codebase refuses
 * wherever a hookmap path, a rendered output path, or a rendered value's own
 * key could name one instead of a real field -- and the one place that list,
 * and the walker that checks a VALUE against it, are now defined.
 *
 * BEFORE THIS FILE, EACH OF THESE KEPT ITS OWN COPY OF THE NAME LIST, because
 * the package kept every one of them module-private: `hookmap-path.ts`,
 * `render-decision.ts`, and `modifications.ts` each defined the identical
 * literal `Set` privately, and `hosts/opencode/apply-host-output.ts` kept a
 * further one of its own -- a HOST'S own source carrying an adapter-wide
 * security invariant because the package had no shared definition to import
 * (§V5 review round 3, Task 3, "duplication vs wrong abstraction"). Worse,
 * `modifications.ts`'s own doc comment used to name that OpenCode file as
 * where "the value-side half of the guard" lives -- a shared package
 * pointing at one host's source for an invariant that must not drift between
 * hosts. `RESERVED_SEGMENTS` below is the one definition every one of those
 * files now imports.
 *
 * TWO DIFFERENT JOBS WEAR THESE THREE NAMES, AND ONLY THE NAME LIST IS
 * SHARED BETWEEN THEM -- the checks themselves stay apart, on purpose:
 *
 *   - PATH SEGMENTS: refusing a PATH (already split into segments) whose
 *     segment names prototype machinery rather than resolving further into
 *     it. `hookmap-path.ts`'s `pathSegments` (a READER of the hookmap's own
 *     JSONPath-lite notation) and `render-decision.ts`'s `place` (a WRITER
 *     over dotted output paths that CREATES levels as it descends) both do
 *     this, each against its own path notation, each still local to its own
 *     module. PR #13's review response deliberately kept `render-decision.ts`'s
 *     copy separate rather than folding it into a shared resolver, on the
 *     grounds that doing so "would have merged two path languages rather
 *     than de-duplicating one" -- that ruling stands, and this file does not
 *     revisit it. `modifications.ts`'s own redaction-path check
 *     (`pointerSegments`, a third path notation -- RFC 6901 JSON pointers)
 *     and its `parameter_overrides` key check are the same STRUCTURAL job:
 *     a caller with a NAME already in hand (a split path segment, or one
 *     object's own top-level key) asking "is this name reserved", not a
 *     caller descending into an arbitrarily nested value. Both stay local to
 *     `modifications.ts` for the identical reason `place` stays local to
 *     `render-decision.ts` -- they reuse the name list below, nothing more.
 *   - VALUE TREES: refusing a rendered VALUE that OWNS a reserved key
 *     anywhere inside it, at any depth, once that value is about to be
 *     trusted rather than merely addressed by one named path. `findReservedKey`
 *     below is that walker -- moved here from being
 *     `hosts/opencode/apply-host-output.ts`'s own file-local copy, the one
 *     duplicate among the group above that was ever a full recursive walk
 *     rather than a name check. It does not throw: unlike the
 *     three-name list, a refusal's WORDING and ERROR CLASS are a fact about
 *     the caller, not about the walk. `modifications.ts` throws
 *     `ModificationsInvalidError` for every violation it finds (its own
 *     documented contract); `apply-host-output.ts` throws a bare `Error`
 *     worded around ITS OWN measured hazard (a recursive in-place merge that
 *     reads a rendered value back through the prototype chain -- see that
 *     file's own doc comment for the attack this closes). R3.2 also forbids
 *     this module from knowing either vocabulary. So `findReservedKey`
 *     answers the one question every caller actually shares -- "does this
 *     value own a reserved key, and where" -- and returns, leaving the
 *     throw, the class, and the words to whoever asked.
 *
 * Sharing the three names across both jobs is fine and desirable, which is
 * why this file holds them once. Sharing the checks is not, because they
 * check different things -- a path a caller is about to resolve or write
 * into, against a value a caller is about to trust as a whole.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walks `value` through every plain object and array it contains, at any
 * depth, and returns the first OWN key found that names a `RESERVED_SEGMENTS`
 * entry -- `{path, key}`, `path` being `label` extended by every segment
 * descended through to reach it (`args.env.__proto__`, `result[2].prototype`)
 * -- or `undefined` if none is found.
 *
 * OWN keys only (`Object.keys`), never inherited ones: a value read off the
 * wire through `JSON.parse` can carry `__proto__` as an ordinary own,
 * enumerable data property -- `JSON.parse` never sets the real
 * `[[Prototype]]` link -- and that is exactly the shape this walker exists to
 * catch. Recurses into arrays too, so a reserved key nested inside a list
 * element is found the same way one nested inside an object field is.
 *
 * Stops at the FIRST hit -- depth-first, keys in `Object.keys` order at each
 * level -- rather than collecting every violation: one reserved key already
 * means the value as a whole cannot be trusted, and every caller of this
 * function refuses on the first violation it finds for the same reason
 * `modifications.ts`'s own `assertValidModifications` does ("Throws ...
 * on the first violation found; never partially validates").
 *
 * DOES NOT THROW. See this file's own header for why: the wording and the
 * error class both belong to the caller, not to the walk.
 */
export function findReservedKey(value: unknown, label: string): { path: string; key: string } | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findReservedKey(value[index], `${label}[${index}]`);
      if (hit !== undefined) {
        return hit;
      }
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_SEGMENTS.has(key)) {
      return { path: `${label}.${key}`, key };
    }
    const hit = findReservedKey(value[key], `${label}.${key}`);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}
