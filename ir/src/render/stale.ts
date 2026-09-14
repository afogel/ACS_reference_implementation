/**
 * U10: the stale-provision list -- ID, why, what it invalidated -- and
 * U32: the migration worklist. Printed by `acs-ir lint`.
 */
import type { StaleEntry, StaleReason, StalenessReport, WorklistEntry } from "../catalog/staleness.ts";

export function renderStale(report: StalenessReport): string {
  const out = ["## Provisions needing review", ""];
  if (report.stale.length === 0) {
    out.push("None. Every record is reviewed against the text its provision currently carries.");
  } else {
    out.push(`${report.stale.length} provision(s) need review. Nothing is invalid: classify each change as editorial, semantic, or split, then update \`reviewed_against\` or issue new IDs.`, "");
    for (const entry of report.stale) out.push(...renderEntry(entry));
  }
  out.push("", ...renderWorklist(report.worklist));
  return out.join("\n") + "\n";
}

function renderEntry(entry: StaleEntry): string[] {
  const lines = [`- **${entry.id}** (\`${entry.source_file}:${entry.line}\`)`];
  for (const reason of entry.reasons) lines.push(`  - ${describe(reason)}`);
  lines.push(`  - invalidates: ${entry.invalidates.length ? entry.invalidates.join(", ") : "nothing downstream"}`);
  lines.push(`  - tests citing it: ${entry.tests.length ? entry.tests.join(", ") : "none (conformance tests arrive in V5)"}`);
  return lines;
}

function describe(reason: StaleReason): string {
  switch (reason.kind) {
    case "text_changed":
      return `its text changed: reviewed against \`${reason.reviewed_against.slice(0, 12)}\`, now \`${reason.text_hash.slice(0, 12)}\``;
    case "dependency_stale":
      return `it depends on ${reason.via}, which needs review`;
    case "restatement_diverged":
      return `it restates ${reason.canonical}, whose canonical text changed; the concept page wins`;
  }
}

export function renderWorklist(worklist: WorklistEntry[]): string[] {
  const lines = ["## Migration worklist", ""];
  if (worklist.length === 0) {
    lines.push("No inline pillar copies await replacement by a reference to their concept page.");
    return lines;
  }
  lines.push(
    `${worklist.length} inline pillar cop${worklist.length === 1 ? "y still restates" : "ies still restate"} a concept-page provision (concepts/README.md:33 promises to replace these with references):`,
    "",
    "| pillar copy | at | restates | canonical page |",
    "|---|---|---|---|",
  );
  for (const w of worklist) lines.push(`| ${w.pillar} | ${w.pillar_source}:${w.pillar_line} | ${w.canonical} | ${w.canonical_source} |`);
  return lines;
}
