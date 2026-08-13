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
 * THE ADAPTER IS NOT "UNCHANGED" (§V5 final review, F3) -- MEASURED:
 * packages/host-adapter/src changed in FOUR of its files
 * (build-envelope.ts, decision-modify.ts, modifications.ts,
 * result-output.ts); `loadHookmap` went from ONE load-time gate
 * (`assertRenderableDecisions`) to FIVE (plus `assertMirrorsWellFormed`,
 * `assertToolsWellFormed`, `assertExitStatusNotBothForms`,
 * `assertRequestGateDeclaresNoOutputs`); and `exit_status` gained a
 * second, `from:` form beside its original `literal:`. Only
 * `render-decision.ts` and `govern-step.ts` are genuinely untouched. So
 * `buildEnvelope`, the hookmap format, and every load-time check are NOT
 * the unmodified set an earlier claim here named.
 *
 * NO INSERTION/DELETION COUNT QUOTED HERE (§V5 review round 3, fix round
 * 2) -- an earlier version of this paragraph named one, and it went stale
 * three times in three consecutive commits on this exact line (+962/-62,
 * then +1026/-63, then wrong again the moment the SECOND correction
 * landed): nothing pins it, and Tasks 2 and 3 of this same review round
 * both still edit packages/host-adapter/src, so any number quoted here is
 * guaranteed wrong again before this plan lands. The count this paragraph
 * actually needs -- FOUR files, no per-host fork, host #1's own source at
 * +0/-0 (mechanically pinned by scripts/verify-zero-diff.sh, below) --
 * carries the claim without it. For a CURRENT count:
 * `git diff --shortstat slice/v4 HEAD -- packages/host-adapter/src/`.
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
 * config store -- `applyHostOutput`, the one function novel to this host,
 * and one load-time correctness gate this host's own applier needs
 * (`assertRefusalRendersUnconditionally`, below -- see its own doc comment).
 * TASK 5 WIRED THE REQUEST GATE, `"tool.execute.before"`: it assembles the
 * payload shape `opencode.hookmap.yaml`'s `$.` paths resolve against
 * (`{tool, session_id, callID, args}` -- OpenCode hands the plugin two
 * arguments per hook, not one blob, so THAT assembly is a shim job, the
 * same way reading stdin is host #1's), calls `resolveSessionConfig` then
 * `governStep`, and applies what comes back through `applyHostOutput`
 * (`apply-host-output.ts`, imported below -- see ITS OWN header for why it
 * is not defined in this file). TASK 6 WIRES `"tool.execute.after"` (the
 * result gate): the same shape, one seam later, for `{result}` (the live
 * `{title, output, metadata, attachments}` object) beside `{args}`, plus
 * `outputs.mirrors` (Task 2) so a redaction lands the leaf and its
 * `metadata.output` mirror together.
 *
 * THE ADAPTER-SIDE HALF OF `apply-host-output.ts`'s OWN PROTOTYPE-CHAIN
 * GUARD (`assertNoReservedSegments`, in that file) lives at its source,
 * corrected in `packages/host-adapter/src/modifications.ts`'s own
 * `RESERVED_SEGMENTS` doc comment -- not duplicated here. (An earlier version
 * of this header claimed this file "may not edit packages/host-adapter/src"; that was
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
 *     `refuse` path uses (apply-host-output.ts) -- because OpenCode's hooks
 *     return `void` and have no other channel to report a failure through.
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
 *     REPLACING `result` (`applyHostOutput`'s merge, in apply-host-output.ts)
 *     rather than by throwing. A sessionID check that refuses at the result gate is still
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
  type Hookmap,
} from "host-adapter";
// applyHostOutput, and every private helper it alone needs, moved to
// apply-host-output.ts (§V5 review, Task 8, fix round 1, Important 1) --
// see that file's own header for why exporting it from THIS module was a
// hazard rather than a convenience, and test/invariants.test.ts's new gate
// for what now keeps this file's export surface to exactly one symbol.
import { applyHostOutput } from "./apply-host-output.ts";

// Matches packages/guardian/src/main.ts's own default port, and
// hosts/claude-code/acs-hook.ts's identical constant -- the runbook and both
// shims agree on 8787 without any of the three hardcoding another's value.
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * `assertExitStatusNotBothForms`/`assertRequestGateDeclaresNoOutputs`, all in
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
 * Checks by STRUCTURE, not by trusting the shipped field name -- but the
 * structure that matters is WHICH KEY the unconditional field sits under, not
 * merely that some field somewhere in the block carries `{value: ...}`.
 * `applyHostOutput` (apply-host-output.ts) refuses on exactly one output key:
 * `refuse` -- read in pass 2a and thrown. `reason` is declared-inert (pass
 * 2b never throws), and `args`/`result` are MERGES that leave a governed
 * decision looking like a successful, unremarkable rewrite: an unconditional
 * `{value: ...}` planted at `reason.text` or `args.something` renders a
 * non-empty output block, which is what an earlier version of this check
 * accepted, but a non-empty render at the wrong key is not a refusal --
 * `applyHostOutput` never reads `refuse` from it, so the applier proceeds all
 * the same. This is the exact hole a hookmap author (or a compromised
 * config) could use to satisfy this gate's letter while reintroducing
 * Critical 1's rendered-`{}` failure mode by another route: an entry naming
 * ONLY `from:` fields under `refuse`, plus one unconditional field under any
 * OTHER key, passed the old check and still applied nothing, threw nothing.
 * So: an entry passes only when at least one output path whose LEADING
 * segment is `refuse` carries `{value: ...}` -- `refuse.denied` (this
 * hookmap's own marker) is one instance of that shape, not a stand-in for
 * "any field, anywhere". An entry naming an unconditional field ONLY outside
 * `refuse` -- or naming only `from:` fields under `refuse` -- is what gets
 * refused. A decision this hookmap does not declare at all (`ask`/`defer`
 * are optional; `loadHookmap`'s own `assertRenderableDecisions` requires
 * only `allow` and `deny`) has nothing here to check.
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
      const hasUnconditionalRefuseField = Object.entries(output).some(([outputPath, field]) => {
        const leadingSegment = outputPath.split(".")[0];
        return (
          leadingSegment === "refuse" && isPlainObject(field) && Object.prototype.hasOwnProperty.call(field, "value")
        );
      });
      if (!hasUnconditionalRefuseField) {
        throw new Error(
          `acs-plugin: ${path}'s "hooks.${hookEventName}.decisions.${decisionName}" declares no unconditional ` +
            `"value:" output field under "refuse" -- applyHostOutput (apply-host-output.ts) refuses only on the ` +
            `"refuse" key; an unconditional field declared under any other key (e.g. "reason.text" or "args...") ` +
            `renders a non-empty output block without making this a refusal, and "refuse.reason" alone is a ` +
            `"from:" field that renders NOTHING when the arriving decision does not carry that source field, or ` +
            `carries it as the wrong type (render-decision.ts). This host's applier would then apply nothing and ` +
            `throw nothing, and the tool would proceed -- a ${decisionName} indistinguishable from a clean allow. ` +
            `Add a literal sibling under "refuse", e.g. "refuse.denied: { value: true }", so this decision always ` +
            `renders a refusal.`,
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
 * `refuse` path (apply-host-output.ts) uses to stop a tool call.
 *
 * Shared by both gates (Task 6 calls this too) rather than written twice --
 * the same reason `isGovernedTool` and `assertUsableTool`, below, are each
 * one function rather than one per gate.
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
 * round 2, Important 1) -- HISTORICALLY. `assertToolsWellFormed`
 * (build-envelope.ts) normalises a bare `tools:` key -- YAML `null`,
 * present and unusable, not absent -- to `undefined` ONLY inside its own
 * local variable, for its own validation; AT THE TIME this compensation was
 * added, the `Hookmap` object `loadHookmap` returned still carried
 * `tools: null` on that entry, because that function shape-checked rather
 * than rewrote. `null === undefined` is `false`, so a bare `!== undefined`
 * read here fell through to `null.includes(tool)` and threw `TypeError:
 * null is not an object` on EVERY call to this gate -- naming neither the
 * hookmap nor the field, and contradicting both this function's own
 * contract ("undeclared means every tool") and the load-time checker's
 * stated intent. Measured end to end against a hookmap whose request gate
 * declares a bare `tools:`. Not reachable through the SHIPPED hookmap
 * (which declares `tools: [bash]`, never bare), but load-time-decidable
 * faults belong caught at load time or handled defensively here, not left
 * to crash a hook that already loaded -- the same rule this slice states
 * for every other hookmap-shape hazard.
 *
 * NO LONGER LOAD-BEARING, AS OF §V5 review round 3, Task 1. `loadHookmap`
 * now returns a NORMALISED `Hookmap`: a present-but-`null` `tools` key
 * comes back OMITTED, never `null` (`normalizeTools`, build-envelope.ts --
 * whose own doc comment cites the crash above as ITS motivation). So the
 * `?? undefined` immediately below is a NO-OP on every call this file can
 * reach: `hookmap.hooks[hookEventName]?.tools` can no longer read `null`,
 * only `undefined` or a well-formed array. Left in place rather than
 * simplified to `=== undefined` here: Task 2 deletes this whole function
 * and moves the rule into the adapter, so the dead compensation is that
 * task's to remove, once, with the rest of the function, not this one's to
 * edit twice.
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
    // See this file's own header, "FOUR THINGS EVERY GATE TASK MUST DO", for
    // what `assertUsableSessionId`/`assertUsableTool`, the `tools` bullet,
    // and the two `sessionId` forms below have to do and why -- shared by
    // both hooks below, unchanged. And for why a throw at the result gate
    // specifically does not mean what it means here, see
    // "tool.execute.after"'s own doc comment, below.
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

    /**
     * Task 6: the result gate. The same seven moves as "tool.execute.before"
     * above -- validate `tool`, honour `tools`, validate `sessionID`,
     * assemble one payload object, negotiate the session, govern the step,
     * apply what comes back -- one seam later, for `{result}` in place of
     * `{args}`.
     *
     * `tools: [bash]` on this hookmap entry too (opencode.hookmap.yaml's own
     * comment, on this entry): `metadata` is PER-TOOL on this host, measured
     * across four tools -- only `bash`'s carries `exit`/`output`, which is
     * what this entry's `outputs`/`exit_status` are shaped for; `read`'s
     * carries `preview`, `grep`'s carries `matches`. An unlisted tool is the
     * same documented no-op `isGovernedTool` already gives the request gate,
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
     * `tool: "invalid"`, not `bash`, so `isGovernedTool` (above) skips it
     * before any payload naming `metadata.exit` is ever built. Unreachable
     * through the shipped config -- this gate's own `tools: [bash]` scope --
     * not unreachable outright, the same qualification `isGovernedTool`'s
     * own doc comment makes elsewhere in this file. And this does not weaken
     * that scope's own justification: opencode.hookmap.yaml's measurement
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
     * gate) -- so `applyHostOutput`'s merge (called below; its own
     * `mergeInPlace`, in apply-host-output.ts) lands `output` and
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
     * `result` (a REPLACING merge, applied below) instead of `refuse` (a
     * throw) -- the `refuse` key never appears in either decision here.
     * `assertUsableTool`/`assertUsableSessionId` still refuse a broken
     * `tool`/`sessionID` by throwing, same as the request gate: an ungoverned
     * step is worse than a stop that does not scrub the disk, and neither of
     * those two faults is a governed decision this gate could instead
     * withhold by replacing.
     */
    "tool.execute.after": async (input, output) => {
      assertUsableTool(input.tool, "tool.execute.after");

      if (!isGovernedTool(hookmap, "tool.execute.after", input.tool)) {
        return;
      }

      assertUsableSessionId(input.sessionID, "tool.execute.after");

      const payload = {
        tool: input.tool,
        session_id: input.sessionID,
        callID: input.callID,
        args: input.args,
        result: output,
      };

      const session = await resolveSessionConfig(
        { guardian, agentId: hookmap.host, sessionId: toSessionUuid(input.sessionID), timeoutMs: DEFAULT_TIMEOUT_MS },
        store,
      );

      const governed = await governStep({
        hookEventName: "tool.execute.after",
        payload,
        hookmap,
        guardian,
        session,
        sessionId: input.sessionID,
        audit,
      });

      applyHostOutput(governed.output, { result: output as unknown as Record<string, unknown> });
    },
  };
};
