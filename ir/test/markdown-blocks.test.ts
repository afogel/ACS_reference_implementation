import { describe, expect, it } from "bun:test";
import { classifyBlocks, splitCells, splitCellsWithOffsets } from "../src/markdown-blocks.ts";

const sample = [
  "# Heading",
  "",
  "Para line one",
  "para line two",
  "",
  "- item one",
  "  lazy continuation",
  "- item two",
  "  1. nested",
  "",
  "| h1 | h2 |",
  "|---|---|",
  "| c1 | c2 \\| esc |",
  "",
  "> quote one",
  "> quote two",
  "",
  "```",
  "fenced # not a heading",
  "```",
  "",
  "---",
  "",
  "Setext",
  "===",
  "",
  "!!! info \"Admonition\"",
  "    indented prose, not code",
].join("\n");

describe("classifyBlocks -- the block types X3 counted, at the lines they occupy", () => {
  const blocks = classifyBlocks(sample);
  const types = blocks.map((b) => `${b.type}@${b.line}`);

  it("names each construct once, in document order", () => {
    expect(types).toEqual([
      "heading@1",
      "paragraph@3",
      "list_item@6",
      "list_item@8",
      "list_item@9",
      "table_cell@11",
      "table_cell@11",
      "table_cell@13",
      "table_cell@13",
      "blockquote@15",
      "code_fence@18",
      "thematic_break@22",
      "heading@24",
      "paragraph@27",
    ]);
  });

  it("keeps a lazy continuation inside its list item and a nested item as its own block", () => {
    expect(blocks[2]?.text).toBe("- item one\n  lazy continuation");
    expect(blocks[4]?.text).toBe("  1. nested");
  });

  it("emits one block per table cell, skips the separator row, and honours escaped pipes", () => {
    const cells = blocks.filter((b) => b.type === "table_cell");
    expect(cells.map((c) => [c.column, c.text])).toEqual([
      [0, "h1"],
      [1, "h2"],
      [0, "c1"],
      [1, "c2 | esc"],
    ]);
  });

  it("joins consecutive quote lines into one blockquote block with the end line recorded", () => {
    const quote = blocks.find((b) => b.type === "blockquote");
    expect(quote).toMatchObject({ line: 15, endLine: 16, text: "> quote one\n> quote two" });
  });

  it("swallows a fence whole, including a line that looks like a heading", () => {
    const fence = blocks.find((b) => b.type === "code_fence");
    expect(fence).toMatchObject({ line: 18, endLine: 20 });
    expect(blocks.some((b) => b.type === "heading" && b.text.includes("fenced"))).toBe(false);
  });

  it("reads a setext underline as a heading, not a thematic break", () => {
    expect(blocks.filter((b) => b.type === "heading").map((b) => b.text)).toEqual(["# Heading", "Setext\n==="]);
  });

  it("treats indented admonition prose as paragraph text rather than an indented code block", () => {
    expect(blocks.at(-1)).toMatchObject({ type: "paragraph", line: 27, endLine: 28 });
  });

  it("skips YAML front matter", () => {
    const withFrontMatter = ["---", "title: x", "---", "", "Body MUST count"].join("\n");
    expect(classifyBlocks(withFrontMatter)).toEqual([{ type: "paragraph", line: 5, endLine: 5, text: "Body MUST count" }]);
  });

  it("closes an unterminated fence at end of file", () => {
    expect(classifyBlocks("```\nopen").map((b) => b.type)).toEqual(["code_fence"]);
  });
});

describe("splitCells", () => {
  it("drops the outer pipes and trims each cell", () => {
    expect(splitCells("|  a | b|")).toEqual(["a", "b"]);
  });
  it("keeps a trailing escaped pipe as content", () => {
    expect(splitCells("| a \\|")).toEqual(["a |"]);
  });
  it("reports where each cell's text starts in the line", () => {
    expect(splitCellsWithOffsets("|  a | b|")).toEqual([
      { text: "a", offset: 3 },
      { text: "b", offset: 7 },
    ]);
    expect(splitCellsWithOffsets("a | b")).toEqual([
      { text: "a", offset: 0 },
      { text: "b", offset: 4 },
    ]);
  });
});
