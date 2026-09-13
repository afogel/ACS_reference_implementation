/**
 * N14: `calloutScan()` -- the `> **Title (normative).**` convention in
 * `concepts/`, plus the other places the corpus tags text as normative.
 *
 * Candidates only. X5 found the callouts are a mix of Invariants,
 * Requirements and one Exclusion, so node type is editorial (E1.4): the
 * tool marks, the editor types. The census lists what it found and what
 * kind of tag it was; nothing here assigns a provision type.
 *
 * Four tag kinds occur in the corpus:
 *  - `callout`  -- a blockquote opening `**Title (normative).**` (concepts pages)
 *  - `heading`  -- a heading ending in `(normative)` (`### 6.4 Honoring decisions (normative)`)
 *  - `lead_in`  -- a paragraph opening `**Title (normative).**` (§8.4's enforcement paragraph)
 *  - `citation` -- any other block carrying `(normative)`. In a pillar that is a
 *                  delegation of normative force to a concept page (§7, §8.4), the
 *                  `referenced_by` edges the source census declares; in
 *                  `concepts/README.md` it is the convention describing the tag itself.
 */
import { classifyBlocks, type Block } from "../markdown-blocks.ts";

export type NormativeTagKind = "callout" | "heading" | "lead_in" | "citation";

export interface NormativeTag {
  source: string;
  line: number;
  kind: NormativeTagKind;
  /** The bold title for callouts and lead-ins, the heading text for headings, empty for citations. */
  title: string;
  /** Whitespace-collapsed text of the tagged block, without the leading `>` or `#` markers. */
  text: string;
}

const TAGGED_TITLE = /^\s*\*\*(.+?)\s*\(normative\)\.?\*\*/;
const TAG = /\(normative\)/i;

export function calloutScan(source: string, text: string, blocks: Block[] = classifyBlocks(text)): NormativeTag[] {
  const tags: NormativeTag[] = [];
  for (const block of blocks) {
    if (block.type === "code_fence" || block.type === "thematic_break") continue;
    if (!TAG.test(block.text)) continue;
    const body = block.type === "blockquote" ? block.text.replace(/^\s{0,3}>\s?/gm, "") : block.text;
    const title = TAGGED_TITLE.exec(body)?.[1];
    if (block.type === "blockquote" && title !== undefined) {
      tags.push({ source, line: block.line, kind: "callout", title, text: collapse(body) });
    } else if (block.type === "heading") {
      tags.push({ source, line: block.line, kind: "heading", title: collapse(body.replace(/^\s{0,3}#+\s*/, "")), text: collapse(body) });
    } else if (title !== undefined) {
      tags.push({ source, line: block.line, kind: "lead_in", title, text: collapse(body) });
    } else {
      tags.push({ source, line: block.line, kind: "citation", title: "", text: collapse(body) });
    }
  }
  return tags;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
