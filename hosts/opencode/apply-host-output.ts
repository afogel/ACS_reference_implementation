/**
 * apply-host-output.ts -- `applyHostOutput`, split out of `acs-plugin.ts` into its own module
 * (§V5 review, Task 8, fix round 1, Important 1).
 *
 * WHY A SEPARATE FILE, AND WHY THIS IS NOT COSMETIC. `applyHostOutput` used to be exported
 * alongside `AcsPlugin` from `acs-plugin.ts`, for exactly one reason: so
 * `hosts/opencode/test/apply-host-output.test.ts` could import and test it directly, in
 * isolation from a live Guardian. That export was measured to be a hazard, not a convenience.
 * OpenCode's plugin loader hands its own registration context -- a live `client`, `directory`,
 * `worktree`, and `$` (its shell executor) -- to EVERY exported function of a plugin module, not
 * only the one shaped like `Plugin`, and calls each as a candidate factory. `applyHostOutput`
 * happened to be the safest possible accident: its own pass-1 validation rejects the context
 * object's first key (`"client"`) before touching anything, so OpenCode caught the throw and
 * logged a non-fatal `ERROR` line. But the SAME mis-invocation mechanism is not always safe --
 * measured (§V5 review, Task 8, fix round 1): a single **non-function** export placed beside a
 * working factory produces `error="Plugin export is not a function"`, and the factory is **never
 * called at all** -- one exported constant silently disables governance for the whole session.
 * And a genuinely broken hookmap (missing hookmap `AcsPlugin` itself refuses to register)
 * produces the byte-identical `level=ERROR message="failed to load plugin" path=...` line, with
 * only the `error=` payload differing -- so an operator watching logs cannot tell "a second,
 * harmless export got mis-invoked" from "the plugin never registered and every tool call this
 * session makes is now completely ungoverned" without reading the payload character by character.
 * The fix is not to make the mis-invocation safer; it is to remove the second export, so OpenCode
 * has exactly one candidate to call. `hosts/opencode/acs-plugin.ts` now exports only `AcsPlugin`,
 * and `test/invariants.test.ts` pins that mechanically -- see the gate added there in the same
 * fix round for what it checks and how it was mutation-tested.
 *
 * GLOBAL CONSTRAINT 4 applies here exactly as it does in `acs-plugin.ts`: this file may name
 * OpenCode's own types freely, but it may not reach into `agt-bridge` or `guardian`'s server-side
 * pieces, only `host-adapter`'s public surface -- and `test/invariants.test.ts`'s "every host
 * shim imports the adapter only" gate checks this file by name too, alongside `acs-plugin.ts`.
 *
 * `isPlainObject` is duplicated here rather than imported from `acs-plugin.ts` -- the same
 * convention `acs-plugin.ts`'s own header already uses for constants it cannot import from
 * `render-decision.ts`/`hookmap-path.ts` because they are module-private there. `acs-plugin.ts`
 * needs its own copy regardless (`assertRefusalRendersUnconditionally` uses it, and that function
 * stays where it is -- it is called from `AcsPlugin`'s own factory body, at plugin registration
 * time, not from `applyHostOutput`), so keeping two small, identical three-line functions is
 * simpler and more honest than an import whose only purpose is to avoid six lines of duplication.
 */
import type { HostOutput } from "host-adapter";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `ACS_DEBUG` asks for the stderr line in pass 2b (below) to
 * fire. Unset or empty both mean "off", and so does the literal string
 * "0" -- an env var is always a string, so the bare `process.env.ACS_DEBUG`
 * truthiness check this replaced treated "0" as ON, the one value every
 * shell convention this flag is meant to follow uses to mean OFF (§V5
 * review, fix round 2, nit).
 */
function isDebugEnabled(): boolean {
  const value = process.env.ACS_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Keys that address a JavaScript object's prototype machinery rather than a
 * field a decision actually rendered -- the same three names, and the same
 * reasoning, as `render-decision.ts`'s and `hookmap-path.ts`'s own
 * `RESERVED_SEGMENTS`, and `modifications.ts`'s `assertNoReservedSegments`
 * (§V5 review, fix round 2, Critical). This file cannot import any of
 * theirs -- they are module-private -- so the convention is repeated here
 * rather than shared, the same way `isPlainObject` above already is.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Refuses `value` if it, or anything nested inside it, owns a key from
 * `RESERVED_SEGMENTS` -- called from pass 1, below, on `output.args` and
 * `output.result`, BEFORE `mergeInPlace` ever runs (§V5 review, fix round 2,
 * Critical).
 *
 * WHY `mergeInPlace` NEEDED THIS AND `Object.assign` DID NOT. A value that
 * reaches this applier came off the Guardian's wire through `JSON.parse`,
 * which -- unlike an object literal in source -- gives `__proto__` an
 * ordinary OWN, enumerable property; `Object.keys`/`Object.entries` list it
 * like any other field. `mergeInPlace` walks those keys and, for each one,
 * reads `target[key]` and recurses when both sides are plain objects. Read
 * on a plain object with no OWN `__proto__` property, `target["__proto__"]`
 * does not return `undefined` -- it resolves through the prototype chain to
 * `Object.prototype` itself, which `isPlainObject` accepts (it IS a plain
 * object). The recursive call that follows then does not touch `target` at
 * all; every assignment inside it lands on `Object.prototype`, global to the
 * whole process, for every object that will ever exist in it -- and this
 * host is one long-lived plugin object per session, not a fresh subprocess
 * per hook, so the blast radius is the rest of the session, not one
 * invocation. `Object.assign(target, source)` never recurses, so it can only
 * ever repoint `target`'s own `__proto__` (itself refused elsewhere, in
 * `render-decision.ts`'s `place`), never write through it onto the shared
 * one -- the exposure is specific to the recursive merge Minor 1 added.
 *
 * MEASURED, end to end, through the shipped hookmap and the unmodified
 * adapter: a `modify` decision whose `modifications.parameter_overrides`
 * carries `{env: {PATH: "/bin", __proto__: {args: {command: "curl ... |
 * sh"}}}}` -- `parameter_overrides`' KEYS are checked against these same
 * three names (`modifications.ts`'s `assertNoReservedSegments`, called on
 * `Object.keys(mods.parameter_overrides)`), but the override VALUE at each
 * key is applied verbatim (`modifications.ts` around `setAtPath`, its own
 * comment: "that value arrives verbatim from the Guardian's own JSON") --
 * reaches `applied_input` with `__proto__` intact, `renderDecision` copies
 * it into `args` unexamined (R3.2: it walks the hookmap's declared paths,
 * not the arriving decision's), and without this check `applyHostOutput`
 * merged it: `Object.prototype.args` became `{command: "curl ... | sh"}`,
 * observable as `({}).args` in the SAME process afterward, on a wholly
 * unrelated allowed tool call that rendered `{}`.
 *
 * `packages/host-adapter/src/modifications.ts`'s own `RESERVED_SEGMENTS`
 * carries the identical three names for the identical reason, one seam
 * earlier -- see its doc comment for the adapter-side half of this guard.
 *
 * Recurses through arrays too (an override value could as easily nest the
 * key inside a list element as inside an object), and refuses on the FIRST
 * reserved key found anywhere in the tree, at any depth -- consistent with
 * `assertNoReservedSegments` in `modifications.ts`, which refuses the same
 * way rather than trying to salvage the rest of a render.
 */
function assertNoReservedSegments(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoReservedSegments(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_SEGMENTS.has(key)) {
      throw new Error(
        `acs-plugin: cannot apply rendered "${label}" -- it owns the reserved key ${JSON.stringify(key)} at ` +
          `"${label}.${key}", which addresses prototype machinery rather than a field this applier can merge. ` +
          `A recursive in-place merge (mergeInPlace, above) that touched this key would write through the ` +
          `prototype chain onto Object.prototype itself, global to this whole long-lived plugin process -- ` +
          `refused rather than merged (§V5 review, fix round 2, Critical).`,
      );
    }
    assertNoReservedSegments(value[key], `${label}.${key}`);
  }
}

/**
 * What this applier is allowed to touch: the live objects OpenCode handed
 * the hook that is applying a rendered `HostOutput`. Both members optional
 * because the two gates hand different halves of this -- the request gate
 * has `args` and no `result`, the result gate has `result` and no `args` --
 * and a caller with neither would have nothing for this function to do.
 */
type LiveHookObjects = { args?: Record<string, unknown>; result?: Record<string, unknown> };

/**
 * Merges `source` onto `target`, IN PLACE and recursively through every pair
 * of matching plain-object fields (§V5 review, fix round 1, Minor 1).
 *
 * A shallow `Object.assign` is functionally correct for the shipped hookmap
 * -- every field `applied_output`/`applied_input` carries is present in the
 * merge source -- but it REPLACES a nested object like `result.metadata`
 * with a brand-new reference rather than mutating the one already there.
 * This applier's entire contract with OpenCode is "mutate what you were
 * handed," and nothing here can prove OpenCode re-reads `metadata` off
 * `result` after the hook returns rather than holding a reference it took
 * earlier: the one measurement on record (opencode.hookmap.yaml's own
 * header) covers mutating `metadata.output` IN PLACE, and says nothing about
 * a wholesale replacement of `metadata` itself. A deep, in-place merge is
 * immune to the question rather than resting on an unmeasured assumption
 * about which OpenCode actually does.
 *
 * A field present on `source` but absent on `target` is added. A field on
 * `target` whose value is not itself a plain object matching a plain object
 * on `source` is overwritten wholesale -- which is what every actual
 * non-container sibling here needs (a redacted `output` string; `exit`,
 * `truncated`), and covers arrays too: `isPlainObject` excludes them, so
 * `attachments` replaces rather than merges element-wise.
 */
function mergeInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeInPlace(existing, value);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Applies what `governStep` rendered onto the objects OpenCode handed this
 * hook -- the one piece of host semantics this slice owns.
 *
 * Claude Code's shim WRITES the rendered `HostOutput` to stdout; this host
 * has no document to write. Its hooks return `void`, and the only channel
 * back to OpenCode is mutating `live.args`/`live.result` in place, or
 * throwing. So the same `HostOutput`, from the same `renderDecision`, is
 * applied instead of printed here, and the hookmap still decides which
 * disposition does which -- this function knows nothing about ACS decisions,
 * only about the four keys `opencode.hookmap.yaml` is allowed to render.
 *
 * VALIDATED WHOLE, THEN APPLIED WHOLE. Every key of `output` is checked
 * BEFORE any assignment happens, in one pass with no side effects -- a
 * half-applied mutation (an argument rewritten while the redaction it
 * arrived beside was dropped because a LATER key turned out to be
 * unapplicable) is the one outcome worse than a refusal, and it is the same
 * rule govern-step.ts states for writing half an output at the seam that
 * renders it for this host. A key this applier cannot honour throws rather
 * than being skipped, for the identical reason renderDecision and
 * buildEnvelope never skip a hookmap fault they could quietly ignore: a
 * silently-dropped field is a governed decision that only partially arrived.
 *
 * VALIDATION IS ALSO ABOUT SHAPE, NOT ONLY ABOUT WHICH KEYS ARE PRESENT
 * (§V5 review, fix round 1, Important 1). `output.args`/`output.result` are
 * checked to be plain objects in the SAME pass, before anything is merged.
 * Without that, `Object.assign`/`mergeInPlace` do not throw on a
 * non-object right-hand side -- a hookmap one character from the shipped
 * file (`args: { from: reasoning, type: string }` in place of
 * `{ from: applied_input }`) would render `args` as a plain STRING (the
 * `reasoning` text), and merging a string into an object spreads its
 * characters onto index keys (`Object.assign({}, "go")` -> `{0:"g",1:"o"}`)
 * while the actual rewrite never lands -- the exact "reported but not
 * applied" defect this project exists to catch, reached silently instead of
 * refused.
 *
 * VALIDATION ALSO WALKS INTO THE SHAPE, RECURSIVELY, FOR ONE SPECIFIC HAZARD
 * (§V5 review, fix round 2, Critical). `assertNoReservedSegments` (above)
 * refuses an `args`/`result` that owns a `__proto__`/`constructor`/
 * `prototype` key at any depth, in this same pass, before `mergeInPlace`
 * (which reads the rendered value back through the prototype chain, unlike
 * a shallow `Object.assign`) ever runs on it. See that function's own doc
 * comment for the measured attack this closes -- a `parameter_overrides`
 * value that reaches `applied_input` with `__proto__` intact writes onto
 * `Object.prototype` itself, global to this whole long-lived plugin
 * process, not merely to the one live object this call was handed.
 *
 * PASS 3 READS ITS OWN-KEY BASIS THE SAME WAY PASS 1 DOES, AND THAT IS NOT
 * COSMETIC (§V5 review, fix round 2, Critical -- the amplification half of
 * the same finding `assertNoReservedSegments` closes the other half of).
 * Pass 1 walks `Object.keys(output)`, which lists OWN enumerable keys only.
 * Pass 3 used to gate each assignment on `output.args !== undefined` /
 * `output.result !== undefined` -- a plain property READ, which resolves
 * through the JavaScript prototype chain on a plain object with no own key
 * of that name, unlike `Object.keys`. If `Object.prototype.args` were ever
 * set -- by anything, anywhere in this long-lived process, not necessarily
 * by a value this file's own `assertNoReservedSegments` failed to catch --
 * a wholly unrelated, cleanly rendered `{}` (an ordinary `allow`, "nothing
 * to change") would read `output.args` as that polluted value through the
 * chain and merge it onto `live.args`, silently rewriting an argument no
 * decision for THIS call ever named. Not reachable today: the one known
 * route to a polluted `Object.prototype` is refused in pass 1, before pass 3
 * ever runs (see the second half of this file's own `applyHostOutput` suite
 * for that non-reachability pinned end to end). But it is a second,
 * independent gap in the same defence -- pass 1 checking own keys while pass
 * 3 reads through the prototype chain is an inconsistency this applier
 * should not carry regardless of whether anything reaches it today -- so
 * pass 3 below uses `Object.hasOwn(output, ...)`, matching pass 1's basis
 * exactly rather than resting on pass 1 being the only door.
 *
 * THE FOUR KEYS, and why `result` is the whole container rather than a leaf
 * (§V5 review, fix round 1, Critical 1 -- opencode.hookmap.yaml's own header
 * states the same correction): `applied_output` is the WHOLE patched clone of
 * the object at the result gate's `outputs.within`, mirror included, not the
 * one leaf `outputs.from` names. This host's own sink for it is `result`
 * itself -- a string field would be a leaf; `result` here is the live
 * `{title, output, metadata, attachments}` object -- the same relation the
 * request gate's `args` already has to `outputs.within`'s counterpart on
 * that side. Landing the leaf and its mirror TOGETHER is why this merges the
 * whole container onto the live object rather than reaching one field deep:
 * a partial merge that touched `result.output` alone and left
 * `result.metadata.output` (the mirror) unpatched would leave the secret
 * sitting in OpenCode's own session record while the model saw the redaction
 * -- clean-looking, and a leak. `applied_output` already carries both,
 * patched together (result-output.ts's `replacingOutput`); this function's
 * job is only to land the container it is handed, not to know which of its
 * fields matter.
 *
 *   - `refuse` -- this host's ONLY deny channel (opencode.hookmap.yaml's own
 *     comment: `output.status`/`output.decision` on the request gate's
 *     output object are both measured ACCEPTED AND IGNORED, and the tool
 *     runs regardless). Throwing is what stops it, so this key is never
 *     applied to anything -- it is read and thrown, before any assignment.
 *     `refuse.reason` is a `from:` field and therefore conditional; this
 *     host's load-time gate (`assertRefusalRendersUnconditionally`, in
 *     `acs-plugin.ts`) is what guarantees `refuse` itself is never entirely
 *     absent for a real `deny`/`ask`/`defer` -- see its own doc comment.
 *   - `reason` -- DECLARED-INERT ON THIS HOST, and opencode.hookmap.yaml's
 *     own header says so: `reason.text` is declared on every disposition
 *     only because an empty `output` block fails `assertRenderableDecisions`
 *     upstream, not because OpenCode reads an explanation back from
 *     anywhere. Neither `args` nor `result` carries a field this host reads
 *     prose into, and the one channel that DOES carry text is `refuse`'s own
 *     thrown message. So this key is handled without pretending it was
 *     delivered (it is never assigned to `live.args` or `live.result` --
 *     there is no field on either that means "why", and inventing one would
 *     be a channel nothing on this host actually reads) and without being
 *     silently dropped either: it is written to stderr, honestly labelled as
 *     undelivered -- but only when `ACS_DEBUG` is set (§V5 review, fix round
 *     1, Minor 4). A V3 observe-only `allow` synthesizes `reasoning` for
 *     every governed step, so an unconditional stderr line here would fire on
 *     the common path of ordinary operation, not only when something is
 *     actually being lost quietly; gating it behind an explicit opt-in keeps
 *     the log honest without making it noise a real deployment has to filter
 *     on every clean tool call. If this host ever grows a real sink for it,
 *     this is where that sink gets named.
 *   - `args` -- merged onto `live.args`, only at a gate that was handed one.
 *   - `result` -- merged onto `live.result`, only at a gate that was handed
 *     one. See above for why this is the whole container, not a leaf.
 *
 * A key this render declares that is none of the four above -- or one of
 * `args`/`result` at a gate that was not handed the live half it targets, or
 * one of `args`/`result` whose rendered value is not itself a plain object --
 * throws rather than being skipped, naming the key, so a hookmap fault of
 * this shape (or a call from the wrong gate) fails loudly instead of quietly
 * discarding or corrupting whatever it could not place.
 */
export function applyHostOutput(output: HostOutput, live: LiveHookObjects): void {
  // Pass 1: validate every key AND every value shape this applier is about
  // to touch. No assignment happens in this loop -- only a throw (refusing
  // everything) or falling through to pass 2 (applying everything). That
  // ordering is the whole "all-or-nothing" guarantee: a key or a shape that
  // cannot be honoured is discovered before any live object has been
  // touched, regardless of where in `output` it sits.
  for (const key of Object.keys(output)) {
    if (key === "refuse" || key === "reason") {
      continue;
    }
    if (key === "args" && live.args !== undefined) {
      if (!isPlainObject(output.args)) {
        throw new Error(
          `acs-plugin: cannot apply rendered "args" -- expected an object, got ${JSON.stringify(output.args)}. ` +
            `A hookmap field sourcing "args" from a decision field that is not itself an object (e.g. "reasoning" ` +
            `where "applied_input" belongs) would otherwise merge its characters onto index keys instead of ` +
            `throwing, and the actual rewrite would never land.`,
        );
      }
      // §V5 review, fix round 2, Critical -- before any assignment, same as
      // the shape check above. See assertNoReservedSegments's own doc
      // comment for the attack this closes.
      assertNoReservedSegments(output.args, "args");
      continue;
    }
    if (key === "result" && live.result !== undefined) {
      if (!isPlainObject(output.result)) {
        throw new Error(
          `acs-plugin: cannot apply rendered "result" -- expected an object, got ${JSON.stringify(output.result)}`,
        );
      }
      assertNoReservedSegments(output.result, "result");
      continue;
    }
    throw new Error(
      `acs-plugin: cannot apply rendered key ${JSON.stringify(key)} at this gate -- opencode.hookmap.yaml ` +
        `declares an output field this applier has no live object to land it in`,
    );
  }

  // Pass 2a: the refusal, if this decision has one. Checked before any
  // assignment: a `refuse` alongside an `args`/`result` rewrite is not a
  // shape any decision on this host's hookmap renders today, but this
  // function does not assume that -- it throws before touching `live`
  // either way, the same discipline pass 1 already applies to an unknown key.
  const refusal = output.refuse as { reason?: unknown } | undefined;
  if (refusal !== undefined) {
    throw new Error(typeof refusal.reason === "string" ? refusal.reason : "denied by policy");
  }

  // Pass 2b: reason.text -- declared-inert on this host (see this function's
  // own doc comment and opencode.hookmap.yaml's header). Surfaced on stderr
  // only under ACS_DEBUG (Minor 4 -- see the doc comment above for why an
  // unconditional line here would be noise, not a diagnostic); never applied
  // to either live object, and never silently ignored when the flag is set.
  const reason = output.reason as { text?: unknown } | undefined;
  if (reason !== undefined && isDebugEnabled()) {
    console.error(
      `acs-plugin: reason.text is declared-inert on this host (opencode.hookmap.yaml) and was not delivered ` +
        `to OpenCode -- reasoning: ${JSON.stringify(reason.text)}`,
    );
  }

  // Pass 3: the assignment. Nothing above threw, so every key `output`
  // carries is one this applier is about to land, and `args`/`result` are
  // both already known to be plain objects -- args and result together,
  // leaf and mirror together, never one without the other, and merged
  // in place rather than replacing a nested reference (mergeInPlace, above).
  //
  // `Object.hasOwn`, not `!== undefined` (see this function's own doc
  // comment, "PASS 3 READS ITS OWN-KEY BASIS..."): an own-key check cannot
  // be fooled by a polluted `Object.prototype`, exactly like pass 1's
  // `Object.keys` above it.
  if (Object.hasOwn(output, "args") && live.args !== undefined) {
    mergeInPlace(live.args, output.args as Record<string, unknown>);
  }
  if (Object.hasOwn(output, "result") && live.result !== undefined) {
    mergeInPlace(live.result, output.result as Record<string, unknown>);
  }
}
