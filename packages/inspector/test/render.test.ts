import { describe, expect, it } from "bun:test";
import {
  decisionMessageOf,
  renderDecisionBadge,
  renderEnvelopeLogEntry,
  type DecisionMessage,
  type RenderOptions,
} from "../src/render.ts";
import type { EnvelopeLogEntry } from "../src/tail-envelope-log.ts";

function entry(overrides: Partial<EnvelopeLogEntry>): EnvelopeLogEntry {
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

function response(result: Record<string, unknown>): EnvelopeLogEntry {
  return entry({ envelope: { jsonrpc: "2.0", id: 1, result } });
}

/** The message renderEnvelopeLogEntry would build for this S6 line, for the
 * badge tests that assert the rendered string end to end. Throws rather than
 * asserting non-null inline, so a line that stopped carrying an outcome fails
 * as itself instead of as a confusing `toBe` diff. */
function messageOf(line: EnvelopeLogEntry): DecisionMessage {
  const message = decisionMessageOf(line);
  if (message === null) {
    throw new Error("expected this entry to carry a decision or an error");
  }
  return message;
}

function badgeFor(result: Record<string, unknown>, options?: RenderOptions): string {
  return renderDecisionBadge(messageOf(response(result)), options);
}

describe("decisionMessageOf -- what U21 is told about", () => {
  it("has nothing to say about a request", () => {
    expect(decisionMessageOf(entry({ direction: "request", envelope: { jsonrpc: "2.0", id: 1 } }))).toBeNull();
  });

  it("has nothing to say about a response with no decision -- a ServerHello", () => {
    expect(decisionMessageOf(response({ negotiated_version: "0.1.0", on_decision_failure: "proceed" }))).toBeNull();
  });

  // The reshape's point (PR #11 review): the badge is handed ACS fields, not
  // a log row to dig through, so everything it renders is decided here.
  it("narrows the ACS fields the badge renders, and drops the rest of the envelope", () => {
    expect(
      decisionMessageOf(
        response({
          decision: "deny",
          reason_codes: ["blocked", 7],
          policy_references: [{ policy_id: "agt_stock", rule_id: "blocked" }, "not an object"],
          reasoning: "ignored by the badge",
        }),
      ),
    ).toEqual({
      decision: "deny",
      reason_codes: ["blocked"],
      policy_references: [{ policy_id: "agt_stock", rule_id: "blocked" }],
    });
  });

  it("reports a JSON-RPC error as an error message, with a null code when it is not a number", () => {
    expect(decisionMessageOf(entry({ envelope: { jsonrpc: "2.0", id: 1, error: { code: "nope" } } }))).toEqual({
      error: { code: null, message: "" },
    });
  });
});

describe("renderDecisionBadge (U21)", () => {
  // The renderer needs no envelope log at all now: anything that can build
  // the message can use the badge.
  it("renders a message built by hand, with no log entry anywhere in sight", () => {
    expect(renderDecisionBadge({ decision: "deny", reason_codes: [], policy_references: [] })).toBe("● DENY");
  });

  it("badges a deny, with reason_codes and policy_references", () => {
    const badge = badgeFor({
      decision: "deny",
      reason_codes: ["destructive_shell_command_blocked"],
      policy_references: [{ policy_id: "agt_stock", rule_id: "destructive_shell_command_blocked" }],
    });

    expect(badge).toBe(
      "● DENY  reason_codes=[destructive_shell_command_blocked]  " +
        "policy_references=[agt_stock#destructive_shell_command_blocked]",
    );
  });

  it("badges a plain allow", () => {
    expect(badgeFor({ decision: "allow" })).toBe("○ ALLOW");
  });

  // The reason U21 exists, per the slices doc: an AGT `warn` arrives as an
  // ACS `allow` with a non-empty policy_references, and the badge is what
  // keeps it from being buried.
  it("distinguishes an allow that carries policy_references -- ACS's encoding of warn", () => {
    const badge = badgeFor({
      decision: "allow",
      reason_codes: ["drift_detected"],
      policy_references: [{ policy_id: "agt_stock", rule_id: "drift_detected" }],
    });

    expect(badge).toBe(
      '◐ ALLOW (policy fired — ACS "warn")  reason_codes=[drift_detected]  ' +
        "policy_references=[agt_stock#drift_detected]",
    );
    expect(badge).not.toBe(badgeFor({ decision: "allow" }));
  });

  // Pins current behaviour (backlog item H): ACS's schemas do not require
  // `rule_id` on a policy_reference, so this is a real shape, not a
  // hypothetical one. Dropping to the bare policy_id here is a deliberate
  // degradation, not a bug -- this test exists so a future change to it is
  // a decision, not an accident.
  it("renders a policy_reference with no rule_id as the bare policy_id", () => {
    const badge = badgeFor({ decision: "deny", policy_references: [{ policy_id: "agt_stock" }] });

    expect(badge).toBe("● DENY  policy_references=[agt_stock]");
  });

  it("badges modify, ask, and defer", () => {
    expect(badgeFor({ decision: "modify" })).toBe("◆ MODIFY");
    expect(badgeFor({ decision: "ask" })).toBe("◆ ASK");
    expect(badgeFor({ decision: "defer" })).toBe("◆ DEFER");
  });

  it("badges a JSON-RPC error", () => {
    const badge = renderDecisionBadge(
      messageOf(entry({ envelope: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "ACS envelope failed" } } })),
    );

    expect(badge).toBe("✖ ERROR -32010  ACS envelope failed");
  });

  // Pins the fallback the old renderer had inline: a code that is not a
  // number reaches the message as null and still renders as `?`.
  it("badges an error whose code is not a number", () => {
    expect(renderDecisionBadge({ error: { code: null, message: "unreadable" } })).toBe("✖ ERROR ?  unreadable");
  });

  it("emits ANSI only when colour is asked for", () => {
    const plain = badgeFor({ decision: "deny" }, { color: false });
    const coloured = badgeFor({ decision: "deny" }, { color: true });

    expect(plain).toBe("● DENY");
    expect(coloured).toContain("\u001b[");
    expect(coloured).toContain("DENY");
  });

  // Backlog item I: with color:true, only the glyph and decision label used
  // to be painted, so a coloured badge read as one coloured half and one
  // plain half. The appended segments are painted dim so the whole badge
  // reads as one unit; color:false stays byte-identical (asserted by the
  // exact-string tests above, which are unchanged).
  it("paints the appended reason_codes/policy_references segments dim when coloured", () => {
    const coloured = badgeFor(
      {
        decision: "deny",
        reason_codes: ["destructive_shell_command_blocked"],
        policy_references: [{ policy_id: "agt_stock", rule_id: "destructive_shell_command_blocked" }],
      },
      { color: true },
    );

    expect(coloured).toContain("\u001b[2mreason_codes=[destructive_shell_command_blocked]\u001b[0m");
    expect(coloured).toContain("\u001b[2mpolicy_references=[agt_stock#destructive_shell_command_blocked]\u001b[0m");
  });
});

describe("renderEnvelopeLogEntry (U20)", () => {
  it("renders a request as a header line plus pretty JSON, with no badge", () => {
    const rendered = renderEnvelopeLogEntry(
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
    const rendered = renderEnvelopeLogEntry(response({ decision: "deny", reason_codes: ["blocked"] }));
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("── #3  12:04:31.221  ← RESPONSE  steps/toolCallRequest  id=1");
    expect(lines[1]).toBe("● DENY  reason_codes=[blocked]");
    expect(lines[2]).toBe("{");
  });

  it("labels an unpaired response -- the malformed-body case -- without an id or a method", () => {
    const rendered = renderEnvelopeLogEntry(
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
    const rendered = renderEnvelopeLogEntry(entry({ envelope }));
    const jsonStart = rendered.indexOf("{");

    expect(JSON.parse(rendered.slice(jsonStart))).toEqual(envelope);
  });

  // Whole-branch review, finding 8. `isEnvelopeLogEntryShape` deliberately does not
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
    } as unknown as EnvelopeLogEntry;

    const lines = renderEnvelopeLogEntry(withoutEnvelope).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("── #3  12:04:31.221  ← RESPONSE  steps/toolCallRequest  id=1");
    expect(lines[1]).toBe("(no envelope recorded)");
  });
});
