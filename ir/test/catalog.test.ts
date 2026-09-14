import { describe, expect, it } from "bun:test";
import { canonicalKeyword, effectiveKeyword, loadCatalog, parseProvisionRecord, polarityOf, strengthOf, type ProvisionRecord } from "../src/catalog/catalog.ts";
import type { Manifest, ManifestEntry } from "../src/extract/extract.ts";

const entry = (id: string, source_file = "spec/x.md"): ManifestEntry => ({
  id,
  type: "Requirement",
  source_file,
  line: 1,
  block_type: "paragraph",
  section_slug: null,
  level: "MUST",
  keywords: ["MUST"],
  text: "t",
  text_hash: "h",
});
const record = (id: string, extra: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  id,
  title: "T",
  actor: "guardian",
  reported_against: "guardian",
  profile: ["acs-core"],
  activation: null,
  modality_kind: "obligation",
  keyword: null,
  keyword_basis: null,
  evidence_class: "wire",
  schema_refs: [],
  depends_on: [],
  restates: null,
  status: "active",
  since: "0.1.0",
  superseded_by: [],
  reviewed_against: "h",
  note: null,
  predicate: null,
  ...extra,
});
const manifest = (...entries: ManifestEntry[]): Manifest => ({ generated_by: "test", corpus: { version: null, commit: null }, provisions: entries });

describe("loadCatalog -- the one join, and what it refuses", () => {
  it("joins a manifest entry to its record by id", () => {
    const catalog = loadCatalog(manifest(entry("ACS-REQ-0001")), [record("ACS-REQ-0001")]);
    expect(catalog.problems).toEqual([]);
    expect(catalog.entries.map((e) => e.record.title)).toEqual(["T"]);
  });

  it("names a marked provision with no record and a record with no marker", () => {
    const catalog = loadCatalog(manifest(entry("ACS-REQ-0001")), [record("ACS-REQ-0002")]);
    expect(catalog.problems).toEqual([
      "ACS-REQ-0001: marked in the corpus but has no record in ir/provisions/",
      "ACS-REQ-0002: has a record but is not marked in the corpus",
    ]);
  });

  it("checks depends_on targets exist and restates points at a concept page", () => {
    const catalog = loadCatalog(manifest(entry("ACS-REQ-0001"), entry("ACS-REQ-0002", "spec/y.md"), entry("ACS-REQ-0003", "concepts/z.md")), [
      record("ACS-REQ-0001", { depends_on: ["ACS-DEF-0009"], restates: "ACS-REQ-0002" }),
      record("ACS-REQ-0002", { restates: "ACS-REQ-0003" }),
      record("ACS-REQ-0003"),
    ]);
    expect(catalog.problems).toEqual([
      "ACS-REQ-0001: depends_on ACS-DEF-0009, which is not in the catalog",
      "ACS-REQ-0001: restates ACS-REQ-0002 in spec/y.md; a restatement points at the concept-page copy (concepts/README.md:33)",
    ]);
  });
});

describe("parseProvisionRecord -- the authored shape", () => {
  const base = [
    "id: ACS-REQ-0001",
    "title: T",
    "actor: guardian",
    "reported_against: guardian",
    "profile: [acs-core]",
    "activation: null",
    "modality_kind: obligation",
    "evidence_class: wire",
    "status: active",
    "since: 0.1.0",
    "reviewed_against: h",
  ];

  it("parses the documented fields with defaults for the optional lists", () => {
    expect(parseProvisionRecord(base.join("\n"), "ACS-REQ-0001")).toEqual(record("ACS-REQ-0001"));
  });

  it("accepts profile: all and schema refs with JSON Pointers", () => {
    const text = base.map((l) => (l.startsWith("profile") ? "profile: all" : l)).concat("schema_refs:\n  - file: a.json\n    pointer: /x").join("\n");
    expect(parseProvisionRecord(text)).toMatchObject({ profile: "all", schema_refs: [{ file: "a.json", pointer: "/x" }] });
  });

  it("rejects a filename/id mismatch, an unknown enum value, and a bad pointer", () => {
    expect(() => parseProvisionRecord(base.join("\n"), "ACS-REQ-0002")).toThrow("record carries id ACS-REQ-0001");
    expect(() => parseProvisionRecord(base.map((l) => (l.startsWith("actor") ? "actor: llm" : l)).join("\n"))).toThrow("actor must be one of");
    expect(() => parseProvisionRecord(base.map((l) => (l.startsWith("profile") ? "profile: [acs-magic]" : l)).join("\n"))).toThrow("unknown profile");
    expect(() => parseProvisionRecord(base.concat("schema_refs:\n  - file: a.json\n    pointer: x").join("\n"))).toThrow("JSON Pointer starting with /");
  });
});

describe("the RFC 2119 keyword a provision is judged by", () => {
  it("canonicalizes the RFC's synonyms and derives strength and polarity", () => {
    expect(["REQUIRED", "SHALL", "MUST NOT", "SHALL NOT", "RECOMMENDED", "NOT RECOMMENDED", "OPTIONAL"].map(canonicalKeyword)).toEqual(["MUST", "MUST", "MUST NOT", "MUST NOT", "SHOULD", "SHOULD NOT", "MAY"]);
    expect(canonicalKeyword(null)).toBeNull();
    expect(["MUST", "MUST NOT", "SHOULD", "SHOULD NOT", "MAY"].map((k) => [strengthOf(k as "MUST"), polarityOf(k as "MUST")])).toEqual([["must", "obligation"], ["must", "prohibition"], ["should", "obligation"], ["should", "prohibition"], ["may", "obligation"]]);
  });

  it("is the marked span's first keyword unless the record states one", () => {
    expect(effectiveKeyword({ level: "RECOMMENDED" }, { keyword: null })).toBe("SHOULD");
    expect(effectiveKeyword({ level: "RECOMMENDED" }, { keyword: "MUST" })).toBe("MUST");
    expect(effectiveKeyword({ level: null }, { keyword: null })).toBeNull();
  });

  it("a record that states a keyword says why, and never a basis without a keyword", () => {
    const base = ["id: ACS-REQ-0001", "title: T", "actor: guardian", "reported_against: guardian", "profile: [acs-core]", "modality_kind: obligation", "evidence_class: wire", "status: active", "since: 0.1.0", "reviewed_against: h"];
    expect(parseProvisionRecord([...base, "keyword: MUST NOT", "keyword_basis: the sentence says MAY NOT"].join("\n"))).toMatchObject({ keyword: "MUST NOT", keyword_basis: "the sentence says MAY NOT" });
    expect(() => parseProvisionRecord([...base, "keyword: MUST NOT"].join("\n"))).toThrow("say why in keyword_basis");
    expect(() => parseProvisionRecord([...base, "keyword_basis: why"].join("\n"))).toThrow("keyword_basis without a keyword");
    expect(() => parseProvisionRecord([...base, "keyword: REQUIRED", "keyword_basis: x"].join("\n"))).toThrow("keyword must be one of");
  });

  it("the join refuses a keyword that disagrees with the modality, and a Requirement with no keyword at all", () => {
    const catalog = loadCatalog(manifest({ ...entry("ACS-REQ-0001"), level: "MAY", keywords: ["MAY"] }, { ...entry("ACS-REQ-0002"), level: "MUST" }, { ...entry("ACS-REQ-0003"), level: null, keywords: [] }, { ...entry("ACS-REQ-0004"), level: "MAY", keywords: ["MAY"] }), [
      record("ACS-REQ-0001"),
      record("ACS-REQ-0002", { modality_kind: "permission" }),
      record("ACS-REQ-0003"),
      record("ACS-REQ-0004", { keyword: "MUST NOT", keyword_basis: "the sentence says MAY NOT" }),
    ]);
    expect(catalog.problems).toEqual([
      "ACS-REQ-0001: an obligation is judged by MUST or SHOULD, not MAY; if the sentence says MAY NOT, state keyword: MUST NOT with keyword_basis",
      "ACS-REQ-0002: a permission is judged by MAY, not MUST",
      "ACS-REQ-0003: the marked span has no RFC 2119 keyword; state keyword: with keyword_basis",
    ]);
  });
});

