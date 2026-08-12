import { describe, expect, it } from "bun:test";
import {
  assertOutputIsReplaceable,
  projectAppliedOutput,
  replacingOutput,
  WITHHELD_OUTPUT,
  type HostOutputLocation,
} from "../src/result-output.ts";

/**
 * `replacingOutput`'s mirror handling (§V5, slice #6): V4's discipline is to
 * patch a CLONE of the object a hookmap names, so every sibling survives by
 * construction. On a host where one sibling is a genuine MIRROR of the leaf --
 * its own copy of the same text, not merely a neighbouring field -- that
 * discipline is exactly the property that leaks: the clone preserves the
 * mirror untouched, and the mirror still carries the plaintext.
 *
 * The example paths below (`$.result.output`, `$.result.metadata.output`) are
 * the brief's own stand-in shape, not any real host's field names -- this
 * module names no host field, and neither does this test.
 */
describe("replacingOutput — a leaf can have mirrors (§V5)", () => {
  const location: HostOutputLocation = {
    payload: { result: { output: "SECRET", metadata: { output: "SECRET", exit: 0 } } },
    outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.result.metadata.output"] },
  };

  it("patches every declared mirror as well as the leaf", () => {
    expect(replacingOutput(location, "[REDACTED]")).toEqual({
      output: "[REDACTED]",
      metadata: { output: "[REDACTED]", exit: 0 },
    });
  });

  it("refuses when a mirror is left holding what the leaf held", () => {
    const undeclared = { ...location, outputs: { from: "$.result.output", within: "$.result" } };
    expect(() => replacingOutput(undeclared, "[REDACTED]")).toThrow(/still holds/);
  });

  // The degenerate case the substring form got wrong. A tool that produced no
  // output must still be replaceable -- otherwise every empty result is
  // withheld, since an empty string is a "substring" of every replacement.
  it("does not refuse an empty leaf just because the empty string is everywhere", () => {
    const empty: HostOutputLocation = {
      payload: { result: { output: "", metadata: { output: "", exit: 0 } } },
      outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.result.metadata.output"] },
    };
    expect(replacingOutput(empty, "[REDACTED]")).toEqual({
      output: "[REDACTED]",
      metadata: { output: "[REDACTED]", exit: 0 },
    });
  });

  // More than one declared mirror -- the loop has to leave NONE of them
  // holding the original, not merely the first.
  it("patches every mirror in a list of more than one, leaving none of them holding the original", () => {
    const twoMirrors: HostOutputLocation = {
      payload: {
        result: {
          output: "SECRET",
          echo: { output: "SECRET" },
          log: { last: { output: "SECRET" } },
        },
      },
      outputs: {
        from: "$.result.output",
        within: "$.result",
        mirrors: ["$.result.echo.output", "$.result.log.last.output"],
      },
    };
    expect(replacingOutput(twoMirrors, "[REDACTED]")).toEqual({
      output: "[REDACTED]",
      echo: { output: "[REDACTED]" },
      log: { last: { output: "[REDACTED]" } },
    });
  });

  // A mirror is a further path INSIDE `within`, the same container the leaf
  // lives in -- not an arbitrary path anywhere in the payload.
  it("refuses a declared mirror that names a path outside `within`", () => {
    const outside: HostOutputLocation = {
      payload: { result: { output: "SECRET" }, other: { output: "SECRET" } },
      outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.other.output"] },
    };
    expect(() => replacingOutput(outside, "[REDACTED]")).toThrow(/is not inside/);
  });

  it("does not mutate the payload the host handed us, mirror included", () => {
    replacingOutput(location, "[REDACTED]");
    expect(location.payload.result).toEqual({ output: "SECRET", metadata: { output: "SECRET", exit: 0 } });
  });

  // Claude Code's hookmap declares no `mirrors` at all -- `mirrors` is
  // optional, and an entry that never names one must behave exactly as it did
  // before this task: nothing left over for the post-condition to catch.
  it("still works exactly as before when no `mirrors` are declared at all", () => {
    const noMirrors: HostOutputLocation = {
      payload: { tool_response: { stdout: "SECRET", stderr: "", interrupted: false } },
      outputs: { from: "$.tool_response.stdout", within: "$.tool_response" },
    };
    expect(replacingOutput(noMirrors, "[REDACTED]")).toEqual({
      stdout: "[REDACTED]",
      stderr: "",
      interrupted: false,
    });
  });
});

/**
 * `assertOutputIsReplaceable` calls `replacingOutput` with `WITHHELD_OUTPUT`
 * BEFORE any decision is sought (`governStep`'s own preflight, see
 * govern-step.ts). So a hookmap entry missing a mirror declaration is refused
 * there too -- not as a withholding deny, but as a blocking stop for the
 * deployment: the same throw, reached one route earlier.
 */
describe("replacingOutput — the same refusal, reached from the preflight (§V5)", () => {
  it("blocks the deployment at the preflight when a hookmap is missing a mirror declaration", () => {
    const location: HostOutputLocation = {
      payload: { result: { output: "SECRET", metadata: { output: "SECRET" } } },
      outputs: { from: "$.result.output", within: "$.result" },
    };
    expect(() => assertOutputIsReplaceable(location)).toThrow(/still holds/);
  });

  it("passes the preflight once the mirror is declared", () => {
    const location: HostOutputLocation = {
      payload: { result: { output: "SECRET", metadata: { output: "SECRET" } } },
      outputs: { from: "$.result.output", within: "$.result", mirrors: ["$.result.metadata.output"] },
    };
    expect(() => assertOutputIsReplaceable(location)).not.toThrow();
  });
});

/**
 * Task 1's own bundle check and its `withoutProjectedLeaf` helper (§V5) were
 * added to `projectAppliedOutput` and covered only indirectly, through
 * validate-decision.test.ts's exercise of the whole `resolveModify` path.
 * This is the direct coverage that Task deferred to this file: the bundle
 * check itself, called straight against `projectAppliedOutput`, and
 * `withoutProjectedLeaf`'s fallback branch -- reached only through
 * `originalDocument`, since `appliedDocument`'s own `outputs[0]` shape is
 * already validated earlier in the same function.
 */
describe("projectAppliedOutput — the bundle check, called directly (§V5)", () => {
  const location: HostOutputLocation = {
    payload: { result: { output: "SECRET" } },
    outputs: { from: "$.result.output", within: "$.result" },
  };
  const originalDocument = { tool: { name: "t" }, exit_status: "success", outputs: [{ value: "SECRET" }] };

  it("lands a leaf-only rewrite with nothing left to catch", () => {
    const appliedDocument = { tool: { name: "t" }, exit_status: "success", outputs: [{ value: "[REDACTED]" }] };
    expect(projectAppliedOutput(appliedDocument, originalDocument, location)).toEqual({ output: "[REDACTED]" });
  });

  it("denies when the leaf lands but the document changed somewhere else too", () => {
    const appliedDocument = { tool: { name: "t" }, exit_status: "failure", outputs: [{ value: "[REDACTED]" }] };
    expect(() => projectAppliedOutput(appliedDocument, originalDocument, location)).toThrow(
      /changed more of the ACS result payload than the one leaf/,
    );
  });

  // `withoutProjectedLeaf`'s fallback branch: `originalDocument.outputs` is
  // not the `[{value}, ...]` shape the projected leaf lives in, so it falls
  // back to comparing `originalDocument` untouched rather than throwing --
  // and the untouched fallback still reports the mismatch as a real
  // difference, rather than pretending a leaf was found where none was.
  //
  // Only `originalDocument` can exercise this branch through
  // `projectAppliedOutput`'s public surface: `appliedDocument`'s own
  // `outputs[0]` is already required to be a plain object carrying "value" by
  // the check earlier in that function, so it always takes the OTHER branch
  // (the leaf zeroed out, not the untouched document) -- which is exactly why
  // this is the fallback's only reachable shape of test here, and why it
  // denies rather than passing quietly: an eligible document compared against
  // an ineligible one can never serialise the same.
  it("does not crash when the original document's own outputs shape is malformed, and still reports the difference", () => {
    const appliedDocument = { tool: { name: "t" }, exit_status: "success", outputs: [{ value: "[REDACTED]" }] };
    const malformedOriginal = { tool: { name: "t" }, exit_status: "success", outputs: "not-the-projected-shape" };
    expect(() => projectAppliedOutput(appliedDocument, malformedOriginal, location)).toThrow(
      /changed more of the ACS result payload than the one leaf/,
    );
  });
});
