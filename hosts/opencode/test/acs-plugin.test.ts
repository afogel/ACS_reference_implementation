/**
 * `AcsPlugin`'s own load-time contract, in isolation from OpenCode -- a
 * plain async factory a test can call directly (acs-plugin.ts's own header
 * states why `ACS_HOOKMAP_PATH` is read inside the factory rather than at
 * module scope, exactly so this works). Scoped to what nothing else in this
 * suite exercises: that the factory itself, not only `applyOpenCodeOutput` in
 * isolation (apply-host-output.test.ts) or the shipped hookmap's static
 * shape (hookmap.test.ts), refuses to register a hookmap whose
 * `assertRefusalRendersUnconditionally` gate would otherwise let a
 * `deny`/`ask`/`defer` render empty (§V5 review, fix round 1, Critical 1;
 * closed as a pin gap in fix round 2).
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
