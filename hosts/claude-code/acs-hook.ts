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
 * ON GUARDIAN-UNREACHABLE HANDLING (V3, replacing a V1 placeholder): once
 * this shim has parsed a hook payload -- a valid `hook_event_name` and
 * `session_id` off stdin, and a session store it was safe to open for that
 * `session_id` -- it always exits 0 with a decision on stdout. There is no
 * remaining path past that point that exits non-zero with nothing written.
 * A Guardian that is down, a response that carries an error instead of a
 * decision, or a request that times out are all delivery failures, not
 * decisions, and Global Constraint 1's two failure domains never merge: a
 * `deny` that arrives is honoured regardless of what follows, and a
 * delivery failure never gets dressed up as one. Every such failure is
 * resolved by the deployment's own negotiated `on_decision_failure`
 * posture (`applyFailurePosture`, N6) -- proceed or deny -- and every
 * fail-open `proceed` taken this way is written to the audit sink (S14)
 * first, so the bypass is visible rather than silent.
 *
 * V1's own version of this paragraph described a placeholder, not a
 * considered posture: it caught nothing, wrote the error to stderr only,
 * and exited 1 with empty stdout. Claude Code reads exit 1 as "non-blocking
 * error" and proceeds as though the hook had never fired -- so a thrown
 * error (the Guardian down, a malformed response, a lazy validator
 * failing) let the tool call run ungoverned, unaudited, and undeclared.
 * That fail-open recurred five more times elsewhere in this project before
 * this rewrite closed this, its origin. It is gone: every one of the
 * throws that used to reach V1's placeholder now flows into
 * `applyFailurePosture` instead, which always returns a decision and
 * always audits taking it.
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
  validateDecision,
  type AcsDecision,
  type AcsRequestEnvelope,
  type HostOutput,
} from "host-adapter";

const HOOKMAP_PATH = fileURLToPath(new URL("./claude-code.hookmap.yaml", import.meta.url));

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
 * Turns whatever stood in for a decision into one line of stderr. `failure` is
 * `unknown` by design -- it is a throw from the wire, a JSON-RPC `error`
 * object, or an Error this shim never constructed -- so this formats all three
 * rather than assuming any one of them.
 */
function describeFailure(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message;
  }
  return typeof failure === "string" ? failure : JSON.stringify(failure);
}

/** This Observed Agent's identity on the wire (ACS metadata.agent_id) --
 * matches claude-code.hookmap.yaml's own `host` field. */
const AGENT_ID = "claude-code";

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

  const hookmap = loadHookmap(HOOKMAP_PATH);

  // Step 2: an unsafe session_id is a broken host, not a policy question.
  // createFileSessionConfigStore throws InvalidSessionIdError synchronously,
  // before this shim writes anywhere; left uncaught here, it propagates to
  // main().catch below and exits 1.
  const store = createFileSessionConfigStore({
    dir: process.env.ACS_SESSION_DIR ?? ".acs/sessions",
    sessionId,
  });

  // Step 3: the audit sink (S14) -- total by construction, so building it
  // cannot itself throw, and a write to it never happens unless a fail-open
  // proceed (or a negotiated fail-closed deny) actually occurs below.
  const audit = createAuditSink({ path: process.env.ACS_AUDIT_LOG ?? ".acs/audit.jsonl" });

  const guardianUrl = process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL;
  const guardian = createGuardianClient(guardianUrl);

  // Step 4: negotiate once per session. A handshake failure decides nothing
  // by itself -- it is only a candidate delivery failure, used below only
  // if the step call that follows also fails to produce a decision. The
  // step call may still succeed on its own (a Guardian that answers
  // `steps/toolCallRequest` but is slow, or briefly refused, to answer
  // `handshake/hello`), and if it does, its decision stands untouched
  // (Global Constraint 2: the posture must never touch an arriving
  // decision).
  let handshakeFailure: unknown;
  if (store.get() === undefined) {
    try {
      // metadata.session_id is schema-constrained to "uuid" (same rule
      // buildEnvelope's own toSessionUuid honours below); the store itself
      // keys on the raw host session_id, per S13's own contract.
      await negotiateSessionConfig(
        { url: guardianUrl, agentId: AGENT_ID, sessionId: toSessionUuid(sessionId) },
        store,
      );
    } catch (error) {
      handshakeFailure = error;
    }
  }

  // Step 5.
  const sessionConfig = store.get();
  const timeoutMs = sessionConfig?.timeout_config.default_ms ?? DEFAULT_TIMEOUT_MS;

  // Step 6: buildEnvelope -> requestDecision, both inside one try. Two
  // outcomes: a decision arrived and goes to validateDecision (N7); no
  // decision arrived -- for any reason, including a JSON-RPC error response,
  // a timeout, or a throw from either call -- and that goes to
  // applyFailurePosture (N6). There is no other way out of this shim once
  // steps 1-3 above have succeeded.
  //
  // `requestDecision` answers the one question that matters here and never
  // throws for a delivery failure (PR #10 review, Important). This shim does
  // not read `.error`, cast `.result`, or work out which of them means "no
  // decision" -- getting that branch wrong is a fail-open, and a decision
  // arriving alongside a malformed `error` must still be honoured, which is
  // the case a copy of that inspection gets wrong.
  let envelope: AcsRequestEnvelope | undefined;
  let decision: AcsDecision;
  const startedAt = performance.now();
  try {
    envelope = buildEnvelope(hookEventName, payload, hookmap);

    // The same values that just went out on the wire, unwrapped from ACS's
    // `{value, provenance?}` argument shape -- so a `modify` decision's
    // `parameter_overrides` apply lands on exactly what the Guardian saw,
    // not on the raw host payload.
    const originalArguments: Record<string, unknown> = {};
    for (const [key, argument] of Object.entries(envelope.params.payload.arguments)) {
      originalArguments[key] = argument.value;
    }

    const answer = await guardian.requestDecision(envelope, { timeoutMs });
    const elapsedMs = performance.now() - startedAt;

    decision = answer.decisionArrived
      ? validateDecision(answer.decision, { elapsedMs, originalArguments })
      : applyFailurePosture({
          // Same preference as the catch below, for the same reason.
          failure: handshakeFailure ?? answer.failure,
          sessionConfig,
          sessionId,
          method: envelope.method,
          rpcId: envelope.id,
          audit,
        });
  } catch (error) {
    decision = applyFailurePosture({
      // Prefers the handshake's own failure when the step call also could
      // not produce a decision: both failed against the same Guardian, on
      // the same connection, for the same underlying reason, and the
      // handshake attempt is the earlier, root-cause signal.
      failure: handshakeFailure ?? error,
      sessionConfig,
      sessionId,
      method: envelope?.method ?? hookEventName,
      rpcId: envelope?.id ?? null,
      audit,
    });
  }

  // Step 7.
  const rendered = renderDecision(decision, hookmap);
  process.stdout.write(JSON.stringify(asClaudeCodeOutput(rendered, hookEventName)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
