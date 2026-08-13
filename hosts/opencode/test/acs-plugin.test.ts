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
    // four the request-gate half's message names -- plus, since §V5 review
    // round 3, Task 5, fix round 1, the paths this decision DOES declare, so
    // a near-miss is legible rather than merely refused.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field at all/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/\["reason\.text"\]/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/result-deny-without-a-sink\.yaml/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/hooks\.tool\.execute\.after\.decisions\.deny/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/EITHER declare 'result: \{ from: applied_output \}'/);
    // Both honest outcomes named, since §V5 review round 3, Task 5, fix
    // round 2 -- the gate accepts either, so the message must offer both.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/OR declare an unconditional refusal/);
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
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field at all/);
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
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "result" output field at all/);
    // The near-miss made legible: the message prints the path that LOOKS like
    // the sink.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/"result\.output"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/NOT a leaf under it/);
  });

  // §V5 review round 3, Task 5, FIX ROUND 1, CRITICAL 1 -- this task's own
  // Critical, surviving through the gate built to close it. The first version
  // of the rule asked only whether the key `result` was PRESENT, never what it
  // SOURCED, so this hookmap loaded clean. Measured on the real chain
  // (result-gate.test.ts): a real deny renders no `result` key at all, applies
  // nothing, throws nothing, and `rm -rf /` is delivered in the leaf AND the
  // mirror.
  it("refuses a result-gate deny declaring result sourced from applied_input -- the right key, the wrong field", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-deny-wrong-source.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_input }\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    // The wrong-source message is NOT the absent-key one: it prints the
    // declared field object verbatim, so the near-miss is visible.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/does not source it from "applied_output"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/\{"from":"applied_input"\}/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/result-deny-wrong-source\.yaml/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/hooks\.tool\.execute\.after\.decisions\.deny/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/EITHER declare 'result: \{ from: applied_output \}'/);
  });

  it("refuses a result-gate deny declaring result as a literal value: -- a fixed answer the Guardian never chose", async () => {
    // The other way to declare the key without honouring the decision. Refused
    // deliberately, not by accident -- see `declaresSinkFrom`'s own doc comment
    // for why a literal here is a hardcoded answer wearing governance's
    // clothes.
    const hookmapPath = join(SCRATCH_DIR, "result-deny-literal-sink.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        '          result: { value: { output: "withheld" } }\n' +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/renders that LITERAL and never reads "from" at all/);
  });

  // §V5 review round 3, Task 5, FIX ROUND 1, IMPORTANT 1 -- `ask`/`defer`
  // DECLARED at this gate were unchecked. Not declaring them is the safe state
  // (renderDecision throws, posture-answered, audited); declaring one without a
  // sink is silent delivery. Measured in result-gate.test.ts.
  //
  // WHAT THIS DECISION IS HELD TO CHANGED IN FIX ROUND 3 (Critical 6a), and the
  // message changed with it: fix round 1 demanded a `result` sink here, which
  // `withResultOutput` can never fill for `ask`/`defer` -- so the requirement is
  // now an unconditional refusal, the same one the request gate's own three get.
  // The HAZARD this test pins is unchanged: a declared `ask` with only
  // `reason.text` is refused, and it is refused for having no honest shape at
  // all rather than for missing one particular key.
  it.each(["ask", "defer"] as const)(
    "refuses a result-gate %s that declares no sink -- declared-but-unlandable, not merely undeclared",
    async (decisionName) => {
      const hookmapPath = join(SCRATCH_DIR, `result-${decisionName}-without-a-sink.yaml`);
      writeFileSync(
        hookmapPath,
        RESULT_GATE_HEAD +
          "      deny:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          "      modify:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          `      ${decisionName}:\n` +
          "        output:\n" +
          "          reason.text: { from: reasoning, type: string }\n",
      );
      await expect(runPlugin(hookmapPath)).rejects.toThrow(
        /declares no unconditional "value:" output field under "refuse", and at this gate that is the ONLY shape/,
      );
      await expect(runPlugin(hookmapPath)).rejects.toThrow(new RegExp(`decisions\\.${decisionName}`));
      // The message says WHY there is no other shape, naming the mechanism.
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/attaches "applied_output" for "deny" alone/);
    },
  );

  // §V5 review round 3, Task 5, FIX ROUND 3, CRITICAL 6a -- the variant this
  // gate itself MANDATED. Fix round 1 required a `result` sink on `ask`/`defer`
  // without checking that `withResultOutput` can ever fill one for them. It
  // cannot: it attaches `applied_output` for `deny` alone and returns `ask`/
  // `defer` untouched. Measured (result-gate.test.ts): the mandated declaration
  // renders no `result` key and delivers the secret in leaf and mirror.
  it.each(["ask", "defer"] as const)(
    "refuses a result-gate %s declaring the sink fix round 1 mandated -- withResultOutput never fills it",
    async (decisionName) => {
      const hookmapPath = join(SCRATCH_DIR, `result-${decisionName}-mandated-sink.yaml`);
      writeFileSync(
        hookmapPath,
        RESULT_GATE_HEAD +
          "      deny:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          "      modify:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          `      ${decisionName}:\n` +
          "        output:\n" +
          "          result: { from: applied_output }\n",
      );
      // Refused for the RIGHT reason: not "you named the wrong key" -- the key
      // is right -- but "nothing ever arrives for you to put in it".
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/that is the ONLY shape open to it/);
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/attaches "applied_output" for "deny" alone/);
      await expect(runPlugin(hookmapPath)).rejects.toThrow(new RegExp(`decisions\\.${decisionName}`));
    },
  );

  it.each(["ask", "defer"] as const)(
    "accepts a result-gate %s that refuses instead -- the one shape it can honestly take",
    async (decisionName) => {
      const hookmapPath = join(SCRATCH_DIR, `result-${decisionName}-refusal-only.yaml`);
      writeFileSync(
        hookmapPath,
        RESULT_GATE_HEAD +
          "      deny:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          "      modify:\n" +
          "        output:\n" +
          "          result: { from: applied_output }\n" +
          `      ${decisionName}:\n` +
          "        output:\n" +
          "          refuse.denied: { value: true }\n" +
          "          refuse.reason: { from: reasoning, type: string }\n",
      );
      await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
    },
  );

  // §V5 review round 3, Task 5, FIX ROUND 3, CRITICAL 6b -- the same
  // unsatisfiable-by-construction fault reached from the ENTRY, and this one
  // hits `deny`.
  it("refuses a result hook that declares no outputs block -- every sink there is unfillable by construction", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-hook-without-outputs.yaml");
    // A perfectly-declared sink on a `deny`. The entry is what is wrong: it
    // declares `arguments:` at the result hook, so governStep builds no output
    // location and withResultOutput no-ops for every decision.
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.after:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no usable "outputs"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/withResultOutput .* returns every decision untouched/);
    // Blames the ENTRY, not the correctly-declared decision.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/"hooks\.tool\.execute\.after" declares no usable/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/result-hook-without-outputs\.yaml/);
  });

  it("still asks nothing of an ask/defer the hookmap does not declare at all", async () => {
    // The half of the old reasoning that was correct and stays correct: a
    // decision the hookmap never declares has nothing here to check.
    // `renderDecision` throws on an arriving one, `governStep` catches it, and
    // the deployment's posture answers it -- audited either way. This is the
    // shipped file's own shape, and it must keep loading.
    const hookmapPath = join(SCRATCH_DIR, "result-gate-no-ask-no-defer.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
  });

  // §V5 review round 3, Task 5, FIX ROUND 2, CRITICAL -- `declaresSinkFrom`
  // checked what the sink NAMED, never whether the declaration could RENDER.
  // Both shapes below name `result` and name `applied_output`, and both were
  // measured (result-gate.test.ts) to deliver the secret in leaf and mirror.
  it("refuses a result-gate deny whose sink declares type: string -- applied_output is an object, so it never renders", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-deny-type-string.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output, type: string }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares a "type" of "string"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/typeof filter/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/hooks\.tool\.execute\.after\.decisions\.deny/);
  });

  it("refuses a result-gate deny whose sink declares a literal BESIDE the right from:", async () => {
    // renderDecision checks for `value` first and never reads `from`, so this
    // renders `{"result":{}}` -- a key present, nothing landed. The shape that
    // falsified this gate's own comment claiming a literal was already refused.
    const hookmapPath = join(SCRATCH_DIR, "result-deny-value-beside-from.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { value: {}, from: applied_output }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/renders that LITERAL and never reads "from" at all/);
  });

  it("accepts a result-gate sink declaring type: object -- the one type that can match", async () => {
    // Not over-refusal by accident: `type` is a typeof filter and
    // `applied_output` IS an object, so this declaration renders exactly as the
    // untyped one does.
    const hookmapPath = join(SCRATCH_DIR, "result-deny-type-object.yaml");
    writeFileSync(
      hookmapPath,
      RESULT_GATE_HEAD +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output, type: object }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
  });

  // §V5 review round 3, Task 5, FIX ROUND 2, MINOR (over-refusal) -- the gate's
  // rule is "land it OR unconditionally refuse it", because both are honest
  // outcomes and only the silent no-op is not. On this host over-refusal is not
  // free: a load-time throw leaves the plugin UNLOADED and the session
  // completely ungoverned, which is strictly worse than a conservative mapping
  // this gate did not anticipate. The throw itself is measured in
  // result-gate.test.ts -- these hookmaps stop the tool, they do not no-op.
  it.each(["deny", "modify", "ask", "defer"] as const)(
    "accepts a result-gate %s mapped to an unconditional refusal instead of a replacement",
    async (decisionName) => {
      const hookmapPath = join(SCRATCH_DIR, `result-${decisionName}-as-refusal.yaml`);
      const sink = (name: string) =>
        name === decisionName
          ? `      ${name}:\n        output:\n          refuse.denied: { value: true }\n`
          : `      ${name}:\n        output:\n          result: { from: applied_output }\n`;
      writeFileSync(hookmapPath, RESULT_GATE_HEAD + sink("deny") + sink("modify") + (decisionName === "ask" || decisionName === "defer" ? sink(decisionName) : ""));
      await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
    },
  );

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
 * THE REQUEST GATE'S `modify` RULE (§V5 review round 3, Task 5, fix round 1,
 * Important 2) -- its own rule, not the refusal rule its `deny`/`ask`/`defer`
 * siblings get: a `modify` asked for the step to RUN, rewritten, so what it
 * needs is a sink for the rewrite, exactly as a result-gate `deny` needs one
 * for the withholding.
 *
 * The fail-open is measured in request-gate.test.ts, against a live Guardian,
 * with `AcsPlugin` out of the path -- including the part that makes it worse
 * than silent: `governStep` returns `stage: "honoured"`, so the audit trail
 * records the rewrite as honoured while nothing was applied.
 */
describe("AcsPlugin's load-time gate, for a request-gate modify", () => {
  const REQUEST_GATE_HEAD =
    "host: opencode\n" +
    "hooks:\n" +
    "  tool.execute.before:\n" +
    "    acs_method: steps/toolCallRequest\n" +
    "    tool_name: $.tool\n" +
    "    arguments: $.args\n" +
    "    tools: [bash]\n" +
    "    decisions:\n" +
    "      allow:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n" +
    "      deny:\n" +
    "        output:\n" +
    "          refuse.denied: { value: true }\n" +
    "          refuse.reason: { from: reasoning, type: string }\n";

  it("refuses a modify that declares only reason.text", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-without-a-sink.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD + "      modify:\n" + "        output:\n" + "          reason.text: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "args" output field at all/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/request-modify-without-a-sink\.yaml/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/hooks\.tool\.execute\.before\.decisions\.modify/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/EITHER declare 'args: \{ from: applied_input \}'/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/OR declare an unconditional refusal/);
    // The audit consequence is in the message, because it is the reason this
    // is a fault rather than a gap.
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/stage "honoured"/);
  });

  it("refuses a modify sourcing args from applied_output -- the result gate's field at the request gate", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-wrong-source.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD + "      modify:\n" + "        output:\n" + "          args: { from: applied_output }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/does not source it from "applied_input"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/\{"from":"applied_output"\}/);
  });

  it("refuses a modify naming an argument under args (args.command) rather than the bag itself", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-naming-a-leaf.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD + "      modify:\n" + "        output:\n" + "          args.command: { from: applied_input }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no "args" output field at all/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/"args\.command"/);
  });

  it("refuses a modify whose args sink declares type: string -- applied_input is an object, so it never renders", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-type-string.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD + "      modify:\n" + "        output:\n" + "          args: { from: applied_input, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares a "type" of "string"/);
  });

  it("refuses a modify whose args sink declares a literal BESIDE the right from: -- the author's own command on every rewrite", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-modify-value-beside-from.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD +
        "      modify:\n" +
        "        output:\n" +
        '          args: { value: { command: "echo pwned" }, from: applied_input }\n',
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/renders that LITERAL and never reads "from" at all/);
  });

  it("accepts a modify mapped to an unconditional refusal -- blocking the tool is more conservative than rewriting it", async () => {
    // §V5 review round 3, Task 5, fix round 2, Minor. Measured in
    // request-gate.test.ts: this mapping THROWS before the tool runs and
    // applies nothing -- an honest outcome, and the shipped hookmap's own idiom
    // for `ask`/`defer` at this very gate.
    const hookmapPath = join(SCRATCH_DIR, "request-modify-as-refusal.yaml");
    writeFileSync(
      hookmapPath,
      REQUEST_GATE_HEAD +
        "      modify:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "          refuse.reason: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
  });

  it("accepts the shipped shape, and asks nothing of a request gate declaring no modify at all", async () => {
    const withModify = join(SCRATCH_DIR, "request-modify-with-sink.yaml");
    writeFileSync(
      withModify,
      REQUEST_GATE_HEAD +
        "      modify:\n" +
        "        output:\n" +
        "          args: { from: applied_input }\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(withModify)).resolves.toBeUndefined();

    // `modify` is optional -- assertRenderableDecisions requires only allow and
    // deny -- so a hookmap that never declares one has nothing here to check.
    const withoutModify = join(SCRATCH_DIR, "request-no-modify.yaml");
    writeFileSync(withoutModify, REQUEST_GATE_HEAD);
    await expect(runPlugin(withoutModify)).resolves.toBeUndefined();
  });
});

/**
 * §V5 review round 3, Task 5, FIX ROUND 4 -- the entry-shape and fixed-path
 * rules, which apply to BOTH gates and are therefore their own block.
 *
 * Every fail-open they close was measured first, routed around `AcsPlugin`, in
 * request-gate.test.ts and result-gate.test.ts. See `GateEntryShape`'s own doc
 * comment (acs-plugin.ts) for each one.
 */
describe("AcsPlugin's load-time gate, on the entry's own shape and paths", () => {
  const REQUEST_DECISIONS =
    "    decisions:\n" +
    "      allow:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n" +
    "      deny:\n" +
    "        output:\n" +
    "          refuse.denied: { value: true }\n";
  const RESULT_DECISIONS =
    "    decisions:\n" +
    "      allow:\n" +
    "        output:\n" +
    "          reason.text: { from: reasoning, type: string }\n" +
    "      deny:\n" +
    "        output:\n" +
    "          result: { from: applied_output }\n";

  // CRITICAL 7B -- a request hook declaring `outputs:` gets an output location,
  // so `resolveModify` fills `applied_output` and the `args` sink this gate
  // demands is unfillable. Measured: stage "honoured", rewrite landed nowhere.
  it("refuses a request hook declaring outputs: instead of arguments:", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-hook-with-outputs.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallResult\n" +
        "    tool_name: $.tool\n" +
        "    outputs:\n" +
        "      from: $.args.command\n" +
        "      within: $.args\n" +
        "    exit_status: { literal: success }\n" +
        REQUEST_DECISIONS,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/declares no usable "arguments"/);
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/fills "applied_output" instead of "applied_input"/);
  });

  it("refuses a request hook declaring BOTH arguments: and outputs:", async () => {
    // `assertRequestGateDeclaresNoOutputs` (build-envelope.ts) already refuses
    // this one upstream -- asserted here so the two checks' division stays
    // visible, and so this gate's own coverage does not depend on which fires
    // first.
    const hookmapPath = join(SCRATCH_DIR, "request-hook-with-both.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.args\n" +
        "    outputs:\n" +
        "      from: $.args.command\n" +
        "      within: $.args\n" +
        "    exit_status: { literal: success }\n" +
        REQUEST_DECISIONS,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow();
  });

  const resultHook = (from: string, within: string) =>
    "host: opencode\n" +
    "hooks:\n" +
    "  tool.execute.after:\n" +
    "    acs_method: steps/toolCallResult\n" +
    "    tool_name: $.tool\n" +
    "    outputs:\n" +
    `      from: ${from}\n` +
    `      within: ${within}\n` +
    "    exit_status: { from: $.result.metadata.exit }\n" +
    RESULT_DECISIONS;

  // CRITICAL 7D -- `outputs.within` must name the object this shim hands the
  // applier. Each case below leaves `outputs.from` CORRECT, so the failure is
  // attributable to `within` alone.
  it.each(["$", "$.result.metadata"] as const)(
    "refuses a result hook whose outputs.within is %s rather than $.result",
    async (within) => {
      const hookmapPath = join(SCRATCH_DIR, `result-within-${within === "$" ? "root" : "metadata"}.yaml`);
      writeFileSync(hookmapPath, resultHook("$.result.output", within));
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/outputs\.within" is/);
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/patched clone OF the container/);
    },
  );

  // The `$.result.output` / `$.result.metadata` pair is ALSO the incoherent one
  // `replacingOutput` throws on at runtime -- `within`'s segments have to be
  // the leading segments of `from`. Refusing it here moves that from a
  // posture-answered runtime throw to a load-time stop, which is the difference
  // this whole gate is about.
  it("refuses the incoherent from/within pair at LOAD, where replacingOutput would only throw at render", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-incoherent-pair.yaml");
    writeFileSync(hookmapPath, resultHook("$.result.output", "$.result.metadata"));
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/outputs\.within" is "\$\.result\.metadata"/);
  });

  // CRITICAL, FIX ROUND 5 -- VARIANT 8. `outputs.from` is the leaf that goes ON
  // THE WIRE as this step's `outputs[0].value`, so pointing it elsewhere does
  // not withhold the wrong field: it asks the policy runtime about a different
  // value, which it then answers correctly. Measured (result-gate.test.ts):
  // envelope carries the tool's own title, decision `allow`, `stage:
  // "honoured"`, and `rm -rf /` delivered in leaf and mirror.
  it.each(["$.result.title", "$.result.metadata.output"] as const)(
    "refuses a result hook whose outputs.from is %s rather than $.result.output",
    async (from) => {
      const hookmapPath = join(SCRATCH_DIR, `result-from-${from.split(".").pop()}.yaml`);
      // `within` correct in both, so the failure is attributable to `from`.
      writeFileSync(hookmapPath, resultHook(from, "$.result"));
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/outputs\.from" is/);
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/the value the policy runtime is asked ABOUT/);
    },
  );

  it("accepts the shipped result hook's own from/within pair", async () => {
    // The accept case, so the two refusals above cannot pass by refusing
    // everything.
    const hookmapPath = join(SCRATCH_DIR, "result-shipped-paths.yaml");
    writeFileSync(hookmapPath, resultHook("$.result.output", "$.result"));
    await expect(runPlugin(hookmapPath)).resolves.toBeUndefined();
  });

  // 7E -- NOT on the review's list. The shim and governStep ask `governsTool`
  // with different arguments, and acs-plugin.ts's header has recorded since
  // Task 2 that "nothing detects that". Measured: governStep skips a governed
  // tool as "ungoverned", no Guardian request, no audit entry.
  it.each(["tool.execute.before", "tool.execute.after"] as const)(
    "refuses a %s entry whose tool_name points away from $.tool",
    async (hookEventName) => {
      const hookmapPath = join(SCRATCH_DIR, `tool-name-diverges-${hookEventName}.yaml`);
      const body =
        hookEventName === "tool.execute.before"
          ? "    arguments: $.args\n" + REQUEST_DECISIONS
          : "    outputs:\n" +
            "      from: $.result.output\n" +
            "      within: $.result\n" +
            "    exit_status: { from: $.result.metadata.exit }\n" +
            RESULT_DECISIONS;
      writeFileSync(
        hookmapPath,
        "host: opencode\n" +
          "hooks:\n" +
          `  ${hookEventName}:\n` +
          "    acs_method: steps/toolCallRequest\n" +
          "    tool_name: $.args.command\n" +
          "    tools: [bash]\n" +
          body,
      );
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/tool_name" is "\$\.args\.command"/);
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/skipped as\s+"ungoverned"/);
    },
  );

  it("refuses a request hook whose arguments path points away from $.args", async () => {
    const hookmapPath = join(SCRATCH_DIR, "request-arguments-diverges.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.before:\n" +
        "    acs_method: steps/toolCallRequest\n" +
        "    tool_name: $.tool\n" +
        "    arguments: $.result\n" +
        REQUEST_DECISIONS,
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/arguments" is "\$\.result"/);
  });
});

/**
 * IMPORTANT 7A -- a DECLARED decision name outside the gate's tables was
 * silently unchecked, because the enforcement loop iterated the TABLE rather
 * than the hookmap. Measured in request-gate.test.ts: declaring the inert entry
 * is strictly worse than leaving it out, because without it `renderDecision`
 * throws and the posture answers it, audited.
 */
describe("AcsPlugin's load-time gate, for a decision name it has no expectation for", () => {
  it.each(["block", "Deny", "warn"] as const)(
    "refuses a request-gate hookmap declaring decisions.%s",
    async (decisionName) => {
      const hookmapPath = join(SCRATCH_DIR, `request-unknown-decision-${decisionName}.yaml`);
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
          "          refuse.denied: { value: true }\n" +
          `      ${decisionName}:\n` +
          "        output:\n" +
          "          reason.text: { from: reasoning, type: string }\n",
      );
      await expect(runPlugin(hookmapPath)).rejects.toThrow(
        new RegExp(`declares "${decisionName}", which this shim has no expectation for at this gate`),
      );
      await expect(runPlugin(hookmapPath)).rejects.toThrow(/strictly WORSE than leaving it out/);
    },
  );

  it("refuses the same at the result gate", async () => {
    const hookmapPath = join(SCRATCH_DIR, "result-unknown-decision.yaml");
    writeFileSync(
      hookmapPath,
      "host: opencode\n" +
        "hooks:\n" +
        "  tool.execute.after:\n" +
        "    acs_method: steps/toolCallResult\n" +
        "    tool_name: $.tool\n" +
        "    outputs:\n" +
        "      from: $.result.output\n" +
        "      within: $.result\n" +
        "    exit_status: { from: $.result.metadata.exit }\n" +
        "    decisions:\n" +
        "      allow:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n" +
        "      deny:\n" +
        "        output:\n" +
        "          result: { from: applied_output }\n" +
        "      block:\n" +
        "        output:\n" +
        "          reason.text: { from: reasoning, type: string }\n",
    );
    await expect(runPlugin(hookmapPath)).rejects.toThrow(/has no expectation for at this gate/);
  });

  it("still accepts every decision name the tables DO know, and allow", async () => {
    // The accept case, so the throw above cannot pass by refusing everything.
    const hookmapPath = join(SCRATCH_DIR, "request-all-known-decisions.yaml");
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
        "          refuse.denied: { value: true }\n" +
        "      ask:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "      defer:\n" +
        "        output:\n" +
        "          refuse.denied: { value: true }\n" +
        "      modify:\n" +
        "        output:\n" +
        "          args: { from: applied_input }\n",
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
