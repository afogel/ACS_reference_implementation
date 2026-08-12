/**
 * The path language a hookmap is written in, and the one place it is parsed.
 *
 * JSONPath-lite: `$.foo.bar`, `$.foo`, or `$` alone. Only dotted field access
 * -- no array indexing, no filters, no wildcards. Every path a hookmap declares
 * is in this notation (`tool_name`, `arguments`, an `outputs` block's `from` and
 * `within`, and each `from:` under a payload's field map), and this module is
 * how all of them are read.
 *
 * ONE PARSER, BECAUSE THE RESERVED-SEGMENT POLICY IS A PROPERTY OF THE LANGUAGE
 * (PR #13 review). There were two resolvers for this notation:
 * `build-envelope.ts` had one with no reserved-segment guard, and
 * `result-output.ts` had a second one with the guard, whose own comment called
 * itself "the third place in this codebase to need it and the first without".
 * A guard that lives in whichever module last remembered it is a guard the next
 * module will not have -- and the failure it prevents is not a crash. A path
 * ending `__proto__` resolves through INHERITED lookup, so it satisfies every
 * "is it present?" check both sides make and then reads or writes prototype
 * machinery instead of a field the host produced. On the reading side that
 * silently hands `Object.prototype` to a caller expecting a tool's value.
 *
 * So the segments are refused here, where the notation is defined, and every
 * reader of it gets the refusal whether or not its author thought about it.
 *
 * PARSED ONCE, NEVER RE-JOINED. `resolveSegments` takes already-split segments
 * and nothing re-joins them into a string to look up again. That is a rule
 * rather than a preference, and result-output.ts's own history is why: a leaf
 * segment of `$raw` was READ as `raw` (a second parse strips the leading `$`)
 * while the replacement PATCHED `$raw`, so a type check inspected one field and
 * the write landed in another. Two parses of one path are two paths.
 *
 * R3.2: this module knows a path notation. Nothing about ACS, hosts, or policy.
 */

/**
 * Segments that address a JavaScript object's prototype machinery rather than a
 * field a host or tool actually produced.
 *
 * `__proto__` is the one that matters; the other two are refused beside it
 * rather than reasoned about individually.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Splits a hookmap path into its field names, refusing any reserved segment.
 *
 * A throw, not a skip: a path naming one of these describes a field that does
 * not exist, and resolving around it would answer with something the hookmap
 * author never named.
 */
export function pathSegments(path: string): string[] {
  if (typeof path !== "string") {
    throw new Error(
      `hookmap path must be a JSONPath-lite string like "$.tool_input.command", got ${JSON.stringify(path)}`,
    );
  }
  const segments = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  for (const segment of segments) {
    if (RESERVED_SEGMENTS.has(segment)) {
      throw new Error(
        `hookmap path ${JSON.stringify(path)} names the reserved segment ${JSON.stringify(segment)}, which ` +
          `addresses no field a host or tool produced -- a value read there would come from the prototype ` +
          `chain, and a replacement patched there would set a prototype rather than the field`,
      );
    }
  }
  return segments;
}

/**
 * Walks ALREADY-SPLIT segments through an object, answering `undefined` at the
 * first level that is not one. Everything that reads a value out of a payload
 * goes through this, and nothing re-joins segments to look one up again.
 */
export function resolveSegments(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** One hookmap path, parsed once and resolved against a payload. */
export function resolvePath(payload: Record<string, unknown>, path: string): unknown {
  return resolveSegments(payload, pathSegments(path));
}
