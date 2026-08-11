/**
 * The result gate's replacing output: how a decision about what a step
 * PRODUCED reaches a host in a shape the host will actually accept.
 *
 * THE ONE HAZARD THIS MODULE EXISTS FOR. A host that lets a hook replace a
 * tool's output validates the replacement against that tool's own output
 * schema, and a replacement that does not match it is DISCARDED -- silently,
 * with the ORIGINAL delivered. Verified by hand against the first host wired to
 * this gate: a hook answering with the redacted text alone, as a bare string,
 * produced a warning line on stderr while the model received the real secret.
 * So a redaction is only a redaction if EVERY SIBLING FIELD SURVIVES.
 *
 * THE WAY THAT IS ACHIEVED, and there is deliberately only one: patch a CLONE
 * of the object the host handed us, at the path the hookmap named. Never
 * construct a new output object. That symmetry is the whole answer -- the shape
 * is preserved because it was never rebuilt, so a field this adapter has never
 * heard of survives exactly as well as one it has.
 *
 * WHY THE ACS DOCUMENT IS NOT SIMPLY HANDED BACK. The ACS result payload
 * carries ONE leaf -- `outputs[0].value`, the leaf S1's `outputs.from` named --
 * where the host's own output object carries that leaf and its siblings. §6.3's
 * pointers address the ACS payload (`/outputs/0/value`), and that is what they
 * are applied to; this module then projects the applied leaf back through
 * `outputs.from` into a clone of `outputs.within`. The two notations stay
 * deliberately separate: nothing here reinterprets an ACS pointer as a
 * host-side path, because the agreement that keeps them aligned is a
 * declaration the policy side owns, not a translation this side could check.
 *
 * R3.2: this module knows ACS's decision vocabulary, ACS's result payload
 * shape, and a hookmap's `outputs` block. It names no host field and no policy
 * runtime -- the field names in the object it clones are the host's own, copied
 * without being read, which is exactly what lets a second host reuse it.
 */
import type { HookmapOutputs } from "./build-envelope.ts";
import type { AcsDecision, ValidatedAcsDecision } from "./decision-message.ts";

/**
 * Where a host's own output object lives for one invocation of one result-gate
 * hook: the raw host payload, and that hook's declared `outputs` paths into it.
 *
 * Both members together, because neither is usable alone -- the paths say where
 * to look and the payload is what they are resolved against, and a caller
 * holding one without the other could not build a replacement at all.
 */
export type HostOutputTarget = {
  /** The raw host payload the hook was invoked with. */
  payload: Record<string, unknown>;
  /** S1's `outputs` block for the hook that asked. */
  outputs: HookmapOutputs;
};

/**
 * What a result-gate `deny` puts in place of the output it withholds.
 *
 * A deny at this gate has to REPLACE the output, not merely report a block:
 * the tool has already run and its result has already formed, so a block on its
 * own injects a reason and suppresses nothing (verified directly -- the model
 * received the real stdout AND the block reason). The replacing output is the
 * half that actually withholds.
 *
 * Prose rather than an empty string, and prose that names policy rather than an
 * error: what lands here is read by a model that will otherwise conclude the
 * tool produced nothing and try again. WHY it was withheld travels separately,
 * in whatever field the hookmap points at the decision's own `reasoning` -- one
 * string per job, so a marker a reader might match on never carries text a
 * policy author wrote.
 */
export const WITHHELD_OUTPUT = "[OUTPUT WITHHELD BY POLICY]";

/** The ACS decision this module withholds an output for. Not a host value:
 * ACS's own disposition, the same string every other module here reads. */
const DENY = "deny";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Path segments that address a JavaScript object's prototype machinery rather
 * than a field a tool actually produced -- the same set, for the same reason, as
 * modifications.ts's and render-decision.ts's.
 *
 * This is the third place in this codebase to need the guard and was the first
 * without it. `outputs.from: $.tool_response.__proto__` resolves through
 * INHERITED lookup, so it satisfies every check both sides make -- `within` is an
 * object, the path extends it, and the leaf is "present" -- and then
 * `clone["__proto__"] = replacement` sets a prototype instead of creating an own
 * property. The clone comes back byte-identical to the payload, the decision
 * reports an applied rewrite, and nothing withheld anything: reported-as-applied
 * with nothing applied, which is the defect class this module exists to close.
 *
 * Nothing is reachable today -- for a prose replacement the leaf's `typeof`
 * (`object` for `__proto__`, `function` for `constructor`) fails the comparison
 * in `replacingOutput` first, and `assertOutputIsReplaceable` now runs that
 * comparison before any decision is sought. That is a guard holding by
 * coincidence of another guard's shape, which is exactly how the two places that
 * already have this one describe what they are for.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** JSONPath-lite (`$.foo.bar`) split into its field names -- the same notation
 * and the same leading-`$` tolerance `buildEnvelope` resolves. */
function pathSegments(path: string): string[] {
  const segments = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  for (const segment of segments) {
    if (RESERVED_SEGMENTS.has(segment)) {
      throw new Error(
        `result-output: hookmap path ${JSON.stringify(path)} names the reserved segment ` +
          `${JSON.stringify(segment)}, which addresses no field a tool produced -- a replacement patched at one ` +
          `would set a prototype rather than the field, and report a rewrite that changed nothing`,
      );
    }
  }
  return segments;
}

function resolve(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const segment of pathSegments(path)) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Returns a clone of `container` with `segments` set to `replacement`, cloning
 * every level the path descends through.
 *
 * Cloning each level, not only the outermost object, is what keeps a nested
 * replacement from reaching back into the payload the host handed us -- which a
 * later step, the audit sink and the envelope log all still read.
 *
 * Every level must already BE there: unlike §6.3's own apply step this never
 * creates one. A path that has to invent a level is describing a field the tool
 * did not produce, and adding one is precisely the shape change that gets a
 * replacement declined and the original delivered. So it throws, and the caller
 * turns that into a decision.
 */
function patchedClone(
  container: Record<string, unknown>,
  segments: string[],
  replacement: unknown,
  path: string,
): Record<string, unknown> {
  const [head, ...rest] = segments as [string, ...string[]];
  const clone: Record<string, unknown> = { ...container };
  if (rest.length === 0) {
    clone[head] = replacement;
    return clone;
  }
  const child = container[head];
  if (!isPlainObject(child)) {
    throw new Error(
      `result-output: the host payload has no object at ${JSON.stringify(head)} for output path ` +
        `${JSON.stringify(path)} to descend through, so there is no object to clone and patch there`,
    );
  }
  clone[head] = patchedClone(child, rest, replacement, path);
  return clone;
}

/**
 * The one way a replacing output is ever built: a clone of the object at
 * `outputs.within`, with the leaf at `outputs.from` replaced.
 *
 * Both failure modes are throws, because both mean the replacement would be a
 * shape the host may decline, and a declined replacement delivers the original.
 * A redaction that does not land is a failure, not a partial success:
 *
 *   - `within` resolving to something that is not an object, or the leaf being
 *     absent from it. There is nothing to clone, or nothing to patch.
 *   - a replacement of a different `typeof` than the value it replaces. Prose
 *     in place of prose preserves the shape; prose in place of a number,
 *     an object or a list does not, and writing it would produce exactly the
 *     silently-discarded replacement this module exists to prevent.
 *
 *     BOTH DIRECTIONS OF THAT MISMATCH ARE REACHABLE, and the one reachable
 *     HERE is the replacement's, not the leaf's. An earlier version of this note
 *     leaned on "ACS types a redaction's `replacement` as a string" as though
 *     that were enforced: `Redaction.replacement?: string` is a TypeScript type
 *     on a value that arrives over the wire, and nothing checks it at runtime.
 *     A Guardian sending `{path: "/outputs/0/value", replacement: 42}` reaches
 *     this comparison with a number for a string leaf and gets
 *     `deny(modifications_invalid)` -- an arriving decision this gate cannot
 *     carry out, answered as a decision, which is what this comparison is for.
 *     The other direction, a leaf that is not prose, no longer reaches a
 *     decision at all: `assertOutputIsReplaceable` refuses the deployment for it
 *     before one is sought, because a leaf no replacement can be expressed for
 *     is not a decision to answer, it is a hookmap that could not carry one out.
 *
 * `buildEnvelope` establishes that the two paths describe one leaf inside one
 * object and that the leaf resolved for this very payload; the assertion below
 * establishes the rest, before a decision is ever sought. Between the two, no
 * throw here is reachable for a prose replacement at a gate that got as far as
 * holding a decision -- which is the property that keeps a `deny` from arriving
 * somewhere it cannot be carried out. They stay throws rather than assumptions:
 * this function is handed a payload and two paths, and "some caller checked" is
 * not a property of the function.
 */
export function replacingOutput(target: HostOutputTarget, replacement: unknown): Record<string, unknown> {
  const { payload, outputs } = target;
  const container = resolve(payload, outputs.within);
  if (!isPlainObject(container)) {
    throw new Error(
      `result-output: hookmap path ${JSON.stringify(outputs.within)} does not resolve to an object in this ` +
        `payload, so there is no output object to clone and patch a replacement into`,
    );
  }

  const segments = pathSegments(outputs.from).slice(pathSegments(outputs.within).length);
  if (segments.length === 0) {
    throw new Error(
      `result-output: hookmap path ${JSON.stringify(outputs.from)} names no leaf inside ` +
        `${JSON.stringify(outputs.within)}, so a replacement would replace the whole output object`,
    );
  }

  const original = resolve(container, segments.join("."));
  if (original === undefined) {
    throw new Error(
      `result-output: hookmap path ${JSON.stringify(outputs.from)} resolves to no value in this payload, so ` +
        `patching it would ADD a field this tool never produced -- a shape the host may decline, and a ` +
        `declined replacement delivers the original output`,
    );
  }
  if (typeof original !== typeof replacement) {
    throw new Error(
      `result-output: the replacement for hookmap path ${JSON.stringify(outputs.from)} is a ` +
        `${typeof replacement} where this tool produced a ${typeof original} -- the host validates a ` +
        `replacement against the tool's own output shape and delivers the ORIGINAL when it does not match, ` +
        `so a replacement of the wrong type withholds nothing and redacts nothing`,
    );
  }

  return patchedClone(container, segments, replacement, outputs.from);
}

/**
 * Throws unless a replacing output can be built for this payload AT ALL --
 * asked, deliberately, by BUILDING one.
 *
 * WHY THIS IS ASKED BEFORE A DECISION IS SOUGHT, AND NOT WHERE THE
 * REPLACEMENT IS NEEDED. Every precondition `replacingOutput` reports is a
 * property of the payload and the hookmap alone -- an object to clone, a leaf
 * to patch, and a leaf whose own type prose can stand in for -- and not one of
 * them depends on which decision arrives. Asked once a decision is in hand,
 * a hookmap that fails any of them leaves the caller holding a `deny` it cannot
 * carry out, at the one point where the caller's only remaining answer is a
 * delivery-failure posture: `proceed` there delivers the unredacted output and
 * drops the decision, `deny` there blocks with nothing withheld. Both are the
 * shape this module exists to prevent, arrived at from the other side.
 *
 * So the question is asked first, where the only answer needed is a loud stop.
 * A hookmap that cannot express a withholding for the payload in hand is a
 * broken deployment, not a policy question -- the same class as a hookmap that
 * will not load -- and nothing has been asked of a policy runtime and nothing
 * has been audited at that point, so there is no decision to drop and no record
 * to falsify.
 *
 * BY BUILDING ONE, rather than by re-stating what building one requires.
 * "A replacement can be built" and "here is what building a replacement needs"
 * are two sentences that can drift, and this check's whole value is that the
 * projection and its precondition cannot come apart. `WITHHELD_OUTPUT` is not a
 * stand-in either: it is the exact value the fail-closed path would have to
 * patch, so what is checked is the very projection that would be performed. The
 * clone is discarded -- the answer is in whether it could be made.
 */
export function assertOutputIsReplaceable(target: HostOutputTarget): void {
  replacingOutput(target, WITHHELD_OUTPUT);
}

/**
 * The applied ACS result payload, projected onto the host's own output object:
 * §6.3's rewrite, landed where the host reads it.
 *
 * The leaf is read back from `outputs[0].value` -- the one place `buildEnvelope`
 * put it, from the same `outputs.from` path this projects it back through. The
 * two halves are symmetric on purpose: one path in the hookmap, one leaf on the
 * wire, one leaf patched back.
 *
 * Called from inside N7's apply step, so a throw here becomes
 * `deny(modifications_invalid)` -- the same answer as a rewrite that could not be
 * applied at all, for the same reason: a rewrite the host cannot land is a
 * rewrite that did not happen (R1.6), and reporting it as applied is the one
 * outcome that is worse than denying.
 */
export function appliedOutput(
  appliedDocument: Record<string, unknown>,
  target: HostOutputTarget,
): Record<string, unknown> {
  const outputs = appliedDocument.outputs;
  const first = Array.isArray(outputs) ? (outputs[0] as unknown) : undefined;
  if (!isPlainObject(first) || !Object.prototype.hasOwnProperty.call(first, "value")) {
    throw new Error(
      `result-output: the applied result payload carries no "outputs[0].value" to project back onto this ` +
        `host's output object -- the modifications were applied to a document that no longer describes what ` +
        `the step produced`,
    );
  }
  return replacingOutput(target, first.value);
}

/**
 * A decision's last word before it is rendered, at a gate where the step has
 * already run: a `deny` here carries the output it withholds.
 *
 * Applied to every decision on its way to a render, and it changes exactly one:
 *
 *   - `deny` gains a replacing output. Without it the rendered answer is a block
 *     with an empty wrapper -- a reported withholding that did not happen, while
 *     the secret is delivered. That covers a deny the policy runtime sent, a
 *     deny N7 substituted for a rewrite it could not apply, AND a deny a
 *     negotiated fail-closed posture produced: all three are withholdings, and
 *     one of them arriving unable to withhold would be the same defect by a
 *     different route.
 *   - `modify` is checked, not changed. Its replacement was built by N7's apply
 *     step, and a `modify` reaching a render without one would render an empty
 *     wrapper too -- a rewrite reported and never applied, R1.6's own failure.
 *     Unreachable while `validateDecision` is given this gate's target, which is
 *     why it is a throw and not a repair.
 *   - everything else is returned untouched. An `allow` deliberately emits no
 *     replacement at all: the output is delivered as the tool produced it, and an
 *     unnecessary replacement is a chance to get the shape wrong for no benefit.
 *
 * `target` is `undefined` at a gate that decides whether a step RUNS. Nothing is
 * withheld there -- the step's own output does not exist yet -- so every decision
 * passes through.
 */
export function withResultOutput(decision: AcsDecision, target: HostOutputTarget | undefined): AcsDecision {
  if (target === undefined) {
    return decision;
  }
  if (decision.decision === DENY) {
    return { ...decision, applied_output: replacingOutput(target, WITHHELD_OUTPUT) } satisfies ValidatedAcsDecision;
  }
  if (decision.decision === "modify" && (decision as ValidatedAcsDecision).applied_output === undefined) {
    throw new Error(
      `result-output: a "modify" reached this gate's render carrying no applied output, so the rewrite it ` +
        `reports has nowhere to land -- the host would deliver the original output unchanged`,
    );
  }
  return decision;
}
