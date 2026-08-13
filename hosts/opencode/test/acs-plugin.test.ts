/**
 * `AcsPlugin`'s own load-time contract, in isolation from OpenCode -- a
 * plain async factory a test can call directly (acs-plugin.ts's own header
 * states why `ACS_HOOKMAP_PATH` is read inside the factory rather than at
 * module scope, exactly so this works). Scoped to what nothing else in this
 * suite exercises: that the factory itself, not only `applyOpenCodeOutput` in
 * isolation (apply-host-output.test.ts) or the shipped hookmap's static
 * shape (hookmap.test.ts), refuses to register a hookmap
 * `assertHostHonoursEveryDecision` would otherwise let govern nothing.
 *
 * TWO GATES' WORTH, since §V5 review round 3, Task 5. The request-gate half
 * (§V5 review, fix round 1, Critical 1; closed as a pin gap in fix round 2)
 * is a `deny`/`ask`/`defer` that can render empty and therefore cannot refuse.
 * The result-gate half is a `deny`/`modify` that declares no `result` sink and
 * therefore cannot withhold -- the fail-open itself is measured, on the real
 * chain against a live Guardian, in result-gate.test.ts's own "a result-gate
 * decision the hookmap gives no way to withhold with" block; what is pinned
 * HERE is that such a hookmap never registers.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcsPlugin } from "../acs-plugin.ts";

const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "acs-plugin-test-"));

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

/** Runs `AcsPlugin` with `ACS_HOOKMAP_PATH` (and nothing else host-specific)
 * pointed at `hookmapPath`, restoring whatever `ACS_HOOKMAP_PATH` was
 * beforehand regardless of outcome -- this factory reads the env var itself,
 * so nothing here needs to touch module state. */
async function runPlugin(hookmapPath: string): Promise<void> {
  const previous = process.env.ACS_HOOKMAP_PATH;
  process.env.ACS_HOOKMAP_PATH = hookmapPath;
  try {
    // AcsPlugin's own FACTORY reads neither of its own two parameters
    // (PluginInput, PluginOptions) -- true regardless of which of its
    // returned gate hooks are wired -- so a placeholder satisfies the
    // `Plugin` type without needing a real PluginInput.
    await AcsPlugin({} as never);
  } finally {
    if (previous === undefined) {
      delete process.env.ACS_HOOKMAP_PATH;
    } else {
      process.env.ACS_HOOKMAP_PATH = previous;
    }
  }
}

describe("AcsPlugin's load-time gate", () => {
  it("registers cleanly against the shipped hookmap", async () => {
    // Sanity: the gate below does not false-positive on the real, shipped
    // opencode.hookmap.yaml, which declares `refuse.denied: { value: true }`
    // on deny/ask/defer precisely so this passes.
    const shipped = new URL("../opencode.hookmap.yaml", import.meta.url).pathname;
    await expect(runPlugin(shipped)).resolves.toBeUndefined();
  });

  it("refuses to register a hookmap whose request-gate deny declares only a conditional (from:) output field", async () => {
    const hookmapPath = join(SCRATCH_DIR, "from-only-deny.yaml");
    // The real hookmap's request gate with refuse.denied's unconditional
    // value: sibling removed -- deny is built ONLY from refuse.reason, a
    // from: field, exactly the shape that measured `{}` before this gate
    // existed (this function's own doc comment, and opencode.hookmap.yaml's
    // header, both record the measurement).
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(
      /declares no unconditional "value:" output field/,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/decisions\.deny/);
  });

  // §V5 final whole-branch review, F1 -- BLOCKS: "the fifteenth fail-open,
  // inside the gate built to close the fourteenth". Before this fix, the gate
  // accepted any deny/ask/defer entry with at least one `{value: ...}` field
  // ANYWHERE in its output block, not only under `refuse` -- the one key
  // `applyOpenCodeOutput` (apply-host-output.ts) actually throws on. Both
  // reproductions below were measured LIVE, before this fix, against the
  // real `AcsPlugin`, `applyOpenCodeOutput`, `loadHookmap`, and a stub Guardian
  // returning a genuine `{"decision":"deny"}`: the hookmap loaded cleanly,
  // `tool.execute.before` returned normally with no throw, `live.args` was
  // untouched, and no audit entry was written -- Task 4's Critical, byte for
  // byte, through the gate meant to close it.
  it("refuses to register a hookmap whose deny declares an unconditional value: field OUTSIDE refuse (reason.text)", async () => {
    const hookmapPath = join(SCRATCH_DIR, "value-outside-refuse-reason.yaml");
    // The author "answers" this gate at the wrong key: reason.text is
    // unconditional, but applyOpenCodeOutput never reads reason to throw -- it
    // is declared-inert (pass 2b). refuse.reason alone is a from: field and
    // can still render nothing.
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        '          reason.text: { value: "denied by policy" }\n' +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(
      /declares no unconditional "value:" output field under "refuse"/,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/decisions\.deny/);
  });

  it("refuses to register a hookmap whose deny declares an unconditional value: field OUTSIDE refuse (args, with a rewrite attached)", async () => {
    const hookmapPath = join(SCRATCH_DIR, "value-outside-refuse-args.yaml");
    // Same hole, with a rewrite riding along: args merges onto live.args
    // regardless of whether refuse ever renders, so this variant both fails
    // to refuse AND applies an unrelated argument rewrite.
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        '          args: { value: { command: "echo replaced" } }\n' +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(
      /declares no unconditional "value:" output field under "refuse"/,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/decisions\.deny/);
  });
});

/**
 * THE RESULT-GATE HALF (§V5 review round 3, Task 5, Critical) -- the gate that
 * holds the secret, and the one `assertRefusalRendersUnconditionally` skipped
 * entirely because it only ever looked at entries declaring `arguments`.
 *
 * The fail-open these refuse is NOT assumed here: result-gate.test.ts measures
 * it end to end, against a live Guardian, with `AcsPlugin` deliberately out of
 * the path so the gate cannot hide it. These tests pin the other half -- that
 * a hookmap of that class never registers in the first place.
 */
describe("AcsPlugin's load-time gate, at the result gate", () => {
  // The shipped result gate, minus the one line that lands a withholding.
  // Every other line is opencode.hookmap.yaml's own.
  const RESULT_GATE_HEAD =
    "host: opencode\n" +
    "hooks:\n" +
    "  tool.execute.after:\n" +
    "    acs_method: steps/toolCallResult\n" +
    "    tool_name: $.tool\n" +
    "    tools: [bash]\n" +
    "    outputs:\n" +
    "      from: $.result.output\n" +
    "      within: $.result\n" +
    "      mirrors:\n" +
    "        - $.result.metadata.output\n" +
    "    exit_status: { from: $.result.metadata.exit }\n" +
    "    decisions:\n" +
    "      allow:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n";

  it("refuses to register a hookmap whose result-gate deny declares only reason.text", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-deny-without-a-sink.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    // Names the file, the hook, the decision, and what to add -- the same
    // four the request-gate half's message names.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/result-deny-without-a-sink\.yaml/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/hooks\.tool\.execute\.after\.decisions\.deny/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/result: \{ from: applied_output \}/);
  });

  it("refuses the same for a result-gate modify, not only deny", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-modify-without-a-sink.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/decisions\.modify/);
  });

  it("refuses a result-gate deny that names the leaf (result.output) instead of the container", async () => {
    // Not an "already covered by the other test" duplicate: this hookmap DOES
    // declare a path whose leading segment is `result`, so a gate written the
    // way the request-gate half is written -- leading segment, not exact key
    // -- would accept it. Measured (result-gate.test.ts): it merges the whole
    // patched container into `live.result.output` and never writes the mirror
    // at all.
    const hookmapPath = join(SCRATCH_DIR, "result-deny-naming-the-leaf.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result.output: { from: applied_output }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/NOT a leaf under it/);
  });

  it("accepts a result gate that declares the sink on both deny and modify", async () => {
    // The shape the shipped hookmap uses, in isolation from it -- so this
    // gate's ACCEPT case is pinned by something other than "the shipped file
    // happens to pass", which the first test in this file already covers.
    const hookmapPath = join(SCRATCH_DIR, "result-gate-with-both-sinks.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
  });
});

/**
 * A HOOK THE TABLE HAS NO ENTRY FOR IS A THROW, NOT A SKIP -- the rule
 * `expectationFor` states in hosts/claude-code/acs-hook.ts, adopted here for
 * the same reason and one more (§V5 review round 3, Task 5).
 */
describe("AcsPlugin's load-time gate, for a hook it has no expectation for", () => {
  it("refuses a hookmap mapping a hook this shim never registers", async () => {
    const hookmapPath = join(SCRATCH_DIR, "unknown-hook.yaml");
    // A perfectly well-formed request-gate entry -- `loadHookmap` accepts it,
    // `refuse.denied` is present, every field names a value or a from. The
    // only thing wrong with it is the event name, and that is enough: this
    // plugin returns "tool.execute.before" and "tool.execute.after" and
    // nothing else, so this entry would never be registered with OpenCode at
    // all while sitting in the hookmap looking like governance.
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.during:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/this shim has no expectation for/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/tool\.execute\.during/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/unknown-hook\.yaml/);
  });

  it("refuses a hookmap naming a hook after a prototype-chain key, with the message that says which hook is unknown", async () => {
    // `hasOwnProperty`, not a bare index, in `expectationFor`: a bare index
    // would read `Object.prototype.constructor` here, pass the `undefined`
    // check, and then die on a missing `assertDecisions` -- an unrelated
    // TypeError in place of the message naming the hook. Same probe
    // acs-hook.ts's own gate reasons about.
    const hookmapPath = join(SCRATCH_DIR, "prototype-hook.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  constructor:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/this shim has no expectation for/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/"constructor"/);
  });
});
