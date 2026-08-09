import { describe, expect, it } from "bun:test";
import { renderDecisionBadge, renderEntry } from "../src/render.ts";
import type { TapEntry } from "../src/tail-envelope-log.ts";

function entry(overrides: Partial<TapEntry>): TapEntry {
  return {
    seq: 3,
    recorded_at: "2026-08-09T12:04:31.221Z",
    direction: "response",
    method: "steps/toolCallRequest",
    rpc_id: 1,
    envelope: {},
    ...overrides,
  };
}

function response(result: Record<string, unknown>): TapEntry {
  return entry({ envelope: { jsonrpc: "2.0", id: 1, result } });
}

describe("renderDecisionBadge (U21)", () => {
  it("returns null for requests", () => {
    expect(renderDecisionBadge(entry({ direction: "request", envelope: { jsonrpc: "2.0", id: 1 } }))).toBeNull();
  });

  it("returns null for a response with no decision -- a ServerHello", () => {
    expect(renderDecisionBadge(response({ negotiated_version: "0.1.0", on_decision_failure: "proceed" }))).toBeNull();
  });

  it("badges a deny, with reason_codes and policy_references", () => {
    const badge = renderDecisionBadge(
      response({
        decision: "deny",
        reason_codes: ["destructive_shell_command_blocked"],
        policy_references: [{ policy_id: "agt_stock", rule_id: "destructive_shell_command_blocked" }],
      }),
    );

    expect(badge).toBe(
      "● DENY  reason_codes=[destructive_shell_command_blocked]  " +
        "policy_references=[agt_stock#destructive_shell_command_blocked]",
    );
  });

  it("badges a plain allow", () => {
    expect(renderDecisionBadge(response({ decision: "allow" }))).toBe("○ ALLOW");
  });

  // The reason U21 exists, per the slices doc: an AGT `warn` arrives as an
  // ACS `allow` with a non-empty policy_references, and the badge is what
  // keeps it from being buried.
  it("distinguishes an allow that carries policy_references -- ACS's encoding of warn", () => {
    const badge = renderDecisionBadge(
      response({
        decision: "allow",
        reason_codes: ["drift_detected"],
        policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }],
      }),
    );

    expect(badge).toBe(
      '◐ ALLOW (policy fired — ACS "warn")  reason_codes=[drift_detected]  ' +
        "policy_references=[agt_stock#drift_detected]",
    );
    expect(badge).not.toBe(renderDecisionBadge(response({ decision: "allow" })));
  });

  it("badges modify, ask, and defer", () => {
    expect(renderDecisionBadge(response({ decision: "modify" }))).toBe("◆ MODIFY");
    expect(renderDecisionBadge(response({ decision: "ask" }))).toBe("◆ ASK");
    expect(renderDecisionBadge(response({ decision: "defer" }))).toBe("◆ DEFER");
  });

  it("badges a JSON-RPC error", () => {
    const badge = renderDecisionBadge(
      entry({ envelope: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "ACS envelope failed" } } }),
    );

    expect(badge).toBe("✖ ERROR -32010  ACS envelope failed");
  });

  it("emits ANSI only when colour is asked for", () => {
    const plain = renderDecisionBadge(response({ decision: "deny" }), { color: false });
    const coloured = renderDecisionBadge(response({ decision: "deny" }), { color: true });

    expect(plain).toBe("● DENY");
    expect(coloured).toContain("\u001b[");
    expect(coloured).toContain("DENY");
  });
});

describe("renderEntry (U20)", () => {
  it("renders a request as a header line plus pretty JSON, with no badge", () => {
    const rendered = renderEntry(
      entry({
        direction: "request",
        seq: 1,
        envelope: { jsonrpc: "2.0", method: "steps/toolCallRequest", id: 1 },
      }),
    );

    expect(rendered.split("\n")[0]).toBe("── #1  12:04:31.221  → REQUEST   steps/toolCallRequest  id=1");
    expect(rendered).toContain('"jsonrpc": "2.0"');
    expect(rendered).not.toContain("●");
  });

  it("renders a response as a header line, a badge line, then pretty JSON", () => {
    const rendered = renderEntry(response({ decision: "deny", reason_codes: ["blocked"] }));
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("── #3  12:04:31.221  ← RESPONSE  steps/toolCallRequest  id=1");
    expect(lines[1]).toBe("● DENY  reason_codes=[blocked]");
    expect(lines[2]).toBe("{");
  });

  it("labels an unpaired response -- the malformed-body case -- without an id or a method", () => {
    const rendered = renderEntry(
      entry({ method: null, rpc_id: null, envelope: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } }),
    );

    expect(rendered.split("\n")[0]).toBe("── #3  12:04:31.221  ← RESPONSE  (no method)  (unpaired)");
  });

  // Retitled by the whole-branch review (finding 2) -- the assertions are
  // unchanged. What this has always checked is that the JSON *value* round
  // trips: nothing stripped, nothing reordered, only whitespace reshaped.
  // "Verbatim" claimed more than that, since S6 stores the value the
  // Guardian parsed rather than the bytes the host sent.
  it("changes nothing but whitespace -- the envelope value round trips through the renderer", () => {
    const envelope = { jsonrpc: "2.0", id: 1, result: { decision: "allow", nested: { deep: [1, 2] } } };
    const rendered = renderEntry(entry({ envelope }));
    const jsonStart = rendered.indexOf("{");

    expect(JSON.parse(rendered.slice(jsonStart))).toEqual(envelope);
  });

  // Whole-branch review, finding 8. `isTapEntryShape` deliberately does not
  // constrain `envelope`, so a hand-written or truncated S6 line reaches the
  // renderer with the key missing entirely. `JSON.stringify(undefined)`
  // returns `undefined`, which `join` would coerce into a blank line
  // indistinguishable from a real empty body.
  it("marks an entry whose envelope key is absent, instead of emitting a blank body", () => {
    const withoutEnvelope = {
      seq: 3,
      recorded_at: "2026-08-09T12:04:31.221Z",
      direction: "response",
      method: "steps/toolCallRequest",
      rpc_id: 1,
    } as unknown as TapEntry;

    const lines = renderEntry(withoutEnvelope).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("── #3  12:04:31.221  ← RESPONSE  steps/toolCallRequest  id=1");
    expect(lines[1]).toBe("(no envelope recorded)");
  });
});
