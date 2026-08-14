/**
 * apply-opencode-output.ts -- `applyOpenCodeOutput`, split out of `acs-plugin.ts` into its own module
 * (§V5 review, Task 8, fix round 1, Important 1).
 *
 * NAMED FOR THE HOST IT APPLIES TO, NOT GENERICALLY (§V5 review round 3, Task 4). This function
 * used to be called `applyHostOutput` -- a name that named neither of the two things this module
 * actually is: the twin of host #1's own `asClaudeCodeOutput` (`hosts/claude-code/acs-hook.ts`),
 * and a module that knows exactly four OpenCode-shaped keys (`refuse`, `reason`, `args`, `result`).
 * A generic name invites a later reader to try moving it into `packages/host-adapter/` -- R3.2
 * forbids that outright, host-specific field names have no business in the package both hosts
 * share -- and every error this file throws used to say `acs-plugin:`, naming a DIFFERENT file's
 * own prefix rather than this one's. Both are fixed here: the function is `applyOpenCodeOutput`,
 * and every thrown message below says `apply-opencode-output:`.
 *
 * WHY A SEPARATE FILE, AND WHY THIS IS NOT COSMETIC. `applyOpenCodeOutput` used to be exported
 * alongside `AcsPlugin` from `acs-plugin.ts`, for exactly one reason: so
 * `hosts/opencode/test/apply-opencode-output.test.ts` could import and test it directly, in
 * isolation from a live Guardian. That export was measured to be a hazard, not a convenience.
 * OpenCode's plugin loader hands its own registration context -- a live `client`, `directory`,
 * `worktree`, and `$` (its shell executor) -- to EVERY exported function of a plugin module, not
 * only the one shaped like `Plugin`, and calls each as a candidate factory. `applyOpenCodeOutput`
 * happened to be the safest possible accident: its own pass-1 validation rejects the context
 * object's first key (`"client"`) before touching anything, so OpenCode caught the throw and
 * logged a non-fatal `ERROR` line. But the SAME mis-invocation mechanism is not always safe --
 * measured (§V5 review, Task 8, fix round 1): a single **non-function** export placed beside a
 * working factory produces `error="Plugin export is not a function"`, and the factory is **never
 * called at all** -- one exported constant silently disables governance for the whole session.
 * And a genuinely broken hookmap (one missing `refuse.denied`, say -- one of the faults
 * `assertHostAcceptsEveryDecision` (acs-plugin.ts) exists to catch) makes `AcsPlugin` itself throw and refuse
 * to register, and OpenCode's loader catches that throw and logs it, producing the byte-identical
 * `level=ERROR message="failed to load plugin" path=...` line, with
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
 * `isPlainObject` is duplicated here rather than imported from `acs-plugin.ts`, and that is a
 * SEPARATE decision from where the reserved-segment guard below now comes from (§V5 review round
 * 3, Task 3) -- `findReservedKey` moved to `host-adapter`'s public surface (`RESERVED_SEGMENTS`,
 * the name list it walks, did NOT move onto that surface -- it stayed module-private inside
 * `reserved-segments.ts`, importable by nothing outside it, not even this file; see that file's
 * own header for why a reachable shared `Set` was a hazard §V5 review round 3, Task 3's own fix
 * round closed) because a security invariant that any host applier might need belongs in the
 * package both hosts run, not in host #2's own source; `isPlainObject` here is a three-line
 * structural-typing helper with no such invariant to drift, and `acs-plugin.ts` needs its own copy
 * of IT regardless (`assertHostAcceptsEveryDecision` uses it, and that function stays where
 * it is -- it is called from `AcsPlugin`'s own factory body, at plugin registration time, not from
 * `applyOpenCodeOutput`), so keeping two small, identical three-line functions is simpler and more
 * honest than an import whose only purpose is to avoid six lines of duplication.
 */
import { findReservedKey, type HostOutput } from "host-adapter";

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
 * Refuses `value` if it, or anything nested inside it, owns a reserved
 * prototype-machinery key (`__proto__`/`constructor`/`prototype`) -- called
 * from pass 1, below, on `output.args` and `output.result`, BEFORE
 * `mergeInPlace` ever runs (§V5 review, fix round 2, Critical).
 *
 * THE WALK ITSELF IS `host-adapter`'s `findReservedKey` (imported above),
 * not a copy kept here (§V5 review round 3, Task 3, "duplication vs wrong
 * abstraction"). This file used to carry its own `RESERVED_SEGMENTS` Set,
 * duplicating the same three names `hookmap-path.ts`, `render-decision.ts`,
 * and `modifications.ts` each also kept privately, AND its own recursive
 * walker -- the one copy among that group that actually recursed into a
 * nested value rather than checking a name already in hand, because the
 * adapter had nowhere shared to export either from. `findReservedKey` does
 * not throw (detection is shared; the wording and the error class below are
 * this file's own, because they describe THIS applier's specific hazard,
 * not a generic one -- see `reserved-segments.ts`'s own header for why that
 * split is deliberate, and for why `modifications.ts`'s own reserved-segment
 * checks stay a local name check rather than also calling this walker); this
 * function is the thin, host-specific wrapper that turns a hit into the
 * refusal below.
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
 * not the arriving decision's), and without this check `applyOpenCodeOutput`
 * merged it: `Object.prototype.args` became `{command: "curl ... | sh"}`,
 * observable as `({}).args` in the SAME process afterward, on a wholly
 * unrelated allowed tool call that rendered `{}`.
 *
 * Recurses through arrays too (an override value could as easily nest the
 * key inside a list element as inside an object), and refuses on the FIRST
 * reserved key found anywhere in the tree, at any depth -- consistent with
 * `assertNoReservedSegments` in `modifications.ts`, which refuses the same
 * way rather than trying to salvage the rest of a render.
 */
function assertNoReservedSegments(value: unknown, label: string): void {
  const hit = findReservedKey(value, label);
  if (hit !== undefined) {
    throw new Error(
      `apply-opencode-output: cannot apply rendered "${label}" -- it owns the reserved key ${JSON.stringify(hit.key)} at ` +
        `"${hit.path}", which addresses prototype machinery rather than a field this applier can merge. A ` +
        `recursive in-place merge (mergeInPlace, above) that touched this key would write through the ` +
        `prototype chain onto Object.prototype itself, global to this whole long-lived plugin process -- ` +
        `refused rather than merged (§V5 review, fix round 2, Critical).`,
    );
  }
}

/**
 * What this applier is allowed to touch: the live object OpenCode handed the
 * hook that is applying a rendered `HostOutput` -- TAGGED by which gate is
 * calling, not a bag with two optional fields a caller asks the presence of
 * (§V5 review round 3, Task 4, thread 3773262488). The request gate hands
 * `{gate: "request", args}`; the result gate hands `{gate: "result", result}`;
 * a caller with neither would have nothing for this function to do, so
 * neither variant allows that.
 *
 * THE TAG IS THE DISPATCH MECHANISM BELOW, NOT A PRESENCE CHECK, and that is
 * most of the fix. This type used to be
 * `{ args?: Record<string, unknown>; result?: Record<string, unknown> }`, one
 * bag with both fields optional, and `applyOpenCodeOutput` (as this function
 * is named below; it was `applyHostOutput` before this task) ASKED which half
 * it had been handed -- `live.args !== undefined` / `live.result !== undefined`
 * in both pass 1 and pass 3. A plain property READ resolves through the
 * JavaScript prototype chain on an object that owns no field of that name --
 * the EXACT class of gap pass 3's own `Object.hasOwn(output, ...)` fix
 * (below) already closed for `output`, left open on the `live` side. If
 * `Object.prototype.args` were ever polluted -- by anything, anywhere in this
 * long-lived process, including the very `parameter_overrides` vector
 * `assertNoReservedSegments` (above) refuses -- a call handed only
 * `{gate: "result", result}` would have read `live.args` as the polluted
 * value through the chain, believed it had been handed a live args object it
 * was never given, and (together with the pre-fix pass 3) merged a rendered
 * `"args"` straight onto the SHARED `Object.prototype.args` object itself
 * rather than refusing -- amplifying the pollution rather than merely
 * misreading it once.
 *
 * SAY PLAINLY WHICH OF THE TWO CHECKS BELOW IS ACTUALLY LOAD-BEARING (§V5
 * review round 3, Task 4, fix round 1, Minor 2 -- an earlier version of this
 * comment called `gate` "the fix" and `Object.hasOwn(live, ...)` the belt
 * beside it; that had it backwards). `live.gate === "request"` is ALSO a
 * plain property READ, and a plain property read resolves through the
 * prototype chain exactly like `live.args !== undefined` did -- comparing it
 * does not eliminate a chain-read question, it moves the question onto a
 * DIFFERENT key. What that move buys is real but narrower than "immune":
 * `args`/`result` are `HostOutput`'s own field names, the exact vocabulary a
 * rendered decision -- and therefore the one pollution vector this codebase
 * actually produces (`assertNoReservedSegments`'s own doc comment, above)
 * -- could plausibly collide with; `gate` is neither, so nothing this
 * codebase's own attack surface writes to `Object.prototype` today lands on
 * it. But a `live.gate` read is only as trustworthy as `live` actually
 * OWNING a `gate` property, and both live objects that ever reach this
 * function are honest, literal-constructed object literals ONLY because
 * `acs-plugin.ts`'s two hook methods each construct one, fully typed with no
 * cast on `live`, and hand it to that file's shared `runExchange`, which makes the
 * single call below with whichever it was given (§V5 review round 3, Task 6
 * merged the two hook bodies; before that each hook called this function
 * itself). A fact about today's two constructors, not a property of the
 * `gate` compare itself.
 *
 * `Object.hasOwn(live, "args")` / `Object.hasOwn(live, "result")`, run
 * BESIDE the `gate` compare in both pass 1 and pass 3 below, are what is
 * actually immune, on any key, regardless of what `Object.prototype` carries
 * -- own-key checks do not resolve through the chain at all, which is the
 * whole reason `output`'s own pass-3 fix (below) uses one. A future call
 * site that narrows the type with an unsafe cast (`as never`, the same
 * escape hatch several of this file's own tests already use on `output`)
 * could hand this function a `live` whose `gate` says `"request"` while its
 * `args` field is actually absent -- and if `Object.prototype.gate` were
 * EVER polluted to match, the `gate` compare alone would be fooled the same
 * way the pre-fix `live.args !== undefined` was. `Object.hasOwn(live, ...)`
 * is what still refuses that `live` correctly regardless: pinned directly,
 * with `Object.prototype.args` polluted AND a cast `live` that owns no
 * `args` field despite claiming `gate: "request"`, in "refuses a cast `live`
 * whose gate lies about owning args, even with Object.prototype.args
 * polluted" (apply-opencode-output.test.ts). So: `gate` narrows the type and
 * documents intent; `Object.hasOwn(live, ...)` is the one of the two that is
 * actually load-bearing against a malformed `live`, matching pass 1's
 * `Object.getOwnPropertyNames` basis and pass 3's `Object.hasOwn(output, ...)`
 * basis exactly.
 */
export type LiveHookObjects =
  | { gate: "request"; args: Record<string, unknown> }
  | { gate: "result"; result: Record<string, unknown> };

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
 * Pass 3 used to gate each assignment on `output.args !== undefined` /
 * `output.result !== undefined` -- a plain property READ, which resolves
 * through the JavaScript prototype chain on a plain object with no own key
 * of that name. If `Object.prototype.args` were ever set -- by anything,
 * anywhere in this long-lived process, not necessarily by a value this
 * file's own `assertNoReservedSegments` failed to catch -- a wholly
 * unrelated, cleanly rendered `{}` (an ordinary `allow`, "nothing to
 * change") would read `output.args` as that polluted value through the
 * chain and merge it onto `live.args`, silently rewriting an argument no
 * decision for THIS call ever named. Not reachable today: the one known
 * route to a polluted `Object.prototype` is refused in pass 1, before pass 3
 * ever runs (see the second half of this file's own `applyOpenCodeOutput`
 * suite for that non-reachability pinned end to end). But it is a second,
 * independent gap in the same defence -- pass 1 checking own keys while pass
 * 3 (at the time) read through the prototype chain -- so pass 3 was switched
 * to `Object.hasOwn(output, ...)`.
 *
 * "MATCHING PASS 1'S BASIS" WAS NOT QUITE TRUE YET WHEN THAT FIX LANDED, AND
 * THIS ROUND CLOSES THE REST (§V5 review round 3, Task 4, fix round 1,
 * Important 4 -- the same class of finding this task exists to fix, one axis
 * over). Pass 1 walked `Object.keys(output)`, own ENUMERABLE keys only;
 * `Object.hasOwn(output, ...)` answers true for an own key regardless of
 * enumerability. Different axis from the prototype-chain gap above --
 * enumerability, not inheritance -- but the identical SHAPE of
 * inconsistency: one pass checks a narrower set of `output`'s own keys than
 * the other does. PROBED: an `output` carrying `args` as a non-enumerable
 * own property (built with `Object.defineProperty`, not something
 * `JSON.parse` -- or `renderDecision`, which never sets a property this way
 * -- ever produces, so nothing in the real pipeline reaches this) skipped
 * pass 1's validation loop entirely -- no shape check, no
 * `assertNoReservedSegments` -- while pass 3's `Object.hasOwn` still found
 * and merged it, spreading a non-object value's characters onto index keys
 * with no throw: the exact "reported but not applied" (here, "validated but
 * not really") defect Important 1's shape check, above, exists to catch,
 * reached by a different door. Closed by walking
 * `Object.getOwnPropertyNames(output)` in pass 1 (below) instead of
 * `Object.keys(output)` -- own, any enumerability, the identical basis
 * `Object.hasOwn` already answers for pass 3 -- so both passes now agree
 * exactly, on both axes.
 *
 * THE SAME GAP EXISTED ON THE `live` SIDE (§V5 review round 3, Task 4,
 * thread 3773262488). Both passes below used to ask `live.args !== undefined`
 * / `live.result !== undefined` too -- the identical prototype-chain read, on
 * the OTHER object this function touches. `LiveHookObjects` (above) reshapes
 * `live` so a gate is TOLD which half it has, via `live.gate`, rather than
 * asking a bag -- and `live.gate === "request"` moves the read onto a key
 * nothing this codebase's own attack surface ever writes to
 * `Object.prototype`, which is real protection for today's two, fully-typed
 * constructors. But `gate` is ALSO a plain property read, not something
 * immune to the chain the way an own-key check is -- see that type's own
 * doc comment for which of the two checks below is the one actually
 * load-bearing (`Object.hasOwn(live, ...)`, not `gate`) against a `live`
 * that does not honestly own what it claims to.
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
 *   - `refuse` -- this host's only deny channel AT THE REQUEST GATE, which is
 *     narrower than the "this host's ONLY deny channel" this bullet used to
 *     claim (§V5 review round 3, Task 5). At the request gate it is genuinely
 *     the only one: opencode.hookmap.yaml's own comment records that
 *     `output.status`/`output.decision` on that gate's output object are both
 *     measured ACCEPTED AND IGNORED, and the tool runs regardless, so throwing
 *     is what stops it. At the RESULT gate `refuse` is the wrong channel and
 *     `result` (below) is the deny channel instead -- a throw there makes
 *     OpenCode discard this plugin's mutations and rebuild `metadata` from its
 *     own pre-hook copy, so the tool's output survives in OpenCode's session
 *     record however early the throw fires (measured). Either way this key is
 *     never applied to anything -- it is read and thrown, before any
 *     assignment. `refuse.reason` is a `from:` field and therefore
 *     conditional; this host's load-time gate
 *     (`assertHostAcceptsEveryDecision`, in `acs-plugin.ts`) is what
 *     guarantees `refuse` itself is never entirely absent for a real
 *     request-gate `deny`/`ask`/`defer` -- see its own doc comment.
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
 *   - `args` -- merged onto `live.args`, only when `live.gate === "request"`
 *     (and `live` owns an `args` field -- see `LiveHookObjects`'s own doc
 *     comment for why both are checked). This is where a request-gate
 *     `modify`'s rewrite lands, and the only place it can: the same load-time
 *     gate requires `args: { from: applied_input }` on any `modify` the
 *     request gate declares -- unless that `modify` refuses outright instead --
 *     because a `modify` with nowhere to land renders nothing, runs the tool
 *     unrewritten, and is still reported `stage: "honoured"` (§V5 review round
 *     3, Task 5, fix round 1, Important 2 -- measured).
 *   - `result` -- merged onto `live.result`, only when `live.gate ===
 *     "result"` (same, for `result`). See above for why this is the whole
 *     container, not a leaf. This is the RESULT gate's deny channel, the
 *     counterpart to `refuse` at the request gate, and the same load-time gate
 *     (`assertHostAcceptsEveryDecision`, in `acs-plugin.ts`) is what guarantees a result-gate
 *     `deny`/`modify` either declares `result: { from: applied_output }` --
 *     that key, that source, a declaration that can actually render, and a
 *     hook that declares an `outputs` block for it to be filled from -- or
 *     declares an unconditional refusal instead, which throws through `refuse`
 *     above. `ask`/`defer` at that gate get only the second option: nothing
 *     ever attaches an `applied_output` to either of them (`withResultOutput`,
 *     result-output.ts), so a sink on one renders nothing however correctly it
 *     is written (§V5 review round 3, Task 5, fix round 3). Without it, a decision carrying a perfectly
 *     good `applied_output` renders nothing this function can land, and this
 *     applier applies nothing and throws nothing while the tool's output is
 *     delivered (§V5 review round 3, Task 5, Critical, and its own fix round
 *     1 -- every shape measured on the real chain before the rule that
 *     refuses it existed).
 *
 * A key this render declares that is none of the four above -- or one of
 * `args`/`result` at a gate that was not handed the live half it targets, or
 * one of `args`/`result` whose rendered value is not itself a plain object --
 * throws rather than being skipped, naming the key, so a hookmap fault of
 * this shape (or a call from the wrong gate) fails loudly instead of quietly
 * discarding or corrupting whatever it could not place.
 */
export function applyOpenCodeOutput(output: HostOutput, live: LiveHookObjects): void {
  // Pass 1: validate every key AND every value shape this applier is about
  // to touch. No assignment happens in this loop -- only a throw (refusing
  // everything) or falling through to pass 2 (applying everything). That
  // ordering is the whole "all-or-nothing" guarantee: a key or a shape that
  // cannot be honoured is discovered before any live object has been
  // touched, regardless of where in `output` it sits.
  //
  // `Object.getOwnPropertyNames(output)`, not `Object.keys(output)` (§V5
  // review round 3, Task 4, fix round 1, Important 4) -- own, REGARDLESS OF
  // ENUMERABILITY, matching pass 3's `Object.hasOwn(output, ...)` basis
  // exactly. See this function's own doc comment, "PASS 3 READS ITS OWN-KEY
  // BASIS THE SAME WAY PASS 1 DOES", for the gap this closes and why
  // `Object.keys` alone left it open.
  for (const key of Object.getOwnPropertyNames(output)) {
    if (key === "refuse" || key === "reason") {
      continue;
    }
    // `Object.hasOwn(live, ...)` beside the `gate` compare, in this pass and
    // in pass 3 below -- see `LiveHookObjects`'s own doc comment for which of
    // the two is actually load-bearing (`Object.hasOwn`, not `gate`) and why,
    // and for why both passes check the SAME compound condition so a key
    // pass 1 accepts is never one pass 3 then silently declines to apply.
    if (key === "args" && live.gate === "request" && Object.hasOwn(live, "args")) {
      if (!isPlainObject(output.args)) {
        throw new Error(
          `apply-opencode-output: cannot apply rendered "args" -- expected an object, got ${JSON.stringify(output.args)}. ` +
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
    if (key === "result" && live.gate === "result" && Object.hasOwn(live, "result")) {
      if (!isPlainObject(output.result)) {
        throw new Error(
          `apply-opencode-output: cannot apply rendered "result" -- expected an object, got ${JSON.stringify(output.result)}`,
        );
      }
      assertNoReservedSegments(output.result, "result");
      continue;
    }
    throw new Error(
      `apply-opencode-output: cannot apply rendered key ${JSON.stringify(key)} at this gate -- opencode.hookmap.yaml ` +
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
      `apply-opencode-output: reason.text is declared-inert on this host (opencode.hookmap.yaml) and was not delivered ` +
        `to OpenCode -- reasoning: ${JSON.stringify(reason.text)}`,
    );
  }

  // Pass 3: the assignment. Nothing above threw, so every key `output`
  // carries is one this applier is about to land, and `args`/`result` are
  // both already known to be plain objects.
  //
  // NEVER BOTH AT ONCE (§V5 review round 3, Task 4, fix round 1, Important
  // 2). A render naming both `args` and `result` always fails pass 1, above,
  // now that `live` is the discriminated union rather than a bag with two
  // optional fields: whichever of the two keys does not match THIS call's
  // `live.gate` has no live half to land in, and falls to that loop's final,
  // unconditional throw. So at most one of the two `if`s just below ever
  // actually merges anything for a single call -- what lands together,
  // always, is `result`'s OWN leaf and its mirror, merged in place rather
  // than replacing a nested reference (mergeInPlace, above), never a
  // rewritten `args` beside a landed `result`.
  //
  // `Object.hasOwn(output, ...)`, not `output.args !== undefined` (see this
  // function's own doc comment, both "PASS 3 READS ITS OWN-KEY BASIS..."
  // paragraphs): an own-key check on a value that arrived over the wire
  // cannot be fooled by a polluted `Object.prototype`, exactly like pass 1's
  // `Object.getOwnPropertyNames` above it. `live.gate === ...` narrows the type and
  // documents which variant this call has; `Object.hasOwn(live, ...)`
  // beside it is the check that is actually immune to a polluted
  // `Object.prototype` on the `live` side, on any key -- see
  // `LiveHookObjects`'s own doc comment, above, for why that is the correct
  // way to say which of the two is load-bearing, not the reverse. Both run
  // in the SAME compound condition pass 1 already used to decide this key
  // was applicable, so nothing pass 1 accepted is silently declined here.
  if (Object.hasOwn(output, "args") && live.gate === "request" && Object.hasOwn(live, "args")) {
    mergeInPlace(live.args, output.args as Record<string, unknown>);
  }
  if (Object.hasOwn(output, "result") && live.gate === "result" && Object.hasOwn(live, "result")) {
    mergeInPlace(live.result, output.result as Record<string, unknown>);
  }
}
