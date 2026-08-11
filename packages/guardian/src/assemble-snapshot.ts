/**
 * assembleSnapshot converts a validated ACS request envelope (method
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

export function assembleSnapshot(envelope: ToolCallRequestEnvelope): Record<string, unknown> {
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
