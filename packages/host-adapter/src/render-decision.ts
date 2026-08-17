/**
 * renderDecision turns an ACS decision into the output its host expects --
 * without naming one field of that output anywhere in this module.
 *
 * The hookmap declares the whole shape. Each `decisions.<decision>` entry
 * carries an `output` block whose keys are dotted paths into the object the
 * host reads, and whose values say where each field's content comes from: a
 * literal (`value:`) or a field of the arriving ACS decision (`from:`, with an
 * optional `type:` the arriving value must have). This module walks that block
 * and assembles the object. It knows ACS decisions, dotted paths, and nothing
 * else; the field names, their nesting, and which of them a given decision
 * even has are all data.
 *
 * That is what lets one adapter serve many hosts rather than one adapter per
 * host: a second host gets this module unchanged, plus a shim and a hookmap.
 * So nothing here is mandatory -- a host with no permission-style field at all
 * still renders -- and a path with no dot places a field outside whatever
 * wrapper the host nests its decision in, rather than inside it.
 *
 * The wrapper itself, and the one field that is not a function of the decision
 * (the name of the hook that asked), belong to the host shim: it wraps what
 * this returns. That keeps this module's contract exactly "the output is a
 * function of the decision and the hookmap".
 *
 * The load-bearing behaviour: a `deny` decision's `reasoning` string must
 * reach the human reading the host's transcript. It happens generically --
 * `deny`'s hookmap entry names the decision field to copy and the host path to
 * copy it to, and this module copies whatever those two say.
 *
 * No policy-runtime vocabulary here and no host vocabulary either;
 * test/invariants.test.ts gates both. An observe-only upstream signal has
 * already become an ACS `allow` (with policy_references) by the time it
 * reaches this module, and it is dispatched through the exact same
 * `decisions.allow` entry a plain allow is: still one dispatch path, still
 * driven by the hookmap alone.
 *
 * `decisions.allow` also declares a reason field, so a plain allow and an
 * observe-only allow are not indistinguishable on the way out -- the latter
 * typically carries a `reasoning` string synthesized for it upstream, and
 * that string reaches the host field the hookmap names for it, where a
 * plain allow's absent `reasoning` leaves the field off entirely (pinned in
 * render-decision.test.ts). Still one dispatch path, still driven by the
 * hookmap alone -- only the rendered shape can differ.
 *
 * The decision this module renders arrives via `validateDecision`
 * (validate-decision.ts), which resolves §6.3's modifications and any
 * ASK/DEFER expiry before this module ever sees the result -- which is why
 * `modify`'s hookmap entry names a post-validation field (`applied_input`),
 * not `modifications` itself.
 */
import type { Hookmap } from "./build-envelope.ts";
import type { AcsDecision } from "./decision-message.ts";

/**
 * A rendered host output: an ordinary JSON object whose keys this module never
 * chose. A host shim receives one of these and hands it to its host -- it is
 * the shim, not the adapter, that knows what the keys mean.
 */
export type HostOutput = Record<string, unknown>;

/**
 * One field of a host output, as the hookmap declares it: exactly one source,
 * plus an optional type the arriving value must have.
 *
 * `type` is a `typeof` string, and it is not decoration. A host field declared
 * to hold prose must not be handed an object because some Guardian put one in
 * the decision field it names: the host would either display a shape it cannot
 * render or reject the whole output as malformed and treat the hook as having
 * produced no decision -- a fail-open, from a decision that arrived perfectly
 * well. A wrong-typed value leaves the field off, exactly as a missing one does.
 */
type HostOutputField = {
  /** A literal, copied through as-is. Mutually exclusive with `from`. */
  value?: unknown;
  /** The name of the ACS decision field whose value to copy. */
  from?: string;
  /** `typeof` the value must satisfy for a `from` field to be copied. */
  type?: string;
};

/** One decision's hookmap-declared rendering rule (its `decisions.<decision>` entry). */
type DecisionRenderRule = { output: Record<string, HostOutputField> };

/**
 * Path segments no output field may name. `__proto__` is the one that matters
 * -- assigning to it through a plain object mutates the prototype instead of
 * adding a key, so a hookmap naming it would produce an output missing the
 * field it declared while changing something else entirely. The other two are
 * rejected beside it rather than reasoned about individually.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Writes `value` into `output` at a dotted `path`, creating the objects along
 * the way.
 *
 * Every failure here is a throw rather than a skip or an overwrite. A hookmap
 * that declares two fields at the same key, or one field nested underneath
 * another, describes an output nobody can render as written -- and a renderer
 * that silently picked one of the two would hand the host something that
 * merely looks like a decision.
 */
function place(output: HostOutput, path: string, value: unknown): void {
  const segments = path.split(".");
  for (const segment of segments) {
    if (segment.length === 0 || RESERVED_SEGMENTS.has(segment)) {
      throw new Error(`renderDecision: output path "${path}" names the segment ${JSON.stringify(segment)}, which addresses no field`);
    }
  }

  const leaf = segments[segments.length - 1] as string;
  let cursor = output;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === undefined) {
      cursor[segment] = {};
    } else if (!isPlainObject(existing)) {
      throw new Error(
        `renderDecision: output path "${path}" nests under "${segment}", which another field already holds a value at`,
      );
    }
    cursor = cursor[segment] as HostOutput;
  }
  if (Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    throw new Error(`renderDecision: output path "${path}" is declared twice, or collides with a field nested under it`);
  }
  cursor[leaf] = value;
}

/**
 * Renders `decision` per `hookmap.decisions[decision.decision]`, returning the
 * host output that entry declares.
 *
 * Throws if the hookmap has no `decisions` block, has no entry for this
 * decision, or has an entry this module cannot render -- there is no default
 * rendering and no partial output. A caller that cannot render a decision
 * still has a decision it must answer; answering it with half an output is the
 * one thing this function will not do.
 */
export function renderDecision(decision: AcsDecision, hookmap: Hookmap): HostOutput {
  const decisions = hookmap.decisions;
  if (!isPlainObject(decisions)) {
    throw new Error("renderDecision: hookmap has no decisions block");
  }
  if (!Object.prototype.hasOwnProperty.call(decisions, decision.decision)) {
    throw new Error(`renderDecision: hookmap has no decisions entry for ACS decision "${decision.decision}"`);
  }

  const rule = decisions[decision.decision];
  if (!isPlainObject(rule) || !isPlainObject(rule.output) || Object.keys(rule.output).length === 0) {
    // An entry that is null, or carries no `output` block, satisfies a bare
    // presence check and then renders nothing -- an output with no decision in
    // it, which a host reads as "the hook produced nothing" exactly as surely
    // as a missing entry does, just more quietly.
    throw new Error(
      `renderDecision: hookmap's "decisions.${decision.decision}" entry needs a non-empty "output" block, ` +
        `got ${JSON.stringify((rule as { output?: unknown } | null)?.output)}`,
    );
  }

  const output: HostOutput = {};
  for (const [path, field] of Object.entries((rule as DecisionRenderRule).output)) {
    if (!isPlainObject(field)) {
      throw new Error(
        `renderDecision: hookmap's "decisions.${decision.decision}" output field "${path}" must be an object ` +
          `naming "value" or "from", got ${JSON.stringify(field)}`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(field, "value")) {
      place(output, path, field.value);
      continue;
    }
    if (typeof field.from !== "string" || field.from.length === 0) {
      // Not skipped: a field naming neither source is a hookmap typo, and
      // rendering around it would produce an output missing a field its author
      // believes is there.
      throw new Error(
        `renderDecision: hookmap's "decisions.${decision.decision}" output field "${path}" must name a literal ` +
          `"value" or a non-empty string "from", got ${JSON.stringify(field.from)}`,
      );
    }
    const carried = decision[field.from];
    if (carried === undefined) {
      continue;
    }
    if (field.type !== undefined && typeof carried !== field.type) {
      continue;
    }
    place(output, path, carried);
  }
  return output;
}
