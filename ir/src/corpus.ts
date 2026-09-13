/**
 * S1: the pinned normative corpus, `spec/acs/docs/**.md`.
 *
 * Everything in `ir/` reads the spec through this one module, and this
 * module reads the git submodule and nothing else in the repository (R8.2):
 * no AGT bridge, no host adapter, no `mapping.yaml`. The default root is
 * resolved relative to this file, not the process cwd, so `acs-ir` gives
 * the same answer from any directory; `--corpus <dir>` overrides it for a
 * second checkout (the reference-number tests point it at the commit the
 * shaping survey measured).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Corpus {
  /** Absolute path of the spec checkout (the submodule root). */
  root: string;
  /** Absolute path of `docs/`, the directory every source path is relative to. */
  docsDir: string;
  /** `git rev-parse HEAD` of the checkout, or null when it is not a git tree. */
  commit: string | null;
  /** Contents of `version.txt`, trimmed, or null when absent. */
  version: string | null;
  /** Every `*.md` under `docs/`, relative to `docs/`, POSIX separators, sorted. */
  files: string[];
}

export function defaultCorpusRoot(): string {
  return resolve(import.meta.dir, "..", "..", "spec", "acs");
}

export function loadCorpus(root: string = defaultCorpusRoot()): Corpus {
  const absRoot = resolve(root);
  const docsDir = join(absRoot, "docs");
  if (!existsSync(docsDir)) {
    throw new Error(
      `corpus not found: ${docsDir} does not exist. ` +
        `If this is the pinned submodule, run \`git submodule update --init spec/acs\`.`,
    );
  }
  const files = Array.from(new Bun.Glob("**/*.md").scanSync({ cwd: docsDir, onlyFiles: true }))
    .map((f) => f.split("\\").join("/"))
    .sort();
  return { root: absRoot, docsDir, commit: readCommit(absRoot), version: readVersion(absRoot), files };
}

export function readSource(corpus: Corpus, file: string): string {
  return readFileSync(join(corpus.docsDir, file), "utf8");
}

function readVersion(root: string): string | null {
  const path = join(root, "version.txt");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function readCommit(root: string): string | null {
  // Only a checkout whose own top level is `root` has a commit to report. A
  // fixture directory nested inside another repository would otherwise be
  // labelled with that repository's HEAD.
  const top = Bun.spawnSync(["git", "-C", root, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (top.exitCode !== 0 || resolve(top.stdout.toString().trim()) !== root) return null;
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.toString().trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
