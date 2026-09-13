import { describe, expect, it } from "bun:test";
import { parseSourceDeclarations, sourceCensus, type SourceDeclaration } from "../src/census/source-census.ts";

const declared: SourceDeclaration[] = [
  { path: "spec/a.md", status: "normative", normative_by: "self" },
  { path: "concepts/b.md", status: "normative", normative_by: "reference", referenced_by: ["spec/a.md#x"] },
  { path: "notes.md", status: "informative" },
];

describe("sourceCensus -- the declaration and the tree must agree both ways", () => {
  it("passes a fully declared corpus", () => {
    expect(sourceCensus(declared, ["spec/a.md", "concepts/b.md", "notes.md"]).problems).toEqual([]);
  });

  it("names a corpus file nobody declared", () => {
    expect(sourceCensus(declared, ["spec/a.md", "concepts/b.md", "notes.md", "new.md"]).problems).toEqual([
      "new.md: in the corpus but not declared in sources.yaml",
    ]);
  });

  it("names a declared file that is not in the corpus, and a duplicate", () => {
    const twice = [...declared, { path: "notes.md", status: "informative" as const }];
    expect(sourceCensus(twice, ["spec/a.md", "concepts/b.md"]).problems).toEqual([
      "notes.md: declared but not in the corpus",
      "notes.md: declared more than once",
      "notes.md: declared but not in the corpus",
    ]);
  });

  it("requires a normative source to say what makes it normative", () => {
    const problems = sourceCensus([{ path: "spec/a.md", status: "normative" }], ["spec/a.md"]).problems;
    expect(problems).toEqual(["spec/a.md: normative sources must say what makes them normative (normative_by: self | reference)"]);
  });

  it("requires a by-reference source to cite a normative or editorial document in the corpus", () => {
    const problems = sourceCensus(
      [
        { path: "concepts/b.md", status: "normative", normative_by: "reference", referenced_by: ["notes.md#x", "gone.md"] },
        { path: "notes.md", status: "informative" },
      ],
      ["concepts/b.md", "notes.md"],
    ).problems;
    expect(problems).toEqual([
      "concepts/b.md: referenced_by cites notes.md, which is declared informative; a citation carries normative force only from a normative or editorial source",
      "concepts/b.md: referenced_by cites gone.md, which is not in the corpus",
    ]);
    expect(sourceCensus([{ path: "c.md", status: "normative", normative_by: "reference", referenced_by: [] }], ["c.md"]).problems).toEqual([
      "c.md: normative_by: reference needs a non-empty referenced_by",
    ]);
  });

  it("rejects normative_by on a non-normative source", () => {
    expect(sourceCensus([{ path: "n.md", status: "informative", normative_by: "self" }], ["n.md"]).problems).toEqual([
      "n.md: only normative sources carry normative_by / referenced_by",
    ]);
  });
});

describe("parseSourceDeclarations -- the authored file's shape", () => {
  it("parses the documented fields and nothing else", () => {
    const parsed = parseSourceDeclarations(
      "sources:\n  - path: a.md\n    status: normative\n    normative_by: self\n    pillar: x\n    note: n\n    extra: dropped\n",
    );
    expect(parsed).toEqual([{ path: "a.md", status: "normative", normative_by: "self", pillar: "x", note: "n" }]);
  });

  it("throws on a missing list, a bad status, or a bad normative_by", () => {
    expect(() => parseSourceDeclarations("nope: 1")).toThrow("expected a top-level `sources:` list");
    expect(() => parseSourceDeclarations("sources:\n  - path: a.md\n    status: maybe\n")).toThrow("status must be one of");
    expect(() => parseSourceDeclarations("sources:\n  - path: a.md\n    status: normative\n    normative_by: vibes\n")).toThrow(
      "normative_by must be self | reference",
    );
  });
});
