/**
 * N22: `lintMarkerPairing()` -- pulled forward from V4 (slices doc, X3).
 *
 * X3 made the terminator mandatory. That rule is only safe to rely on if
 * an anchor without a terminator, a terminator without an anchor, a
 * mismatched pair, or a nested span cannot ship silently, so this lint
 * runs on the marked corpus before anything is extracted from it. It is
 * also the reader the extractor uses: a well-formed file yields one span
 * per pair, with the text boundaries the markers state (E2.2).
 */
import { ANCHOR_PATTERN, anchorToId } from "../ids.ts";

export interface MarkedSpan {
  id: string;
  /** Offset in the marked text of the anchor's first character. */
  anchor: number;
  /** Offset of the first character of provision text (just after the anchor). */
  start: number;
  /** Offset one past the last character of provision text (just before the terminator). */
  end: number;
}

export interface PairingResult {
  source: string;
  spans: MarkedSpan[];
  problems: string[];
}

const TOKEN = /<a id="(acs-(?:req|def|inv|exc)-\d{4})"><\/a>|<!--\/(acs-(?:req|def|inv|exc)-\d{4})-->/g;

export function lintMarkerPairing(source: string, marked: string): PairingResult {
  const spans: MarkedSpan[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let open: { id: string; anchor: number; start: number } | null = null;
  const where = (offset: number): string => `${source}:${marked.slice(0, offset).split("\n").length}`;

  for (const match of marked.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    const anchorId = match[1];
    const terminatorId = match[2];
    if (anchorId !== undefined) {
      if (!ANCHOR_PATTERN.test(anchorId)) continue;
      const id = anchorToId(anchorId);
      if (seen.has(id)) problems.push(`${where(at)}: ${id} anchored more than once`);
      seen.add(id);
      if (open) {
        problems.push(`${where(at)}: ${id} opens inside ${open.id}; spans must not nest`);
        continue;
      }
      open = { id, anchor: at, start: at + match[0].length };
      continue;
    }
    if (terminatorId !== undefined) {
      const id = anchorToId(terminatorId);
      if (!open) {
        problems.push(`${where(at)}: terminator for ${id} with no open anchor`);
        continue;
      }
      if (open.id !== id) {
        problems.push(`${where(at)}: terminator for ${id} closes ${open.id}; the pair must carry one ID`);
        continue;
      }
      spans.push({ id, anchor: open.anchor, start: open.start, end: at });
      open = null;
    }
  }
  if (open) problems.push(`${where(open.anchor)}: ${open.id} has no terminator`);
  return { source, spans, problems };
}
