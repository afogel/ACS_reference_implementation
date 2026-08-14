/**
 * acs-plugin.ts (N10) -- OpenCode's ACS plugin shim, slice V5's second host
 * against packages/host-adapter -- SHARED with host #1, not forked for this
 * one (see below for the precise claim that is, not the looser "unchanged"
 * an earlier version of this header made).
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
 * semantics this slice owns.
 *
 * THE ADAPTER IS NOT "UNCHANGED" (§V5 final review, F3). Named by what
 * changed rather than by how many files did: `loadHookmap` went from ONE
 * load-time gate (`assertRenderableDecisions`) to FIVE (plus
 * `assertMirrorsWellFormed`, `assertToolsWellFormed`,
 * `assertExitStatusNotBothForms`, `assertRequestGateDeclaresNoOutputs`) and
 * now returns a normalised hookmap rather than the raw YAML parse tree;
 * `exit_status` gained a second, `from:` form beside its original
 * `literal:`; `outputs.mirrors` was added and is read by the projection
 * side; and `governStep` gained the `tools` skip both shims now share
 * (`governsTool`). So `buildEnvelope`, the hookmap format, every load-time
 * check, and the step exchange itself are NOT the unmodified set an earlier
 * claim here named.
 *
 * NO COUNT OF ANY KIND QUOTED HERE (§V5 review round 3, fix round 2, and
 * again in Task 2). An earlier version of this paragraph quoted an
 * insertion/deletion count, and it went stale three times in three
 * consecutive commits on this exact line (+962/-62, then +1026/-63, then
 * wrong again the moment the SECOND correction landed). Retiring that
 * number left a FILE count -- "FOUR of its files ... only render-decision.ts
 * and govern-step.ts are genuinely untouched" -- which was the same defect
 * one size smaller, and it went stale within the same review round: Task 2
 * edits govern-step.ts. Nothing pins either figure, and Task 3 still edits
 * this package. What this paragraph actually needs -- no per-host fork, and
 * host #1's own source at +0/-0, mechanically pinned by
 * scripts/verify-zero-diff.sh -- carries the claim without any number. For a
 * current one, on demand:
 * `git diff --stat slice/v4 HEAD -- packages/host-adapter/src/`.
 *
 * THE CLAIM THAT IS ACTUALLY TRUE, AND STRONGER THAN "UNCHANGED": this
 * second host cost no PER-HOST FORK. Every one of those changes landed in
 * packages/host-adapter/src -- the package BOTH hosts run -- not in a
 * host #2-specific copy of anything, and host #1's own source
 * (hosts/claude-code/acs-hook.ts, hosts/claude-code/claude-code.hookmap.yaml)
 * is +0/-0: host #1 gained only two additive test files, and nothing in its
 * own shipped source changed to make host #2 work. That is what R3.4
 * actually argues (docs/shaping/acs-reference-impl-shaping.md's own R3.4
 * row) -- not that the adapter never moved, but that whatever moved, moved
 * once, in code both hosts share, rather than being forked per host. That is
 * the claim this file rests on.
 *
 * TASK 4 SHIPPED THE SKELETON: the plugin factory's setup -- loading the
 * hookmap, the Guardian client, the audit sink, the negotiated session
 * config store -- `applyOpenCodeOutput`, the one function novel to this host,
 * and one load-time correctness gate this host's own applier needs
 * (`assertHostAcceptsEveryDecision`, below -- see its own doc comment; it
 * shipped as `assertRefusalRendersUnconditionally`, covering the request gate
 * alone, and §V5 review round 3, Task 5 generalised it to both gates).
 * TASK 5 WIRED THE REQUEST GATE, `"tool.execute.before"`: it assembles the
 * payload shape `opencode.hookmap.yaml`'s `$.` paths resolve against
 * (`{tool, session_id, callID, args}` -- OpenCode hands the plugin two
 * arguments per hook, not one blob, so THAT assembly is a shim job, the
 * same way reading stdin is host #1's), calls `resolveSessionConfig` then
 * `governStep`, and applies what comes back through `applyOpenCodeOutput`
 * (`apply-opencode-output.ts`, imported below -- see ITS OWN header for why it
 * is not defined in this file). TASK 6 WIRED `"tool.execute.after"` (the
 * result gate): the same shape, one seam later, for `{result}` (the live
 * `{title, output, metadata, attachments}` object) beside `{args}`, plus
 * `outputs.mirrors` (Task 2) so a redaction lands the leaf and its
 * `metadata.output` mirror together. BOTH GATES ARE WIRED -- this paragraph
 * described the second as pending long after it shipped, which §V5 review
 * round 3, Task 5, fix round 1, Minor 2 caught; the tense is the record of
 * which task built what, not a statement about what is left to do.
 *
 * AND §V5 REVIEW ROUND 3'S OWN TASK 6 -- a DIFFERENT task from the one named
 * two sentences up, which is why it is dated -- MERGED THE TWO BODIES
 * (thread 3773262484). Both hooks made the same seven moves in the same
 * order, written out twice; they are one module-private function now
 * (`runExchange`, at the bottom of this file, beside the factory that calls it),
 * and each hook method is the edge that names its own event, assembles its
 * own payload, and constructs its own live half. OpenCode's `Plugin` type
 * needs two method names; it never needed two copies of the exchange behind
 * them -- host #1 already had the merged shape, one `main()` reading
 * `hook_event_name` off the payload it was handed.
 *
 * THE ADAPTER-SIDE HALF OF `apply-opencode-output.ts`'s OWN PROTOTYPE-CHAIN
 * GUARD (`assertNoReservedSegments`, in that file, wrapping the imported
 * `findReservedKey`) lives at its source: `reserved-segments.ts`
 * (`packages/host-adapter/src/`), the one shared definition of the three
 * reserved names and the value-tree walker that checks a rendered value
 * against them (§V5 review round 3, Task 3 -- it used to be a doc comment on
 * `modifications.ts`'s own now-retired, module-private copy, naming this
 * OpenCode file as where the guard it pointed at actually lived; a shared
 * package pointing at one host's source for a security invariant was the
 * wrong abstraction). Not duplicated here. (An earlier version of this header
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
 * own bullet, last, for why it is now load-bearing rather than a nicety).
 *
 * DONE ONCE FOR BOTH GATES SINCE §V5 REVIEW ROUND 3, TASK 6, not once per
 * gate: `runExchange` (bottom of this file) is the single function both hook
 * methods call, so all four happen in one place rather than in two hook
 * bodies that had to be kept in step by hand. Still not something this file
 * can do at LOAD time, which is what this heading has always been about --
 * each of the four is a property of a firing hook, so a load-time check
 * cannot make any of them:
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
 *     This host has no counterpart to step 2: `createMemorySessionConfigStore`
 *     (S15, this file's own header) is in memory, keyed by nothing -- the
 *     session id it is handed never becomes a filename, an argument to any
 *     filesystem call, or any string this process writes anywhere. There is
 *     no hazard for a path-safety check to close here, so this file adds
 *     none.
 *
 *     NAME THE MECHANISM (§V5 review, fix round 1, Minor 3): this host has no
 *     exit code to set. The only "blocking stop" it has is a THROW out of the
 *     hook function itself -- the same mechanism `applyOpenCodeOutput`'s own
 *     `refuse` path uses (apply-opencode-output.ts) -- because OpenCode's hooks
 *     return `void` and have no other channel to report a failure through.
 *
 *     AND AT THE RESULT GATE SPECIFICALLY, that throw -- this one, or
 *     `applyOpenCodeOutput`'s -- does not do what a reader of host #1's own
 *     "exit 2 blocks the tool call" might expect. opencode.hookmap.yaml's own
 *     header states the measurement: a throw at `tool.execute.after` stops
 *     the MODEL from ever seeing the tool's output, but OpenCode discards the
 *     plugin's mutations on that path and rebuilds `metadata` from its own
 *     pre-hook copy, so whatever the tool actually produced survives in
 *     OpenCode's own session record regardless of how early the throw fires.
 *     That is exactly why the shipped hookmap's result-gate `deny`/`modify`
 *     withhold by REPLACING `result` (`applyOpenCodeOutput`'s merge, in
 *     apply-opencode-output.ts) rather than by throwing -- and why this file's own
 *     `assertHostAcceptsEveryDecision`'s message for that gate says which of
 *     the two an author is choosing rather than treating them as equivalent.
 *     A sessionID check that refuses at the result gate is still the right call
 *     -- an ungoverned step is worse than a stop that does not scrub the disk
 *     -- but NOBODY READING A RESULT-GATE THROW may read "it threw, so the
 *     secret is contained" into it the way that reading would be correct at
 *     the request gate. (This sentence addressed "Task 6" in the future tense
 *     long after that task shipped; §V5 review round 3, Task 5, fix round 2,
 *     Minor -- the same class as the two tenses fix round 1 corrected, outside
 *     the lines that finding named.)
 *   - Assemble `session_id: input.sessionID` onto the payload RAW, not
 *     pre-converted -- `buildEnvelope` reads `payload.session_id` as a
 *     hardcoded top-level field and derives the ACS uuid itself. The uuid
 *     form (`toSessionUuid(input.sessionID)`) is a DIFFERENT value, for a
 *     DIFFERENT call: `resolveSessionConfig({..., sessionId: toSessionUuid(...)})`
 *     takes the uuid; `governStep({..., sessionId})` takes the raw host id,
 *     for the audit entry (S14). Mixing the two is the exact bug class this
 *     note exists to prevent -- see acs-hook.ts's own step 4 and step 5 for
 *     both call sites side by side.
 *   - TRUST, RATHER THAN RE-CHECK, THAT A DECISION THAT MUST REFUSE, WITHHOLD
 *     OR REWRITE HAS SOMEWHERE TO DO IT. `assertHostAcceptsEveryDecision`
 *     (below), called from `AcsPlugin` beside `loadHookmap`, refuses this
 *     hookmap at LOAD TIME unless every one of these holds (deliberately not
 *     counted -- this list has grown twice and a quoted count went stale each
 *     time, §V5 review round 3, Task 5, fix rounds 3 and 4):
 *
 *       * every request-gate `deny`/`ask`/`defer` declares an unconditional
 *         (`value:`) output field under `refuse` -- `refuse.denied` in the
 *         shipped hookmap. These three have nothing to LAND, so refusing is
 *         the only honest outcome open to them;
 *       * every result-gate `ask`/`defer` declares that same unconditional
 *         refusal, for the identical reason -- `withResultOutput` never
 *         attaches an `applied_output` to either, so nothing arrives for them
 *         to land there either (§V5 review round 3, Task 5, fix round 3);
 *       * every request-gate `modify` EITHER declares
 *         `args: { from: applied_input }` OR declares that same unconditional
 *         refusal;
 *       * every result-gate `deny`/`modify` EITHER declares
 *         `result: { from: applied_output }` OR declares that same
 *         unconditional refusal;
 *       * every decision name either table names, or `allow`, and nothing
 *         else -- a declared decision this shim has no expectation for is a
 *         throw, not a skip, the same rule `expectationFor` states for an
 *         unknown hook (§V5 review round 3, Task 5, fix round 4);
 *       * and each hook's ENTRY matches the gate this shim runs it as: the
 *         request hook declares `arguments` and not `outputs`, the result hook
 *         declares `outputs` and not `arguments`, and the `$.` paths this
 *         shim's own payload assembly fixes (`tool_name`, `arguments`,
 *         `outputs.within`) name what it actually assembled. See
 *         `GateEntryShape` below -- without those, the sinks above are
 *         unfillable, or fillable with the wrong thing, however correctly they
 *         are declared.
 *
 *     "EITHER ... OR" is the rule, not a convenience (§V5 review round 3,
 *     Task 5, fix round 2): landing what a decision arrived carrying and
 *     refusing outright are both honest; the SILENT NO-OP is the only
 *     unacceptable outcome, and it is what every finding in this task has
 *     actually been about. See `satisfiesGate` (below) for why over-refusal
 *     is a costly direction to err in on THIS host specifically.
 *
 *     Where a sink is declared it must be the EXACT KEY, the EXACT SOURCE,
 *     and a declaration that can actually RENDER -- see `declaresSinkFrom`
 *     (below) for why all of those are load-bearing and what each one was
 *     measured to leak without.
 *
 *     WHICH DECISION MAY DECLARE WHICH is not a list of special cases either:
 *     it is one question, asked per decision per gate -- what does this
 *     decision ARRIVE CARRYING here? -- answered by the `CARRIED_AT_*` tables
 *     below and by nothing else. Six variants of one fail-open reached this
 *     gate before that was written down.
 *     Neither gate task needs to special-case an arriving decision that
 *     carries no (or a wrongly typed) `reasoning`: by the time either hook
 *     fires, this file has already refused to register a hookmap that could
 *     render one as `{}`, indistinguishable from a clean allow (§V5 review,
 *     fix round 1, Critical 1).
 *
 *     EVERYTHING PAST THE FIRST BULLET IS NEW, AND THIS BULLET USED TO
 *     ARGUE AGAINST THE RESULT GATE'S (§V5 review round 3, Task 5, Critical).
 *     It said the result gate's own `deny`/`modify` "need no equivalent check
 *     here: they are already guaranteed a non-empty `applied_output` by
 *     construction (`withResultOutput`, result-output.ts, host-agnostic)".
 *     That guarantee is real and it is about the DECISION MESSAGE; it says
 *     nothing about the HOOKMAP declaring an output path to land it in.
 *     Measured: a result gate one block different from the shipped one --
 *     `deny` declaring only `reason.text` -- loaded clean, and a real Guardian
 *     deny then applied nothing and threw nothing, delivering the tool's
 *     output in the leaf and its `metadata.output` mirror both. Fix round 1 of
 *     that same task then found three more members of the identical class the
 *     first gate still accepted -- a `result` sourced from the wrong field,
 *     an `ask`/`defer` DECLARED at the result gate with no sink, and the
 *     request gate's own `modify` -- each measured before it was closed. See
 *     `assertHostAcceptsEveryDecision`'s own doc comment (below, this file).
 *   - HONOUR `tools`, BEFORE ANY OF THE ABOVE except validating `tool`
 *     itself. A gate whose hookmap entry declares a `tools` list must
 *     return, without building a payload, without validating `sessionID`,
 *     and without calling `resolveSessionConfig`/`governStep`, for any tool
 *     that list does not name (`governsTool`, imported from the adapter --
 *     see its own doc comment, govern-step.ts, for what this costs and why
 *     it is right). This is data-turned-behaviour, not a nicety:
 *     `policy/manifest.yaml`'s own policy target is fixed and checked
 *     before any authored rule runs, independent of the tool registry, so
 *     a gate with no `tools` check does not govern every tool it is asked
 *     about -- it denies every tool its deployment cannot express a target
 *     for, unconditionally, and calls that governance (§V5 review, Task 5,
 *     fix round 1, priority item; measured against the shipped manifest
 *     before this bullet existed).
 *
 *     THE RULE IS THE ADAPTER'S NOW, THE EARLY RETURN IS STILL THIS FILE'S
 *     (§V5 review round 3, Task 2). This bullet used to describe a function
 *     defined in this file, `isGovernedTool`, and that was the finding:
 *     `tools` was hookmap vocabulary the adapter shape-checked and only this
 *     shim enacted, so a third host copied from a shim would load a `tools`
 *     list and govern every tool anyway. `governStep` now asks `governsTool`
 *     itself and returns an empty output for a tool it does not govern, so
 *     that third host inherits the skip instead of copying it. The call
 *     below stays because of what it saves rather than what it decides: it
 *     is the only one early enough to skip `assertUsableSessionId` and the
 *     session handshake as well as the envelope.
 *
 *     TWO CALL SITES, ONE RULE, AND SINCE §V5 review round 4 (thread
 *     3778055539) ONE ARGUMENT TOO. This file used to pass `input.tool`,
 *     OpenCode's own field, while `governStep` re-derived a name by resolving
 *     this hook's `tool_name` path against the payload assembled below --
 *     two questions off two sources, agreeing only because
 *     opencode.hookmap.yaml's `tool_name: $.tool` happens to name the very
 *     field this file reads. MEASURED with `tool_name: $.args.command`
 *     beside `tools: [bash]` (§V5 review round 3, Task 5, fix round 4 --
 *     found while measuring that round's directed findings, not on its
 *     list): this file's own `governsTool` answered TRUE on `input.tool` and
 *     proceeded, `governStep` resolved `tool_name` to the command, asked the
 *     same function, got FALSE, and returned `stage: "ungoverned"` -- no
 *     Guardian request, no decision, no audit entry, `rm -rf /` through.
 *     `runExchange` now TELLS `governStep` the tool it scoped on
 *     (`scopedTool`), so the adapter asks about that value and no other, and
 *     a caller reaching a gate that declares `tools` without telling is
 *     refused there outright. The divergence is closed in the ADAPTER, which
 *     is where the two-ask pattern lived; `assertEntryMatchesGate` (below)
 *     still refuses a `tool_name` that is anything but `$.tool`, for what it
 *     still says -- see its own note. See `governsTool`'s doc comment
 *     (govern-step.ts).
 *
 *     `tool` ITSELF must be validated first (`assertUsableTool`, below),
 *     ahead of the `tools` check -- a malformed `tool` is not "out of
 *     scope", it is unreadable, and `Array.prototype.includes` does not
 *     throw on one: it silently answers `false`, which used to be the
 *     audited, posture-answered `buildEnvelope` throw and became a silent,
 *     unaudited proceed the moment a `tools` check started intercepting
 *     every call before `governStep` (§V5 review, Task 5, fix round 2,
 *     Important 2).
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
  createMemorySessionConfigStore,
  DEFAULT_TIMEOUT_MS,
  governStep,
  // The `tools` rule, as the adapter states it (§V5 review round 3, Task 2)
  // -- this file used to carry its own copy, `isGovernedTool`. Called from
  // `runExchange` (below), exactly where each hook body used to call that copy
  // before Task 6 merged the two, and for what the earlier call buys rather
  // than for what it decides: `governStep` asks the same function itself,
  // about the very value this call site passes it (`scopedTool`, §V5 review
  // round 4), so a shim that forgot would still skip -- but only this call
  // site is early enough to skip the session validation and the handshake too.
  governsTool,
  loadHookmap,
  resolveSessionConfig,
  toSessionUuid,
  // `AuditSink`/`GuardianClient`/`SessionConfigStore` -- the three
  // collaborators `AcsPlugin`'s factory builds once and hands `runExchange` on
  // every call (`Deployment`, below). Named by the adapter's own published
  // types rather than by `ReturnType<typeof create...>`: what `runExchange` depends
  // on is the INTERFACES, which is the whole reason the in-memory and
  // file-backed session config stores are interchangeable at all (S15).
  type AuditSink,
  type GuardianClient,
  type Hookmap,
  type SessionConfigStore,
} from "host-adapter";
// applyOpenCodeOutput (named for this host, §V5 review round 3, Task 4 --
// it was `applyHostOutput` before that task; see apply-opencode-output.ts's own
// header, top, for why a generic name was the wrong one), and every private
// helper it alone needs, moved to apply-opencode-output.ts (§V5 review, Task 8,
// fix round 1, Important 1) -- see that file's own header for why exporting
// it from THIS module was a hazard rather than a convenience, and
// test/invariants.test.ts's new gate for what now keeps this file's export
// surface to exactly one symbol.
import { applyOpenCodeOutput, type LiveHookObjects } from "./apply-opencode-output.ts";

// Matches packages/guardian/src/main.ts's own default port, and
// hosts/claude-code/acs-hook.ts's identical constant -- the runbook and both
// shims agree on 8787 without any of the three hardcoding another's value.
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * THE RULE THIS WHOLE GATE HAS ALWAYS BEEN ABOUT, WRITTEN DOWN AS A TABLE
 * INSTEAD OF DISCOVERED ONE SHAPE AT A TIME (§V5 review round 3, Task 5, fix
 * round 3).
 *
 * Six variants of one fail-open reached this gate across four rounds, each
 * satisfying the letter of the rule that closed the last. The reason they kept
 * coming is that the rules were written as LISTS OF ACCEPTED SHAPES. Stated as
 * an invariant instead, and applied per decision per gate:
 *
 *     A declared decision must be able to LAND what it actually arrives
 *     carrying at THIS gate, or to UNCONDITIONALLY REFUSE. The silent no-op
 *     is the only unacceptable outcome.
 *
 * Which makes the whole gate one question asked twice: WHAT DOES THIS DECISION
 * ARRIVE CARRYING HERE? These two tables answer it, and nothing below decides
 * it ad hoc.
 *
 *   - A decision field name means: it arrives carrying that field, so it may
 *     land it (a correctly-declared sink) or refuse.
 *   - `null` means: it arrives carrying NOTHING this host could land, so
 *     refusing is the only honest shape open to it -- exactly the rule the
 *     request gate's `deny`/`ask`/`defer` have had since §V5 review fix
 *     round 1's Critical 1.
 *   - Absent from the table means: not this check's business. `allow` is the
 *     only such decision, at either gate, and deliberately -- rendering
 *     nothing IS its own meaning ("nothing to change" / "deliver the output as
 *     the tool produced it"), which is the same distinction `acs-hook.ts`'s
 *     `emptyOutputIsHonest` draws between host #1's two gates.
 *
 * VARIANT 6 IS WHAT FORCED THE TABLE, and it is the one this gate itself
 * MANDATED. Fix round 1 widened the result gate's rule to include `ask` and
 * `defer` without asking whether the sink it demands can ever be FILLED for
 * them. It cannot: `withResultOutput` (result-output.ts) attaches
 * `applied_output` for `deny` alone, throws for a `modify` arriving without
 * one, and returns everything else -- `allow`, `ask`, `defer` -- UNTOUCHED. So
 * `result: { from: applied_output }` on a result-gate `ask`, the exact
 * declaration this gate required, renders no `result` key at all. Measured
 * (result-gate.test.ts): applier applies nothing, throws nothing, secret in
 * leaf and mirror -- variant 1's exact observable, reached through the
 * mandated declaration. A table that says what each decision CARRIES makes
 * that unwritable; a list of shapes did not.
 */
type DecisionCarries = ReadonlyMap<string, string | null>;

/**
 * The decisions this gate asks nothing of, and the ONLY ones it may leave
 * unasked -- named as a set rather than left implicit, because §V5 review round
 * 3, Task 5, fix round 4 (Important 7A) found the implicit version silently
 * covering every decision name the tables happened not to list.
 *
 * `allow` is the whole set, at both gates. Rendering nothing IS its own meaning
 * there ("nothing to change" at the request gate, "deliver the output as the
 * tool produced it" at the result gate) -- the same distinction `acs-hook.ts`'s
 * `emptyOutputIsHonest` draws between host #1's two gates. Anything else a
 * hookmap declares is either in a `CARRIED_AT_*` table or refused.
 */
const ALWAYS_HONEST_DECISIONS: ReadonlySet<string> = new Set(["allow"]);

/**
 * THE REQUEST GATE (`tool.execute.before`), where the live half is `args`.
 *
 * `deny`/`ask`/`defer` carry nothing to land: the step has not run, there is
 * no output to replace, and none of the three carries an `applied_input`.
 * Refusing is the only honest shape, and a `from:`-only `refuse` block is not
 * one -- a `from:` field renders NOTHING when its source is absent or the
 * wrong type (render-decision.ts), so an entry built only from `from:` fields
 * can render `{}` on a Guardian's minimal or malformed decision message: this
 * applier sees no keys at all, applies nothing, throws nothing, and the tool
 * proceeds, indistinguishable from a clean allow. Measured against the shipped
 * hookmap before any of this existed (§V5 review, fix round 1, Critical 1):
 * `{"decision":"deny"}` and `{"decision":"deny","reasoning":{"code":"R7"}}` (a
 * `reasoning` of the wrong type) both rendered `{}`. Same for
 * `{"decision":"ask"}`.
 *
 * `modify` DOES carry something here -- `applied_input`, guaranteed non-empty
 * by `resolveModify` (decision-modify.ts) or already converted to a `deny` --
 * so it may land it or refuse. That guarantee is about the DECISION MESSAGE
 * and says nothing about the hookmap declaring a path for it: measured (§V5
 * review round 3, Task 5, fix round 1, Important 2), a `modify` declaring only
 * `reason.text` renders `{}`, the tool runs unrewritten, and `governStep` still
 * reports `stage: "honoured"` -- so the audit trail records the rewrite as
 * honoured rather than as never landed.
 */
const CARRIED_AT_REQUEST_GATE: DecisionCarries = new Map([
  ["deny", null],
  ["ask", null],
  ["defer", null],
  ["modify", "applied_input"],
]);

/**
 * THE RESULT GATE (`tool.execute.after`), where the live half is `result`.
 *
 * `deny` and `modify` carry `applied_output` -- the whole patched clone of the
 * object at `outputs.within`, leaf and mirror both replaced. `deny` gets one
 * attached by `withResultOutput`; `modify` must already have one or that
 * function throws. Either may land it or refuse.
 *
 * `ask` AND `defer` CARRY NOTHING HERE, WHICH IS THE CORRECTION THIS TABLE
 * EXISTS FOR (§V5 review round 3, Task 5, fix round 3, Critical 6a).
 * `withResultOutput` returns them untouched. An earlier version of this file
 * claimed the opposite in as many words -- "All of them arrive carrying the
 * whole patched container on `applied_output` ... and on this host all of them
 * land the same way" -- and then required a sink that can never be filled for
 * two of the four. RETRACTED: that sentence was false for `ask`/`defer` under
 * any entry, and false for all four under an entry declaring no `outputs`
 * block at all (see `assertEntryMatchesGate`, below, for that second
 * face). Both were measured delivering the secret in leaf and mirror.
 *
 * So `ask`/`defer` are held to the refusal branch alone here, exactly as the
 * request gate's own three are, and for the identical reason: nothing arrives
 * for them to land. Round 2 legalised that branch, which is what makes this a
 * correction rather than a new prohibition -- a hookmap declaring
 * `ask`/`defer` at this gate has a shape it can honestly use.
 */
const CARRIED_AT_RESULT_GATE: DecisionCarries = new Map([
  ["deny", "applied_output"],
  ["modify", "applied_output"],
  ["ask", null],
  ["defer", null],
]);

/** One decision's declared `output` block, as this gate reads it off a loaded
 * hookmap, or `undefined` when there is nothing here to check.
 *
 * `undefined` covers two cases this gate deliberately does not report on: a
 * decision the hookmap never declares (`ask`/`defer`/`modify` are optional --
 * `loadHookmap`'s own `assertRenderableDecisions` requires only `allow` and
 * `deny`), and a present-but-malformed entry, which that same function has
 * already refused with a better message than anything here could give. */
function declaredOutputFor(decisions: unknown, decisionName: string): Record<string, unknown> | undefined {
  const rule = isPlainObject(decisions) ? decisions[decisionName] : undefined;
  const output = isPlainObject(rule) ? (rule as { output?: unknown }).output : undefined;
  return isPlainObject(output) ? output : undefined;
}

/**
 * Whether `output` declares the merge sink `sinkKey`, SOURCED FROM
 * `sourceField` -- the shared predicate behind both of this file's
 * "can this decision actually land what it arrived carrying" rules (the result
 * gate's `result`/`applied_output`, and the request gate's `modify`
 * `args`/`applied_input`).
 *
 * BOTH HALVES ARE LOAD-BEARING, AND THE FIRST VERSION OF THIS CHECK ONLY HAD
 * THE FIRST (§V5 review round 3, Task 5, fix round 1, Critical 1 -- this
 * task's own Critical, surviving through the gate built to close it).
 *
 *   - THE EXACT KEY, not a path leading with it. `applyOpenCodeOutput` merges
 *     the rendered value at this key onto the live object; a path naming
 *     something UNDER it (`result.output`, `args.command`) renders a NESTED
 *     object, which the applier merges one level too deep -- landing the whole
 *     container in a field that holds a leaf, and leaving the mirror unwritten.
 *     Measured for `result.output` (result-gate.test.ts): the mirror keeps the
 *     tool's own output.
 *   - THE SOURCE FIELD, not merely that some source is named. A `from:` field
 *     renders NOTHING when the arriving decision does not carry that source
 *     (render-decision.ts) -- which is the reasoning the request gate's own
 *     refusal rule was already written around, and which the result gate's
 *     first rule inherited none of. `result: { from: applied_input }` declares
 *     the right key against a field a result-gate decision never carries, and
 *     is one copy-paste from the request gate's own `args: { from:
 *     applied_input }` in the same file. MEASURED, through the real chain
 *     against a live Guardian: a real `deny` renders no `result` key at all,
 *     the applier applies nothing and throws nothing, and `rm -rf /` is
 *     delivered in the leaf AND its mirror.
 *   - NO `type:`, OR `type: "object"`. `type` is a `typeof` filter, and
 *     `renderDecision` DROPS a `from:` field whose carried value fails it --
 *     the same `continue` an absent source takes. `applied_output` and
 *     `applied_input` are both objects, so `type: string` never matches and the
 *     field never renders. MEASURED: a result-gate `deny` declaring
 *     `result: { from: applied_output, type: string }` renders no `result` key
 *     and delivers `rm -rf /` in leaf and mirror; the `modify` counterpart
 *     renders LITERALLY `{}`.
 *   - NO `value:` KEY, even beside a correct `from:`. `renderDecision` checks
 *     `hasOwnProperty(field, "value")` FIRST and `continue`s -- it never reads
 *     `from` at all. MEASURED: `result: { value: {}, from: applied_output }`
 *     renders `{"result":{}}`, which the applier merges, merging nothing; and
 *     the request-gate twin, `args: { value: { command: "echo pwned" }, from:
 *     applied_input }`, lands the AUTHOR'S command on every `modify` while the
 *     Guardian's own rewrite never lands.
 *
 * THE LAST TWO WERE ADDED IN §V5 review round 3, Task 5, FIX ROUND 2 (Critical)
 * -- the third time this class survived a fix built to close it. The first two
 * bullets check what the sink NAMES; these two check whether the declaration
 * can actually RENDER. An earlier version of this comment asserted that a
 * literal at the sink "IS ALSO REFUSED, and that is not an oversight", which
 * was true only when `from` was ABSENT: `{value: ..., from: applied_output}`
 * passed. The claim is now true because the code makes it true, which is the
 * order those two have to happen in.
 *
 * A LITERAL AT THE SINK IS REFUSED FOR A REASON WORTH KEEPING: a hookmap could
 * land SOMETHING that way, but not the decision's own withholding or rewrite --
 * it would be a fixed value the Guardian never chose, applied identically to
 * every decision, which is a hardcoded answer wearing governance's clothes.
 * The only thing that honours an arriving decision here is that decision's own
 * field, rendered.
 */
function declaresSinkFrom(output: Record<string, unknown>, sinkKey: string, sourceField: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(output, sinkKey)) {
    return false;
  }
  const sink = output[sinkKey];
  if (!isPlainObject(sink)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(sink, "value")) {
    return false;
  }
  if (sink.type !== undefined && sink.type !== "object") {
    return false;
  }
  return sink.from === sourceField;
}

/**
 * Whether `output` declares an UNCONDITIONAL refusal -- at least one path whose
 * leading segment is `refuse` carrying a literal `{value: ...}`.
 *
 * Extracted, unchanged in behaviour, from the request gate's `deny`/`ask`/
 * `defer` rule, which is where this predicate has lived since §V5 review fix
 * round 1's Critical 1 -- see that rule's own doc comment (below) for why the
 * LEADING SEGMENT rather than the exact key, and why an unconditional field
 * under any OTHER key does not count.
 *
 * It is shared now because §V5 review round 3, Task 5, fix round 2 makes it the
 * SECOND way a decision can satisfy the two sink rules -- see
 * `satisfiesGate` (below) for the principle, which is what every finding in
 * this task has actually been about.
 */
function declaresUnconditionalRefusal(output: Record<string, unknown>): boolean {
  return Object.entries(output).some(([outputPath, field]) => {
    const leadingSegment = outputPath.split(".")[0];
    return leadingSegment === "refuse" && isPlainObject(field) && Object.prototype.hasOwnProperty.call(field, "value");
  });
}

/**
 * THE RULE THIS WHOLE GATE HAS ACTUALLY BEEN ABOUT, stated once instead of
 * implied five times (§V5 review round 3, Task 5, fix round 2, Minor):
 *
 *   A decision passes if it can LAND what it arrived carrying, or if it can
 *   UNCONDITIONALLY REFUSE. The silent no-op is the only unacceptable outcome.
 *
 * Both alternatives are honest. Landing is what the shipped hookmap does.
 * Refusing is a deliberately more conservative choice an author may prefer, and
 * it is this file's OWN idiom -- `opencode.hookmap.yaml` maps `ask` and `defer`
 * to `refuse.denied` at the request gate precisely because this host has no
 * native "ask". A gate that refused an author for applying that same idiom one
 * gate over would be contradicting the file it ships beside.
 *
 * WHY THE ALTERNATIVE MATTERS MORE ON THIS HOST THAN IT WOULD ON HOST #1.
 * Over-refusal is not a free direction to err in here. A throw out of
 * `AcsPlugin`'s factory does not stop the session the way host #1's exit 2
 * stops a tool call: OpenCode catches it, logs it, and CONTINUES WITH THE
 * PLUGIN UNLOADED (measured -- docs/shaping/acs-reference-impl-slices.md, and
 * `AcsPlugin`'s own doc comment below). So refusing a safe-but-unusual hookmap
 * at load buys nothing and costs everything: every tool call for the rest of
 * that session runs completely ungoverned. Between "an author's conservative
 * mapping this gate did not anticipate" and "no governance at all", the first
 * is strictly better, and the gate has to be written knowing that.
 *
 * WHAT A REFUSAL COSTS AT THE RESULT GATE, said plainly rather than glossed. It
 * is a WEAKER withholding than replacing: `applyOpenCodeOutput` throws, the
 * model never sees the tool's output (measured -- result-gate.test.ts pins the
 * throw for all four decisions), but OpenCode discards this plugin's mutations
 * on that path and rebuilds `metadata` from its own pre-hook copy, so the
 * plaintext survives in OpenCode's own session record (opencode.hookmap.yaml's
 * own header records that measurement). Weaker, and still honest, and still far
 * better than the alternative this gate would otherwise force -- which, per the
 * paragraph above, is a hookmap that never registers and a session that governs
 * nothing.
 *
 * `allow` is asked neither question, at either gate: rendering nothing IS its
 * own meaning there.
 */
function satisfiesGate(output: Record<string, unknown>, sinkKey: string, sourceField: string): boolean {
  return declaresSinkFrom(output, sinkKey, sourceField) || declaresUnconditionalRefusal(output);
}

/**
 * How `declaresSinkFrom` just failed, in words, for the two messages below --
 * because the two failures need different fixes and a single "declares no X"
 * would misdescribe one of them.
 *
 * ABSENT lists the paths the decision DOES declare, which is what makes the
 * near-miss legible: a `deny` whose output block reads `["result.output",
 * "reason.text"]` looks, to the author who wrote it, exactly like it declares
 * the sink. WRONG SOURCE prints the declared field object verbatim, so
 * `{"from":"applied_input"}` is visible beside the `applied_output` it should
 * have named rather than being described in prose.
 */
function sinkFaultPhrase(output: Record<string, unknown>, sinkKey: string, sourceField: string): string {
  if (!Object.prototype.hasOwnProperty.call(output, sinkKey)) {
    return (
      `declares no ${JSON.stringify(sinkKey)} output field at all (its output block declares ` +
      `${JSON.stringify(Object.keys(output))}), and no unconditional "value:" field under "refuse" either`
    );
  }
  const sink = output[sinkKey];
  const declared = `declares ${JSON.stringify(sinkKey)} as ${JSON.stringify(sink)}, which `;
  // Which of the three render faults it is -- because they need three
  // different one-character fixes, and "does not source it from X" would
  // misdescribe two of them (§V5 review round 3, Task 5, fix round 2).
  if (isPlainObject(sink) && Object.prototype.hasOwnProperty.call(sink, "value")) {
    return (
      `${declared}renders that LITERAL and never reads "from" at all -- renderDecision checks for a "value" key ` +
      `first and stops there (render-decision.ts), so the decision's own ${JSON.stringify(sourceField)} is never ` +
      `read`
    );
  }
  if (isPlainObject(sink) && sink.type !== undefined && sink.type !== "object") {
    return (
      `${declared}declares a "type" of ${JSON.stringify(sink.type)} -- "type" is a typeof filter and ` +
      `${JSON.stringify(sourceField)} is an OBJECT, so renderDecision drops this field every time ` +
      `(render-decision.ts). Only an absent "type", or "object", can match`
    );
  }
  return `${declared}does not source it from ${JSON.stringify(sourceField)}`;
}

/**
 * What this shim expects of ONE hook -- the same role `HOOK_EXPECTATIONS`
 * plays in hosts/claude-code/acs-hook.ts, for host #2's own two gates.
 *
 * A table rather than one rule, for the same reason host #1 needs one: this
 * host's two gates are not symmetric, and neither gate's rule is the other's.
 * A request-gate decision that cannot refuse lets a step RUN; a result-gate
 * decision that cannot withhold DELIVERS what a step produced. Different key,
 * different failure, same class.
 */
type HookExpectation = {
  /**
   * Throws unless this hook's ENTRY can honour every decision it declares --
   * each of them either landing what it arrives carrying here or refusing
   * outright, per this gate's own `CARRIED_AT_*` table.
   *
   * TAKES THE WHOLE ENTRY, not just its `decisions` block (§V5 review round 3,
   * Task 5, fix round 3, Critical 6b): whether a decision CAN land anything
   * depends on the entry too, not only on the decision's own output block. A
   * `tool.execute.after` entry declaring no `outputs:` makes `governStep` build
   * no output location, which makes `withResultOutput` a no-op for EVERY
   * decision -- so the sink this gate demands is unfillable no matter how
   * correctly it is declared. A signature that saw only `decisions` could not
   * ask that question.
   */
  assertEntry: (entry: unknown, path: string, hookEventName: string) => void;
};

/**
 * Applies this gate's own `CARRIED_AT_*` table to one entry's decisions -- the
 * single place the invariant is enforced, for both gates (§V5 review round 3,
 * Task 5, fix round 3).
 *
 * One loop, one question per decision: what does it arrive carrying here?
 *
 *   - `null` -- nothing this host could land, so an unconditional refusal is
 *     the only honest shape and the only one accepted.
 *   - a field name -- it may land that field through `sinkKey`, or refuse.
 *
 * A decision the hookmap does not declare is skipped (`declaredOutputFor`
 * returns `undefined`). A decision the table does not name is REFUSED, not
 * skipped -- see the loop's own comment below. An earlier version of this
 * paragraph said such a decision "is not asked anything -- `allow` is the only
 * one, at either gate", and that was false in a way that mattered: `allow` was
 * the only one the tables OMITTED DELIBERATELY, but the skip covered every
 * name a hookmap might declare (§V5 review round 3, Task 5, fix round 4,
 * Important 7A). `ALWAYS_HONEST_DECISIONS` now names the deliberate set, and
 * everything outside it throws.
 *
 * The two messages are built by the caller, because what a silent no-op COSTS
 * differs by gate: at the request gate the tool runs ungoverned; at the result
 * gate the tool's output, secret included, is delivered in the leaf and its
 * mirror both.
 */
function assertDecisionsCanAct(
  decisions: unknown,
  carried: DecisionCarries,
  sinkKey: string,
  path: string,
  hookEventName: string,
  onCannotRefuse: (decisionName: string, output: Record<string, unknown>) => Error,
  onCannotLand: (decisionName: string, output: Record<string, unknown>, sourceField: string) => Error,
): void {
  // A DECLARED DECISION THIS GATE HAS NO ANSWER FOR IS A THROW, NOT A SKIP --
  // the same rule `expectationFor` states for an unknown HOOK, applied one
  // level down where the identical skip used to be silent (§V5 review round 3,
  // Task 5, fix round 4, Important 7A). The loop below iterates the TABLE, so
  // a hookmap declaring `decisions.block` (or `Deny`, or `warn`) was never
  // asked anything: it loaded clean, and a Guardian answering that string
  // rendered whatever the entry declared -- `{reason}` for an inert one --
  // while the applier applied nothing and threw nothing.
  //
  // WORSE THAN NOT DECLARING IT, which is what makes this a fault rather than
  // a gap, and it is measured (request-gate.test.ts): the SAME hookmap without
  // the entry makes `renderDecision` throw `no decisions entry for ACS
  // decision "block"`, which `governStep` catches and the deployment's posture
  // answers -- audited either way. Declaring the inert entry converts an
  // audited failure into a silent one.
  //
  // Reaching it needs a non-conformant Guardian, so this ranks below the
  // faults a conformant one reaches. It is still the same class, and the throw
  // costs nothing a correct hookmap would ever pay.
  const answerable = new Set([...carried.keys(), ...ALWAYS_HONEST_DECISIONS]);
  for (const declaredName of Object.keys(isPlainObject(decisions) ? decisions : {})) {
    if (!answerable.has(declaredName)) {
      throw new Error(
        `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions" declares ${JSON.stringify(declaredName)}, ` +
          `which this shim has no expectation for at this gate -- it knows ${JSON.stringify([...answerable])} ` +
          `here and nothing else. A decision name nothing checks is a decision nothing governs: if a Guardian ` +
          `ever answered with it, this entry would render whatever it declares and this host's applier would ` +
          `apply nothing and throw nothing, silently. Declaring it is strictly WORSE than leaving it out -- ` +
          `without the entry renderDecision throws, governStep catches that, and the deployment's posture ` +
          `answers it, audited either way. Remove it, or teach this shim the decision (CARRIED_AT_REQUEST_GATE ` +
          `/ CARRIED_AT_RESULT_GATE, this file) so it can say what the decision may honestly do here (§V5 ` +
          `review round 3, Task 5, fix round 4, Important 7A).`,
      );
    }
  }
  for (const [decisionName, sourceField] of carried) {
    const output = declaredOutputFor(decisions, decisionName);
    if (output === undefined) {
      continue;
    }
    if (sourceField === null) {
      if (!declaresUnconditionalRefusal(output)) {
        throw onCannotRefuse(decisionName, output);
      }
      continue;
    }
    if (!satisfiesGate(output, sinkKey, sourceField)) {
      throw onCannotLand(decisionName, output, sourceField);
    }
  }
}

/**
 * WHAT THIS SHIM'S OWN PAYLOAD ASSEMBLY FIXES ABOUT AN ENTRY, per gate -- the
 * second half of "what does this decision arrive carrying here", and the half
 * that is a property of the ENTRY rather than of any decision (§V5 review round
 * 3, Task 5, fix rounds 3 and 4).
 *
 * `AcsPlugin`'s two hook methods assemble the payload themselves and construct
 * a hardcoded live half for the applier (handed to `runExchange`, below, which makes
 * the one `applyOpenCodeOutput` call). That makes two things facts about the
 * SHIM rather than choices left to a hookmap -- and a hookmap disagreeing with
 * either produces a gate-SATISFYING entry that governs nothing:
 *
 *   - WHICH PAYLOAD SHAPE this hook builds. `governStep` and `buildEnvelope`
 *     read that off the ENTRY'S SHAPE (`arguments` vs `outputs`) and never off
 *     the event name -- deliberately, so a typo in an event name cannot
 *     silently select the wrong behaviour (govern-step.ts's own comment). This
 *     shim decides the same question by hook NAME, because its two hook methods
 *     hardcode `{gate: "request", args}` and `{gate: "result", result}`. When
 *     the two disagree, the decision that arrives is shaped for the other gate.
 *   - WHICH PATHS resolve against what this shim assembled. `tool_name` must
 *     name `$.tool`, because `$.tool` is the field this shim's own payload
 *     assembly puts `input.tool` in, and `tool_name` is what `buildEnvelope`
 *     reads to NAME THE TOOL ON THE WIRE. `outputs.within` must name `$.result`, because that is where
 *     this shim puts the live object it hands the applier -- an `applied_output`
 *     is a patched clone OF that container, so naming another one lands the
 *     clone at a depth the applier then merges wrongly.
 *
 * EACH FAULT WAS MEASURED AS A LIVE FAIL-OPEN BEFORE IT WAS CLOSED:
 *
 *   - 6b: a result hook with no `outputs` block. `governStep` builds no output
 *     location, `withResultOutput` no-ops for EVERY decision, `deny` included,
 *     and a perfectly-declared `result: { from: applied_output }` renders
 *     nothing. `rm -rf /` in leaf and mirror.
 *   - 7B: a REQUEST hook declaring `outputs:`. It gets an output location, so
 *     `resolveModify` (decision-modify.ts) fills `applied_output` instead of
 *     `applied_input` -- and the `args: { from: applied_input }` this gate
 *     demands is then correct, declared, and unfillable. `stage: "honoured"`,
 *     rewrite landed nowhere, secret ran. `assertRequestGateDeclaresNoOutputs`
 *     (build-envelope.ts) does not cover it: that check returns early unless
 *     `arguments` is a non-empty string, so it only catches an entry declaring
 *     BOTH.
 *   - 7D: `outputs.within: $` renders a `result` key that satisfies the sink
 *     rule and merges a clone of the whole PAYLOAD -- leaf and mirror both keep
 *     the plaintext, and `tool`/`session_id`/`callID` land on OpenCode's live
 *     result object as junk keys. `within: $.result.metadata`, with a `from`
 *     nesting correctly under it so nothing upstream complains, leaves the
 *     mirror plaintext -- the exact leak `outputs.mirrors` exists to close.
 *   - 8: `outputs.from: $.result.title`, with `within: $.result` so the two
 *     nest correctly and nothing upstream complains. This one is NOT "the
 *     withholding replaces the wrong field", which is how it was first
 *     characterised here and declined on those grounds. `outputs.from` is the
 *     leaf that goes ON THE WIRE as the ACS result payload's
 *     `outputs[0].value` -- the value the policy runtime is asked ABOUT. So
 *     the Guardian is handed a different value entirely, answers it correctly,
 *     and the step is audited as a CLEAN ALLOW. Measured: envelope payload
 *     `outputs: [{value: "cat .env"}]` (the tool's own title) where the shipped
 *     hookmap puts `rm -rf /`; decision `allow`, `stage: "honoured"`, render
 *     `{}`, applier applies nothing, and `rm -rf /` survives in leaf and
 *     mirror. Variant 1's observable reached by never asking the question.
 *   - 7E, found while measuring the others and NOT on the review's own list:
 *     `tool_name: $.args.command` beside `tools: [bash]`. This shim's own
 *     `governsTool(hookmap, hook, input.tool)` answered TRUE and proceeded;
 *     `governStep` resolved `tool_name` to the command, asked the same
 *     function, got FALSE, and returned `stage: "ungoverned"` with an empty
 *     output. No Guardian request, no decision, no audit entry, and `rm -rf /`
 *     proceeded.
 *
 *     THAT FAULT IS NOT WHAT THIS CHECK REFUSES ANY MORE, AND THE CHECK STAYS
 *     ANYWAY (§V5 review round 4, thread 3778055539). `governStep` is now TOLD
 *     the tool this file scoped on (`scopedTool`, `runExchange` below), so it
 *     derives no second name and the two can no longer disagree -- the skip
 *     above is closed in the adapter, for every host, rather than by this
 *     one hookmap check. What a divergent `tool_name` costs INSTEAD is a
 *     different fault of the same family as 8, and it is why this check is
 *     not now redundant. RE-MEASURED against the same hookmap, told
 *     `scopedTool: "bash"`: the step is governed and audited normally --
 *     `stage: "honoured"`, one Guardian request -- and the envelope that goes
 *     out carries `payload.tool.name: "rm -rf /"`, the COMMAND, where the
 *     shipped hookmap puts `bash`. The policy runtime is asked about a tool
 *     the deployment never registered, so its answer is a configuration
 *     mismatch reported as governance, and the tool that actually ran was
 *     never named to it. A load-time refusal beats a runtime one, and this is
 *     the one thing only this file can say: `tool_name` has to read the field
 *     THIS shim feeds.
 *
 * `outputs.mirrors` IS DELIBERATELY NOT FIXED HERE, and the asymmetry with
 * `outputs.from`/`within` is the point rather than an oversight. Which
 * CONTAINER the live object is, and which leaf inside it is the tool's output,
 * are both facts about the shape this shim assembles -- fixed, so checked.
 * WHERE THAT LEAF IS MIRRORED is not: `metadata` is per-tool on this host
 * (opencode.hookmap.yaml's own measurement table -- `bash`'s carries
 * `exit`/`output`, `read`'s carries `preview`, `grep`'s carries `matches`), so
 * a second deployment scoping this gate to a different tool would name a
 * different mirror, or none. Nothing here could say which is right.
 *
 * WHAT THAT LEAVES OPEN, STATED RATHER THAN IMPLIED: a hookmap that simply
 * OMITS `mirrors` is not refused, and it leaks. Measured (§V5 review round 3,
 * Task 5, fix round 5) with the shipped file's `mirrors` line deleted and a
 * live Guardian: a real `deny` landed `[OUTPUT WITHHELD BY POLICY]` on the
 * leaf and left `rm -rf /` in `metadata.output`. Not closed here because the
 * same freedom that makes it possible is what lets a second host deployment
 * declare the right mirror at all.
 *
 * "WEAKER THAN THE REST OF THIS LIST" IS A CLAIM ABOUT A `tools`-SCOPED GATE,
 * and it was stated here without that condition until §V5 review round 3's
 * final whole-branch review. Scoped, the bound is real: the model does see the
 * redaction, so what a `mirrors`-less deployment loses is OpenCode's session
 * record rather than the secret itself. What the bound RESTS ON is this
 * entry's own `tools: [bash]`, because that is what keeps `outputs` and
 * `exit_status` pointed at a tool whose result carries those fields -- and
 * `tools` is precisely what `fixedPaths` above does NOT pin. MEASURED, on the
 * shipped hookmap minus this gate's `tools: [bash]` (which registers clean:
 * `loadHookmap` and this file's own `assertHostAcceptsEveryDecision` both
 * accept it, so `AcsPlugin` returns both hooks), against a `read`-shaped
 * result whose `metadata` carries no `exit`: `buildEnvelope` throws,
 * `governStep`'s stage-"request" catch answers with the delivery posture --
 * measured with none negotiated, so ACS's default `proceed` applied -- one
 * audit entry says `outcome: "proceeded"`, and the file's contents stand
 * untouched in the leaf. A DELIVERED SECRET, through a hookmap this gate
 * loaded, and nothing withholds it: the step was never asked about, and
 * `read`'s own mirror is `metadata.preview`, a field this entry does not name.
 *
 * AND `mirrors` IS NOT WHAT WAS HOLDING THAT SHUT, which is the part to know
 * before deleting either line. Measured both ways: `mirrors` declared and
 * `mirrors` deleted produce the IDENTICAL posture-answered proceed for that
 * `read` payload, because `buildEnvelope` throws before
 * `assertOutputIsReplaceable` (govern-step.ts) is ever reached. Where
 * `mirrors` does act as a backstop is the other route -- a payload the
 * envelope CAN be built from (leaf and `exit_status` both resolve) whose
 * DECLARED mirror is absent from it: there `assertOutputIsReplaceable` cannot
 * build the withholding, and the deployment stops loudly with nothing asked
 * and nothing audited, where the same payload against a `mirrors`-less entry
 * is governed normally.
 *
 * THAT GUARD IS DESIGNED -- WHAT IS ACCIDENTAL IS THAT THIS FILE ARMS IT.
 * `replacingOutput`'s own doc comment (result-output.ts) specifies exactly
 * that check: a declared mirror "resolving to no value in the payload -- adds
 * a field the tool never produced, the same defect an absent `from` would
 * be". So the adapter is not overlooking anything, and this is not a gap
 * anyone needs to close. What nobody designed is the CONNECTION: the check
 * runs over the mirrors a hookmap DECLARED, and the only reason one is
 * declared here is the session-record leak that `outputs.mirrors` was added
 * for. A deployment that declares none is a deployment where that guard never
 * fires -- correctly, by its own design, since it has been told there is no
 * mirror -- so the protection travels with a declaration nothing requires.
 * Deleting `mirrors` from this hookmap therefore disarms a working guard as a
 * side effect of dropping a mirror, and it does not touch the route above,
 * which never reaches the guard at all. The two lines are independent; each
 * deletion is load-clean on its own, and so is both together.
 *
 * NEITHER IS CLOSED HERE, AND CLOSING THEM BELONGS TO V6: requiring `tools`
 * wherever `exit_status`/`outputs` name per-tool fields, or moving the
 * hookmap-decidable posture faults docs/demos/v5-runbook.md enumerates to load
 * time, are changes to what a hookmap MEANS rather than to what this comment
 * says. Carried as known parked items rather than silently accepted.
 *
 * THE ADAPTER CANNOT MAKE ANY OF THESE CHECKS, and that is deliberate on its
 * side rather than an omission: every one rests on knowing which hook name IS
 * which gate, and on what THIS shim's payload assembly named. Only a host shim
 * has both.
 */
type GateEntryShape = {
  /** The payload-shape key this gate's entry must declare. */
  readonly declares: "arguments" | "outputs";
  /** The other one, which it must not declare -- see `declares`. */
  readonly notDeclares: "arguments" | "outputs";
  /** What a mis-shaped entry costs at this gate, for the message. */
  readonly mismatchCosts: string;
  /**
   * Dotted paths into the ENTRY whose value this shim's own payload assembly
   * fixes, and the value it fixes them to.
   */
  readonly fixedPaths: ReadonlyArray<readonly [string, string]>;
};

const REQUEST_GATE_ENTRY: GateEntryShape = {
  declares: "arguments",
  notDeclares: "outputs",
  mismatchCosts:
    "governStep would build this gate an output location off that shape, so resolveModify (decision-modify.ts) " +
    'fills "applied_output" instead of "applied_input" -- and the "args: { from: applied_input }" this gate ' +
    'requires would then be correct, declared and unfillable: the rewrite lands nowhere while governStep still ' +
    'reports stage "honoured"',
  fixedPaths: [
    ["tool_name", "$.tool"],
    ["arguments", "$.args"],
  ],
};

const RESULT_GATE_ENTRY: GateEntryShape = {
  declares: "outputs",
  notDeclares: "arguments",
  mismatchCosts:
    "governStep would build NO output location, so withResultOutput (result-output.ts) returns every decision " +
    'untouched -- "deny" included -- and a perfectly-declared "result: { from: applied_output }" renders ' +
    "nothing: the tool's own output, leaf and metadata.output mirror both, is delivered. It would also make " +
    "buildEnvelope ask the Guardian a tool-call-REQUEST question about a step that already ran",
  fixedPaths: [
    ["tool_name", "$.tool"],
    ["outputs.from", "$.result.output"],
    ["outputs.within", "$.result"],
  ],
};

/** Reads a dotted path out of a loaded hookmap entry, for `fixedPaths` above. */
function entryValueAt(entry: unknown, path: string): unknown {
  let cursor: unknown = entry;
  for (const segment of path.split(".")) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Refuses an entry whose payload shape, or whose `$.` paths, disagree with what
 * this shim's own hook of that name actually does -- see `GateEntryShape`
 * above for each fault, what it was measured to cost, and why only a host shim
 * can make the check.
 */
function assertEntryMatchesGate(entry: unknown, path: string, hookEventName: string, shape: GateEntryShape): void {
  const declared = isPlainObject(entry) ? (entry as Record<string, unknown>)[shape.declares] : undefined;
  const wellDeclared =
    shape.declares === "outputs" ? isPlainObject(declared) : typeof declared === "string" && declared.length > 0;
  if (!wellDeclared) {
    throw new Error(
      `acs-plugin: ${path}'s "hooks.${hookEventName}" declares no usable "${shape.declares}" (it declares ` +
        `${JSON.stringify(declared)}). This shim's "${hookEventName}" hook is fixed: it assembles the payload ` +
        `itself and hands applyOpenCodeOutput a hardcoded live half, so an entry at this hook has to be the ` +
        `matching payload shape. Without it, ${shape.mismatchCosts}. Declare "${shape.declares}" on this hook ` +
        `(§V5 review round 3, Task 5, fix rounds 3 and 4 -- measured).`,
    );
  }
  const forbidden = isPlainObject(entry) ? (entry as Record<string, unknown>)[shape.notDeclares] : undefined;
  if (forbidden !== undefined && forbidden !== null) {
    throw new Error(
      `acs-plugin: ${path}'s "hooks.${hookEventName}" declares "${shape.notDeclares}" ` +
        `(${JSON.stringify(forbidden)}) at a hook this shim treats as the "${shape.declares}" gate. governStep ` +
        `and buildEnvelope read a gate's KIND off the entry's shape and never off the event name -- ` +
        `deliberately, so an event-name typo cannot silently select the wrong behaviour -- while this shim ` +
        `decides it by hook NAME, because its two hook methods hardcode which live half the applier gets. When ` +
        `the two disagree, ${shape.mismatchCosts}. Remove "${shape.notDeclares}" from this hook (§V5 review ` +
        `round 3, Task 5, fix round 4 -- measured).`,
    );
  }
  for (const [fixedPath, required] of shape.fixedPaths) {
    const actual = entryValueAt(entry, fixedPath);
    if (actual !== required) {
      throw new Error(
        `acs-plugin: ${path}'s "hooks.${hookEventName}.${fixedPath}" is ${JSON.stringify(actual)}, and this ` +
          `shim's own payload assembly fixes it at ${JSON.stringify(required)}. That payload is built in this ` +
          `file, not by the hookmap. "$.tool" is where "tool_name" has to look, because that is the field this ` +
          `shim puts input.tool in and "tool_name" is what buildEnvelope reads to NAME THE TOOL ON THE WIRE: ` +
          `measured with "tool_name: $.args.command", the step was governed and audited normally while the ` +
          `envelope carried payload.tool.name "rm -rf /" -- the command, not the tool -- so the policy runtime ` +
          `was asked about a tool this deployment never registered. "$.args"/"$.result" are where ` +
          `this shim puts the live objects it hands applyOpenCodeOutput -- an "applied_output" is a patched ` +
          `clone OF the container "outputs.within" names, so naming another container lands that clone at the ` +
          `wrong depth: measured with "within: $", the leaf AND its metadata.output mirror both kept the ` +
          `plaintext while the payload's own top-level fields were merged onto OpenCode's live result object. ` +
          `And "outputs.from" is the leaf that goes ON THE WIRE as this step's outputs[0].value -- the value ` +
          `the policy runtime is asked ABOUT -- so pointing it elsewhere does not withhold the wrong field, it ` +
          `asks the wrong question: measured with "from: $.result.title", the Guardian was handed the tool's ` +
          `own title, answered "allow", and "rm -rf /" was audited as a clean allow and delivered. ` +
          `Point this at ${JSON.stringify(required)} (§V5 review round 3, Task 5, fix rounds 4 and 5 -- measured).`,
      );
    }
  }
}

/**
 * KEYED BY HOOK EVENT NAME, NOT BY THE ENTRY'S OWN SHAPE, and that is the
 * correct basis rather than a convenience (§V5 review round 3, Task 5).
 *
 * The old check sniffed the entry -- `typeof entry.arguments === "string"` --
 * and skipped everything else, which is exactly how the result gate went
 * unchecked. Hook name is the better key because it is what actually decides
 * which live half the applier gets: `AcsPlugin`'s returned object has exactly
 * two hooks, and each constructs a hardcoded tag -- `"tool.execute.before"`
 * builds `{ gate: "request", args }` and `"tool.execute.after"` builds
 * `{ gate: "result", result }` (both at the bottom of this file; since §V5
 * review round 3, Task 6 each hands its own to `runExchange`, which makes the one
 * `applyOpenCodeOutput` call with whichever it was given). So "which key
 * withholds here" is a fact about the HOOK METHOD, which is per hook name,
 * regardless of what payload shape the hookmap entry declares. A hookmap
 * declaring `tool.execute.before` with `outputs:` instead of `arguments:`
 * would still be handed `{gate: "request", args}` at runtime, and still needs
 * the refusal rule -- the shape sniff would have applied the wrong rule to it,
 * or none.
 */
const HOOK_EXPECTATIONS: Record<string, HookExpectation> = {
  /**
   * §V5 review, fix round 1, Critical 1, unchanged in substance by this task's
   * generalisation -- only moved into the table.
   *
   * Checks by STRUCTURE, not by trusting the shipped field name -- but the
   * structure that matters is WHICH KEY the unconditional field sits under,
   * not merely that some field somewhere in the block carries `{value: ...}`.
   * `applyOpenCodeOutput` (apply-opencode-output.ts) refuses on exactly one output
   * key: `refuse` -- read in pass 2a and thrown. `reason` is declared-inert
   * (pass 2b never throws), and `args`/`result` are MERGES that leave a
   * governed decision looking like a successful, unremarkable rewrite: an
   * unconditional `{value: ...}` planted at `reason.text` or `args.something`
   * renders a non-empty output block, which is what an earlier version of this
   * check accepted, but a non-empty render at the wrong key is not a refusal
   * -- `applyOpenCodeOutput` never reads `refuse` from it, so the applier
   * proceeds all the same. This is the exact hole a hookmap author (or a
   * compromised config) could use to satisfy this gate's letter while
   * reintroducing Critical 1's rendered-`{}` failure mode by another route: an
   * entry naming ONLY `from:` fields under `refuse`, plus one unconditional
   * field under any OTHER key, passed the old check and still applied nothing,
   * threw nothing.
   *
   * So: an entry passes only when at least one output path whose LEADING
   * segment is `refuse` carries `{value: ...}` -- `refuse.denied` (this
   * hookmap's own marker) is one instance of that shape, not a stand-in for
   * "any field, anywhere". LEADING SEGMENT, not the exact key, because the
   * marker legitimately sits BESIDE `refuse.reason` under a shared `refuse`
   * container: it is the container the applier reads and throws on, so
   * anything unconditional inside it is enough to guarantee the container
   * exists. (The result gate's rule below is the exact key for the opposite
   * reason -- there the sink IS the key.)
   */
  "tool.execute.before": {
    assertEntry(entry, path, hookEventName) {
      // The request gate had no entry-shape check at all until §V5 review
      // round 3, Task 5, fix round 4 (Critical 7B and 7E) -- see
      // `GateEntryShape`'s own doc comment for both measurements.
      assertEntryMatchesGate(entry, path, hookEventName, REQUEST_GATE_ENTRY);
      const decisions = isPlainObject(entry) ? (entry as { decisions?: unknown }).decisions : undefined;
      assertDecisionsCanAct(
        decisions,
        CARRIED_AT_REQUEST_GATE,
        "args",
        path,
        hookEventName,
        (decisionName) =>
          new Error(
            `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" declares no unconditional ` +
              `"value:" output field under "refuse" -- applyOpenCodeOutput (apply-opencode-output.ts) refuses only on ` +
              `the "refuse" key; an unconditional field declared under any other key (e.g. "reason.text" or ` +
              `"args...") renders a non-empty output block without making this a refusal, and "refuse.reason" ` +
              `alone is a "from:" field that renders NOTHING when the arriving decision does not carry that ` +
              `source field, or carries it as the wrong type (render-decision.ts). This host's applier would then ` +
              `apply nothing and throw nothing, and the tool would proceed -- a ${decisionName} indistinguishable ` +
              `from a clean allow. Add a literal sibling under "refuse", e.g. "refuse.denied: { value: true }", ` +
              `so this decision always renders a refusal.`,
          ),
        (decisionName, output, sourceField) =>
          new Error(
            `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" ` +
              `${sinkFaultPhrase(output, "args", sourceField)} -- at this ` +
              `host's request gate "args" is the ONLY key a rewrite can land in, because applyOpenCodeOutput ` +
              `(apply-opencode-output.ts) merges it onto the live args object OpenCode handed the hook and nothing ` +
              `else it renders reaches that object at all ("reason" is declared-inert, "refuse" throws, "result" ` +
              `has no live half at this gate). THE EXACT KEY: a path under it ("args.command") renders a nested ` +
              `object the applier merges one level too deep, so the whole rewrite bag lands in a single argument. ` +
              `AND THE EXACT SOURCE: "applied_input" is the field a request-gate modify carries its rewrite on, ` +
              `and a "from:" field naming anything else renders NOTHING (render-decision.ts). Without both, this ` +
              `host's applier would apply nothing and throw nothing while the tool ran with its ORIGINAL ` +
              `arguments -- and governStep would still return stage "honoured", so the audit trail would record ` +
              `the rewrite as honoured rather than recording that it never landed. EITHER declare ` +
              `'args: { from: applied_input }' so the rewrite lands, OR declare an unconditional refusal ` +
              `('refuse.denied: { value: true }') so this decision blocks the tool instead -- both are honest ` +
              `outcomes and this gate accepts either; only the silent no-op is refused. Measured (§V5 review ` +
              `round 3, Task 5, fix rounds 1 and 2).`,
          ),
      );
    },
  },
  /**
   * THE HALF THAT DID NOT EXIST (§V5 review round 3, Task 5, Critical) -- the
   * gate that holds the secret.
   *
   * `result` is the ONLY key that withholds anything at this event, and the
   * requirement is `result: { from: applied_output }` EXACTLY -- that key, that
   * source. `declaresSinkFrom` (above) carries why both halves are
   * load-bearing and what each was measured to leak without; in short, the
   * exact key because a path UNDER it (`result.output`) merges one level too
   * deep and leaves the mirror unwritten, and the exact source because a
   * `from:` naming a field the arriving decision does not carry renders
   * nothing at all. `opencode.hookmap.yaml`'s own `deny` comment already called
   * the leaf shape wrong and `hookmap.test.ts` already asserted the shipped
   * file avoids it; nothing REFUSED either shape until §V5 review round 3,
   * Task 5 and its own fix round 1.
   *
   * "OR DECLARE `refuse` INSTEAD" IS ALLOWED, AND AN EARLIER VERSION OF THIS
   * COMMENT SAID IT WAS NOT (§V5 review round 3, Task 5, fix round 2, Minor).
   * A throw out of `tool.execute.after` makes OpenCode discard this plugin's
   * mutations and rebuild `metadata` from its own pre-hook copy, so the tool's
   * output survives in OpenCode's own session record however early the throw
   * fires (measured -- opencode.hookmap.yaml's own header). That makes
   * replacing the STRONGER of the two, which is why the shipped hookmap
   * replaces and why this rule's error message says which one an author is
   * choosing. It does not make refusing a silent no-op: the model never sees
   * the output (measured -- result-gate.test.ts pins the throw for all four
   * decisions), so it is an honest outcome and `satisfiesGate` accepts it. The
   * cost of the alternative -- refusing such a hookmap at LOAD, on a host where
   * that leaves the plugin unloaded and the session ungoverned -- is stated in
   * `satisfiesGate`'s own doc comment.
   */
  "tool.execute.after": {
    assertEntry(entry, path, hookEventName) {
      // BEFORE any decision is looked at: an entry whose payload shape or
      // whose `$.` paths disagree with what this shim's own hook does makes
      // every sink below unfillable, or fillable with the wrong thing, however
      // correctly it is declared (§V5 review round 3, Task 5, fix rounds 3 and
      // 4). Checked first so the message names the real fault rather than
      // blaming a correctly-declared decision.
      assertEntryMatchesGate(entry, path, hookEventName, RESULT_GATE_ENTRY);
      const decisions = isPlainObject(entry) ? (entry as { decisions?: unknown }).decisions : undefined;
      assertDecisionsCanAct(
        decisions,
        CARRIED_AT_RESULT_GATE,
        "result",
        path,
        hookEventName,
        (decisionName) =>
          new Error(
            `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" declares no unconditional ` +
              `"value:" output field under "refuse", and at this gate that is the ONLY shape open to it. ` +
              `withResultOutput (result-output.ts) attaches "applied_output" for "deny" alone -- it throws for a ` +
              `"modify" arriving without one, and returns "allow", "ask" and "defer" UNTOUCHED -- so a ` +
              `${decisionName} here never carries anything this host could land, and ` +
              `'result: { from: applied_output }' on it renders NOTHING however correctly it is written. ` +
              `Measured: applier applies nothing, throws nothing, and the tool's own output -- the leaf AND its ` +
              `metadata.output mirror -- is delivered, indistinguishable from a clean allow. Declare an ` +
              `unconditional refusal instead ("refuse.denied: { value: true }"), which throws: weaker than ` +
              `replacing, since OpenCode rebuilds metadata from its own pre-hook copy on that path and the ` +
              `plaintext survives in its session record, but the model never sees the output and that is an ` +
              `honest outcome. Or do not declare ${decisionName} at this hook at all -- an undeclared decision ` +
              `makes renderDecision throw, which governStep answers with this deployment's posture, audited ` +
              `either way (§V5 review round 3, Task 5, fix round 3, Critical 6a).`,
          ),
        (decisionName, output, sourceField) =>
          new Error(
            `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" ` +
              `${sinkFaultPhrase(output, "result", sourceField)} -- at ` +
              `this host's result gate "result" is the ONLY key that withholds anything, because ` +
              `applyOpenCodeOutput (apply-opencode-output.ts) merges it onto the live object OpenCode handed the hook ` +
              `and nothing else it renders reaches that object at all ("reason" is declared-inert, "args" has no ` +
              `live half at this gate). withResultOutput (result-output.ts) guarantees the arriving decision ` +
              `CARRIES a withholding on "applied_output" for THIS decision; it cannot make this hookmap declare ` +
              `anywhere to land it. THE EXACT KEY, NOT a leaf under it: "result.output" renders the whole patched ` +
              `container into a field that is a string on this host, and leaves the metadata.output mirror ` +
              `unwritten. AND THE EXACT SOURCE, RENDERABLY DECLARED: a "from:" naming another field, a "type:" an ` +
              `object can never satisfy, or a "value:" beside the "from:" all render nothing (render-decision.ts). ` +
              `Without all of it, the applier would apply nothing and throw nothing, and the tool's own output -- ` +
              `the leaf AND its mirror -- would be delivered: a ${decisionName} indistinguishable from a clean ` +
              `allow. EITHER declare 'result: { from: applied_output }' so the withholding lands, OR declare an ` +
              `unconditional refusal ('refuse.denied: { value: true }') so this decision throws instead -- this ` +
              `gate accepts either, because only the silent no-op is unacceptable. Be aware which you are ` +
              `choosing, though: a throw out of "${hookEventName}" stops the model seeing the output, but ` +
              `OpenCode discards this plugin's mutations on that path and rebuilds metadata from its own ` +
              `pre-hook copy, so the plaintext survives in OpenCode's own session record. Replacing is the ` +
              `stronger of the two.`,
          ),
      );
    },
  },
};

/**
 * This shim's expectation of `hookEventName`, or a throw -- the same rule
 * `expectationFor` states in hosts/claude-code/acs-hook.ts, for two reasons
 * here rather than one.
 *
 * A hook this table has no entry for is a hook whose declared decisions
 * nothing checks: an unchecked hook is an unchecked fail-open, which is the
 * whole reason this gate exists. And on THIS host there is a second, sharper
 * reason -- `AcsPlugin` returns exactly two hooks, `"tool.execute.before"` and
 * `"tool.execute.after"`, so a hookmap entry for any other event is never
 * registered with OpenCode at all. It would sit in the hookmap looking like
 * governance and govern nothing, silently, for the life of the deployment.
 * Refused rather than skipped, on both counts.
 */
function expectationFor(hookEventName: string, path: string): HookExpectation {
  // `hasOwnProperty`, not a bare index: a hookmap naming a hook `toString` or
  // `constructor` would otherwise read an inherited function off
  // Object.prototype, pass the `undefined` check, and then fail on a missing
  // `assertDecisions` -- an unrelated TypeError in place of the message that
  // says which hook is unknown. Same reasoning as acs-hook.ts's own
  // `expectationFor`, and as `isReservedSegment` (reserved-segments.ts).
  const expectation = Object.prototype.hasOwnProperty.call(HOOK_EXPECTATIONS, hookEventName)
    ? HOOK_EXPECTATIONS[hookEventName]
    : undefined;
  if (expectation === undefined) {
    throw new Error(
      `acs-plugin: ${path} maps hook "${hookEventName}", which this shim has no expectation for -- nothing here ` +
        `can say which of this host's output keys withholds at that event, or which live object OpenCode hands a ` +
        `hook there. It is also a hook this plugin never registers: AcsPlugin returns "tool.execute.before" and ` +
        `"tool.execute.after" and nothing else, so this entry would sit in the hookmap looking like governance ` +
        `and govern nothing. A hook nothing checks is a hook nothing governs, so it is refused rather than ` +
        `passed through. Teach this shim the event (HOOK_EXPECTATIONS, this file) before mapping it here.`,
    );
  }
  return expectation;
}

/**
 * Refuses to register a hookmap in which any decision that must REFUSE (at the
 * request gate) or must WITHHOLD (at the result gate) declares no output field
 * this host's applier would honour that way -- called from `AcsPlugin`, beside
 * `loadHookmap`, so this is a LOAD-TIME stop rather than a fault this shim
 * could only discover from a live decision.
 *
 * REPLACES `assertRefusalRendersUnconditionally`, WHICH WAS ONLY HALF OF THIS
 * (§V5 review round 3, Task 5, Critical). That function skipped every entry
 * that did not declare `arguments`, so `tool.execute.after` was never asked
 * whether its `deny` could actually withhold -- and its own doc comment
 * DEFENDED the skip, on the grounds that "the result gate's own `deny`/`modify`
 * are protected a different way, by construction (`withResultOutput`,
 * result-output.ts, host-agnostic)". That defence was wrong, and it is the
 * exact confusion this task exists to retire: `withResultOutput` guarantees the
 * DECISION MESSAGE carries a non-empty `applied_output`. It says nothing about
 * the HOOKMAP declaring an output path that lands it. Upstream,
 * `assertRenderableDecisions` (build-envelope.ts) requires only a non-empty
 * `output` block, so a result-gate `deny` declaring only `reason.text` loaded
 * clean -- and then applied nothing and threw nothing on a real Guardian deny,
 * delivering the tool's output in both the leaf and its mirror. Measured; see
 * `CARRIED_AT_RESULT_GATE`'s own doc comment (above) for what each decision
 * actually arrives carrying at this gate, and
 * hosts/opencode/test/result-gate.test.ts for the tests that keep measuring
 * the fault.
 *
 * LOAD TIME, NOT POSTURE TIME, and that is the whole point. This fault is
 * decidable from the hookmap file ALONE, with no invocation payload -- the
 * same class this slice has repeatedly moved to a load-time check
 * (`assertMirrorsWellFormed`, `assertToolsWellFormed`,
 * `assertExitStatusNotBothForms`, `assertRequestGateDeclaresNoOutputs`, all in
 * build-envelope.ts; no count quoted, per this file's own header) rather than
 * leaving it to surface downstream, where a
 * throw is caught by `governStep` and answered by the deployment's NEGOTIATED
 * delivery posture instead of refused outright. A negotiated `proceed` there
 * is an ungoverned step -- and at the result gate an ungoverned step is the
 * tool's output, secret included, delivered.
 *
 * THIS CANNOT LIVE IN `loadHookmap`, host-agnostically: it is host #2's own
 * rule about what THIS host's applier needs -- which decisions exist, which
 * output key refuses, which one withholds -- not a claim
 * packages/host-adapter/src may make about any host's field names (R3.2). For
 * `refuse` that is enforced mechanically: test/invariants.test.ts's
 * host-vocabulary gate fails on the word appearing anywhere in the adapter's
 * own source. NOT for `result`, and the reason is the one that gate's own
 * comment gives for excluding `sessionID` and `metadata`: `result-output.ts`
 * uses "result" for ACS's own replacing-output concept, so listing it would
 * fail on day one for a word the adapter is supposed to speak. What keeps
 * `result`-as-an-OpenCode-output-key out of the adapter is this function
 * living here, not a gate. The identical reasoning is why
 * `assertHostAcceptsEveryDecision` lives in hosts/claude-code/acs-hook.ts and
 * not in the adapter; this is host #2's general form of that same rule, now
 * with the same coverage: every hook, both gates, and a hook the table has no
 * entry for is a throw rather than a skip.
 *
 * FIX ROUND 1 FOUND THREE MORE MEMBERS OF THE SAME CLASS THIS GATE'S FIRST
 * VERSION STILL ACCEPTED, each measured before it was closed:
 *
 *   - CRITICAL: the result-gate rule checked that `result` was PRESENT, never
 *     what it SOURCED, so `result: { from: applied_input }` passed -- this
 *     task's own Critical, byte for byte, through the gate built to refuse it.
 *     Closed by `declaresSinkFrom` (above), which checks the key AND the
 *     source, exactly the reasoning the request gate's refusal rule was
 *     already written around and this one had inherited none of.
 *   - `ask`/`defer` DECLARED at the result gate were unchecked, excluded on
 *     the grounds that the shipped hookmap declares neither -- reasoning from
 *     the shipped file to the class, the same move the request-gate-only skip
 *     was making. See `CARRIED_AT_RESULT_GATE`'s own doc comment (above) for
 *     what those two carry here -- and 6a below for the half of this round's
 *     own answer that had to be retracted.
 *   - The request gate's own `modify` had no rule at all
 *     (`CARRIED_AT_REQUEST_GATE`, above, is where its carrying is stated
 *     now). An earlier version of this file named
 *     that gap in a comment and declined to close it as unmeasured; measuring
 *     it showed `governStep` returning `stage: "honoured"` while the rewrite
 *     landed nowhere, so the audit trail asserted the opposite of what
 *     happened.
 *
 * FIX ROUND 2 FOUND THE SAME CLASS A THIRD TIME, PLUS ITS MIRROR IMAGE:
 *
 *   - CRITICAL: `declaresSinkFrom` checked what the sink NAMED and never
 *     whether the declaration could RENDER. `result: { from: applied_output,
 *     type: string }` and `result: { value: {}, from: applied_output }` both
 *     passed -- the first because `type` is a `typeof` filter and
 *     `applied_output` is an object, the second because `renderDecision` reads
 *     `value` first and never looks at `from`. Both measured delivering the
 *     secret in leaf and mirror; the request gate's twins measured too, one of
 *     which lands the hookmap author's OWN command on every `modify`.
 *   - MINOR, in the opposite direction: the rule refused a decision an author
 *     had mapped to an unconditional refusal instead of a sink -- a SAFE
 *     configuration, and this hookmap's own idiom for `ask`/`defer`. Over-
 *     refusal is not free on this host (see `satisfiesGate`), so the rule is
 *     now "land it OR refuse it", which is what this gate was always actually
 *     about.
 *
 * FIX ROUND 3 FOUND A SIXTH MEMBER WITH TWO FACES, AND ONE OF THEM THIS GATE
 * HAD MANDATED:
 *
 *   - 6a: fix round 1 widened the result gate's rule to `ask`/`defer` without
 *     asking whether `withResultOutput` can ever fill the sink it demands for
 *     them. It cannot -- it attaches `applied_output` for `deny` alone. So the
 *     declaration this gate REQUIRED rendered nothing, and delivered the secret
 *     in leaf and mirror. Both are now held to the refusal branch alone.
 *   - 6b: a `tool.execute.after` entry declaring no `outputs` block makes
 *     `withResultOutput` a no-op for EVERY decision, `deny` included, so a
 *     perfectly-declared sink is unfillable by construction. Closed by
 *     `assertEntryMatchesGate` (above).
 *
 * THAT IS WHY THE RULES ARE NOW TABLES. Each of the six satisfied the letter of
 * the rule that closed the last, because each rule was a LIST OF ACCEPTED
 * SHAPES. `CARRIED_AT_REQUEST_GATE`/`CARRIED_AT_RESULT_GATE` state the
 * invariant instead -- what does this decision arrive carrying at this gate,
 * and therefore what can it honestly do -- so a seventh variant would have to
 * be a decision whose carrying those tables get WRONG, which is a much smaller
 * place to hide than "a shape nobody enumerated".
 *
 * WHAT THIS STILL DOES NOT DO, stated so a reader does not read more into it.
 * It is a check on the HOOKMAP, not on a rendered output: a hookmap that
 * declares the right key and source and a decision that reaches the render
 * carrying nothing to put in it are different faults, and only the first is
 * decidable here -- the same split acs-hook.ts draws between
 * `assertHostAcceptsEveryDecision` and `asClaudeCodeOutput`'s own runtime
 * check -- though that boundary is NARROWER than an earlier version of this
 * paragraph implied, and fix round 3 is why: WHICH decisions can ever carry
 * `applied_output`, and WHETHER an entry declares an `outputs` block, are both
 * hookmap-and-adapter facts decidable here, and both were being excused as
 * "the render's business". They are checked now. It also asks nothing of
 * `allow` at either gate (rendering nothing is that decision's own meaning at
 * both) and nothing about a decision the hookmap never declares. And it does not rank the two honest outcomes: a hookmap that
 * refuses where it could have replaced passes, with the trade-off spelled out
 * in the error message an author sees on the way to choosing.
 */
function assertHostAcceptsEveryDecision(hookmap: Hookmap, path: string): void {
  for (const [hookEventName, entry] of Object.entries(hookmap.hooks ?? {})) {
    expectationFor(hookEventName, path).assertEntry(entry, path, hookEventName);
  }
}

/**
 * Refuses BEFORE `resolveSessionConfig`/`governStep` are ever asked, when
 * `sessionID` is missing or not a non-empty string -- see this file's own
 * header, "FOUR THINGS EVERY GATE TASK MUST DO", first bullet -- FOUR, not
 * the "THREE" this line said until §V5 review round 3, Task 5, fix round 1,
 * Minor 1: a fourth bullet (the `tools` rule) joined the original three and
 * this back-reference was not re-counted with it.
 * `buildEnvelope` already throws on a missing `session_id`, but that throw
 * lands inside `governStep`'s stage-"request" `catch` and is answered by the
 * deployment's NEGOTIATED posture (`resolveByPosture`) -- and a negotiated
 * `proceed` there is an ungoverned step. A missing session id is a broken
 * deployment, not a policy question, so both gates refuse it here, before
 * either call is made.
 *
 * THE MECHANISM IS A THROW, not an exit code (this file's header, same
 * bullet): OpenCode's hooks return `void` and have no other channel to
 * report a failure through -- the same mechanism `applyOpenCodeOutput`'s own
 * `refuse` path (apply-opencode-output.ts) uses to stop a tool call.
 *
 * ONE CALL SITE NOW, NOT ONE PER GATE (§V5 review round 3, Task 6). This was
 * always one function rather than one per gate -- the same reason
 * `assertUsableTool`, below, is, and the reason the `tools` rule both gates
 * apply is now one function in the adapter (`governsTool`, govern-step.ts)
 * rather than a copy per host -- but it was CALLED from each hook body, once
 * each. Both gates reach it through `runExchange` (below) now, which is where the
 * whole exchange they share lives. The `hookEventName` parameter stays for the
 * reason it was added: the message names the gate that actually fired.
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
 * Refuses BEFORE `governsTool` is ever asked, when `tool` is not a
 * non-empty string -- the same shape as `assertUsableSessionId`, above, and
 * for a matching reason (§V5 review, Task 5, fix round 2, Important 2).
 *
 * WITHOUT THIS, THE `tools` CHECK ITSELF SILENTLY ABSORBED THE FAULT.
 * `Array.prototype.includes` never throws on a non-string needle -- a
 * malformed `tool` (this host's own contract types `input.tool: string`,
 * but nothing enforces that at the boundary a hook actually fires across)
 * simply reads as "not in this gate's `tools` list" and the caller returns,
 * the identical no-op path a genuinely out-of-scope tool takes. MEASURED,
 * before any `tools` check existed here: a malformed `tool` reached
 * `buildEnvelope`, which throws when `tool_name`'s path does not resolve to
 * a string; that throw lands in `governStep`'s stage-"request" `catch` and
 * is answered by the deployment's negotiated posture -- AUDITED regardless
 * of which way the posture resolved, and a negotiated `deny` posture would
 * have blocked. A clean, silent `false` for that one malformed shape
 * converted an audited, posture-answered decision into an UNAUDITED, silent
 * proceed -- the exact asymmetry this file otherwise refuses: a missing
 * `sessionID` is a hard throw a few lines later; a missing `tool` was a
 * no-op. This closes it, in the identical shape, so a broken host contract
 * for `tool` is refused the same way a broken one for `sessionID` already is
 * -- a THROW, this host's only blocking mechanism, never a fault that
 * reaches `governStep` to be routed through a posture.
 *
 * STILL THIS FILE'S JOB AFTER §V5 review round 3, Task 2 moved the `tools`
 * rule itself into the adapter (`governsTool`, govern-step.ts), and MORE
 * squarely this file's job since §V5 review round 4 made the adapter take the
 * scoped tool as an argument instead of deriving one. What `governStep` now
 * scopes on is the value THIS function has just vouched for, handed to it as
 * `scopedTool` (`runExchange`, below).
 *
 * WHAT A MALFORMED `tool` WOULD MEET DOWNSTREAM IF IT GOT PAST HERE -- stated
 * from measurement, because an earlier version of this paragraph asserted the
 * opposite in both halves and was wrong in both (§V5 review round 4,
 * whole-branch review, Important 3). It claimed a non-string would be a
 * silently-`false` needle at BOTH call sites and that the adapter's guard
 * "would not catch it either, since it refuses an ABSENT or empty told tool,
 * which a non-string is not". MEASURED, `scopedTool` of `42`, `null` and
 * `{}`:
 *
 *   - AT A GATE DECLARING `tools`: all three THROW out of `governStep`, on
 *     that guard's own `typeof scopedTool !== "string"` half -- 0 Guardian
 *     calls, 0 audit events. The guard does catch a non-string; it is written
 *     as "not a non-empty string", not as "absent or empty".
 *   - AT A GATE DECLARING NO `tools`: `governsTool` answers `true` for all
 *     three -- not `false` -- because an entry with no list governs every
 *     tool and the needle is never compared to anything. So the step is
 *     GOVERNED (`stage: "honoured"`, Guardian asked once), and `buildEnvelope`
 *     goes on to read the tool name from the PAYLOAD, where this shim put the
 *     same malformed value.
 *
 * So "silently false at both call sites" describes no configuration that
 * exists. WHY THIS FUNCTION IS STILL RIGHT is the second bullet rather than
 * the first: at an unscoped gate nothing downstream refuses a malformed
 * `tool`, and what reaches the Guardian is whatever this shim assembled. This
 * is the boundary that has the value in its host's own type, so this is where
 * the shape is checked -- before either call site, so neither has to be
 * correct about a value that should never have got this far.
 *
 * WHAT AN UNREADABLE `tool_name` PATH DOES IS NO LONGER PART OF THIS, and
 * that is the simplification the round-4 change bought: nothing scopes off
 * the payload any more, so no payload shape can produce a silent skip.
 * Re-measured through `governStep` with the tool told and `tools` declared:
 * an ABSENT or NON-STRING `tool_name` is a `buildEnvelope` throw,
 * posture-answered and AUDITED (`stage: "request"`, Guardian asked 0 times, 1
 * audit event -- the path this paragraph's own measurement above describes);
 * an EMPTY-STRING one does not throw at all, because `buildEnvelope` checks
 * the type and not the length, so the envelope is built carrying
 * `tool: {"name": ""}` and the step is really asked about (`stage:
 * "honoured"`, Guardian asked 1 time, 0 audit events; this repo's own shipped
 * policy configuration answers it `deny`). Governed or audited; never silent.
 * `GovernStepInput.scopedTool`'s doc comment (govern-step.ts) carries the
 * table.
 *
 * Generic over `hookEventName`, exactly like `assertUsableSessionId` -- and,
 * like it, called from ONE place since §V5 review round 3, Task 6 (`runExchange`,
 * below, runs the exchange both gates share). The parameter is what puts the
 * firing gate's own name in the message.
 */
function assertUsableTool(tool: unknown, hookEventName: string): asserts tool is string {
  if (typeof tool !== "string" || tool.length === 0) {
    throw new Error(
      `acs-plugin: "${hookEventName}" fired with no usable tool name (got ${JSON.stringify(tool)}) -- a missing ` +
        `or empty tool name is a broken deployment, not a policy question, so this refuses before governsTool ` +
        `or governStep are ever asked rather than letting a malformed value read as "not in this gate's tools ` +
        `list" and silently proceed ungoverned and unaudited`,
    );
  }
}

/**
 * The long-lived collaborators `AcsPlugin`'s factory builds ONCE and every
 * hook call then shares for the rest of the session -- passed to `runExchange`
 * (below) as an argument rather than closed over, so the one exchange both
 * gates run is a module-level function whose dependencies are named in its
 * signature.
 *
 * HOST #1 NEEDS NO EQUIVALENT, and the difference is this host's own shape
 * rather than a disagreement: hosts/claude-code/acs-hook.ts is a fresh
 * subprocess per hook, so its `main()` takes no arguments and builds its own
 * collaborators on the way through. What the two shims share is ONE function
 * carrying the whole exchange -- not how that function is handed what it
 * needs.
 *
 * Interfaces, not implementations: `SessionConfigStore` is the one S15 rests
 * on (this host binds the in-memory implementation, host #1 the file-backed
 * one, and neither `resolveSessionConfig` nor `governStep` learns which).
 */
type Deployment = {
  readonly hookmap: Hookmap;
  readonly guardian: GuardianClient;
  readonly audit: AuditSink;
  readonly store: SessionConfigStore;
};

/**
 * What ONE gate's own payload assembly produces: the single object
 * `opencode.hookmap.yaml`'s `$.` paths resolve against, and the live object
 * that gate's rendered decision is applied to.
 *
 * The two halves are assembled together, at the edge, because they share a
 * reference: the live object the applier mutates is the same one the payload
 * carries, which is what makes a rendered `args`/`result` land on the object
 * OpenCode is actually holding.
 */
type AssembledStep = {
  readonly payload: Record<string, unknown>;
  readonly live: LiveHookObjects;
};

/**
 * THE ONE EXCHANGE BOTH GATES RUN (§V5 review round 3, Task 6, thread
 * 3773262484).
 *
 * `"tool.execute.before"` and `"tool.execute.after"` made the same seven
 * moves in the same order -- validate `tool`, honour `tools`, validate
 * `sessionID`, assemble the payload, negotiate the session, govern the step,
 * apply what comes back -- written out twice. They are this function now, and
 * the two hook methods below are edges: each names its own event, assembles
 * its own payload, and constructs its own live half.
 *
 * THE ORDER IS LOAD-BEARING, EVERY STEP OF IT. This file's header ("FOUR
 * THINGS EVERY GATE TASK MUST DO") carries each measurement in full; in
 * short:
 *
 *   - `assertUsableTool` FIRST, ahead of the `tools` check, because
 *     `Array.prototype.includes` does not throw on a malformed `tool` -- it
 *     answers a silent `false`, which reads as "out of scope" and turns an
 *     audited, posture-answered fault into a silent unaudited proceed.
 *   - `governsTool`'s early return BEFORE `assertUsableSessionId`, so a tool
 *     this gate does not govern costs no session validation and no handshake
 *     round trip. `governStep` asks the same function itself (§V5 review
 *     round 3, Task 2) about the very value this function hands it
 *     (`scopedTool`, §V5 review round 4), so a shim that forgot would still
 *     skip; this call site is the only one early enough to skip the rest as
 *     well.
 *   - `assertUsableSessionId` BEFORE `governStep`, because `buildEnvelope`'s
 *     own throw on a missing `session_id` lands in `governStep`'s
 *     stage-"request" catch and is answered by the negotiated posture, where
 *     a `proceed` is an ungoverned step.
 *
 * PAYLOAD ASSEMBLY STAYS AT THE EDGE, called from here rather than done here,
 * because the two gates genuinely differ: the request gate reads `args` off
 * the mutable `output` object OpenCode hands it (the only place OpenCode puts
 * them at that gate), while the result gate reads `args` off `input` directly
 * and passes the whole live `{title, output, metadata, attachments}` object
 * as `result`. Called in the ORDERED position -- after both validations, not
 * before -- and handed the two values this function has just checked, so a
 * gate cannot put an unvalidated `tool` or `sessionID` on its payload.
 *
 * BOTH `sessionId` FORMS ARE HERE, WHICH IS WHY THIS IS WHERE THE NOTE
 * BELONGS: `resolveSessionConfig` takes the derived ACS uuid
 * (`toSessionUuid`), `governStep` takes the RAW host id for the audit entry
 * (S14), and the payload carries the raw one too because `buildEnvelope`
 * reads `payload.session_id` as a hardcoded top-level field and derives the
 * uuid itself. Mixing the two is the exact bug class that note exists to
 * prevent -- see acs-hook.ts's own step 4 and step 5 for host #1's two calls
 * side by side, and this file's header for the full statement.
 */
async function runExchange(
  deployment: Deployment,
  hookEventName: string,
  input: { tool: string; sessionID: string; callID: string },
  assemble: (tool: string, sessionID: string) => AssembledStep,
): Promise<void> {
  // `tool` first, ahead of the `tools` check below (§V5 review, Task 5, fix
  // round 2, Important 2): a list membership test cannot tell a malformed
  // `tool` from a genuinely out-of-scope one, so a broken host contract for
  // `tool` has to be refused here, the same "broken deployment" shape
  // `assertUsableSessionId` gives `sessionID` -- see `assertUsableTool`'s own
  // doc comment for the measured asymmetry this closes.
  assertUsableTool(input.tool, hookEventName);

  // A tool this gate's own `tools` list does not name is NOT governed here --
  // return before anything else, without validating a session id, without
  // negotiating a session config, without building an envelope, and without
  // asking the Guardian anything. See `governsTool`'s own doc comment
  // (govern-step.ts) for what this costs and why it is right anyway (§V5
  // review, Task 5, fix round 1, priority item; moved into the adapter in
  // review round 3, Task 2).
  if (!governsTool(deployment.hookmap, hookEventName, input.tool)) {
    return;
  }

  assertUsableSessionId(input.sessionID, hookEventName);

  // ONE payload object, so `opencode.hookmap.yaml`'s `$.` paths have a single
  // thing to resolve against -- OpenCode hands a hook two arguments, not one
  // blob, so this assembly is a shim job the same way reading stdin is host
  // #1's (this file's header). Handed the checked `tool` and the RAW,
  // un-converted `sessionID`; see this function's own doc comment above for
  // why the raw host id and the derived uuid must never be mixed.
  const { payload, live } = assemble(input.tool, input.sessionID);

  const session = await resolveSessionConfig(
    {
      guardian: deployment.guardian,
      agentId: deployment.hookmap.host,
      sessionId: toSessionUuid(input.sessionID),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    deployment.store,
  );

  const governed = await governStep({
    hookEventName,
    payload,
    hookmap: deployment.hookmap,
    guardian: deployment.guardian,
    session,
    // RAW, the other of the two `sessionId` forms -- this one is for the
    // audit entry (S14), never the uuid `resolveSessionConfig` above was
    // given.
    sessionId: input.sessionID,
    audit: deployment.audit,
    // THE TOOL THIS EXCHANGE ALREADY SCOPED ON, told rather than left to be
    // asked a second time (§V5 review round 4, thread 3778055539). It is the
    // very value `governsTool` was asked about a few lines up, and passing it
    // is what makes the two checks two askings of ONE question: `governStep`
    // used to re-derive a name by resolving the entry's `tool_name` path
    // against the payload assembled below, so a hookmap pointing that path
    // elsewhere had this file proceeding on `input.tool` while the adapter
    // scoped on something else -- measured as a governed step returned
    // `stage: "ungoverned"`, unaudited, with `rm -rf /` through. Both of this
    // shim's gates pass through here, so this one line is both of its call
    // sites.
    scopedTool: input.tool,
  });

  applyOpenCodeOutput(governed.output, live);
}

/**
 * OpenCode's plugin entry point: loads the hookmap and this deployment's
 * long-lived collaborators once, and returns the hooks OpenCode calls for
 * the rest of the session's lifetime.
 *
 * A throw here -- an unreadable or invalid hookmap (`loadHookmap` shape-checks
 * everything statically decidable from the hookmap file alone, and
 * `assertHostAcceptsEveryDecision` adds this host's own such check, for both
 * of its gates) --
 * names the same "broken deployment, not a policy question" fault
 * `BlockingConfigurationError`/exit 2 stops host #1's session for. THIS HOST
 * DOES NOT STOP, though, which is NOT what an earlier version of this
 * comment claimed. Measured (§V5 review, Task 8; docs/demos/v5-runbook.md's
 * own capture): OpenCode's plugin loader catches whatever a plugin module's
 * factory throws during registration, logs a `level=ERROR message="failed
 * to load plugin"` line, and CONTINUES THE SESSION WITHOUT THIS PLUGIN --
 * every subsequent hook call for the rest of that session is simply never
 * registered, so every tool call runs completely ungoverned, silently, with
 * no further indication anything is wrong. So a throw here is a log line
 * host #1 has no counterpart for, not a stop host #1's exit 2 is equivalent
 * to -- it names the fault correctly without being able to halt the session
 * the way exit 2 does. That gap is OpenCode's to close, not this file's; see
 * the runbook capture and the slice's own docs of record for what would be
 * needed and why it is out of this slice's scope.
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
  assertHostAcceptsEveryDecision(hookmap, hookmapPath);

  // Built once, here, and handed to `runExchange` on every call -- the four this
  // deployment runs on, in one object so the exchange both gates share can
  // take them as one argument.
  const deployment: Deployment = {
    hookmap,
    guardian: createGuardianClient(process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL),
    audit: createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" }),
    // S15 -- IN MEMORY, and this is the half V3 built for exactly this host.
    // See this file's own header for the measured reason: one plugin object
    // per session, so the negotiated config survives in a variable and the
    // second hook of a session skips the handshake round trip. One interface,
    // two implementations, and the adapter never learns which host is
    // running.
    store: createMemorySessionConfigStore(),
  };

  return {
    // BOTH HOOKS ARE EDGES ON ONE EXCHANGE (§V5 review round 3, Task 6): the
    // seven moves they share -- validate `tool`, honour `tools`, validate
    // `sessionID`, assemble the payload, negotiate the session, govern the
    // step, apply what comes back -- are `runExchange` (above), which is also
    // where the order they must happen in is stated and defended. What is
    // left here is the half the two gates genuinely differ on: which event
    // name this is, and where OpenCode puts the live objects it hands this
    // hook. See this file's own header, "FOUR THINGS EVERY GATE TASK MUST
    // DO", for what `assertUsableSessionId`/`assertUsableTool`, the `tools`
    // bullet and the two `sessionId` forms have to do and why. And for why a
    // throw at the result gate specifically does not mean what it means at
    // the request gate, see "tool.execute.after"'s own doc comment, below.

    /**
     * The request gate. `args` off the MUTABLE `output` object OpenCode hands
     * this hook -- the only place it puts them at this gate, which is why the
     * payload's `args` and the applier's live half are both read from there:
     * they are the same object, so a rendered rewrite lands on the arguments
     * OpenCode is actually about to run (`applyOpenCodeOutput`'s in-place
     * merge, apply-opencode-output.ts).
     */
    "tool.execute.before": async (input, output) =>
      runExchange(deployment, "tool.execute.before", input, (tool, sessionID) => ({
        payload: { tool, session_id: sessionID, callID: input.callID, args: output.args },
        live: { gate: "request", args: output.args },
      })),

    /**
     * The result gate, wired by Task 6 (past tense as of §V5 review round 3,
     * Task 5, fix round 1, Minor 2 -- this comment opened with "Task 6:" as
     * though the hook below were still to be written). The seven moves it
     * makes -- validate `tool`, honour `tools`, validate `sessionID`,
     * assemble one payload object, negotiate the session, govern the step,
     * apply what comes back -- are `runExchange`'s (above), NOT written out here:
     * they were a second copy of `"tool.execute.before"`'s until §V5 review
     * round 3's own Task 6 merged the two. What remains this hook's is the
     * seam that differs -- `{result}` in place of `{args}`, one step later.
     *
     * `tools: [bash]` on this hookmap entry too (opencode.hookmap.yaml's own
     * comment, on this entry): `metadata` is PER-TOOL on this host, measured
     * across four tools -- only `bash`'s carries `exit`/`output`, which is
     * what this entry's `outputs`/`exit_status` are shaped for; `read`'s
     * carries `preview`, `grep`'s carries `matches`. An unlisted tool is the
     * same documented no-op `governsTool` already gives the request gate,
     * not a fault this hook resolves any other way.
     *
     * A RESULT MISSING `metadata.exit` POSTURE-PROCEEDS, AND THAT IS
     * CORRECT -- NOT A GAP THIS GATE SHOULD CLOSE (§V5 review, Task 6 fix
     * round 1, Important 1). `exitStatusOf` (build-envelope.ts) throws when
     * `$.result.metadata.exit` resolves to no value; `governStep`'s
     * stage-"request" catch answers that with this deployment's negotiated
     * posture, which can proceed -- a real fail-open, delivering the tool's
     * own output, secret included, in both the leaf and the mirror, audited
     * with `failure.kind: "host_configuration"`. That is the payload-
     * dependent kind of fault this slice's own rule routes to
     * `resolveByPosture` rather than closes here, exactly like the other
     * three times this slice has hit the same seam. NOT REACHABLE THROUGH
     * `bash`, the only tool this gate governs -- measured against real
     * OpenCode 1.18.15, not assumed: a FAILING `bash` command still carries
     * `metadata.exit`/`metadata.output` (`cat missing-file.txt` ->
     * `{output: "cat: missing-file.txt: No such file or directory\n", exit:
     * 1, truncated: false}`), and an INVALID tool call reports itself as
     * `tool: "invalid"`, not `bash`, so the `tools` check (`governsTool`, in
     * `runExchange`) skips it before any payload naming `metadata.exit` is ever
     * built. Unreachable through the shipped config -- this gate's own
     * `tools: [bash]` scope -- not unreachable outright, the same
     * qualification `governsTool`'s own
     * doc comment (govern-step.ts) makes. AND THE SHIPPED CONFIG IS ONE
     * LOAD-CLEAN EDIT AWAY FROM REACHING IT: nothing refuses a hookmap that
     * drops this entry's `tools` line -- measured, `AcsPlugin` registers both
     * hooks off it -- and a `read` call against that hookmap takes exactly
     * this route on its first invocation, leaving the file's contents standing
     * in the leaf under a `proceed` posture. `GateEntryShape`'s own doc
     * comment (above) carries that measurement, what `mirrors` does and does
     * not backstop about it, and where closing it belongs. NEITHER
     * QUALIFICATION -- unreachable through the config rather than outright,
     * and one load-clean edit from reachable -- weakens the
     * `tools: [bash]` scope's own justification: opencode.hookmap.yaml's measurement
     * table's fourth row ("an invalid call's [metadata] is `{truncated}`
     * alone") names a tool called `invalid`, which this gate never governs
     * to begin with -- not a `bash` call slipping through ungoverned.
     *
     * `args: input.args`, RAW, same as the request gate's own `session_id` --
     * unlike the request gate (where `args` sits on the mutable `output`
     * object because that is the only place OpenCode puts it at that gate),
     * OpenCode hands THIS hook `input.args` directly, so no second read is
     * needed to put it on the payload. Nothing in opencode.hookmap.yaml's
     * result-gate entry resolves a `$.args` path today, but the payload
     * carries it anyway, the same way `buildEnvelope` is handed every field a
     * hookmap COULD name rather than only the ones this shipped one does.
     *
     * `result: output`, THE WHOLE LIVE OBJECT, not one of its fields --
     * OpenCode hands this hook `{title, output, metadata, attachments}`
     * (`attachments` at runtime, measured; the published 1.18.15 type omits
     * it, so this shim never examines it by name and passes it through
     * opaque). `governed.output.result`, when a `deny`/`modify` renders one,
     * is `applied_output` -- the WHOLE patched clone of that same object,
     * mirror included (`outputs.mirrors`, opencode.hookmap.yaml's own result
     * gate) -- so `applyOpenCodeOutput`'s merge (called by `runExchange`, on the
     * live half this hook constructs below; its own `mergeInPlace`, in
     * apply-opencode-output.ts) lands `output` and
     * `metadata.output` together, and leaves `title`/`attachments`/
     * `metadata.exit`/`metadata.truncated` -- everything a render does not
     * name -- exactly as OpenCode handed them in.
     *
     * A THROW HERE DOES NOT MEAN WHAT IT MEANS AT THE REQUEST GATE (this
     * file's own header, "FOUR THINGS EVERY GATE TASK MUST DO", first
     * bullet's own last paragraph, and opencode.hookmap.yaml's own comment on
     * this entry's `deny`): OpenCode discards this plugin's mutations on a
     * throw out of `tool.execute.after` and rebuilds `metadata` from its own
     * pre-hook copy, so a secret scrubbed by a throw does not stay scrubbed
     * on disk. That is why this entry's `deny`/`modify` decisions render
     * `result` (a REPLACING merge, applied through `runExchange`) instead of
     * `refuse` (a throw) -- the `refuse` key never appears in either decision
     * here.
     * `assertUsableTool`/`assertUsableSessionId` still refuse a broken
     * `tool`/`sessionID` by throwing, same as the request gate: an ungoverned
     * step is worse than a stop that does not scrub the disk, and neither of
     * those two faults is a governed decision this gate could instead
     * withhold by replacing.
     */
    "tool.execute.after": async (input, output) =>
      runExchange(deployment, "tool.execute.after", input, (tool, sessionID) => ({
        payload: { tool, session_id: sessionID, callID: input.callID, args: input.args, result: output },
        // The cast is on the FIELD, never on `live` itself: OpenCode's
        // published 1.18.15 type for this object (`{title, output, metadata}`)
        // has no index signature, and the applier takes what it may merge as a
        // `Record<string, unknown>`. `live` stays a typed object literal
        // owning its own `gate` -- which is the fact `LiveHookObjects`' own
        // doc comment (apply-opencode-output.ts) rests part of its reasoning on.
        live: { gate: "result", result: output as unknown as Record<string, unknown> },
      })),
  };
};
