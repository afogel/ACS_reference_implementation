import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startGuardian, type StartedGuardian } from "guardian";
import { checkFailureDomains } from "../src/failure-domains.ts";

let guardian: StartedGuardian;
beforeAll(async () => {
  guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
});
afterAll(async () => {
  await guardian.close();
});

describe("N44 -- the two failure domains stay apart", () => {
  it("resolves the deny column expressed, by name, at exactly the six points mapping.yaml gives an ACS method to", async () => {
    // Pins the SCOPE of the claim (review round 1, Important 2): the prior
    // version of this test only asserted "every deny cell that came back is
    // expressed", which passes identically whether checkFailureDomains
    // measured one point or six -- it could not have told a correct
    // six-point measurement apart from an unmeasured one. This asserts
    // exactly which points are covered, by name, matching mapping.yaml's six
    // acs_method-bearing rows (pre_model_call / post_model_call excluded --
    // N41's cell, not this check's).
    const cells = await checkFailureDomains(guardian.url);
    const deny = cells.filter((c) => c.verdict === "deny");

    expect(deny.map((c) => c.point).sort()).toEqual([
      "agent_shutdown",
      "agent_startup",
      "input",
      "output",
      "post_tool_call",
      "pre_tool_call",
    ]);
    for (const cell of deny) {
      expect(cell.status).toBe("expressed");
      expect(cell.measuredBy).toContain("N44");
    }
  });

  it("gets a decision rather than a JSON-RPC error when the envelope cannot be validated", async () => {
    const response = await fetch(guardian.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-n44",
        method: "steps/toolCallRequest",
        params: {
          acs_version: "0.1.0",
          // A real UUID, not the brief's literal "req-n44": request_id is
          // echoed into the deny response's own result.request_id, which
          // response-envelope.json constrains to format "uuid" -- keeping
          // the placeholder would make the RESPONSE itself fail schema
          // validation and log a console.error unrelated to what this test
          // means to exercise (review round 1, Minor 5; Task 2 made the same
          // fix for the same reason -- see the task report).
          request_id: crypto.randomUUID(),
          metadata: { session_id: "sess-n44" },
          payload: {},
        },
      }),
    });
    const body = (await response.json()) as { result?: { decision?: string }; error?: unknown };

    expect(body.error).toBeUndefined();
    expect(body.result?.decision).toBe("deny");
  });
});
