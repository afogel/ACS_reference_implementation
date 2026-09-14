/**
 * N12: `provisionCensus()` -- per source, counts by node type, plus every
 * keyword occurrence and what became of it.
 *
 * R1.3 and R1.6: every RFC 2119 occurrence in the corpus ends up in exactly
 * one of three states -- bound to a provision ID, excluded with a
 * machine-readable reason, or unbound. Nothing is dropped. In V1 nothing is
 * bound yet, so the census is the complete burn-down list: an occurrence in
 * a normative source is `unbound`, and one in a source the census declares
 * informative or editorial is `excluded` with that source status as the
 * reason. Later slices add the finer exclusions X3 found necessary
 * (`restatement_of`). An occurrence inside a resolved marker span is bound
 * to that provision, which is how the unbound count burns down.
 *
 * `by_node_type` is carried per source from V1 so the shape of the report
 * does not change when V2 starts filling it.
 */
import type { Corpus } from "../corpus.ts";
import type { BlockType } from "../markdown-blocks.ts";
import { calloutScan, type NormativeTag } from "./callout-scan.ts";
import { keywordScan, RFC2119_KEYWORDS, type Keyword, type Occurrence } from "./keyword-scan.ts";
import { seedDependsOn, type FooterEdge } from "./seed-depends-on.ts";
import type { SourceDeclaration, SourceStatus } from "./source-census.ts";
import type { ResolvedSpan } from "../markers/overlay.ts";
import type { ResolvedExclusion } from "./exclusions.ts";

export type ExclusionReason = "informative_source" | "editorial_source" | "restatement_of" | "mention" | "roadmap" | "rationale";

export type Binding =
  | { kind: "unbound" }
  | { kind: "excluded"; reason: ExclusionReason; of?: string }
  | { kind: "bound"; provision_id: string };

export interface OccurrenceRow extends Occurrence {
  binding: Binding;
}

export interface NodeTypeCounts {
  requirement: number;
  definition: number;
  invariant: number;
  exclusion: number;
}

export interface PerSourceCensus {
  path: string;
  status: SourceStatus;
  occurrences: number;
  by_block_type: Record<BlockType, number>;
  by_node_type: NodeTypeCounts;
  bound: number;
  excluded: number;
  unbound: number;
  normative_tags: number;
  footer_entries: number;
}

export interface DependencyAudit {
  /** Pillar entries in `Referenced by` footers with no provision depending back. All of them, until V2. */
  entries_without_depending_provision: number;
  /** Concept pages declared normative that carry no `Referenced by` footer. */
  pages_without_footer: string[];
  /** Footer links whose target document is not in the corpus. */
  dangling_targets: { from: string; line: number; doc: string }[];
}

export interface ProvisionCensus {
  corpus: { version: string | null; commit: string | null; documents: number };
  totals: {
    occurrences: number;
    by_keyword: Record<Keyword, number>;
    by_block_type: Record<BlockType, number>;
    blocks_with_keywords: number;
    masked: number;
    bound: number;
    excluded: number;
    unbound: number;
  };
  sources: PerSourceCensus[];
  normative_tags: NormativeTag[];
  dependency_edges: FooterEdge[];
  dependency_audit: DependencyAudit;
  occurrences: OccurrenceRow[];
  /** Exclusion entries that did not cover exactly one occurrence: an authoring error the census refuses to hide. */
  exclusion_problems: string[];
}

const BLOCK_TYPES: BlockType[] = ["paragraph", "list_item", "table_cell", "blockquote", "heading", "code_fence", "thematic_break"];

export function provisionCensus(
  corpus: Corpus,
  declared: SourceDeclaration[],
  read: (file: string) => string,
  spans: ResolvedSpan[] = [],
  exclusions: ResolvedExclusion[] = [],
): ProvisionCensus {
  const byPath = new Map(declared.map((d) => [d.path, d]));
  const spansBySource = new Map<string, ResolvedSpan[]>();
  for (const span of spans) spansBySource.set(span.source, [...(spansBySource.get(span.source) ?? []), span]);
  const exclusionsBySource = new Map<string, ResolvedExclusion[]>();
  for (const x of exclusions) exclusionsBySource.set(x.source, [...(exclusionsBySource.get(x.source) ?? []), x]);
  const covered = new Map<ResolvedExclusion, number>();
  const exists = (doc: string): boolean => corpus.files.includes(doc);

  const sources: PerSourceCensus[] = [];
  const tags: NormativeTag[] = [];
  const edges: FooterEdge[] = [];
  const rows: OccurrenceRow[] = [];
  const pagesWithoutFooter: string[] = [];
  let blocksWithKeywords = 0;
  let masked = 0;

  for (const file of corpus.files) {
    const declaration = byPath.get(file);
    if (!declaration) continue; // sourceCensus() already reported it; the census as a whole fails.
    const text = read(file);
    const scan = keywordScan(file, text);
    const fileTags = calloutScan(file, text);
    const footer = seedDependsOn(file, text, exists);

    blocksWithKeywords += scan.blocks_with_keywords;
    masked += scan.masked.length;
    tags.push(...fileTags);
    edges.push(...footer.edges);
    if (declaration.pillar === "concepts" && declaration.status === "normative" && !footer.has_footer) {
      pagesWithoutFooter.push(file);
    }

    const perSource: PerSourceCensus = {
      path: file,
      status: declaration.status,
      occurrences: scan.occurrences.length,
      by_block_type: zeroBlockTypes(),
      by_node_type: { requirement: 0, definition: 0, invariant: 0, exclusion: 0 },
      bound: 0,
      excluded: 0,
      unbound: 0,
      normative_tags: fileTags.length,
      footer_entries: footer.edges.length,
    };
    for (const occurrence of scan.occurrences) {
      const binding = bindingFor(declaration, occurrence.offset, spansBySource.get(file) ?? [], exclusionsBySource.get(file) ?? [], covered);
      perSource.by_block_type[occurrence.block_type]++;
      if (binding.kind === "excluded") perSource.excluded++;
      else if (binding.kind === "bound") perSource.bound++;
      else perSource.unbound++;
      rows.push({ ...occurrence, binding });
    }
    sources.push(perSource);
  }

  const totals = {
    occurrences: rows.length,
    by_keyword: zeroKeywords(),
    by_block_type: zeroBlockTypes(),
    blocks_with_keywords: blocksWithKeywords,
    masked,
    bound: 0,
    excluded: 0,
    unbound: 0,
  };
  for (const row of rows) {
    totals.by_keyword[row.keyword]++;
    totals.by_block_type[row.block_type]++;
    if (row.binding.kind === "bound") totals.bound++;
    else if (row.binding.kind === "excluded") totals.excluded++;
    else totals.unbound++;
  }

  const pillarEdges = edges.filter((e) => e.kind === "pillar");
  const dependency_audit: DependencyAudit = {
    entries_without_depending_provision: pillarEdges.length,
    pages_without_footer: pagesWithoutFooter,
    dangling_targets: edges.flatMap((e) =>
      e.targets.filter((t) => !t.external && !t.exists).map((t) => ({ from: e.from, line: e.line, doc: t.doc })),
    ),
  };

  const exclusion_problems = exclusions
    .filter((x) => (covered.get(x) ?? 0) !== 1)
    .map((x) => `exclusion in ${x.source} covers ${covered.get(x) ?? 0} keyword occurrence(s), not one: ${JSON.stringify(x.quote.slice(0, 60))}`);

  return {
    corpus: { version: corpus.version, commit: corpus.commit, documents: corpus.files.length },
    totals,
    sources,
    normative_tags: tags,
    dependency_edges: edges,
    dependency_audit,
    occurrences: rows,
    exclusion_problems,
  };
}

function bindingFor(
  declaration: SourceDeclaration,
  offset: number,
  spans: ResolvedSpan[],
  exclusions: ResolvedExclusion[],
  covered: Map<ResolvedExclusion, number>,
): Binding {
  const span = spans.find((s) => s.start <= offset && offset < s.end);
  if (span) return { kind: "bound", provision_id: span.id };
  const exclusion = exclusions.find((x) => x.start <= offset && offset < x.end);
  if (exclusion) {
    covered.set(exclusion, (covered.get(exclusion) ?? 0) + 1);
    return exclusion.of ? { kind: "excluded", reason: exclusion.reason, of: exclusion.of } : { kind: "excluded", reason: exclusion.reason };
  }
  if (declaration.status === "informative") return { kind: "excluded", reason: "informative_source" };
  if (declaration.status === "editorial") return { kind: "excluded", reason: "editorial_source" };
  return { kind: "unbound" };
}

function zeroBlockTypes(): Record<BlockType, number> {
  return Object.fromEntries(BLOCK_TYPES.map((t) => [t, 0])) as Record<BlockType, number>;
}

function zeroKeywords(): Record<Keyword, number> {
  return Object.fromEntries(RFC2119_KEYWORDS.map((k) => [k, 0])) as Record<Keyword, number>;
}
