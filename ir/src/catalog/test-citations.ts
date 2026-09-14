/**
 * S14's citation index: which conformance test files cite which provision IDs.
 *
 * R2.7: tests cite provision IDs only, never quoted English, so a citation
 * is a literal `ACS-XXX-NNNN` in a file under `ir/test/conformance/`. The
 * directory is added with the fixtures in V5; until then the index is empty
 * and the stale list's `tests` column says so rather than omitting it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestCitations } from "./staleness.ts";

const CITATION = /\bACS-(?:REQ|DEF|INV|EXC)-\d{4}\b/g;

export function defaultConformanceDir(): string {
  return resolve(import.meta.dir, "..", "..", "test", "conformance");
}

export function collectTestCitations(dir: string = defaultConformanceDir()): TestCitations {
  const citations: TestCitations = new Map();
  if (!existsSync(dir)) return citations;
  const files = Array.from(new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })).sort();
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const id of new Set(Array.from(text.matchAll(CITATION), (m) => m[0]))) {
      citations.set(id, [...(citations.get(id) ?? []), file]);
    }
  }
  return citations;
}
