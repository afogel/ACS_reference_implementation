/**
 * E8.2: authored census exclusions.
 *
 * X3 found that an occurrence count is an upper bound on provisions, not a
 * count: the spec restates rules inside their own parentheticals, mentions
 * keywords ("promote PQC to RECOMMENDED"), and describes roadmap
 * intent in normative sources. `ir/census/exclusions.yaml` names each such
 * occurrence by a verbatim quote that contains exactly one keyword
 * occurrence, with a machine-readable reason, so R1.6 holds: every
 * occurrence is bound, excluded with a reason, or unbound, and no
 * occurrence is dropped. A quote that no longer resolves, or that spans more
 * than one occurrence, fails the census.
 *
 * Reasons:
 *   restatement_of   the same obligation, restated in a parenthetical or a
 *                    summary; `of` names the provision that carries it
 *   mention          the keyword is mentioned, not used ("expected to
 *                    promote X to RECOMMENDED")
 *   roadmap          intent for a future version, in a normative source
 *   rationale        explanatory prose about why a rule exists, in which
 *                    a keyword recurs without adding an obligation
 */
import { ID_PATTERN } from "../ids.ts";

export type ExclusionReason = "restatement_of" | "mention" | "roadmap" | "rationale";

export interface ExclusionEntry {
  source: string;
  quote: string;
  reason: ExclusionReason;
  of: string | null;
  note: string | null;
}

export interface ResolvedExclusion extends ExclusionEntry {
  /** Character offsets of the quote in the unmarked source. */
  start: number;
  end: number;
}

const REASONS: ReadonlySet<string> = new Set(["restatement_of", "mention", "roadmap", "rationale"]);

export function parseExclusions(yamlText: string): ExclusionEntry[] {
  const parsed = Bun.YAML.parse(yamlText) as { exclusions?: unknown };
  if (!Array.isArray(parsed?.exclusions)) throw new Error("exclusions.yaml: expected a top-level `exclusions:` list");
  return parsed.exclusions.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`exclusions.yaml: entry ${i + 1} must be a map`);
    const e = raw as Record<string, unknown>;
    if (typeof e.source !== "string" || typeof e.quote !== "string" || e.quote.length === 0) throw new Error(`exclusions.yaml: entry ${i + 1} needs source and quote`);
    if (typeof e.reason !== "string" || !REASONS.has(e.reason)) throw new Error(`exclusions.yaml: entry ${i + 1}: reason must be restatement_of | mention | roadmap | rationale`);
    const of = typeof e.of === "string" ? e.of : null;
    if (e.reason === "restatement_of" && (!of || !ID_PATTERN.test(of))) throw new Error(`exclusions.yaml: entry ${i + 1}: restatement_of needs \`of: <provision ID>\``);
    if (e.reason !== "restatement_of" && of) throw new Error(`exclusions.yaml: entry ${i + 1}: only restatement_of takes \`of\``);
    return { source: e.source, quote: e.quote, reason: e.reason as ExclusionReason, of, note: typeof e.note === "string" ? e.note : null };
  });
}

/** Locate each exclusion in its source; every failure is a census problem. */
export function resolveExclusions(entries: ExclusionEntry[], read: (source: string) => string | null): { exclusions: ResolvedExclusion[]; problems: string[] } {
  const exclusions: ResolvedExclusion[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const text = read(entry.source);
    if (text === null) {
      problems.push(`exclusion in ${entry.source}: source is not in the corpus`);
      continue;
    }
    const first = text.indexOf(entry.quote);
    if (first === -1) {
      problems.push(`exclusion in ${entry.source}: quote not found: ${JSON.stringify(entry.quote.slice(0, 60))}`);
      continue;
    }
    if (text.indexOf(entry.quote, first + 1) !== -1) {
      problems.push(`exclusion in ${entry.source}: quote occurs more than once; lengthen it: ${JSON.stringify(entry.quote.slice(0, 60))}`);
      continue;
    }
    exclusions.push({ ...entry, start: first, end: first + entry.quote.length });
  }
  return { exclusions, problems };
}
