import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { handshakeResponder } from "../src/handshake.ts";

const MODULE = fileURLToPath(new URL("../src/handshake.ts", import.meta.url));

/**
 * Calls `handshakeResponder()` with NO argument at all -- the shipped call
 * site, and the one path every test in this file used to skip by passing an
 * explicit object.
 *
 * In a subprocess, deliberately. The zero-argument path reads
 * `process.env`, and setting that in-process leaks into every other test in
 * the run: plan Risk 7 forbids it by name, and Task 1's own posture wiring
 * was reworked to take an explicit option for exactly this reason. A
 * subprocess gets its own environment, so `posture` here is the genuine
 * value of `process.env.ACS_ON_DECISION_FAILURE` inside that process --
 * including genuinely unset, which is the case a mocked env cannot honestly
 * produce.
 */
async function respondInSubprocess(
  posture: string | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env } as Record<string, string | undefined>;
  if (posture === undefined) {
    delete env.ACS_ON_DECISION_FAILURE;
  } else {
    env.ACS_ON_DECISION_FAILURE = posture;
  }
  const proc = Bun.spawn(
    ["bun", "-e", `import {handshakeResponder} from ${JSON.stringify(MODULE)};` +
      "process.stdout.write(JSON.stringify(handshakeResponder()));"],
    { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("handshakeResponder — negotiated posture (D8, R1.7)", () => {
  it("ships the ACS spec default when nothing is configured", () => {
    expect(handshakeResponder({}).on_decision_failure).toBe("proceed");
  });

  it("declares fail-closed when the deployment asks for it", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "deny" }).on_decision_failure).toBe("deny");
  });

  it("declares fail-open when the deployment asks for it explicitly", () => {
    expect(handshakeResponder({ ACS_ON_DECISION_FAILURE: "proceed" }).on_decision_failure).toBe("proceed");
  });

  // A typo must not silently pick a posture. Fail-open is the spec default,
  // but "dney" is not a request for it -- it is a broken deployment, and a
  // governance tool that guesses here is the whole problem this slice is about.
  it("throws on a value that is neither posture, naming the value", () => {
    expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: "dney" })).toThrow(/dney/);
  });

  // An empty string is explicitly set (not undefined), so it is a broken
  // deployment that must throw, not silently fall back to fail-open.
  it("throws on an empty string, treating it as explicit misconfiguration", () => {
    expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: "" })).toThrow();
  });

  // A posture is a deployment's declared intent, not a spelling suggestion.
  // `"Deny"` is not a request to fail closed and `"PROCEED"` is not a
  // request to fail open -- both are typos, and a governance tool that
  // normalizes them is guessing at exactly the point this slice exists to
  // stop guessing. Correct today; untested until now, so a future
  // `.toLowerCase()` added for "convenience" would have shipped silently.
  for (const miscased of ["Deny", "DENY", "PROCEED", "Proceed", " deny", "deny "]) {
    it(`throws on ${JSON.stringify(miscased)} rather than normalizing it`, () => {
      expect(() => handshakeResponder({ ACS_ON_DECISION_FAILURE: miscased })).toThrow(
        /ACS_ON_DECISION_FAILURE must be/,
      );
    });
  }

  it("still declares every ServerHello field handshake.json requires", () => {
    const hello = handshakeResponder({});
    expect(Object.keys(hello).sort()).toEqual(
      ["methods_evaluated", "negotiated_version", "on_decision_failure", "selected_transport", "timeout_config"],
    );
    expect(hello.timeout_config.default_ms).toBe(5000);
  });
});

// Every test above passes an explicit object, so none of them touches the
// shipped call site: `handshakeResponder()` with no argument, falling back to
// `process.env`. That fallback is the only thing that makes
// ACS_ON_DECISION_FAILURE a deployment control at all -- if it silently
// stopped reading the environment, every test above would still pass and
// every deployment would silently run fail-open.
describe("handshakeResponder — the zero-argument path the Guardian actually calls", () => {
  it("reads the deployment's posture from its own process environment", async () => {
    const { exitCode, stdout, stderr } = await respondInSubprocess("deny");
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout).on_decision_failure).toBe("deny");
  });

  it("applies the ACS default when the variable is genuinely unset", async () => {
    const { exitCode, stdout, stderr } = await respondInSubprocess(undefined);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout).on_decision_failure).toBe("proceed");
  });

  it("throws on a misconfigured environment rather than falling back to fail-open", async () => {
    const { exitCode, stdout, stderr } = await respondInSubprocess("dney");
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("dney");
  });
});
