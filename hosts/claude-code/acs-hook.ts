/**
 * acs-hook.ts (N1) -- Claude Code's PreToolUse hook shim.
 *
 * Deliberately thin: read the hook JSON Claude Code sends on stdin, call
 * buildEnvelope -> guardianClient.post -> renderDecision (all three from
 * `host-adapter`, packages/host-adapter), wrap the output that comes back
 * into the JSON Claude Code expects, and write it to stdout. All logic lives
 * in the adapter -- this file is only the wiring a Claude Code hook process
 * needs (stdin, stdout, exit code, which hookmap file to load) plus the one
 * thing the adapter must not know: this host's own output shape. Slice V5
 * adds a second host by writing another shim this thin against the same,
 * unchanged adapter; any logic added here is logic V5 would have to
 * duplicate.
 *
 * This file is host-specific by definition (it may name Claude Code
 * freely) but must not reach into AGT -- it never imports `agt-bridge` or
 * `guardian`'s server-side pieces, only `host-adapter`'s public surface,
 * and talks to the Guardian only over HTTP via `guardianClient.post`.
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
 * V1 SCOPE -- Guardian-unreachable handling: if anything above throws (the
 * Guardian is down, returns a JSON-RPC error, or the stdin payload is
 * malformed), this shim does NOT implement a fail-open/fail-closed
 * posture. That negotiation is N6/N7, deliberately deferred to slice V3.
 * It writes the error to stderr only, and exits 1 ("non-blocking error"
 * per the hook protocol) with nothing on stdout -- Claude Code proceeds as
 * though the hook had not fired. This is a placeholder, not a considered
 * posture; V3 should replace it deliberately.
 */
import { fileURLToPath } from "node:url";
import { buildEnvelope, guardianClient, loadHookmap, renderDecision, type HostOutput } from "host-adapter";

const HOOKMAP_PATH = fileURLToPath(new URL("./claude-code.hookmap.yaml", import.meta.url));

// Matches packages/guardian/src/main.ts's own default port -- the runbook
// and this shim agree on 8787 without either hardcoding the other's value.
// Override with ACS_GUARDIAN_URL when the Guardian runs on a different
// host/port (e.g. in tests, which start a Guardian on an ephemeral port).
const DEFAULT_GUARDIAN_URL = "http://localhost:8787/acs";

/**
 * Claude Code's own output shape, which lives here and nowhere else (PR #10
 * review, Critical).
 *
 * The adapter renders into a shape it does not name: `renderDecision` reads
 * the hookmap's dotted output paths and assembles the object they describe,
 * knowing ACS decisions and nothing about this host. That is what lets slice
 * V5 add a second host with a shim and a hookmap instead of a fork of the
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

async function main(): Promise<void> {
  const input = await Bun.stdin.text();
  const payload = JSON.parse(input) as Record<string, unknown>;

  const hookEventName = payload.hook_event_name;
  if (typeof hookEventName !== "string") {
    throw new Error('acs-hook: stdin payload is missing a string "hook_event_name" field');
  }

  const hookmap = loadHookmap(HOOKMAP_PATH);
  const envelope = buildEnvelope(hookEventName, payload, hookmap);

  const guardianUrl = process.env.ACS_GUARDIAN_URL ?? DEFAULT_GUARDIAN_URL;
  const response = await guardianClient.post(guardianUrl, envelope);

  if (response.error) {
    throw new Error(`acs-hook: Guardian returned a JSON-RPC error: ${response.error.message}`);
  }

  const rendered = renderDecision(response.result as { decision: string } & Record<string, unknown>, hookmap);

  process.stdout.write(JSON.stringify(asClaudeCodeOutput(rendered, hookEventName)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
