/**
 * `AcsPlugin`'s own load-time contract, in isolation from OpenCode -- a
 * plain async factory a test can call directly (acs-plugin.ts's own header
 * states why `ACS_HOOKMAP_PATH` is read inside the factory rather than at
 * module scope, exactly so this works). Scoped to what nothing else in this
 * suite exercises: that the factory itself, not only `applyHostOutput` in
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
    // AcsPlugin's own implementation reads neither parameter (Tasks 5/6
    // leave the two gates unwired), so a placeholder satisfies the `Plugin`
    // type without needing a real PluginInput.
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
});
