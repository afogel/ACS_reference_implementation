/**
 * assemblePreToolCallSnapshot converts a validated ACS request envelope (method
 * `steps/toolCallRequest`) into the AGT snapshot for `pre_tool_call`,
 * shaped per AGT-SNAPSHOT-1.0.md §2.5.
 *
 * Envelope-only (per the V1 watch-for): this reads nothing but the
 * envelope handed to it -- no session state, no chain hash, no prior
 * decisions, no intent. Those arrive in V6 via S3/S4/S5.
 */

/**
 * The envelope type is validate-envelope.ts's (Task 5) -- re-exported here
 * so existing imports of `ToolCallRequestEnvelope` from this module keep
 * working. Task 4 had declared a local, narrower type as a temporary seam;
 * this closes it so there's exactly one envelope shape, not two that could
 * silently diverge.
 *
 * Since the PR #10 review that name means what it says: the tool-call view of
 * a validated ACS request, reachable only through `isToolCallRequest`. This
 * function takes exactly that, so its signature no longer accepts a
 * `handshake/hello` it would read `params.payload.tool.name` off.
 */
import type { ToolCallRequestEnvelope } from "./validate-envelope.ts";
export type { ToolCallRequestEnvelope };

/**
 * The AGT `pre_tool_call` snapshot, as a message rather than an anonymous dict
 * (PR #10 review, Important). This module used to return
 * `Record<string, unknown>`: the bridge could be handed anything at all, and
 * the only description of what a snapshot contains was the literal below.
 *
 * Named for the intervention point it is the snapshot FOR, because that is what
 * fixes its shape -- AGT-SNAPSHOT-1.0.md §2.5 gives each point its own. A later
 * slice's `post_tool_call` snapshot is a sibling type beside this one, not a
 * widening of it.
 *
 * `args` stays `Record<string, unknown>` on purpose: those are the tool's own
 * arguments, unwrapped from ACS's `{value, provenance}` shape, and their keys
 * are the tool's business rather than this project's.
 */
export type AgtPreToolCallSnapshot = {
  envelope: {
    budgets: {
      tool_call_count: number;
      token_count: number;
      elapsed_seconds: number;
      cost_usd: number;
    };
  };
  tool_call: {
    name: string;
    args: Record<string, unknown>;
    id: string;
  };
};

export function assemblePreToolCallSnapshot(envelope: ToolCallRequestEnvelope): AgtPreToolCallSnapshot {
  const { payload, request_id } = envelope.params;

  // Unwrap every argument. AGT reads raw values (e.g. args.command must be
  // a plain string for the stock pattern check's is_string guard -- C5);
  // the ACS {value, provenance} wrapper does not survive into the snapshot.
  const args: Record<string, unknown> = {};
  for (const [key, wrapper] of Object.entries(payload.arguments)) {
    args[key] = wrapper.value;
  }

  return {
    // budgets.rego fails closed on a present-but-wrong-typed counter, so
    // these are always real zeros, never undefined/null.
    envelope: {
      budgets: {
        tool_call_count: 0,
        token_count: 0,
        elapsed_seconds: 0,
        cost_usd: 0,
      },
    },
    tool_call: {
      name: payload.tool.name,
      args,
      id: request_id,
    },
  };
}
