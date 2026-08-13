/**
 * applyHostOutput's own tests, in isolation from OpenCode -- plain objects in,
 * mutation or a throw out. See acs-plugin.ts's own header for why this
 * function exists at all: this host's hooks return `void`, so applying the
 * rendered `HostOutput` (rather than writing it, as host #1 does) is the one
 * piece of host semantics this slice owns.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { applyHostOutput } from "../acs-plugin.ts";

describe("applyHostOutput", () => {
  it("assigns args and result fields onto the live objects", () => {
    const live = { args: { command: "cat .env" }, result: { output: "SECRET", metadata: { output: "SECRET" } } };
    applyHostOutput(
      { args: { command: "echo safe" }, result: { output: "[REDACTED]", metadata: { output: "[REDACTED]" } } },
      live,
    );
    expect(live.args.command).toBe("echo safe");
    expect(live.result.metadata.output).toBe("[REDACTED]");
  });

  it("merges the whole result container, not a leaf, landing the leaf and its mirror together", () => {
    // §V5 review, fix round 1, Critical 1: applied_output is the WHOLE patched
    // clone of outputs.within (leaf + mirror), and this host's sink for it is
    // `result` itself. A sibling untouched by the redaction (title,
    // attachments) must survive the merge exactly like the leaf (output) and
    // its mirror (metadata.output) land -- the exact shape a real bash result
    // takes on this host, measured in opencode.hookmap.yaml's own header.
    const live = {
      result: {
        title: "bash",
        output: "TOKEN=ghp_ABCDEF123456",
        metadata: { output: "TOKEN=ghp_ABCDEF123456", exit: 0, truncated: false },
        attachments: [] as unknown[],
      },
    };
    applyHostOutput(
      {
        result: {
          title: "bash",
          output: "[OUTPUT WITHHELD BY POLICY]",
          metadata: { output: "[OUTPUT WITHHELD BY POLICY]", exit: 0, truncated: false },
          attachments: [],
        },
      },
      live,
    );
    expect(live.result.title).toBe("bash");
    expect(live.result.output).toBe("[OUTPUT WITHHELD BY POLICY]");
    expect(live.result.metadata).toEqual({ output: "[OUTPUT WITHHELD BY POLICY]", exit: 0, truncated: false });
    expect(live.result.attachments).toEqual([]);
  });

  it("merges metadata IN PLACE -- the object reference survives the redaction (§V5 review, fix round 1, Minor 1)", () => {
    // A shallow Object.assign would REPLACE live.result.metadata with a new
    // object rather than mutate the one already there. The only measurement
    // on record (opencode.hookmap.yaml's own header) covers an in-place
    // mutation of metadata.output; nothing proves OpenCode re-reads metadata
    // off `result` after the hook returns rather than holding a reference it
    // already took, so the merge must not depend on the answer either way.
    const live = { result: { output: "SECRET", metadata: { output: "SECRET", exit: 0 } } };
    const metadataRef = live.result.metadata;
    applyHostOutput({ result: { output: "[REDACTED]", metadata: { output: "[REDACTED]", exit: 0 } } }, live);
    expect(live.result.metadata).toBe(metadataRef);
    expect(live.result.metadata.output).toBe("[REDACTED]");
  });

  it("refuses a rendered 'result' that is not an object, rather than spreading it onto index keys (§V5 review, fix round 1, Important 1)", () => {
    // The exact hazard: a hookmap one character from the shipped file
    // (sourcing "result" from a string-valued decision field instead of
    // applied_output) would otherwise render a STRING, and
    // Object.assign({}, "gone") spreads characters onto "0", "1", ... while
    // never actually landing a rewrite. Refused instead of silently corrupting
    // the live object.
    const live = { result: { output: "SECRET", metadata: { output: "SECRET" } } };
    expect(() => applyHostOutput({ result: "gone" } as never, live)).toThrow(/cannot apply/);
    expect(live.result).toEqual({ output: "SECRET", metadata: { output: "SECRET" } });
  });

  it("refuses a rendered 'args' that is not an object, applying nothing (§V5 review, fix round 1, Important 1)", () => {
    const live = { args: { command: "cat .env" } };
    expect(() => applyHostOutput({ args: 42 } as never, live)).toThrow(/cannot apply/);
    expect(live.args).toEqual({ command: "cat .env" });
  });

  it("throws the declared refusal, and assigns nothing first", () => {
    const live = { args: { command: "cat .env" } };
    expect(() => applyHostOutput({ refuse: { reason: "denied by policy" }, args: { command: "x" } }, live)).toThrow(
      "denied by policy",
    );
    expect(live.args.command).toBe("cat .env");
  });

  it("falls back to a generic refusal message when the refusal carries no string reason", () => {
    const live = { args: {} };
    expect(() => applyHostOutput({ refuse: {} }, live)).toThrow("denied by policy");
  });

  it("refuses a key it cannot apply rather than applying the rest", () => {
    const live = { args: {} };
    expect(() => applyHostOutput({ unknown_channel: {} } as never, live)).toThrow(/cannot apply/);
  });

  it("refuses a rendered 'args' key at a gate that was handed no live args object", () => {
    // The request-gate half of a render reaching the result gate's applier --
    // same defect class as an unknown key, and refused the same way.
    const live = { result: { output: "x" } };
    expect(() => applyHostOutput({ args: { command: "x" } }, live)).toThrow(/cannot apply/);
    expect(live.result.output).toBe("x");
  });

  it("refuses a rendered 'result' key at a gate that was handed no live result object", () => {
    const live = { args: { command: "cat .env" } };
    expect(() => applyHostOutput({ result: { output: "x" } }, live)).toThrow(/cannot apply/);
    expect(live.args.command).toBe("cat .env");
  });

  it("applies neither field when only one of two rendered keys can be honoured (all-or-nothing)", () => {
    // govern-step.ts's own rule for writing half an output, applied here: a
    // rewrite this applier COULD have landed (args) must not land while a
    // sibling key in the same render (result) has nowhere to go.
    const live = { args: { command: "cat .env" } };
    expect(() => applyHostOutput({ args: { command: "echo safe" }, result: { output: "x" } }, live)).toThrow(
      /cannot apply/,
    );
    expect(live.args.command).toBe("cat .env");
  });

  it("reason.text is declared-inert on this host: not applied, and not surfaced on stderr on the common path (§V5 review, fix round 1, Minor 4)", () => {
    // A V3 observe-only allow synthesizes `reasoning` for every governed
    // step, so an unconditional stderr line here would fire on every clean
    // tool call. Gated behind ACS_DEBUG, so the common path stays silent --
    // see acs-plugin.ts's own doc comment for why that is not the same as
    // silently dropping the text (the ACS_DEBUG=1 case below still surfaces it).
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const previousDebug = process.env.ACS_DEBUG;
    delete process.env.ACS_DEBUG;
    try {
      const live = { args: { command: "cat .env" } };
      applyHostOutput({ args: { command: "echo safe" }, reason: { text: "matched rule R1" } }, live);
      expect(live.args.command).toBe("echo safe");
      // Not invented as a channel: no field of `live.args` carries it.
      expect(live.args).not.toHaveProperty("reason");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.ACS_DEBUG;
      } else {
        process.env.ACS_DEBUG = previousDebug;
      }
    }
  });

  it("reason.text is surfaced on stderr, honestly labelled as undelivered, when ACS_DEBUG is set (§V5 review, fix round 1, Minor 4)", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const previousDebug = process.env.ACS_DEBUG;
    process.env.ACS_DEBUG = "1";
    try {
      const live = { args: { command: "cat .env" } };
      applyHostOutput({ args: { command: "echo safe" }, reason: { text: "matched rule R1" } }, live);
      expect(live.args.command).toBe("echo safe");
      expect(live.args).not.toHaveProperty("reason");
      // Not silently dropped: surfaced, and the actual text is in the message.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("matched rule R1");
    } finally {
      errorSpy.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.ACS_DEBUG;
      } else {
        process.env.ACS_DEBUG = previousDebug;
      }
    }
  });

  it("does nothing and logs nothing for a render with no keys at all", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const live = { args: { command: "cat .env" } };
      applyHostOutput({}, live);
      expect(live.args.command).toBe("cat .env");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
