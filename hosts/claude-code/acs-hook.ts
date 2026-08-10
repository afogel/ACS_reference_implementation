/**
 * acs-hook.ts -- Claude Code's PreToolUse hook shim.
 *
 * Deliberately thin: read the hook JSON Claude Code sends on stdin, call
 * buildEnvelope -> createGuardianClient(...).requestDecision -> renderDecision
 * (all three from `host-adapter`, packages/host-adapter), wrap what comes
 * back into the JSON Claude Code expects, and write it to stdout. All logic lives
 * in the adapter -- this file is only the wiring a Claude Code hook process
 * needs (stdin, stdout, exit code, which hookmap file to load) plus the one
 * thing the adapter must not know: this host's own output shape. A second
 * host is another shim this thin against the same, unchanged adapter, so any
 * logic added here is logic that host would have to duplicate.
 *
 * This file is host-specific by definition (it may name Claude Code
 * freely) but must not reach into AGT -- it never imports `agt-bridge` or
 * `guardian`'s server-side pieces, only `host-adapter`'s public surface,
 * and talks to the Guardian only over HTTP, through the client role
 * `createGuardianClient` returns.
 *
 * Claude Code's hook protocol (see the task brief and
 * docs/demos/v1-runbook.md): stdin is one JSON object
 * `{ session_id, transcript_path, cwd, hook_event_name, tool_name,
 * tool_input }`; stdout is one JSON object
 * `{ hookSpecificOutput: { hookEventName, permissionDecision, ... } }`;
 * the process **always exits 0** for a real decision -- "deny" travels in
 * the JSON body, not the exit code. Exit 2 means "blocking error" to
 * Claude Code and exit 1 means "non-blocking error"; neither is how a
 * policy deny is expressed, so getting this wrong would make a deny look
 * like a crash.
 *
 * ON FAILURE, PAST THE POINT A HOOK PAYLOAD HAS PARSED (V3, replacing a V1
 * placeholder): there are exactly three exit shapes past that point, never
 * a fourth.
 *
 *   - Exit 1 ("non-blocking error"), empty stdout: ONLY before a hook
 *     payload has parsed at all -- stdin is not JSON, or is missing a
 *     string `hook_event_name`/`session_id`. Nothing has been promised to
 *     Claude Code yet.
 *   - Exit 2 ("blocking error"), stderr only: once the payload has parsed,
 *     but before this shim can trust its own configuration enough to make
 *     a governed decision at all -- the hookmap fails to load, or
 *     `session_id` is unsafe to use as a path segment (constraint 9). Both
 *     are a broken deployment, not a policy question, and a loud, blocking
 *     stop beats a silent, ungoverned proceed.
 *   - Exit 0, a decision on stdout: every remaining case, with no
 *     exception. A Guardian that is down, a response carrying an error
 *     instead of a decision, a request that times out, or a decision this
 *     host cannot even render (an unrecognised decision string, or a
 *     hookmap gap) are all delivery failures, not decisions, and Global
 *     Constraint 1's two failure domains never merge: a `deny` that
 *     arrives is honoured regardless of what follows, and a delivery
 *     failure never gets dressed up as one. Every such failure is resolved
 *     by the deployment's own negotiated `on_decision_failure` posture
 *     (`applyFailurePosture`, N6) -- proceed or deny -- and every fail-open
 *     `proceed` taken this way is written to the audit sink (S14) first,
 *     so the bypass is visible rather than silent. The posture's own
 *     "allow"/"deny" is guaranteed renderable: loadHookmap doesn't just
 *     require both to exist in every hookmap's `decisions` block, it
 *     shape-checks every entry it accepts, so this tier can never recurse
 *     into itself.
 *
 * V1's own version of this paragraph described a placeholder, not a
 * considered posture: it caught nothing, wrote the error to stderr only,
 * and exited 1 with empty stdout for every failure past this point,
 * including a broken deployment. Claude Code reads exit 1 as "non-blocking
 * error" and proceeds as though the hook had never fired -- so a thrown
 * error (the Guardian down, a malformed response, a lazy validator
 * failing) let the tool call run ungoverned, unaudited, and undeclared.
 * That fail-open recurred five more times elsewhere in this project before
 * this rewrite closed this, its origin. It is gone: every one of the
 * throws that used to reach V1's placeholder now flows into either exit 2
 * (a broken deployment, loud and blocking) or `applyFailurePosture` (every
 * other case, which always returns a decision and always audits taking
 * it).
 */
import { fileURLToPath } from "node:url";
import {
  applyFailurePosture,
  buildEnvelope,
  createAuditSink,
  createFileSessionConfigStore,
  createGuardianClient,
  DEFAULT_TIMEOUT_MS,
  loadHookmap,
  negotiateSessionConfig,
  renderDecision,
  toSessionUuid,
  unwrapArguments,
  validateDecision,
  type AcsDecision,
  type AcsRequestEnvelope,
  type Hookmap,
  type HostOutput,
  type SessionConfigStore,
} from "host-adapter";

// Override with ACS_HOOKMAP_PATH to point this shim at a different hookmap
// -- e.g. a test proving the exit-2 path for a hookmap that fails to load,
// without touching the real file every other test and the real deployment
// read off this default.
const HOOKMAP_PATH = process.env.ACS_HOOKMAP_PATH ?? fileURLToPath(new URL("./claude-code.hookmap.yaml", import.meta.url));

// Matches packages/guardian/src/main.ts's own default port -- the runbook
// and this shim agree on 8787 without either hardcoding the other's value.
// Override with ACS_GUARDIAN_URL when the Guardian runs on a different
// host/port (e.g. in tests, which start a Guardian on an ephemeral port).
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

/**
 * Claude Code's own output shape, which lives here and nowhere else.
 *
 * The adapter renders into a shape it does not name: `renderDecision` reads
 * the hookmap's dotted output paths and assembles the object they describe,
 * knowing ACS decisions and nothing about this host. That is what lets a
 * second host arrive as a shim and a hookmap rather than a fork of the
 * shared module -- and it is only true while these names appear on this side
 * of the seam. The two inside the wrapper appear as data in
 * claude-code.hookmap.yaml's output paths; here the wrapper itself is the one
 * name this shim needs, because it is the shim that wraps.
 */
const HOOK_SPECIFIC_OUTPUT = "hookSpecificOutput";

/**
 * Wraps the adapter's host-agnostic output into the exact JSON Claude Code
 * expects, adding the one field that is not a function of the decision: the
 * name of the hook that asked.
 *
 * `hookEventName` is deliberately not in the hookmap. Every output field
 * declared there is copied from the decision or is a literal; this one is
 * neither -- it is the raw host event name that produced the original
 * request, the same string passed to buildEnvelope, carried through
 * unchanged. Adding it here keeps the adapter's contract exactly "the output
 * is a function of the decision and the hookmap".
 *
 * It goes first, and any field the hookmap declared under the wrapper
 * follows; a field the hookmap declared OUTSIDE the wrapper (a top-level key
 * alongside it) travels untouched, which is the second half of what the
 * generic output shape bought.
 *
 * A rendered output with no wrapper object in it is a throw rather than a
 * repair: writing `{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}`
 * would hand Claude Code JSON it reads as no decision at all, and it would
 * then let the tool call proceed. Half an output is the one thing this hook
 * must never write.
 */
function asClaudeCodeOutput(rendered: HostOutput, hookEventName: string): HostOutput {
  const wrapper = rendered[HOOK_SPECIFIC_OUTPUT];
  if (typeof wrapper !== "object" || wrapper === null || Array.isArray(wrapper)) {
    throw new Error(
      `acs-hook: the rendered output has no "${HOOK_SPECIFIC_OUTPUT}" object for Claude Code to read a ` +
        `decision from, so there is no output this host could honestly write`,
    );
  }
  return { ...rendered, [HOOK_SPECIFIC_OUTPUT]: { hookEventName, ...(wrapper as Record<string, unknown>) } };
}

/**
 * Thrown when this shim cannot trust its own configuration enough to make
 * a governed decision at all -- a hookmap that fails to load, or a
 * `session_id` unsafe to use as a path segment. Distinct from a step-1
 * parse failure (a bare throw, still exit 1): both of these happen only
 * after a hook payload HAS parsed, so Claude Code must not read them as
 * "the hook didn't fire" the way it reads exit 1 -- `main().catch` below
 * exits 2 ("blocking error") for this class specifically, which stops the
 * tool call and surfaces stderr instead of silently letting it through.
 */
class BlockingConfigurationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BlockingConfigurationError";
  }
}

async function main(): Promise<void> {
  const input = await Bun.stdin.text();
  const payload = JSON.parse(input) as Record<string, unknown>;

  // Step 1: nothing has been promised to Claude Code yet, so a failure here
  // still throws and exits 1 -- there is no hook to decide about.
  const hookEventName = payload.hook_event_name;
  if (typeof hookEventName !== "string") {
    throw new Error('acs-hook: stdin payload is missing a string "hook_event_name" field');
  }
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string") {
    throw new Error('acs-hook: stdin payload is missing a string "session_id" field');
  }

  // Step 2: from here on, a hook payload HAS parsed. A hookmap that fails
  // to load, or an unsafe session_id, both make a governed decision
  // impossible -- a broken deployment, not a policy question -- so both
  // become a BlockingConfigurationError and exit 2, not the silent exit-1
  // proceed a bare throw would produce. Nothing is written anywhere before
  // this succeeds (constraint 4): createFileSessionConfigStore's
  // InvalidSessionIdError throws synchronously, before its first write.
  let hookmap: Hookmap;
  let store: SessionConfigStore;
  try {
    hookmap = loadHookmap(HOOKMAP_PATH);
    store = createFileSessionConfigStore({
      dir: process.env.ACS_SESSION_DIR ?? ".acs/sessions",
      sessionId,
    });
  } catch (error) {
    throw new BlockingConfigurationError(error);
  }

  // Step 3: the audit sink (S14) -- total by construction, so building it
  // cannot itself throw, and a write to it never happens unless a fail-open
  // proceed (or a negotiated fail-closed deny) actually occurs below.
  const audit = createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" });

  const guardianUrl = process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL;
  const guardian = createGuardianClient(guardianUrl);

  // Step 4: negotiate once per session. A handshake failure decides nothing
  // by itself, and is not carried forward into whatever the step call
  // below reports: the two are different requests that can fail for
  // unrelated reasons, and the audited entry (if one is written at all)
  // must classify the failure of the request it is filed against
  // (steps/toolCallRequest), not this one. `posture_source: "default"`
  // already records, durably, that no handshake ever completed for this
  // session -- that is the fact that matters, not which error this
  // particular attempt raised. The step call may still succeed even after
  // this fails (Global Constraint 2: the posture must never touch an
  // arriving decision).
  if (store.get() === undefined) {
    try {
      // metadata.session_id is schema-constrained to "uuid" (same rule
      // buildEnvelope's own toSessionUuid honours below); the store itself
      // keys on the raw host session_id, per S13's own contract. agentId
      // is the hookmap's own `host` field -- the same identity buildEnvelope
      // sends for the step call below, so the two never diverge. Bounded by
      // the ACS default timeout: there is no negotiated timeout yet, since
      // negotiating one is what this call is for -- without a bound, a
      // Guardian that accepts the connection and never answers would hang
      // this hook until Claude Code's own hook timeout kills the process.
      await negotiateSessionConfig(
        {
          guardian,
          agentId: hookmap.host,
          sessionId: toSessionUuid(sessionId),
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        store,
      );
    } catch {
      // Not fatal, and not carried forward -- see the comment above.
    }
  }

  // Step 5.
  const sessionConfig = store.get();
  const timeoutMs = sessionConfig?.timeout_config.default_ms ?? DEFAULT_TIMEOUT_MS;

  // Steps 6-7, one guard: buildEnvelope -> requestDecision -> render, all
  // inside the same try. Rendering has to be in here too: a decision this
  // host cannot even render (an unrecognised decision string that
  // validateDecision passed through unchanged, or a hookmap gap) is exactly
  // as undeliverable as a timeout or a JSON-RPC error, and must be answered
  // by the posture the same way, not left to escape as a bare throw. The
  // fallback render in the catch cannot itself fail: loadHookmap already
  // guaranteed every entry in `hookmap.decisions` it accepted -- including
  // `allow` and `deny`, both required -- is itself a renderable rule, not
  // merely present, and applyFailurePosture never returns any decision but
  // those two. Both of those rules also declare a path under the wrapper
  // that asClaudeCodeOutput requires, so the wrap cannot fail either.
  //
  // `requestDecision` answers the one question that matters here and never
  // throws for a delivery failure (PR #10 review, Important). This shim does
  // not read `.error`, cast `.result`, or work out which of them means "no
  // decision" -- getting that branch wrong is a fail-open, and a decision
  // arriving alongside a malformed `error` must still be honoured, which is
  // the case a copy of that inspection gets wrong.
  let envelope: AcsRequestEnvelope | undefined;
  let hostOutput: HostOutput;
  const startedAt = performance.now();
  try {
    envelope = buildEnvelope(hookEventName, payload, hookmap);
    // The same values that just went out on the wire, unwrapped from ACS's
    // `{value, provenance?}` argument shape -- so a `modify` decision's
    // `parameter_overrides` apply lands on exactly what the Guardian saw.
    const originalArguments = unwrapArguments(envelope);

    const answer = await guardian.requestDecision(envelope, { timeoutMs });
    const elapsedMs = performance.now() - startedAt;

    const decision: AcsDecision = answer.decisionArrived
      ? validateDecision(answer.decision, { elapsedMs, originalArguments })
      : applyFailurePosture({
          failure: answer.failure,
          sessionConfig,
          sessionId,
          method: envelope.method,
          rpcId: envelope.id,
          audit,
        });

    hostOutput = asClaudeCodeOutput(renderDecision(decision, hookmap), hookEventName);
  } catch (error) {
    const decision = applyFailurePosture({
      failure: error,
      sessionConfig,
      sessionId,
      method: envelope?.method ?? hookEventName,
      rpcId: envelope?.id ?? null,
      audit,
    });
    hostOutput = asClaudeCodeOutput(renderDecision(decision, hookmap), hookEventName);
  }

  process.stdout.write(JSON.stringify(hostOutput));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof BlockingConfigurationError ? 2 : 1);
});
