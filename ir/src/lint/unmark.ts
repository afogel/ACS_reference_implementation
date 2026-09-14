/**
 * The marked corpus, read back as prose plus spans.
 *
 * Once markers live upstream, the corpus the census scans is the marked
 * one. Markers add no keywords (an anchor has none, a terminator is a
 * comment the scanner masks) and no lines, but they do occupy characters,
 * so a context window taken from marked text would differ from one taken
 * from the same prose unmarked, and the lint's "is this occurrence new?"
 * comparison against the committed census would misfire. `unmark()` strips
 * the markers and re-bases each span's offsets onto the stripped text, so
 * the census sees exactly what an editor wrote.
 */
import type { ResolvedSpan } from "../markers/overlay.ts";
import { lintMarkerPairing, type PairingResult } from "./marker-pairing.ts";

const MARKER = /<a id="acs-(?:req|def|inv|exc)-\d{4}"><\/a>|<!--\/acs-(?:req|def|inv|exc)-\d{4}-->/g;

export interface Unmarked {
  text: string;
  spans: ResolvedSpan[];
  pairing: PairingResult;
}

export function unmark(source: string, marked: string): Unmarked {
  const pairing = lintMarkerPairing(source, marked);
  // Cumulative marker length before each offset, so a marked offset maps to a stripped one.
  const removals: { at: number; length: number }[] = [];
  for (const m of marked.matchAll(MARKER)) removals.push({ at: m.index ?? 0, length: m[0].length });
  const rebase = (offset: number): number => {
    let removed = 0;
    for (const r of removals) {
      if (r.at + r.length <= offset) removed += r.length;
      else break;
    }
    return offset - removed;
  };
  const text = marked.replace(MARKER, "");
  const spans = pairing.spans.map((s) => ({ id: s.id, source, start: rebase(s.start), end: rebase(s.end) }));
  return { text, spans, pairing };
}
