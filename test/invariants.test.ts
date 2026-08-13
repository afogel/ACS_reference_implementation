import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * Strips comments before matching, so these gates assert what the package
 * boundaries actually claim -- no AGT or host vocabulary *used in code*
 * (imports, types, calls) -- rather than the much weaker and much more
 * brittle claim "never mentioned anywhere, including prose". Doc comments
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

/**
 * True when `relativePath` has a `test` path segment anywhere, including at
 * the very start. `Glob.scanSync` returns paths relative to the scanned
 * root, with no leading slash, so a `test/` directory sitting directly under
 * that root (e.g. scanning `packages/foo/src` with a `packages/foo/src/test/`
 * subdirectory) produces a path like `test/bar.ts` -- no `/test/` substring
 * for a plain `.includes("/test/")` check to find. Anchoring on `(^|/)`
 * catches that case as well as the nested one, without false-positiving on a
 * segment that merely starts with "test" (`testing/`, `latest/`).
 */
function isUnderTestDir(relativePath: string): boolean {
  return /(^|\/)test\//.test(relativePath);
}

/**
 * Every non-test `.ts` file under `dir`, with comments stripped.
 *
 * The emptiness check is what stops all four gates below from passing
 * vacuously. A *renamed* directory already
 * failed loudly -- `Glob.scanSync` throws ENOENT -- but a directory that
 * still exists with no non-test `.ts` under it would sail through with zero
 * assertions, and a gate that cannot fail is worse than no gate: it reads as
 * enforcement in the README while enforcing nothing.
 */
function readSourceFiles(dir: string): { file: string; code: string }[] {
  const files = [...new Glob("**/*.ts").scanSync(dir)].filter((f) => !isUnderTestDir(f));
  expect({ dir, sourceFiles: files.length > 0 }).toEqual({ dir, sourceFiles: true });
  return files.map((f) => ({ file: f, code: stripComments(readFileSync(`${dir}/${f}`, "utf8")) }));
}

/**
 * Escapes regex metacharacters in `term`, so `assertNoVocabulary`'s "whole
 * word" claim holds LITERALLY, not just for terms with no special
 * characters. `tool.execute` was the first term this list gained with one
 * (§V5 review, fix round 1, Minor 1): unescaped, `\btool.execute\b`'s `.`
 * matches ANY character, so it would also match `tool_execute`,
 * `tool execute`, `toolXexecute` -- over-matching that happened to be safe
 * (nothing in this codebase writes any of those), but a future term with
 * `[`, `(`, or `$` would either throw building the `RegExp` or silently mean
 * something other than what its author wrote. The doc above says "whole
 * word", not "regex fragment", so the code is made to agree with the doc
 * rather than the other way around.
 */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      const found = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(code);
      expect({ file, term, found }).toEqual({ file, term, found: false });
    }
  }
}

describe("architectural invariants", () => {
  /**
   * The claim the whole M×N argument rests on: a host implements ACS once
   * (packages/host-adapter) and is governable by any conformant runtime. That
   * collapse is only real if the adapter never leaks policy-runtime (AGT)
   * vocabulary into its own code.
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
   * The other half of that boundary: the adapter is promised to a second
   * host *unchanged*, so it must not name the FIRST host's output fields
   * either. Declaring Claude Code's wire shape here -- a mandatory
   * `permissionDecision`, a returned `{ hookSpecificOutput }` -- would make
   * one host's vocabulary the shared module's public API, and a second host
   * would have to inherit it or fork the module.
   *
   * Every name the gate below lists now lives in hosts/claude-code/: all but
   * one as data in claude-code.hookmap.yaml's output paths, and the remaining
   * one -- the wrapper -- in acs-hook.ts, which is what wraps, and in the
   * hookmap as the dotted prefix those paths sit under. Stated by relation
   * rather than by count on purpose: this is the gate whose job is catching
   * stale declarations, and it carried one ("all four names") from the moment
   * V4 added a fifth. Same scope note as the gate above -- non-test `.ts`
   * under packages/host-adapter/src only, with comments stripped, so a doc
   * comment may still explain the boundary it must not cross in code.
   */
  it("the host adapter's source names no host output field", () => {
    assertNoVocabulary("packages/host-adapter/src", [
      "permissionDecision",
      "permissionDecisionReason",
      "updatedInput",
      // V4's own field, and the one this list would have been weakest without:
      // the result gate is where the adapter now builds a replacement for a
      // host's tool output, so `updatedToolOutput` is the name it would be most
      // natural to reach for -- and a gate that listed the four fields the
      // request gate uses while omitting the one the new code is about would
      // look like coverage while quietly losing it. It lives in
      // claude-code.hookmap.yaml as data and in acs-hook.ts as a checked path,
      // and nowhere else.
      "updatedToolOutput",
      "hookSpecificOutput",
      // V5 (slice #6, host #2), §V5 review fix round 1, Minor 4: the same gap
      // this list closed for V4's `updatedToolOutput` -- host #2's own deny
      // channel, `refuse.reason` in opencode.hookmap.yaml, is a field name this
      // adapter must stay just as ignorant of as host #1's. It lives in that
      // hookmap as data and nowhere in packages/host-adapter/src.
      "refuse",
    ]);
  });

  /**
   * What makes a second host cost zero AGT code: the bridge that knows AGT
   * must never learn a specific host's wire shape, or adding a host would
   * mean touching this package too.
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

  /**
   * An ACS-first reader must be able to trace one action end to end without
   * reading AGT source. The Inspector is that reader's tool, so the claim
   * is only real if the tool itself knows nothing about AGT and nothing
   * about any particular host: it renders ACS envelopes as data. Both term
   * lists from the two gates above apply to it at once.
   */
  it("the Envelope Inspector's source contains zero AGT vocabulary and zero host vocabulary", () => {
    assertNoVocabulary("packages/inspector/src", [
      "agt",
      "AgentControl",
      "rego",
      "opa",
      "intervention_point",
      "verdict",
      // The three AGT verdict names. Listing the word "verdict" without the
      // verdicts themselves is not enough: it let a badge reading
      // `ALLOW (policy fired -- ACS "warn")` pass with a green suite. ACS has
      // no `warn` disposition, so that string taught a reader AGT's
      // vocabulary from an ACS-first tool -- exactly the leak this gate
      // exists to prevent.
      //
      // `allow`/`deny`/`ask`/`modify`/`defer` are deliberately NOT here --
      // they are ACS's own dispositions and the Inspector must name them.
      // These three are AGT's alone.
      "warn",
      "escalate",
      "transform",
      "claude",
      "opencode",
      "hookSpecificOutput",
      "permissionDecision",
      "stdin",
    ]);
  });

  /**
   * Envelopes must be inspectable on the wire. If the Inspector imported the
   * Guardian's types, "inspectable" would be a claim about our own type
   * graph instead: any third-party reader of the envelope log has only the
   * file. So does this one.
   *
   * "host-adapter" is on this list because the Inspector also tails the
   * audit log, a host-side artifact, and declares its own AuditEntry rather
   * than importing the adapter's, for exactly the same reason it re-declares
   * EnvelopeLogEntry rather than importing the Guardian's (see
   * tail-audit-log.ts's module doc). Without this third entry, the gate
   * would still pass -- but it would no longer be testing the claim this
   * test makes, and a gate that passes without covering what it claims to
   * cover is worse than no gate: it looks like coverage while quietly
   * losing it.
   */
  it("the Envelope Inspector imports nothing from the Guardian, the AGT bridge, or the host adapter", () => {
    for (const { file, code } of readSourceFiles("packages/inspector/src")) {
      for (const spec of ["guardian", "agt-bridge", "host-adapter"]) {
        const found = importsSpecifier(code, spec);
        expect({ file, spec, found }).toEqual({ file, spec, found: false });
      }
    }
  });

  /**
   * This is the same boundary from the host's side. The vocabulary gate
   * above deliberately excludes `hosts/`, because a host shim is
   * host-specific by definition and its doc comment may name the policy
   * runtime in prose -- but the invariant that *does* bind it is an
   * import-graph one, exactly as that exclusion says: "never imports
   * agt-bridge or guardian's server-side pieces, only host-adapter's public
   * surface". acs-hook.ts's own header asserts the property; this is what
   * checks it.
   *
   * That claim is what makes a second host cost zero policy-runtime code: a
   * shim reaching into the Guardian in-process would be governable by that
   * Guardian and nothing else, which undoes the M×N collapse this
   * architecture depends on. It passes today with one shim, and starts
   * biting the moment there are two.
   *
   * `isUnderTestDir` excludes hosts/claude-code/test/, which is the only
   * place that legitimately imports `guardian` -- it stands up a real one to
   * prove the wire contract end to end, the same test-only precedent
   * packages/host-adapter/test/ already sets.
   *
   * Known and left as is: `importsSpecifier` matches the specifier by
   * substring, so a future shim importing a local file whose name merely
   * contains "guardian" (`./guardian-defaults.ts`, say) would trip this gate
   * spuriously. That is deliberate. The substring match is what catches the
   * real hole -- a relative reach-around like
   * `from "../../packages/guardian/src/index.ts"`, which no exact-match
   * check on a bare package name would see, and which is asserted directly
   * in "the import gate itself" below. A false positive here is a loud
   * failure with the offending file named, which someone renames a file to
   * fix; the alternative trades that for a silent hole. Anyone hitting it
   * should read this comment before "fixing" the regex.
   */
  it("every host shim imports the adapter only -- never the Guardian, never the AGT bridge", () => {
    const scanned = readSourceFiles("hosts");

    // Asserted, not assumed. `readSourceFiles`'s emptiness check stops the
    // gate passing vacuously on zero files, but not on the wrong ones: this
    // gate passes today partly because `Glob.scanSync` does not descend into
    // hosts/claude-code/node_modules. A globbing change that started
    // returning vendored `.ts` files would bury the shim among hundreds of
    // them; one that stopped returning the shim would leave a gate that scans
    // something irrelevant and always passes. Pinned to the exact list, so a
    // second shim has to be added here consciously.
    expect(scanned.map(({ file }) => file).sort()).toEqual([
      "claude-code/acs-hook.ts",
      "opencode/acs-plugin.ts",
      "opencode/apply-host-output.ts",
    ]);

    for (const { file, code } of scanned) {
      for (const spec of ["agt-bridge", "guardian"]) {
        const found = importsSpecifier(code, spec);
        expect({ file, spec, found }).toEqual({ file, spec, found: false });
      }
    }
  });

  /**
   * R3.2, continued -- the seventh gate, and V5's own: the first gate above
   * catches host #1's (Claude Code's) wire vocabulary leaking into the shared
   * adapter; this one catches host #2's (OpenCode's). Placed last rather than
   * beside the gate it parallels, so the sixth gate stays V3's and this stays
   * countable as "the seventh" without renumbering anything above it --
   * README.md's "Status" section names both the total count ("Seven ... of
   * this project's architectural claims are enforced by
   * test/invariants.test.ts") and V3's own ordinal ("The sixth of the gates
   * counted above is V3's"), in two different paragraphs. Section-referenced
   * rather than by line number deliberately: this comment already went stale
   * once, when an unrelated paragraph added above both of them shifted their
   * line numbers, and inserting a new gate in the middle of this describe
   * block is exactly how a stale ORDINAL gets written (see V4's own fifth
   * name, gate 2's comment above) -- the same failure mode, twice over, is
   * worth not inviting a third time by citing a line number here too.
   *
   * `attachments` is the term this slice could most plausibly get wrong: it
   * is the field OpenCode's result payload carries at runtime and does not
   * declare in its own published type (hosts/opencode/acs-plugin.ts,
   * "measured" against 1.18.15's type -- the same gap `outputs.mirrors` exists
   * to let a hookmap declare instead of the adapter hard-coding), so a
   * shortcut in result-output.ts naming it explicitly -- rather than treating
   * it as an opaque sibling the clone-and-patch approach never has to read by
   * name -- is the mistake this gate exists to catch. `tool.execute` (the hook
   * name OpenCode's own runtime dispatches on) and `callID` (its per-call
   * identifier) sit beside it for the same reason.
   *
   * Two more OpenCode-shaped terms are deliberately NOT in this list, and the
   * reason is the gate's own validity, same as the exclusions on the gate
   * above:
   *
   *   - `sessionID` case-insensitively matches `sessionId`, which several
   *     adapter files use for ACS's own `metadata.session_id` -- gating it
   *     would fail on day one, for a term that names ACS's vocabulary, not
   *     OpenCode's.
   *   - `metadata` appears in build-envelope.ts and handshake.ts as the ACS
   *     envelope's OWN `metadata` block -- the exact same collision.
   *
   * Listing either would produce a gate that fails for the wrong reason, and
   * "loosen the gate until it passes" is how a gate stops meaning anything.
   * What protects R3.2 for those two is that they are ACS vocabulary the
   * adapter is *supposed* to speak, not a gate.
   */
  it("the adapter names no OpenCode field", () => {
    assertNoVocabulary("packages/host-adapter/src", ["tool.execute", "callID", "attachments"]);
  });

  /**
   * The eighth gate, V5's second -- §V5 review, Task 8, fix round 1,
   * Important 1. Placed last for the same reason the seventh gate is: so
   * neither this comment nor that one goes stale by renumbering when a
   * ninth gate is eventually appended.
   *
   * `acs-plugin.ts` used to export a second symbol, `applyHostOutput`, for
   * no reason but its own unit test's convenience (`hosts/opencode/test/
   * apply-host-output.test.ts` imported it directly, to test it against
   * plain objects rather than a live OpenCode session). Measured: OpenCode's
   * plugin loader hands EVERY exported function of a plugin module its own
   * registration context -- a live `client`, `directory`, `worktree`, and
   * `$` (its shell executor) -- and calls each one as a candidate plugin
   * factory, not only the export shaped like `Plugin`. `applyHostOutput`
   * happened to be the safest possible accident: its own pass-1 validation
   * rejected the context object's first key (`"client"`) before touching
   * anything, so the mis-invocation surfaced as a caught, non-fatal `ERROR`
   * log line and `AcsPlugin` itself still registered. But the SAME mechanism
   * is not always safe -- measured, same review: a single **non-function**
   * export placed beside a working factory produces `error="Plugin export is
   * not a function"`, and the factory is **never called at all**. One
   * exported constant would silently disable governance for the whole
   * session, and nothing in this suite -- or in OpenCode's own log line,
   * which is byte-identical in shape whether the fault is harmless or total
   * -- would say so.
   *
   * `applyHostOutput` now lives in its own module (`apply-host-output.ts`,
   * imported into `acs-plugin.ts`, tested directly by
   * `apply-host-output.test.ts`) specifically so `acs-plugin.ts` has exactly
   * one export for OpenCode's loader to find. This gate is what keeps that
   * true going forward, mechanically: a second export added here -- for a
   * new helper, a re-exported type, anything -- fails this test rather than
   * silently reopening the hazard.
   */
  it("hosts/opencode/acs-plugin.ts exports exactly one symbol, so OpenCode's plugin loader has no second export to mis-invoke as a candidate factory", () => {
    const file = readSourceFiles("hosts").find(({ file }) => file === "opencode/acs-plugin.ts");
    expect(file).toBeDefined();
    expect(exportedNames(file!.code)).toEqual(["AcsPlugin"]);
  });
});

/**
 * True when `code` names a module specifier containing `spec` in any position
 * that actually creates a dependency on it.
 *
 * `from "…"` alone is the one form nobody reaching for a forbidden import by
 * accident would use. Each alternative below is a real hole a narrower
 * check would leave:
 *
 *   from "guardian"              the static named/default import
 *   import "guardian"            the bare side-effect import, no `from`
 *   import("guardian")           dynamic, and `await import("guardian")`
 *   import("guardian").EnvelopeLogEntry
 *                                type position -- erased at build, still a
 *                                compile-time dependency on the Guardian's
 *                                type graph, which is exactly what the gate
 *                                above forbids
 *   require("guardian")          CJS interop
 *
 * `\(?` covers the parenthesised and unparenthesised forms in one pass, and
 * the `i` flag closes the last hole: module resolution is case-insensitive on
 * macOS, so `from "Guardian"` resolves here and the case-sensitive gate said
 * nothing about it.
 */
function importsSpecifier(code: string, spec: string): boolean {
  return new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'][^"']*${spec}[^"']*["']`, "i").test(code);
}

/**
 * Every name a top-level `export` declaration binds in `code`, in source
 * order -- `export (default )?(async )?(function|const|class|type|interface|
 * let|var) NAME`. Deliberately narrow, the same pragmatism `assertNoVocabulary`
 * and `importsSpecifier` above already apply: a regex precise enough for the
 * shape this codebase actually writes exports in, not a full TS parser and
 * not every legal export form. `export { a, b }` re-export lists are not
 * matched -- nothing in this codebase's host shims uses one, and a shim that
 * grew one would be a new shape worth a human reading this gate again, not
 * one to guess about silently. Callers pass comment-stripped code (this
 * suite's own `readSourceFiles` already does that), so a doc comment that
 * happens to contain the word "export" -- this file has several -- is never
 * mistaken for a declaration.
 */
function exportedNames(code: string): string[] {
  const pattern = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|type|interface|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

describe("the import gate itself", () => {
  /**
   * A gate is only worth having if it bites. These are the exact forms a
   * narrower regex would miss, asserted directly against the matcher so a
   * future simplification cannot quietly reopen one of them.
   */
  it("catches every import form, in any case", () => {
    const caught = [
      'import { EnvelopeLogEntry } from "guardian";',
      'import "guardian";',
      'const g = await import("guardian");',
      'type E = import("guardian").EnvelopeLogEntry;',
      'const g = require("guardian");',
      'import { EnvelopeLogEntry } from "Guardian";',
      'export { x } from "../../guardian/src/index.ts";',
    ].map((line) => ({ line, found: importsSpecifier(line, "guardian") }));

    expect(caught).toEqual(caught.map(({ line }) => ({ line, found: true })));
  });

  it("stays quiet on code that merely mentions the word", () => {
    const ignored = [
      'const label = "guardian";',
      "const guardian = startGuardian();",
      'import { renderEnvelopeLogEntry } from "./render.ts";',
    ].map((line) => ({ line, found: importsSpecifier(line, "guardian") }));

    expect(ignored).toEqual(ignored.map(({ line }) => ({ line, found: false })));
  });
});

describe("the host-vocabulary gate itself", () => {
  /**
   * §V5 review, fix round 1, Minor 4: adding "refuse" to the term list above
   * is worth nothing if the gate it was added to cannot actually catch it --
   * a term added to a list nobody exercises is exactly the "reads as coverage
   * while enforcing nothing" failure this whole suite exists to avoid (see
   * `readSourceFiles`'s own emptiness-check comment). Run against a scratch
   * directory rather than the real `packages/host-adapter/src` -- the real
   * tree is what the gate ABOVE already exercises, and it must stay clean;
   * this checks the CHECK, the same split "the import gate itself" and "the
   * source-file filter itself" already make for their own helpers.
   */
  function withScratchSourceFile(code: string, fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "acs-invariants-vocab-"));
    try {
      writeFileSync(join(dir, "leak.ts"), code);
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("catches 'refuse' when it appears in real code, not just when it's declared forbidden", () => {
    withScratchSourceFile('export function refuse(reason: string): void {\n  throw new Error(reason);\n}\n', (dir) => {
      expect(() => assertNoVocabulary(dir, ["refuse"])).toThrow();
    });
  });

  it("stays quiet when 'refuse' appears only in a comment, which stripComments removes", () => {
    withScratchSourceFile("// this module must never refuse to compile\nexport const ok = true;\n", (dir) => {
      expect(() => assertNoVocabulary(dir, ["refuse"])).not.toThrow();
    });
  });

  it("stays quiet on ordinary code naming none of the forbidden terms", () => {
    withScratchSourceFile("export function allow(): boolean {\n  return true;\n}\n", (dir) => {
      expect(() => assertNoVocabulary(dir, ["refuse"])).not.toThrow();
    });
  });

  /**
   * §V5 review, fix round 1, Minor 1 and Minor 2 in one case, as the review
   * itself suggested. `tool.execute` is the first forbidden term carrying a
   * regex metacharacter, so it closes two different gaps at once:
   *
   *   - Minor 2: pins that the term the gate above lists is one the gate can
   *     actually catch (the same argument as "catches 'refuse'..." above,
   *     applied to the OpenCode gate's own term rather than assumed to carry
   *     over).
   *   - Minor 1: proves `escapeRegExp` is doing real work, not merely
   *     present. Before terms were escaped, the literal `.` compiled to a
   *     regex `.` -- ANY character -- so `"tool_execute"` (underscore, a
   *     DIFFERENT term nobody asked to forbid) would have tripped the same
   *     gate as `"tool.execute"` (dot, the real term). Escaped, only the
   *     literal dot matches.
   */
  it("catches 'tool.execute' literally, without over-matching its dot as regex 'any character'", () => {
    withScratchSourceFile('export const hookName = "tool.execute";\n', (dir) => {
      expect(() => assertNoVocabulary(dir, ["tool.execute"])).toThrow();
    });
    withScratchSourceFile('export const hookName = "tool_execute";\n', (dir) => {
      expect(() => assertNoVocabulary(dir, ["tool.execute"])).not.toThrow();
    });
  });
});

describe("the export-count gate itself", () => {
  /**
   * §V5 review, Task 8, fix round 1, Important 1, "mutation-tested": proves
   * `exportedNames` actually distinguishes one export from two, rather than
   * always returning a fixed-length answer that would let the real gate
   * above pass no matter what `acs-plugin.ts` exports. The reviewer's own
   * measured case -- a second export appearing beside a working factory --
   * is reproduced here directly, on a scratch file rather than the real
   * `hosts/opencode/acs-plugin.ts`: this checks the CHECK, the same split
   * "the import gate itself" and "the host-vocabulary gate itself" already
   * make for their own helpers.
   */
  it("counts exactly one export on a file that declares one", () => {
    expect(exportedNames('export const AcsPlugin = async () => ({});\n')).toEqual(["AcsPlugin"]);
  });

  it("counts two exports, in source order, on a file that declares two -- the exact shape this gate exists to catch", () => {
    expect(
      exportedNames(
        'export function applyHostOutput(output, live) {}\n\nexport const AcsPlugin = async () => ({});\n',
      ),
    ).toEqual(["applyHostOutput", "AcsPlugin"]);
  });

  it("does not count a plain function or const that is not exported", () => {
    expect(exportedNames('function helper() {}\nconst AcsPlugin = async () => ({});\n')).toEqual([]);
  });

  it("does not mistake the word \"export\" inside a comment for a declaration", () => {
    // Mirrors this suite's own convention: callers pass comment-stripped
    // code, so a doc comment is never a source of a false export -- proven
    // here the same way "stays quiet when 'refuse' appears only in a
    // comment" proves it for assertNoVocabulary, just without needing
    // stripComments as an extra step, since the fixture is written already
    // comment-free at the code level being tested (a raw block comment
    // would not match `^export\s+...` at a line start regardless).
    expect(exportedNames('// acs-plugin.ts exports exactly one symbol\nexport const AcsPlugin = 1;\n')).toEqual([
      "AcsPlugin",
    ]);
  });

  it("does not count an import naming a symbol also used as an export's type", () => {
    expect(
      exportedNames('import { applyHostOutput } from "./apply-host-output.ts";\n\nexport const AcsPlugin = 1;\n'),
    ).toEqual(["AcsPlugin"]);
  });
});

describe("the source-file filter itself", () => {
  /**
   * `Glob.scanSync`'s relative paths never carry a leading slash, so a
   * `test/` directory sitting directly under the scanned root -- rather than
   * nested deeper -- produces a path with no `/test/` substring at all. No
   * scanned package has such a directory today (each puts `test/` as a
   * sibling of `src/`, never inside it), so this was stricter-than-intended
   * rather than a real hole, but it is still the exact case a bare
   * `.includes("/test/")` misses.
   */
  it("excludes a test/ segment at the start of the path, not only when nested", () => {
    const paths = ["test/invariants.test.ts", "src/test/helper.ts", "packages/foo/test/bar.ts"].map((path) => ({
      path,
      excluded: isUnderTestDir(path),
    }));

    expect(paths).toEqual(paths.map(({ path }) => ({ path, excluded: true })));
  });

  it("does not exclude a segment that merely starts with the letters 'test'", () => {
    const paths = ["latest/foo.ts", "testing/bar.ts", "src/index.ts"].map((path) => ({
      path,
      excluded: isUnderTestDir(path),
    }));

    expect(paths).toEqual(paths.map(({ path }) => ({ path, excluded: false })));
  });
});
