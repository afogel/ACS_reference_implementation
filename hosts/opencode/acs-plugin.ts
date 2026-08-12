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
 * SKELETON ONLY (this task). This file ships the plugin factory's setup --
 * loading the hookmap, the Guardian client, the audit sink, the negotiated
 * session config store -- and `applyHostOutput`, the one function novel to
 * this host. The two gates themselves, `"tool.execute.before"` (the request
 * gate) and `"tool.execute.after"` (the result gate), are Tasks 5 and 6: they
 * assemble the payload shape `opencode.hookmap.yaml`'s `$.` paths resolve
 * against (`{tool, session_id, callID, args, result}` -- OpenCode hands the
 * plugin two arguments per hook, not one blob, so THAT assembly is a shim
 * job, the same way reading stdin is host #1's), call `resolveSessionConfig`
 * then `governStep`, and apply what comes back through `applyHostOutput`
 * below. Neither gate is wired here; `AcsPlugin` returns an object those
 * tasks fill in.
 *
 * TWO THINGS EVERY GATE TASK MUST DO THAT THIS FILE CANNOT DO FOR THEM,
 * because neither is knowable until a hook actually fires:
 *
 *   - Validate `sessionID` -- present, a non-empty string -- and raise a
 *     BLOCKING stop BEFORE calling `governStep`, exactly as
 *     hosts/claude-code/acs-hook.ts's `main()` step 1 does for
 *     `payload.session_id`. `buildEnvelope` already throws on a missing
 *     `session_id`, but that throw lands inside `governStep`'s stage-
 *     "request" `catch` and is answered by the deployment's NEGOTIATED
 *     posture (`resolveByPosture`) -- and a negotiated `proceed` there is an
 *     ungoverned step. A missing session id is a broken deployment, not a
 *     policy question, so it has to be refused before `governStep` is ever
 *     called, not left to arrive as a payload fault it then resolves.
 *   - Assemble `session_id: input.sessionID` onto the payload RAW, not
 *     pre-converted -- `buildEnvelope` reads `payload.session_id` as a
 *     hardcoded top-level field and derives the ACS uuid itself. The uuid
 *     form (`toSessionUuid(input.sessionID)`) is a DIFFERENT value, for a
 *     DIFFERENT call: `resolveSessionConfig({..., sessionId: toSessionUuid(...)})`
 *     takes the uuid; `governStep({..., sessionId})` takes the raw host id,
 *     for the audit entry (S14). Mixing the two is the exact bug class this
 *     note exists to prevent -- see acs-hook.ts's own step 4 and step 5 for
 *     both call sites side by side.
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
  loadHookmap,
  type HostOutput,
} from "host-adapter";

// Override with ACS_HOOKMAP_PATH to point this shim at a different hookmap --
// same convention as hosts/claude-code/acs-hook.ts, and for the same reason
// (a test proving the load-time failure path without touching the real file
// every other test and the real deployment read off this default).
const HOOKMAP_PATH = process.env.ACS_HOOKMAP_PATH ?? fileURLToPath(new URL("./opencode.hookmap.yaml", import.meta.url));

// Matches packages/guardian/src/main.ts's own default port, and
// hosts/claude-code/acs-hook.ts's identical constant -- the runbook and both
// shims agree on 8787 without any of the three hardcoding another's value.
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

/**
 * What this applier is allowed to touch: the live objects OpenCode handed
 * the hook that is applying a rendered `HostOutput`. Both members optional
 * because the two gates hand different halves of this -- the request gate
 * has `args` and no `result`, the result gate has `result` and no `args` --
 * and a caller with neither would have nothing for this function to do.
 */
type LiveHookObjects = { args?: Record<string, unknown>; result?: Record<string, unknown> };

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
 *     undelivered, so a reader of this host's own logs is not left to assume
 *     the reasoning reached the model when nothing on this host carries it
 *     there. If this host ever grows a real sink for it, this is where that
 *     sink gets named.
 *   - `args` -- merged onto `live.args`, only at a gate that was handed one.
 *   - `result` -- merged onto `live.result`, only at a gate that was handed
 *     one. See above for why this is the whole container, not a leaf.
 *
 * A key this render declares that is none of the four above -- or one of
 * `args`/`result` at a gate that was not handed the live half it targets --
 * throws rather than being skipped, naming the key, so a hookmap fault of
 * this shape (or a call from the wrong gate) fails loudly instead of quietly
 * discarding whatever it could not place.
 */
export function applyHostOutput(output: HostOutput, live: LiveHookObjects): void {
  // Pass 1: validate every key. No assignment happens in this loop -- only a
  // throw (refusing everything) or falling through to pass 2 (applying
  // everything). That ordering is the whole "all-or-nothing" guarantee: a key
  // that cannot be honoured is discovered before any live object has been
  // touched, regardless of where in `output` it sits.
  for (const key of Object.keys(output)) {
    if (key === "refuse" || key === "reason") {
      continue;
    }
    if (key === "args" && live.args !== undefined) {
      continue;
    }
    if (key === "result" && live.result !== undefined) {
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
  // own doc comment and opencode.hookmap.yaml's header). Surfaced on stderr,
  // not applied to either live object and not silently ignored.
  const reason = output.reason as { text?: unknown } | undefined;
  if (reason !== undefined) {
    console.error(
      `acs-plugin: reason.text is declared-inert on this host (opencode.hookmap.yaml) and was not delivered ` +
        `to OpenCode -- reasoning: ${JSON.stringify(reason.text)}`,
    );
  }

  // Pass 3: the assignment. Nothing above threw, so every key `output`
  // carries is one this applier is about to land -- args and result together,
  // leaf and mirror together, never one without the other.
  if (output.args !== undefined && live.args !== undefined) {
    Object.assign(live.args, output.args as Record<string, unknown>);
  }
  if (output.result !== undefined && live.result !== undefined) {
    Object.assign(live.result, output.result as Record<string, unknown>);
  }
}

/**
 * OpenCode's plugin entry point: loads the hookmap and this deployment's
 * long-lived collaborators once, and returns the hooks OpenCode calls for
 * the rest of the session's lifetime.
 *
 * A throw here (an unreadable or invalid hookmap -- `loadHookmap` shape-checks
 * everything statically decidable from the hookmap file alone) fails plugin
 * registration itself, before any hook can fire -- the same "broken
 * deployment, not a policy question" stop `BlockingConfigurationError`/exit 2
 * is for on host #1, reached at the equivalent point in this host's own
 * lifecycle: load time, never per-invocation.
 */
export const AcsPlugin: Plugin = async () => {
  const hookmap = loadHookmap(HOOKMAP_PATH);
  const guardian = createGuardianClient(process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL);
  const audit = createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" });
  // S15 -- IN MEMORY, and this is the half V3 built for exactly this host. See
  // this file's own header for the measured reason: one plugin object per
  // session, so the negotiated config survives in a variable and the second
  // hook of a session skips the handshake round trip. One interface, two
  // implementations, and the adapter never learns which host is running.
  const store = createSessionConfigStore();

  return {
    // Tasks 5 and 6: "tool.execute.before" (the request gate) and
    // "tool.execute.after" (the result gate). Each assembles this hook's own
    // {tool, session_id, callID, args, result} payload, validates sessionID
    // (this file's header states why that check belongs here and not inside
    // governStep), calls resolveSessionConfig -> governStep against `hookmap`,
    // `guardian`, `session`/`store` and `audit` above, and applies the
    // result through `applyHostOutput`.
  };
};
