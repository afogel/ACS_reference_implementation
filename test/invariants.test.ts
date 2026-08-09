import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/**
 * Strips comments before matching, so these gates assert what R3.2/R3.3
 * actually claim -- no AGT/host vocabulary *used in code* (imports, types,
 * calls) -- rather than the much weaker, much more brittle claim "never
 * mentioned anywhere, including prose". Doc comments in this codebase
 * routinely explain a module's boundary by naming the exact vocabulary it
 * must stay clear of (see hosts/claude-code/acs-hook.ts: "must not reach
 * into AGT -- it never imports `agt-bridge`..."). A gate that fires on
 * that sentence is a gate the next person deletes rather than fixes,
 * which is worse than no gate at all.
 *
 * Line comments are stripped to end-of-line unless the "//" is
 * immediately preceded by ":" -- an `https://`-style URL that happens to
 * sit inside a comment or string, not a line-comment delimiter.
 */
function stripComments(src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlockComments.replace(/(?<!:)\/\/.*$/gm, "");
}

/** Every non-test `.ts` file under `dir`, with comments stripped. */
function readSourceFiles(dir: string): { file: string; code: string }[] {
  return [...new Glob("**/*.ts").scanSync(dir)]
    .filter((f) => !f.includes("/test/"))
    .map((f) => ({ file: f, code: stripComments(readFileSync(`${dir}/${f}`, "utf8")) }));
}

/**
 * Asserts none of `terms` appears as a whole word (case-insensitive) in
 * any non-test `.ts` file's code under `dir`. Whole-word matching, not
 * bare substring: "opa" as a substring would false-positive on ordinary
 * English words like "opaque"; a gate that fails on that is exactly the
 * "annoyingly false" failure mode this suite exists to avoid. Each
 * assertion diffs `{file, term, found}` against `{file, term, found:
 * false}` on failure, so the failing file and the offending term are
 * both in the test output -- no separate message plumbing needed.
 */
function assertNoVocabulary(dir: string, terms: string[]): void {
  for (const { file, code } of readSourceFiles(dir)) {
    for (const term of terms) {
      const found = new RegExp(`\\b${term}\\b`, "i").test(code);
      expect({ file, term, found }).toEqual({ file, term, found: false });
    }
  }
}

describe("architectural invariants", () => {
  /**
   * R3.2 -- the claim the whole M×N argument rests on: a host implements
   * ACS once (packages/host-adapter) and is governable by any conformant
   * runtime. That collapse is only real if the adapter never leaks
   * policy-runtime (AGT) vocabulary into its own code.
   *
   * Scope, deliberately: packages/host-adapter/src only.
   *   - hosts/claude-code/ is NOT scanned here. A host shim is
   *     host-specific by definition, and its own doc comment is allowed
   *     to name AGT in prose (acs-hook.ts's header does, explaining what
   *     it must NOT import). The invariant that actually matters for that
   *     file is an import-graph one ("never imports agt-bridge or
   *     guardian's server-side pieces"), not "never mentions the word" --
   *     a different claim this suite doesn't make for host shims.
   *   - host-adapter/package.json's devDependency on `guardian` is a
   *     test-only wiring choice: packages/host-adapter/test/*.test.ts spin
   *     up a real Guardian for end-to-end coverage (see client.test.ts's
   *     and build-envelope.test.ts's own comments). This gate reads only
   *     `.ts` source under src/, never package.json and never test/, so
   *     that dependency is correctly out of scope.
   */
  it("host adapter's source contains zero AGT-specific code", () => {
    assertNoVocabulary("packages/host-adapter/src", [
      "agt",
      "AgentControl",
      "rego",
      "opa",
      "intervention_point",
      "verdict",
    ]);
  });

  /**
   * R3.3 -- what makes slice V5's second host cost zero AGT code: the
   * bridge that knows AGT must never learn a specific host's wire shape,
   * or adding a host would mean touching this package too.
   */
  it("AGT bridge's source contains zero host-specific code", () => {
    assertNoVocabulary("packages/agt-bridge/src", [
      "claude",
      "opencode",
      "hookSpecificOutput",
      "permissionDecision",
      "stdin",
    ]);
  });
});
