/**
 * E3: the staging overlay, and N1 / N2.
 *
 * Until markers land upstream, `ir/markers/overlay.yaml` says where each
 * provision's anchor and terminator go, by verbatim quote against the
 * pinned corpus. Quote matching is unsound as a steady state (it cannot
 * tell a reword from a semantic change) and sound here, because a pinned
 * corpus has zero drift (shaping doc, Fact 10). The day the bulk marker PR
 * merges, this file is deleted and the extractor reads the submodule
 * directly (E3.3); until then it is also the exact payload of that PR.
 *
 * An entry is `{id, source, quote}` for a provision that is one run of
 * text, or `{id, source, start, end}` for one that spans blocks (a stem
 * paragraph and its list, §8.2 and §9.2). `start` must occur exactly once
 * in the file, so a quote can never silently bind the wrong sentence; `end`
 * is the first occurrence at or after `start`. The anchor goes immediately
 * before `start` and the terminator immediately after `end`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Corpus } from "../corpus.ts";
import { ID_PATTERN, idToAnchor } from "../ids.ts";

export interface MarkerEntry {
  id: string;
  source: string;
  start: string;
  end: string;
}

export interface ResolvedSpan {
  id: string;
  source: string;
  /** 0-based offset of the first character of the provision text in the unmarked file. */
  start: number;
  /** 0-based offset one past the last character of the provision text. */
  end: number;
}

export function defaultMarkersDir(): string {
  return resolve(import.meta.dir, "..", "..", "markers");
}

export function defaultBuildDir(): string {
  return resolve(import.meta.dir, "..", "..", ".build");
}

export function parseOverlay(yamlText: string): MarkerEntry[] {
  const parsed = Bun.YAML.parse(yamlText) as { markers?: unknown };
  if (!Array.isArray(parsed?.markers)) throw new Error("overlay.yaml: expected a top-level `markers:` list");
  return parsed.markers.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`overlay.yaml: entry ${index + 1} must be a map`);
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
      throw new Error(`overlay.yaml: entry ${index + 1} needs an id of the form ACS-{REQ|DEF|INV|EXC}-NNNN`);
    }
    if (typeof entry.source !== "string") throw new Error(`overlay.yaml: ${entry.id} needs a source path`);
    if (typeof entry.quote === "string") {
      if (entry.start !== undefined || entry.end !== undefined) throw new Error(`overlay.yaml: ${entry.id} has quote and start/end; use one`);
      return { id: entry.id, source: entry.source, start: entry.quote, end: entry.quote };
    }
    if (typeof entry.start !== "string" || typeof entry.end !== "string") {
      throw new Error(`overlay.yaml: ${entry.id} needs either quote or both start and end`);
    }
    return { id: entry.id, source: entry.source, start: entry.start, end: entry.end };
  });
}

/** N2: locate one entry in its unmarked source. Throws when the quote does not identify exactly one place. */
export function resolveQuote(entry: MarkerEntry, text: string): ResolvedSpan {
  if (entry.start.length === 0 || entry.end.length === 0) throw new Error(`${entry.id}: empty quote`);
  const first = text.indexOf(entry.start);
  if (first === -1) throw new Error(`${entry.id}: start quote not found in ${entry.source}: ${excerpt(entry.start)}`);
  if (text.indexOf(entry.start, first + 1) !== -1) {
    throw new Error(`${entry.id}: start quote occurs more than once in ${entry.source}; lengthen it: ${excerpt(entry.start)}`);
  }
  const endAt = text.indexOf(entry.end, first);
  if (endAt === -1) throw new Error(`${entry.id}: end quote not found after start in ${entry.source}: ${excerpt(entry.end)}`);
  return { id: entry.id, source: entry.source, start: first, end: endAt + entry.end.length };
}

export interface OverlayResolution {
  spans: ResolvedSpan[];
  problems: string[];
}

/** Resolve every entry, then reject anything two entries would both claim: nested or overlapping spans are lint failures (E9.6). */
export function resolveOverlay(entries: MarkerEntry[], read: (source: string) => string | null): OverlayResolution {
  const spans: ResolvedSpan[] = [];
  const problems: string[] = [];
  const texts = new Map<string, string | null>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`${entry.id}: appears more than once in the overlay`);
    ids.add(entry.id);
    if (!texts.has(entry.source)) texts.set(entry.source, read(entry.source));
    const text = texts.get(entry.source) ?? null;
    if (text === null) {
      problems.push(`${entry.id}: source ${entry.source} is not in the corpus`);
      continue;
    }
    try {
      spans.push(resolveQuote(entry, text));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const a of spans) {
    for (const b of spans) {
      if (a === b || a.source !== b.source || a.id > b.id) continue;
      if (a.start < b.end && b.start < a.end) problems.push(`${a.id} and ${b.id} overlap in ${a.source}; spans must not nest or cross`);
    }
  }
  return { spans, problems };
}

export function anchorFor(id: string): string {
  return `<a id="${idToAnchor(id)}"></a>`;
}

export function terminatorFor(id: string): string {
  return `<!--/${idToAnchor(id)}-->`;
}

/** Insert every span's anchor and terminator into one file's text. Applied back to front so earlier offsets stay valid. */
export function markText(text: string, spans: ResolvedSpan[]): string {
  const edits = spans
    .flatMap((s) => [
      { at: s.end, insert: terminatorFor(s.id), order: 0 },
      { at: s.start, insert: anchorFor(s.id), order: 1 },
    ])
    .sort((a, b) => b.at - a.at || a.order - b.order);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.at) + edit.insert + out.slice(edit.at);
  return out;
}

/** N1: materialize the marked corpus (S3). Every corpus file is written, marked where the overlay says so, so the extractor reads one tree. */
export function applyOverlay(corpus: Corpus, spans: ResolvedSpan[], read: (file: string) => string, outDir: string): string[] {
  const bySource = new Map<string, ResolvedSpan[]>();
  for (const span of spans) bySource.set(span.source, [...(bySource.get(span.source) ?? []), span]);
  const written: string[] = [];
  for (const file of corpus.files) {
    const target = join(outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markText(read(file), bySource.get(file) ?? []));
    written.push(file);
  }
  return written;
}

function excerpt(quote: string): string {
  const flat = quote.replace(/\s+/g, " ");
  return JSON.stringify(flat.length > 72 ? `${flat.slice(0, 69)}...` : flat);
}
