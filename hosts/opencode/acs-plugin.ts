/**
 * acs-plugin.ts (N10) -- OpenCode's ACS plugin shim, slice V5's second host
 * against the *unchanged* adapter (packages/host-adapter).
 *
 * WHY THIS FILE IS NOT hosts/claude-code/acs-hook.ts WITH A DIFFERENT NAME.
 * Claude Code's shim is a fresh subprocess per hook: it reads one JSON object
 * on stdin, calls `resolveSessionConfig` -> `governStep`, and WRITES the
 * rendered `HostOutput` to stdout. OpenCode is a different shape of host
 * entirely -- one plugin object, loaded once, whose hook methods return
 * `void` and are handed live, mutable objects (`{args}` at the request gate,
 * `{title, output, metadata, attachments}` at the result gate). There is no
 * document to write and no exit code to set: the only channel back to
 * OpenCode is MUTATING what it handed us, or throwing. So the same rendered
 * `HostOutput`, from the same `governStep` -> `renderDecision`, is APPLIED
 * here instead of printed -- and applying it is the one piece of host
 * semantics this slice owns. `buildEnvelope`, `renderDecision`, `governStep`,
 * the hookmap format, and every check load-hookmap.ts already makes are
 * exactly the modules host #1 uses, unmodified: that is the whole claim
 * slice V5 exists to prove, and it is a claim about packages/host-adapter/src,
 * not about this file.
 *
 * TASK 4 SHIPPED THE SKELETON: the plugin factory's setup -- loading the
 * hookmap, the Guardian client, the audit sink, the negotiated session
 * config store -- `applyHostOutput`, the one function novel to this host,
 * and one load-time correctness gate this host's own applier needs
 * (`assertRefusalRendersUnconditionally`, below -- see its own doc comment).
 * TASK 5 WIRED THE REQUEST GATE, `"tool.execute.before"`: it assembles the
 * payload shape `opencode.hookmap.yaml`'s `$.` paths resolve against
 * (`{tool, session_id, callID, args}` -- OpenCode hands the plugin two
 * arguments per hook, not one blob, so THAT assembly is a shim job, the
 * same way reading stdin is host #1's), calls `resolveSessionConfig` then
 * `governStep`, and applies what comes back through `applyHostOutput`
 * below. `"tool.execute.after"` (the result gate) is Task 6's: the same
 * shape, one seam later, for `{result}` in place of `{args}`.
 *
 * THE ADAPTER-SIDE HALF OF THIS FILE'S OWN PROTOTYPE-CHAIN GUARD (below,
 * `assertNoReservedSegments`) lives at its source, corrected in
 * `packages/host-adapter/src/modifications.ts`'s own `RESERVED_SEGMENTS`
 * doc comment -- not duplicated here. (An earlier version of this header
 * claimed this file "may not edit packages/host-adapter/src"; that was
 * never true -- Global Constraint 1 freezes `packages/guardian/src`,
 * `packages/agt-bridge/src`, `policy/lib/`, `agt.lock`, `mapping.yaml`, and
 * `hosts/claude-code/`, and the adapter is not on that list. NOT
 * `policy/` whole: `policy/manifest.yaml` and `policy/manifest.drift.yaml`
 * are this deployment's own TOOL REGISTRY -- which tool names exist, not
 * what any of them may do -- and §V5 review, Task 5, fix round 1 registers
 * `bash` there, additively, beside the existing `Bash`/`run_shell` entries.
 * `policy/lib/` is the pinned policy content itself (agt.lock); that stays
 * frozen.)
 *
 * FOUR THINGS EVERY GATE TASK MUST DO THAT THIS FILE CANNOT DO FOR THEM,
 * because none of them is knowable until a hook actually fires (a fourth
 * joined the original three in §V5 review, Task 5, fix round 1 -- see its
 * own bullet, last, for why it is now load-bearing rather than a nicety):
 *
 *   - Validate `sessionID` -- present, a non-empty string -- and refuse
 *     BEFORE calling `governStep`, the TYPEOF half of what
 *     hosts/claude-code/acs-hook.ts's `main()` step 1 does for
 *     `payload.session_id`. `buildEnvelope` already throws on a missing
 *     `session_id`, but that throw lands inside `governStep`'s
 *     stage-"request" `catch` and is answered by the deployment's
 *     NEGOTIATED posture (`resolveByPosture`) -- and a negotiated `proceed`
 *     there is an ungoverned step. A missing session id is a broken
 *     deployment, not a policy question, so it has to be refused before
 *     `governStep` is ever called, not left to arrive as a payload fault it
 *     then resolves.
 *
 *     ONLY THE TYPEOF HALF, DELIBERATELY (§V5 review, Task 5, fix round 1,
 *     Minor 4). `acs-hook.ts`'s own step 1 checks the same `typeof`; its
 *     step 2 adds a SECOND check, path-safety (`assertSafeSessionId`,
 *     session-config.ts), because that host's session config store is
 *     file-backed and the raw session id becomes part of a filesystem path.
 *     This host has no counterpart to step 2: `createSessionConfigStore`
 *     (S15, this file's own header) is in memory, keyed by nothing -- the
 *     session id it is handed never becomes a filename, an argument to any
 *     filesystem call, or any string this process writes anywhere. There is
 *     no hazard for a path-safety check to close here, so this file adds
 *     none.
 *
 *     NAME THE MECHANISM (§V5 review, fix round 1, Minor 3): this host has no
 *     exit code to set. The only "blocking stop" it has is a THROW out of the
 *     hook function itself -- the same mechanism `applyHostOutput`'s own
 *     `refuse` path uses below -- because OpenCode's hooks return `void` and
 *     have no other channel to report a failure through.
 *
 *     AND AT THE RESULT GATE SPECIFICALLY, that throw -- this one, or
 *     `applyHostOutput`'s -- does not do what a reader of host #1's own
 *     "exit 2 blocks the tool call" might expect. opencode.hookmap.yaml's own
 *     header states the measurement: a throw at `tool.execute.after` stops
 *     the MODEL from ever seeing the tool's output, but OpenCode discards the
 *     plugin's mutations on that path and rebuilds `metadata` from its own
 *     pre-hook copy, so whatever the tool actually produced survives in
 *     OpenCode's own session record regardless of how early the throw fires.
 *     That is exactly why the result gate's own `deny`/`modify` withhold by
 *     REPLACING `result` (`applyHostOutput`'s merge, below) rather than by
 *     throwing. A sessionID check that refuses at the result gate is still
 *     the right call -- an ungoverned step is worse than a stop that does not
 *     scrub the disk -- but Task 6 must not read "it threw, so the secret is
 *     contained" into a result-gate throw the way that reading would be
 *     correct at the request gate.
 *   - Assemble `session_id: input.sessionID` onto the payload RAW, not
 *     pre-converted -- `buildEnvelope` reads `payload.session_id` as a
 *     hardcoded top-level field and derives the ACS uuid itself. The uuid
 *     form (`toSessionUuid(input.sessionID)`) is a DIFFERENT value, for a
 *     DIFFERENT call: `resolveSessionConfig({..., sessionId: toSessionUuid(...)})`
 *     takes the uuid; `governStep({..., sessionId})` takes the raw host id,
 *     for the audit entry (S14). Mixing the two is the exact bug class this
 *     note exists to prevent -- see acs-hook.ts's own step 4 and step 5 for
 *     both call sites side by side.
 *   - TRUST, RATHER THAN RE-CHECK, THAT deny/ask/defer AT THE REQUEST GATE
 *     CANNOT RENDER EMPTY. `assertRefusalRendersUnconditionally` (below),
 *     called from `AcsPlugin` beside `loadHookmap`, refuses this hookmap at
 *     LOAD TIME unless every one of those three decisions declares an
 *     unconditional (`value:`) output field -- `refuse.denied` in the
 *     shipped hookmap. Neither gate task needs to special-case an arriving
 *     `deny`/`ask`/`defer` that carries no (or a wrongly typed) `reasoning`:
 *     by the time either hook fires, this file has already refused to
 *     register a hookmap that could render one as `{}`, indistinguishable
 *     from a clean allow (§V5 review, fix round 1, Critical 1). The result
 *     gate's own `deny`/`modify` need no equivalent check here: they are
 *     already guaranteed a non-empty `applied_output` by construction
 *     (`withResultOutput`, result-output.ts, host-agnostic) before this file
 *     is ever reached.
 *   - HONOUR `tools`, BEFORE ANY OF THE ABOVE except validating `tool`
 *     itself. A gate whose hookmap entry declares a `tools` list must
 *     return, without building a payload, without validating `sessionID`,
 *     and without calling `resolveSessionConfig`/`governStep`, for any tool
 *     that list does not name (`isGovernedTool`, below -- see its own doc
 *     comment for what this costs and why it is right, and for the
 *     `null`-vs-`undefined` hazard fixed in §V5 review, Task 5, fix round
 *     2, Important 1). This is data-turned-behaviour, not a nicety:
 *     `policy/manifest.yaml`'s own policy target is fixed and checked
 *     before any authored rule runs, independent of the tool registry, so
 *     a gate with no `tools` check does not govern every tool it is asked
 *     about -- it denies every tool its deployment cannot express a target
 *     for, unconditionally, and calls that governance (§V5 review, Task 5,
 *     fix round 1, priority item; measured against the shipped manifest
 *     before this bullet existed). `tool` ITSELF must be validated first
 *     (`assertUsableTool`, below), ahead of `isGovernedTool` -- a malformed
 *     `tool` is not "out of scope", it is unreadable, and `Array.prototype
 *     .includes` does not throw on one: it silently answers `false`, which
 *     used to be the audited, posture-answered `buildEnvelope` throw and
 *     became a silent, unaudited proceed the moment `isGovernedTool`
 *     started intercepting every call before `governStep` (§V5 review,
 *     Task 5, fix round 2, Important 2).
 *
 * S15 -- THE STORE IS IN MEMORY, and this is the half V3 built for exactly
 * this host. The Claude Code shim is a fresh subprocess per hook, so its
 * session config store is file-backed (`createFileSessionConfigStore`); this
 * plugin is one long-lived object for the whole session (measured: OpenCode
 * calls the plugin factory once, and every hook after that fires against the
 * closure this factory returns), so the negotiated config survives in a
 * variable and the second hook of a session skips the handshake round trip
 * entirely. One interface (`SessionConfigStore`), two implementations, and
 * `resolveSessionConfig`/`governStep` never learn which host they are
 * running under -- R3.4.
 *
 * GLOBAL CONSTRAINT 4: this file may name OpenCode freely -- it is
 * host-specific by definition -- but it must not reach into `agt-bridge` or
 * `guardian`'s server-side pieces, only `host-adapter`'s public surface, and
 * it talks to the Guardian only over HTTP through `createGuardianClient`.
 * `test/invariants.test.ts`'s "every host shim imports the adapter only"
 * gate checks this mechanically, against this file by name.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import {
  createAuditSink,
  createGuardianClient,
  createSessionConfigStore,
  DEFAULT_TIMEOUT_MS,
  governStep,
  loadHookmap,
  resolveSessionConfig,
  toSessionUuid,
  type HostOutput,
  type Hookmap,
} from "host-adapter";

// Matches packages/guardian/src/main.ts's own default port, and
// hosts/claude-code/acs-hook.ts's identical constant -- the runbook and both
// shims agree on 8787 without any of the three hardcoding another's value.
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

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
 *     host's load-time gate (`assertRefusalRendersUnconditionally`, below)
 *     is what guarantees `refuse` itself is never entirely absent for a real
 *     `deny`/`ask`/`defer` -- see its own doc comment.
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

/**
 * Decisions whose ENTIRE signal to this host is a refusal: `deny`, `ask`
 * (this hookmap's own least-wrong mapping for a hook with no native "ask"),
 * and `defer` (the same, for "defer"). None of these three declares any
 * OTHER output field at the request gate -- `refuse.reason` is the whole
 * entry -- and a `from:` field renders NOTHING when its source is absent or
 * the wrong type (render-decision.ts). So an entry built only from `from:`
 * fields can, on a Guardian's minimal or malformed decision message, render
 * `{}`: this applier sees no keys at all, applies nothing, throws nothing,
 * and the tool proceeds -- indistinguishable from a clean allow.
 *
 * `allow` and `modify` are deliberately NOT in this set:
 *   - `allow` rendering `{}` IS its own meaning ("nothing to change"); there
 *     is no ambiguity a marker would resolve.
 *   - `modify` is guaranteed, by construction and host-agnostically
 *     (`resolveModify`, decision-modify.ts), to reach this render EITHER
 *     carrying a non-empty `applied_input` OR already converted into a
 *     `deny` whose `reasoning` is a guaranteed non-empty string (`deny()`,
 *     decision-message.ts) -- so it can never actually reach this host's
 *     applier as an empty render either.
 *
 * §V5 review, fix round 1, Critical 1. Measured against the shipped hookmap
 * before this set and `assertRefusalRendersUnconditionally` existed:
 * `{"decision":"deny"}` and `{"decision":"deny","reasoning":{"code":"R7"}}`
 * (a `reasoning` of the wrong type) both rendered `{}` -- applied nothing,
 * threw nothing, and the tool ran. Same for `{"decision":"ask"}`.
 */
const MUST_RENDER_UNCONDITIONALLY = new Set(["deny", "ask", "defer"]);

/**
 * Refuses to register a hookmap in which a request-gate `deny`/`ask`/`defer`
 * entry declares no unconditional (`value:`) output field -- called from
 * `AcsPlugin`, beside `loadHookmap`, so this is a LOAD-TIME stop rather than
 * a fault this shim could only discover from a live decision.
 *
 * §V5 review, fix round 1, Critical 1. This is decidable from the hookmap
 * file ALONE, with no invocation payload needed -- the same class of fault
 * this slice has now moved to a load-time check three times already
 * (`assertMirrorsWellFormed`, `assertToolsWellFormed`,
 * `assertExitStatusNotBothForms`/`assertRequestGateUnscopable`, all in
 * build-envelope.ts) rather than leaving it to surface downstream, where a
 * throw is caught by `governStep` and answered by the deployment's
 * NEGOTIATED delivery posture instead of refused outright -- and `proceed`
 * there is an ungoverned step.
 *
 * This check cannot live in `loadHookmap` itself, host-agnostically: it is
 * host #2's own rule about what THIS host's applier needs -- which decisions
 * exist and which of them can render nothing -- not a claim
 * packages/host-adapter/src may make about any host's field names (R3.2).
 * The identical reasoning is why `assertHostAcceptsEveryDecision` lives in
 * hosts/claude-code/acs-hook.ts and not in the adapter; this is host #2's
 * general form of that same rule.
 *
 * Scoped to the REQUEST gate only (an entry declaring `arguments`), mirroring
 * `acs-hook.ts`'s own asymmetry between its two gates: the result gate's own
 * `deny`/`modify` are protected a different way, by construction
 * (`withResultOutput`, result-output.ts, host-agnostic), not by a hookmap
 * shape check -- see MUST_RENDER_UNCONDITIONALLY's own doc comment.
 *
 * Checks by STRUCTURE, not by trusting the shipped field name: any
 * `deny`/`ask`/`defer` entry with at least one `{value: ...}` field passes,
 * whether that field is `refuse.denied` (this hookmap's own marker) or
 * something else entirely -- an entry naming ONLY `from:` fields, whatever
 * their paths, is what gets refused. A decision this hookmap does not
 * declare at all (`ask`/`defer` are optional; `loadHookmap`'s own
 * `assertRenderableDecisions` requires only `allow` and `deny`) has nothing
 * here to check.
 */
function assertRefusalRendersUnconditionally(hookmap: Hookmap, path: string): void {
  for (const [hookEventName, entry] of Object.entries(hookmap.hooks ?? {})) {
    const isRequestGate = isPlainObject(entry) && typeof (entry as { arguments?: unknown }).arguments === "string";
    if (!isRequestGate) {
      continue;
    }
    const decisions = (isPlainObject(entry) ? (entry as { decisions?: unknown }).decisions : undefined) ?? {};
    for (const decisionName of MUST_RENDER_UNCONDITIONALLY) {
      const rule = isPlainObject(decisions) ? (decisions as Record<string, unknown>)[decisionName] : undefined;
      const output = isPlainObject(rule) ? (rule as { output?: unknown }).output : undefined;
      if (!isPlainObject(output)) {
        // loadHookmap's own assertRenderableDecisions has already refused a
        // present-but-malformed entry (null, {}, a non-object field) or
        // required allow/deny to exist at all -- not this check's job to
        // re-report that, or to require a decision this hookmap never
        // declares.
        continue;
      }
      const hasUnconditionalField = Object.values(output).some(
        (field) => isPlainObject(field) && Object.prototype.hasOwnProperty.call(field, "value"),
      );
      if (!hasUnconditionalField) {
        throw new Error(
          `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" declares no unconditional ` +
            `"value:" output field -- every field it names is "from:", which renders NOTHING when the arriving ` +
            `decision does not carry that source field, or carries it as the wrong type (render-decision.ts). ` +
            `This host's applier would then see an empty render, apply nothing, and the tool would proceed -- a ` +
            `${decisionName} indistinguishable from a clean allow. Add a literal sibling, e.g. ` +
            `"refuse.denied: { value: true }", so this decision always renders something.`,
        );
      }
    }
  }
}

/**
 * Refuses BEFORE `resolveSessionConfig`/`governStep` are ever asked, when
 * `sessionID` is missing or not a non-empty string -- see this file's own
 * header, "THREE THINGS EVERY GATE TASK MUST DO", first bullet.
 * `buildEnvelope` already throws on a missing `session_id`, but that throw
 * lands inside `governStep`'s stage-"request" `catch` and is answered by the
 * deployment's NEGOTIATED posture (`resolveByPosture`) -- and a negotiated
 * `proceed` there is an ungoverned step. A missing session id is a broken
 * deployment, not a policy question, so both gates refuse it here, before
 * either call is made.
 *
 * THE MECHANISM IS A THROW, not an exit code (this file's header, same
 * bullet): OpenCode's hooks return `void` and have no other channel to
 * report a failure through -- the same mechanism `applyHostOutput`'s own
 * `refuse` path (above) uses to stop a tool call.
 *
 * Shared by both gates (Task 6 calls this too) rather than written twice,
 * the same way `isPlainObject` and `RESERVED_SEGMENTS` above are shared
 * rather than re-derived per gate.
 */
function assertUsableSessionId(sessionID: unknown, hookEventName: string): asserts sessionID is string {
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new Error(
      `acs-plugin: "${hookEventName}" fired with no usable sessionID (got ${JSON.stringify(sessionID)}) -- a ` +
        `missing or empty session id is a broken deployment, not a policy question, so this refuses before ` +
        `resolveSessionConfig/governStep are ever asked rather than letting buildEnvelope's throw be answered ` +
        `by the negotiated posture, where a negotiated "proceed" would be an ungoverned step`,
    );
  }
}

/**
 * True when `tool` is one this gate governs, per `hookmap.hooks[hookEventName]
 * .tools` -- undeclared (`undefined`) means "every tool", matching
 * `HookmapHookEntryCommon.tools`'s own contract (build-envelope.ts).
 *
 * §V5 review, Task 5, fix round 1 (priority item). Called from a gate hook
 * BEFORE `assertUsableSessionId`, before any payload is assembled, and
 * before `resolveSessionConfig`/`governStep` are ever asked -- a tool this
 * list does not name is a documented, deliberate NO-OP at this gate, not a
 * silent skip and not a fault this file resolves any other way.
 *
 * WHAT THIS COSTS: a tool call this gate does not govern at all. Nothing
 * here stands between the model and that tool call at this gate -- a real
 * gap, not a formality.
 *
 * WHY IT IS RIGHT ANYWAY. This deployment's own policy configuration
 * (policy/manifest.yaml, outside this package) binds its evaluation to a
 * single fixed target, checked before any of that deployment's own authored
 * rules run; a tool this deployment never registered, or whose arguments
 * that fixed target cannot resolve against, is refused there by the shape
 * mismatch alone -- unconditionally, for every such tool, never by a rule a
 * policy author wrote (see `HookmapHookEntryCommon.tools`'s own doc comment,
 * build-envelope.ts, for the measurement). Asking anyway would not govern
 * that tool call; it would deny it and call the denial governance. A gate
 * that never asks is the honest answer to "this deployment cannot express a
 * policy question for this tool" -- and the CONSEQUENCE THIS FUNCTION MUST
 * NOT CREATE is an unlisted tool reaching `governStep` regardless, to be
 * answered by the deployment's negotiated posture: that is the identical
 * fail-open shape this slice has hit four times, one call later. The skip
 * this function's caller takes runs BEFORE any envelope is built, which is
 * what keeps it a documented no-op rather than a posture-routed one.
 *
 * `?? undefined`, NOT a bare `=== undefined` check (§V5 review, Task 5, fix
 * round 2, Important 1). `assertToolsWellFormed` (build-envelope.ts)
 * normalises a bare `tools:` key -- YAML `null`, present and unusable, not
 * absent -- to `undefined` ONLY inside its own local variable, for its own
 * validation; the `Hookmap` object `loadHookmap` actually returns still
 * carries `tools: null` on that entry, because that function shape-checks
 * rather than rewrites. `null === undefined` is `false`, so a bare `!==
 * undefined` read here fell through to `null.includes(tool)` and threw
 * `TypeError: null is not an object` on EVERY call to this gate -- naming
 * neither the hookmap nor the field, and contradicting both this function's
 * own contract ("undeclared means every tool") and the load-time checker's
 * stated intent. Measured end to end against a hookmap whose request gate
 * declares a bare `tools:`. Not reachable through the SHIPPED hookmap
 * (which declares `tools: [bash]`, never bare), but load-time-decidable
 * faults belong caught at load time or handled defensively here, not left
 * to crash a hook that already loaded -- the same rule this slice states
 * for every other hookmap-shape hazard.
 */
function isGovernedTool(hookmap: Hookmap, hookEventName: string, tool: string): boolean {
  const tools = hookmap.hooks[hookEventName]?.tools ?? undefined;
  return tools === undefined || tools.includes(tool);
}

/**
 * Refuses BEFORE `isGovernedTool` is ever asked, when `tool` is not a
 * non-empty string -- the same shape as `assertUsableSessionId`, above, and
 * for a matching reason (§V5 review, Task 5, fix round 2, Important 2).
 *
 * WITHOUT THIS, `isGovernedTool`'s OWN CHECK SILENTLY ABSORBED THE FAULT.
 * `Array.prototype.includes` never throws on a non-string needle -- a
 * malformed `tool` (this host's own contract types `input.tool: string`,
 * but nothing enforces that at the boundary a hook actually fires across)
 * simply reads as "not in this gate's `tools` list" and the caller returns,
 * the identical no-op path a genuinely out-of-scope tool takes. MEASURED,
 * before `isGovernedTool` existed: a malformed `tool` reached
 * `buildEnvelope`, which throws when `tool_name`'s path does not resolve to
 * a string; that throw lands in `governStep`'s stage-"request" `catch` and
 * is answered by the deployment's negotiated posture -- AUDITED regardless
 * of which way the posture resolved, and a negotiated `deny` posture would
 * have blocked. `isGovernedTool`'s clean, silent `false` for this one
 * malformed shape converted an audited, posture-answered decision into an
 * UNAUDITED, silent proceed -- the exact asymmetry this file otherwise
 * refuses: a missing `sessionID` is a hard throw a few lines later; a
 * missing `tool` was a no-op. This closes it, in the identical shape, so a
 * broken host contract for `tool` is refused the same way a broken one for
 * `sessionID` already is -- a THROW, this host's only blocking mechanism,
 * never a fault that reaches `governStep` to be routed through a posture.
 *
 * Generic over `hookEventName`, exactly like `assertUsableSessionId`, so
 * Task 6 calls this unchanged for the result gate.
 */
function assertUsableTool(tool: unknown, hookEventName: string): asserts tool is string {
  if (typeof tool !== "string" || tool.length === 0) {
    throw new Error(
      `acs-plugin: "${hookEventName}" fired with no usable tool name (got ${JSON.stringify(tool)}) -- a missing ` +
        `or empty tool name is a broken deployment, not a policy question, so this refuses before isGovernedTool ` +
        `or governStep are ever asked rather than letting a malformed value read as "not in this gate's tools ` +
        `list" and silently proceed ungoverned and unaudited`,
    );
  }
}

/**
 * OpenCode's plugin entry point: loads the hookmap and this deployment's
 * long-lived collaborators once, and returns the hooks OpenCode calls for
 * the rest of the session's lifetime.
 *
 * A throw here -- an unreadable or invalid hookmap (`loadHookmap` shape-checks
 * everything statically decidable from the hookmap file alone, and
 * `assertRefusalRendersUnconditionally` adds this host's own such check) --
 * fails plugin registration itself, before any hook can fire: the same
 * "broken deployment, not a policy question" stop `BlockingConfigurationError`
 * /exit 2 is for on host #1, reached at the equivalent point in this host's
 * own lifecycle -- load time, never per-invocation.
 */
export const AcsPlugin: Plugin = async () => {
  // Override with ACS_HOOKMAP_PATH to point this shim at a different hookmap
  // -- same convention as hosts/claude-code/acs-hook.ts. Read HERE, inside
  // the factory, rather than at module scope (unlike acs-hook.ts's own
  // HOOKMAP_PATH): this plugin factory is a plain function a test can call
  // directly, with no subprocess boundary forcing a fresh module evaluation
  // per test the way spawning acs-hook.ts does for its own suite, so a
  // module-scope constant would freeze whatever ACS_HOOKMAP_PATH was at
  // import time and ignore anything a test set afterwards.
  const hookmapPath = process.env.ACS_HOOKMAP_PATH ?? fileURLToPath(new URL("./opencode.hookmap.yaml", import.meta.url));
  const hookmap = loadHookmap(hookmapPath);
  assertRefusalRendersUnconditionally(hookmap, hookmapPath);

  const guardian = createGuardianClient(process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL);
  const audit = createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" });
  // S15 -- IN MEMORY, and this is the half V3 built for exactly this host. See
  // this file's own header for the measured reason: one plugin object per
  // session, so the negotiated config survives in a variable and the second
  // hook of a session skips the handshake round trip. One interface, two
  // implementations, and the adapter never learns which host is running.
  const store = createSessionConfigStore();

  return {
    // Task 6 fills in this hook's sibling, "tool.execute.after" (the result
    // gate). See this file's own header, "FOUR THINGS EVERY GATE TASK MUST
    // DO", for what `assertUsableSessionId`/`assertUsableTool`, the `tools`
    // bullet, and the two `sessionId` forms below have to do and why -- and
    // for why a throw at the result gate specifically does not mean what it
    // means here.
    "tool.execute.before": async (input, output) => {
      // `tool` first, ahead of the `tools` check below (§V5 review, Task 5,
      // fix round 2, Important 2): `isGovernedTool` cannot tell a malformed
      // `tool` from a genuinely out-of-scope one, so a broken host contract
      // for `tool` has to be refused here, the same "broken deployment"
      // shape `assertUsableSessionId` already gives `sessionID` -- see
      // `assertUsableTool`'s own doc comment for the measured asymmetry
      // this closes.
      assertUsableTool(input.tool, "tool.execute.before");

      // A tool this gate's own `tools` list does not name is NOT governed
      // here -- return before anything else, without building an envelope
      // or asking the Guardian anything. See `isGovernedTool`'s own doc
      // comment for what this costs and why it is right anyway (§V5 review,
      // Task 5, fix round 1, priority item).
      if (!isGovernedTool(hookmap, "tool.execute.before", input.tool)) {
        return;
      }

      assertUsableSessionId(input.sessionID, "tool.execute.before");

      // ONE payload object so opencode.hookmap.yaml's `$.` paths ($.tool,
      // $.args) have a single thing to resolve against -- OpenCode hands
      // this hook `{tool, sessionID, callID}` and a separate, mutable
      // `{args}`; assembling the two into one object is the shim's own job
      // (this file's header). `session_id`, RAW and not pre-converted:
      // `buildEnvelope` reads `payload.session_id` as a hardcoded top-level
      // field and derives the ACS uuid itself -- see this file's header,
      // second bullet, for why the raw host id and the derived uuid must
      // never be mixed.
      const payload = { tool: input.tool, session_id: input.sessionID, callID: input.callID, args: output.args };

      const session = await resolveSessionConfig(
        { guardian, agentId: hookmap.host, sessionId: toSessionUuid(input.sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
        store,
      );

      const governed = await governStep({
        hookEventName: "tool.execute.before",
        payload,
        hookmap,
        guardian,
        session,
        // RAW, the other of the two `sessionId` forms this file's header
        // warns against mixing -- this one is for the audit entry (S14),
        // never the uuid `resolveSessionConfig` above was given.
        sessionId: input.sessionID,
        audit,
      });

      applyHostOutput(governed.output, { args: output.args });
    },
  };
};
