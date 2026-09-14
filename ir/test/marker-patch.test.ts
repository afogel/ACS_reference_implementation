/**
 * V8: `acs-ir markers patch` (N60). The overlay, emitted as a git patch
 * against the spec repository, applies to the pinned checkout, and the
 * corpus it produces yields the manifest already committed: the E3.3
 * retirement, proven before the patch is sent.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, readSource } from "../src/corpus.ts";
import { defaultManifestPath, extractProvisions, type Manifest } from "../src/extract/extract.ts";
import { defaultMarkersDir, parseOverlay, resolveOverlay } from "../src/markers/overlay.ts";
import { fileDiff, materializeMarkerPatch } from "../src/markers/patch.ts";

describe("fileDiff -- a unified diff for one-line replacements", () => {
  it("emits one hunk with three lines of context and grouped removals then additions", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
    const after = before.replace("d\ne", "d!\ne!");
    expect(fileDiff("docs/x.md", before, after)).toBe(
      ["diff --git a/docs/x.md b/docs/x.md", "--- a/docs/x.md", "+++ b/docs/x.md", "@@ -1,8 +1,8 @@", " a", " b", " c", "-d", "-e", "+d!", "+e!", " f", " g", " h", ""].join("\n"),
    );
  });

  it("merges hunks whose context would overlap, and keeps separate ones apart", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const before = lines.join("\n") + "\n";
    const near = before.replace("l5\n", "l5x\n").replace("l9\n", "l9x\n");
    expect(fileDiff("d.md", before, near).match(/^@@/gm)).toHaveLength(1);
    const far = before.replace("l5\n", "l5x\n").replace("l25\n", "l25x\n");
    expect(fileDiff("d.md", before, far).match(/^@@/gm)).toHaveLength(2);
  });

  it("marks a missing trailing newline the way git does", () => {
    const diff = fileDiff("d.md", "one\ntwo", "one\ntwo<!--/acs-req-0001-->");
    expect(diff).toContain("-two\n\\ No newline at end of file\n+two<!--/acs-req-0001-->\n\\ No newline at end of file\n");
  });

  it("returns nothing for an unchanged file and refuses a line-count change", () => {
    expect(fileDiff("d.md", "a\nb\n", "a\nb\n")).toBe("");
    expect(() => fileDiff("d.md", "a\nb\n", "a\nb\nc\n")).toThrow("must not contain a line break");
  });
});

describe("materializeMarkerPatch -- the overlay against the pinned spec", () => {
  const corpus = loadCorpus();
  const overlay = parseOverlay(readFileSync(join(defaultMarkersDir(), "overlay.yaml"), "utf8"));
  const resolution = resolveOverlay(overlay, (file) => (corpus.files.includes(file) ? readSource(corpus, file) : null));
  const read = (file: string): string => readSource(corpus, file);
  const bulk = materializeMarkerPatch(corpus, resolution.spans, read);

  it("covers every marked provision, names the corpus it was generated against, and touches only files with markers", () => {
    expect(resolution.problems).toEqual([]);
    expect(bulk.provisions).toHaveLength(155);
    expect(bulk.patch.startsWith(`# Provision markers for ACS ${corpus.version} at ${corpus.commit}.`)).toBe(true);
    expect(bulk.files).toHaveLength(14);
    expect(bulk.patch.match(/^diff --git a\/docs\//gm)).toHaveLength(14);
  });

  it("applies cleanly to the pinned checkout with git apply --check", () => {
    const patchFile = join(mkdtempSync(join(tmpdir(), "acs-ir-patch-")), "markers.patch");
    writeFileSync(patchFile, bulk.patch);
    const result = Bun.spawnSync(["git", "apply", "--check", patchFile], { cwd: corpus.root, stderr: "pipe", stdout: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("produces, once applied, the corpus the committed manifest was extracted from (E3.3)", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-ir-applied-"));
    cpSync(corpus.docsDir, join(root, "docs"), { recursive: true });
    const patchFile = join(root, "markers.patch");
    writeFileSync(patchFile, bulk.patch);
    const applied = Bun.spawnSync(["git", "apply", patchFile], { cwd: root, stderr: "pipe", stdout: "pipe" });
    expect(applied.stderr.toString()).toBe("");
    expect(applied.exitCode).toBe(0);
    // The patched tree is read as if it were the submodule: no overlay involved.
    const extraction = extractProvisions(join(root, "docs"), corpus.files, { version: corpus.version, commit: corpus.commit });
    expect(extraction.problems).toEqual([]);
    const committed = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
    const hashes = (m: Manifest): [string, string][] => m.provisions.map((p) => [p.id, p.text_hash]);
    expect(hashes(extraction.manifest)).toEqual(hashes(committed));
  });

  it("builds the proof-of-concept subset from the same overlay and refuses an ID it does not hold", () => {
    const ids = new Set(["ACS-REQ-0007", "ACS-REQ-0010", "ACS-REQ-0013", "ACS-INV-0001", "ACS-EXC-0001"]);
    const poc = materializeMarkerPatch(corpus, resolution.spans, read, ids);
    expect(poc.provisions).toEqual([...ids].sort());
    expect(poc.files).toEqual(["concepts/intent.md", "spec/instrument/specification.md"]);
    expect(poc.patch).toContain('<a id="acs-req-0007"></a>Required at session start, before any hook traffic.<!--/acs-req-0007-->');
    expect(() => materializeMarkerPatch(corpus, resolution.spans, read, new Set(["ACS-REQ-9999"]))).toThrow("ACS-REQ-9999 is not in the overlay");
  });
});
