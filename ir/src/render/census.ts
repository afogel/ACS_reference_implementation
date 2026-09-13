/**
 * N52: `renderCensus()` -- the census report for a terminal (P4).
 *
 * Four panels, each an affordance a spec editor can read without having
 * seen the IR (R1.9): the source census (U19), the provision census per
 * source (U20), the unbound-occurrence table (U21), and the dependency-edge
 * audit (U33). The migration worklist (U32) and exclusion roster (U34)
 * belong to V3 and V6; their panels are absent rather than empty, so no
 * reader mistakes a placeholder for a measurement.
 */
import type { ProvisionCensus } from "../census/provision-census.ts";
import type { SourceCensus } from "../census/source-census.ts";

export function renderCensus(sources: SourceCensus, census: ProvisionCensus | null): string {
  const out: string[] = [];
  out.push(...renderSourceCensus(sources));
  if (census) {
    out.push("", ...renderProvisionCensus(census), "", ...renderUnbound(census), "", ...renderEdgeAudit(census));
  }
  return out.join("\n") + "\n";
}

function renderSourceCensus(sources: SourceCensus): string[] {
  const lines = ["## Source census (U19)", ""];
  if (sources.problems.length > 0) {
    lines.push("The declaration and the corpus disagree. Fix `ir/census/sources.yaml`:", "");
    for (const p of sources.problems) lines.push(`- ${p}`);
    return lines;
  }
  const rows = sources.sources.map((s) => [
    s.path,
    s.status,
    s.normative_by ?? "",
    (s.referenced_by ?? []).join(", "),
  ]);
  lines.push(...table(["document", "status", "normative by", "referenced by"], rows));
  const counts = count(sources.sources.map((s) => s.status));
  lines.push("", `${sources.sources.length} documents declared: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
  return lines;
}

function renderProvisionCensus(census: ProvisionCensus): string[] {
  const t = census.totals;
  const lines = [
    `## Provision census (U20) -- ACS ${census.corpus.version ?? "?"} at ${census.corpus.commit?.slice(0, 7) ?? "unknown commit"}`,
    "",
    `${t.occurrences} RFC 2119 keyword occurrences in ${t.blocks_with_keywords} blocks across ${census.corpus.documents} documents; ${t.masked} inside inline code or comments.`,
    `By keyword: ${entries(t.by_keyword)}.`,
    `By block type: ${entries(t.by_block_type, true)}.`,
    `Bound ${t.bound}, excluded ${t.excluded}, unbound ${t.unbound}.`,
    "",
  ];
  const rows = census.sources
    .filter((s) => s.occurrences > 0 || s.normative_tags > 0 || s.footer_entries > 0)
    .map((s) => [
      s.path,
      s.status,
      String(s.occurrences),
      `${s.by_node_type.requirement}/${s.by_node_type.definition}/${s.by_node_type.invariant}/${s.by_node_type.exclusion}`,
      String(s.bound),
      String(s.excluded),
      String(s.unbound),
      String(s.normative_tags),
      String(s.footer_entries),
    ]);
  lines.push(...table(["source", "status", "occ.", "REQ/DEF/INV/EXC", "bound", "excl.", "unbound", "tags", "footer"], rows));
  lines.push("", `${census.normative_tags.length} normative tags:`);
  for (const tag of census.normative_tags) {
    lines.push(`- ${tag.source}:${tag.line} [${tag.kind}] ${tag.title || tag.text.slice(0, 96)}`);
  }
  return lines;
}

function renderUnbound(census: ProvisionCensus): string[] {
  const lines = ["## Unbound and excluded occurrences (U21)", ""];
  const rows = census.occurrences
    .filter((o) => o.binding.kind !== "bound")
    .map((o) => [
      `${o.source}:${o.line}:${o.column}`,
      o.keyword,
      o.block_type,
      o.binding.kind === "excluded" ? `excluded: ${o.binding.reason}` : "unbound",
      o.context,
    ]);
  lines.push(...table(["location", "keyword", "block", "binding", "context"], rows));
  return lines;
}

function renderEdgeAudit(census: ProvisionCensus): string[] {
  const audit = census.dependency_audit;
  const pillar = census.dependency_edges.filter((e) => e.kind === "pillar");
  const lines = [
    "## Dependency-edge audit (U33)",
    "",
    `${pillar.length} pillar entries in Referenced-by footers; ${audit.entries_without_depending_provision} with no provision depending back (provisions arrive in V2).`,
  ];
  if (audit.pages_without_footer.length) lines.push(`Concept pages without a footer: ${audit.pages_without_footer.join(", ")}.`);
  if (audit.dangling_targets.length) {
    lines.push("Footer links to documents not in the corpus:");
    for (const d of audit.dangling_targets) lines.push(`- ${d.from}:${d.line} -> ${d.doc}`);
  }
  lines.push("");
  lines.push(
    ...table(
      ["from", "pillar", "targets", "depending provisions"],
      pillar.map((e) => [
        `${e.from}:${e.line}`,
        e.pillar ?? "",
        e.targets.map((t) => (t.anchor ? `${t.doc}#${t.anchor}` : t.doc)).join(", "),
        "(none yet)",
      ]),
    ),
  );
  return lines;
}

function entries(record: Record<string, number>, dropZero = false): string {
  return Object.entries(record)
    .filter(([, v]) => !dropZero || v > 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

function count(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function table(header: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)];
}
