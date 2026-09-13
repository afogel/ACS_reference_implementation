/**
 * Block classification for the corpus's Markdown.
 *
 * X3 measured where RFC 2119 keywords live: paragraphs, list items, table
 * cells and blockquotes, and nowhere else -- zero in headings, code fences
 * or inline code spans. The census has to reproduce that measurement
 * (`normative-ir-slices.md` §V1: "If V1's scan disagrees with those, V1's
 * scan is wrong"), so this classifier names those four block types and
 * also keeps the ones that must come out empty, so that an occurrence
 * turning up in a heading is reported as such rather than mis-filed.
 *
 * This is a line-level classifier, not a CommonMark parser. It knows the
 * constructs the corpus uses -- fences, ATX headings, blockquotes, pipe
 * tables, list items with lazy continuation, thematic breaks -- and treats
 * everything else as paragraph text. Indented code blocks are deliberately
 * not recognised: the corpus writes code in fences, and MkDocs admonitions
 * (`!!! info` plus indented prose) would otherwise be misread as code.
 */

export type BlockType =
  | "paragraph"
  | "list_item"
  | "table_cell"
  | "blockquote"
  | "heading"
  | "code_fence"
  | "thematic_break";

export interface Block {
  type: BlockType;
  /** 1-based line the block starts on. */
  line: number;
  /** 1-based line the block ends on (inclusive). */
  endLine: number;
  /** Raw text of the block: the source lines joined by "\n", or the trimmed cell text for a table cell. */
  text: string;
  /** Table cells only: 0-based column index within the row. */
  column?: number;
  /** Table cells only: 0-based character offset of the trimmed cell text within the source line. */
  offset?: number;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const BLOCKQUOTE = /^\s{0,3}>/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+\S/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;

export function classifyBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];

  let open: { type: "paragraph" | "list_item" | "blockquote"; line: number; lines: string[] } | null = null;
  const close = (endLine: number): void => {
    if (open) blocks.push({ type: open.type, line: open.line, endLine, text: open.lines.join("\n") });
    open = null;
  };

  let i = 0;
  // Front matter: a `---` on line 1 opens a YAML block that runs to the next `---`.
  if (lines[0]?.trim() === "---") {
    let j = 1;
    while (j < lines.length && lines[j]?.trim() !== "---") j++;
    i = Math.min(j + 1, lines.length);
  }

  for (; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;

    const fence = FENCE_OPEN.exec(raw);
    if (fence) {
      close(lineNo - 1);
      const marker = fence[1] ?? "";
      const char = marker[0] ?? "`";
      const start = lineNo;
      const body: string[] = [raw];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        body.push(l);
        const closeRun = new RegExp(`^\\s{0,3}${char === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        if (closeRun.test(l)) break;
      }
      blocks.push({ type: "code_fence", line: start, endLine: Math.min(j + 1, lines.length), text: body.join("\n") });
      i = j;
      continue;
    }

    if (raw.trim() === "") {
      close(lineNo - 1);
      continue;
    }

    if (open?.type === "paragraph" && SETEXT_UNDERLINE.test(raw)) {
      // A paragraph followed by `===` or `---` is a setext heading, not a break.
      const heading = open;
      open = null;
      blocks.push({ type: "heading", line: heading.line, endLine: lineNo, text: [...heading.lines, raw].join("\n") });
      continue;
    }

    if (THEMATIC_BREAK.test(raw)) {
      close(lineNo - 1);
      blocks.push({ type: "thematic_break", line: lineNo, endLine: lineNo, text: raw });
      continue;
    }

    if (HEADING.test(raw)) {
      close(lineNo - 1);
      blocks.push({ type: "heading", line: lineNo, endLine: lineNo, text: raw });
      continue;
    }

    if (BLOCKQUOTE.test(raw)) {
      if (open?.type === "blockquote") {
        open.lines.push(raw);
      } else {
        close(lineNo - 1);
        open = { type: "blockquote", line: lineNo, lines: [raw] };
      }
      continue;
    }

    if (TABLE_ROW.test(raw)) {
      close(lineNo - 1);
      if (TABLE_SEPARATOR.test(raw)) continue;
      splitCellsWithOffsets(raw).forEach(({ text: cell, offset }, column) => {
        blocks.push({ type: "table_cell", line: lineNo, endLine: lineNo, text: cell, column, offset });
      });
      continue;
    }

    if (LIST_ITEM.test(raw)) {
      close(lineNo - 1);
      open = { type: "list_item", line: lineNo, lines: [raw] };
      continue;
    }

    // Plain text: a lazy continuation of whatever is open, else a new paragraph.
    if (open) {
      open.lines.push(raw);
    } else {
      open = { type: "paragraph", line: lineNo, lines: [raw] };
    }
  }
  close(lines.length);
  return blocks;
}

/** Split a pipe-table row into its cells, honouring `\|` escapes; the outer pipes are dropped. */
export function splitCells(row: string): string[] {
  return splitCellsWithOffsets(row).map((c) => c.text);
}

/**
 * The cells of a pipe-table row with the offset of each cell's trimmed text in
 * the line, so a keyword found inside a cell can report the column it occupies
 * in the file rather than in the cell.
 */
export function splitCellsWithOffsets(row: string): { text: string; offset: number }[] {
  const boundaries: number[] = [];
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "|" && row[i - 1] !== "\\") boundaries.push(i);
  }
  const first = row.search(/\S/);
  const last = row.search(/\s*$/);
  let start = boundaries[0] === first ? first + 1 : first;
  const stops = boundaries.filter((b) => b >= start);
  const endsWithPipe = stops.length > 0 && stops[stops.length - 1] === last - 1;
  const cuts = endsWithPipe ? stops : [...stops, last];
  const cells: { text: string; offset: number }[] = [];
  for (const cut of cuts) {
    const raw = row.slice(start, cut);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim().replace(/\\\|/g, "|"), offset: start + lead });
    start = cut + 1;
  }
  return cells;
}
