import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, readSource } from "../src/corpus.ts";
import { extractProvisions, hashText, slugify } from "../src/extract/extract.ts";
import { applyOverlay, parseOverlay, resolveOverlay } from "../src/markers/overlay.ts";

const mini = join(import.meta.dir, "fixtures", "mini");

function markedFixture(): { dir: string; files: string[] } {
  const corpus = loadCorpus(mini);
  const entries = parseOverlay(readFileSync(join(mini, "overlay.yaml"), "utf8"));
  const { spans, problems } = resolveOverlay(entries, (f) => (corpus.files.includes(f) ? readSource(corpus, f) : null));
  if (problems.length) throw new Error(problems.join("\n"));
  const dir = mkdtempSync(join(tmpdir(), "acs-ir-marked-"));
  applyOverlay(corpus, spans, (f) => readSource(corpus, f), dir);
  return { dir, files: corpus.files };
}

describe("extractProvisions -- the mechanical half, read back from the markers", () => {
  const { dir, files } = markedFixture();
  const { manifest, problems } = extractProvisions(dir, files, { version: "9.9.9", commit: null });
  const byId = Object.fromEntries(manifest.provisions.map((p) => [p.id, p]));

  it("emits one entry per marked provision, sorted by id, with the corpus pin", () => {
    expect(problems).toEqual([]);
    expect(manifest.generated_by).toBe("acs-ir extract");
    expect(manifest.corpus).toEqual({ version: "9.9.9", commit: null });
    expect(manifest.provisions.map((p) => p.id)).toEqual(["ACS-DEF-0001", "ACS-INV-0001", "ACS-REQ-0001", "ACS-REQ-0002", "ACS-REQ-0003"]);
  });

  it("reads a paragraph span verbatim, across a line break, and takes the first keyword as level", () => {
    expect(byId["ACS-REQ-0001"]).toMatchObject({
      type: "Requirement",
      source_file: "spec/rules.md",
      line: 3,
      block_type: "paragraph",
      section_slug: "rules-that-must-not-count-in-a-heading",
      level: "MUST",
      keywords: ["MUST", "MUST NOT"],
      text: "A client MUST send a handshake first, and it\nMUST NOT send hooks before that.",
    });
  });

  it("reads a list item, a table cell, and a blockquote callout by their block types", () => {
    expect(byId["ACS-REQ-0002"]).toMatchObject({ block_type: "list_item", line: 6, level: "SHOULD", keywords: ["SHOULD", "MAY"] });
    expect(byId["ACS-REQ-0003"]).toMatchObject({ block_type: "table_cell", line: 15, level: "OPTIONAL", text: "OPTIONAL, MAY be empty" });
    expect(byId["ACS-INV-0001"]).toMatchObject({ type: "Invariant", block_type: "blockquote", level: "MUST NOT", section_slug: "thing" });
  });

  it("leaves level null for a keyword-free definition", () => {
    expect(byId["ACS-DEF-0001"]).toMatchObject({ type: "Definition", level: null, keywords: [], text: "A thing is defined here." });
  });

  it("hashes whitespace-normalized text, so a reflow is not a change", () => {
    expect(byId["ACS-REQ-0001"]?.text_hash).toBe(hashText("A client MUST send a handshake first, and it MUST NOT send hooks before that."));
    expect(hashText("a  b\n c")).toBe(hashText("a b c"));
    expect(hashText("a b c")).not.toBe(hashText("a b d"));
  });

  it("reports a missing marked file rather than skipping it", () => {
    expect(extractProvisions(dir, [...files, "ghost.md"], { version: null, commit: null }).problems).toEqual([
      "ghost.md: missing from the marked corpus; run `acs-ir markers apply`",
    ]);
  });
});

describe("slugify -- Python-Markdown's, so the slug equals the published anchor", () => {
  it("matches the spec's own heading anchors", () => {
    expect(slugify("6.4 Honoring decisions (normative)")).toBe("64-honoring-decisions-normative");
    expect(slugify("4. Capability Negotiation Handshake")).toBe("4-capability-negotiation-handshake");
    expect(slugify("Intent extension via ASK")).toBe("intent-extension-via-ask");
  });
});
