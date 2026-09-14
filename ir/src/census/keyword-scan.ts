/**
 * N13: `keywordScan()` -- the RFC 2119 keyword scan, block-type aware.
 *
 * Reports every keyword occurrence with its file, line, column, block type
 * and a one-line context window. Keywords inside inline code spans and
 * HTML comments are masked out before matching and counted separately, so
 * a future `<!--/acs-req-0017-->` terminator or a quoted `MUST` in a code
 * span can never inflate the count. RFC 8174 scope: uppercase forms only.
 *
 * The alternation lists two-word forms before their one-word prefixes so
 * `MUST NOT` is never counted as `MUST`.
 */
import { classifyBlocks, lineStarts, locateOffset, type Block, type BlockType } from "../markdown-blocks.ts";

export const RFC2119_KEYWORDS = [
  "MUST NOT",
  "MUST",
  "SHALL NOT",
  "SHALL",
  "SHOULD NOT",
  "SHOULD",
  "NOT RECOMMENDED",
  "RECOMMENDED",
  "MAY",
  "OPTIONAL",
  "REQUIRED",
] as const;

export type Keyword = (typeof RFC2119_KEYWORDS)[number];

export interface Occurrence {
  source: string;
  line: number;
  /** 1-based character offset within the line. */
  column: number;
  /** 0-based character offset in the file, the key a marker span binds on. */
  offset: number;
  keyword: Keyword;
  block_type: BlockType;
  /** 1-based ordinal of the block within the file, so two occurrences in one block are visibly one block. */
  block: number;
  /** Whitespace-collapsed window around the keyword, for an editor reading the table without opening the file. */
  context: string;
}

export interface KeywordScan {
  source: string;
  occurrences: Occurrence[];
  /** Occurrences found only inside inline code spans or HTML comments -- mentions, not uses. Expected empty. */
  masked: Occurrence[];
  blocks_with_keywords: number;
}

const KEYWORD = new RegExp(`\\b(${RFC2119_KEYWORDS.join("|")})\\b`, "g");
const CONTEXT_RADIUS = 72;

export function keywordScan(source: string, text: string, blocks: Block[] = classifyBlocks(text)): KeywordScan {
  const occurrences: Occurrence[] = [];
  const masked: Occurrence[] = [];
  const starts = lineStarts(text);
  let blocksWithKeywords = 0;

  blocks.forEach((block, index) => {
    if (block.type === "code_fence" || block.type === "thematic_break") return;
    const visible = maskSpans(block.text);
    const before = occurrences.length;
    for (const match of block.text.matchAll(KEYWORD)) {
      const at = match.index ?? 0;
      const keyword = match[1] as Keyword;
      const occurrence = locate(source, block, index + 1, keyword, at, starts);
      (visible.slice(at, at + keyword.length) === keyword ? occurrences : masked).push(occurrence);
    }
    if (occurrences.length > before) blocksWithKeywords++;
  });

  return { source, occurrences, masked, blocks_with_keywords: blocksWithKeywords };
}

function locate(source: string, block: Block, ordinal: number, keyword: Keyword, at: number, starts: number[]): Occurrence {
  const offset = block.start + at;
  const { line, column } = locateOffset(starts, offset);
  return { source, line, column, offset, keyword, block_type: block.type, block: ordinal, context: context(block.text, at, keyword) };
}

function context(text: string, at: number, keyword: Keyword): string {
  const start = Math.max(0, at - CONTEXT_RADIUS);
  const end = Math.min(text.length, at + keyword.length + CONTEXT_RADIUS);
  const window = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${window}${end < text.length ? "…" : ""}`;
}

/** Replace inline code spans and HTML comments with spaces of equal length, preserving every offset. */
export function maskSpans(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)[\s\S]*?\1/g, blank);
}

function blank(match: string): string {
  return match.replace(/[^\n]/g, " ");
}
