/**
 * E4: the generated manifest. N4 `extractProvisions()`, N5 `readSpan()`,
 * N6 `hashText()`.
 *
 * Walks the marked corpus (S3), reads each anchor-to-terminator span, and
 * emits the mechanical half of every provision: `id`, `type`,
 * `source_file`, `line`, `block_type`, `section_slug`, `level`, `text`,
 * `text_hash`. Written to `ir/manifest/provisions.json` and never
 * hand-edited (E4.2); the authored half lives in `ir/provisions/` and the
 * two meet only in the catalog join (N15).
 *
 * `section_slug` is informational and regenerated, never a key (Fact 1:
 * section numbers move). It follows Python-Markdown's slugify so it equals
 * the anchor MkDocs publishes for the same heading.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyBlocks, lineStarts, locateOffset, type BlockType } from "../markdown-blocks.ts";
import { maskSpans, RFC2119_KEYWORDS, type Keyword } from "../census/keyword-scan.ts";
import { nodeType, parseId, type NodeType } from "../ids.ts";
import { lintMarkerPairing, type MarkedSpan } from "../lint/marker-pairing.ts";

export interface ManifestEntry {
  id: string;
  type: NodeType;
  source_file: string;
  /** 1-based line of the anchor in the unmarked source (markers occupy no lines of their own). */
  line: number;
  block_type: BlockType;
  section_slug: string | null;
  /** The first RFC 2119 keyword in the span, or null for keyword-free provisions (definitions, table-borne rules). */
  level: Keyword | null;
  /** Every RFC 2119 keyword in the span, in order. */
  keywords: Keyword[];
  /** The span's text, verbatim, trimmed. */
  text: string;
  /** SHA-256 over the whitespace-normalized text: what `reviewed_against` pins and staleness compares. */
  text_hash: string;
}

export interface Manifest {
  generated_by: string;
  corpus: { version: string | null; commit: string | null };
  provisions: ManifestEntry[];
}

export interface Extraction {
  manifest: Manifest;
  problems: string[];
}

export function defaultManifestPath(): string {
  return resolve(import.meta.dir, "..", "..", "manifest", "provisions.json");
}

const KEYWORD = new RegExp(`\\b(${RFC2119_KEYWORDS.join("|")})\\b`, "g");

export function extractProvisions(
  markedDir: string,
  files: string[],
  corpus: { version: string | null; commit: string | null },
): Extraction {
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const path = join(markedDir, file);
    if (!existsSync(path)) {
      problems.push(`${file}: missing from the marked corpus; run \`acs-ir markers apply\``);
      continue;
    }
    const marked = readFileSync(path, "utf8");
    const pairing = lintMarkerPairing(file, marked);
    problems.push(...pairing.problems);
    if (pairing.problems.length > 0) continue;
    for (const span of pairing.spans) {
      if (ids.has(span.id)) problems.push(`${span.id}: anchored in more than one file`);
      ids.add(span.id);
      entries.push(readSpan(file, marked, span));
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { manifest: { generated_by: "acs-ir extract", corpus, provisions: entries }, problems };
}

/** N5: one provision from one well-formed pair, across any of the four block types. */
export function readSpan(file: string, marked: string, span: MarkedSpan): ManifestEntry {
  const parsed = parseId(span.id);
  if (!parsed) throw new Error(`${span.id}: not a provision ID`);
  const text = marked.slice(span.start, span.end).trim();
  const visible = maskSpans(text);
  const keywords = Array.from(visible.matchAll(KEYWORD), (m) => m[1] as Keyword);
  const blocks = classifyBlocks(marked);
  const block = blocks.find((b) => b.start <= span.anchor && span.anchor < b.start + b.text.length + 1);
  const starts = lineStarts(marked);
  return {
    id: span.id,
    type: nodeType(parsed.type),
    source_file: file,
    line: unmarkedLine(marked, span.anchor, starts),
    block_type: block?.type ?? "paragraph",
    section_slug: sectionSlug(marked, span.anchor),
    level: keywords[0] ?? null,
    keywords,
    text,
    text_hash: hashText(text),
  };
}

/** N6: whitespace-normalized SHA-256, so a reflowed paragraph is not a change and a reworded one is. */
export function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

/** Python-Markdown's `slugify`, which is what MkDocs uses for heading anchors. */
export function slugify(heading: string): string {
  return heading
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

function sectionSlug(marked: string, offset: number): string | null {
  const before = marked.slice(0, offset).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(before[i] ?? "");
    if (m) return slugify(stripMarkers(m[1] ?? ""));
  }
  return null;
}

function unmarkedLine(marked: string, offset: number, starts: number[]): number {
  return locateOffset(starts, offset).line;
}

function stripMarkers(text: string): string {
  return text.replace(/<a id="[^"]*"><\/a>|<!--\/[^>]*-->/g, "");
}
