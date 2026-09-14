/**
 * N27: `renderImpactComment()` -- the normative-impact comment a spec PR
 * gets (P5). Four sections, one per affordance: U22 changed provisions and
 * their now-stale tests, U23 added provisions with no test, U24 removed
 * provisions missing a tombstone, U25 unmarked normative statements with
 * `file:line`. Each section says "none" rather than disappearing, so the
 * absence of impact is stated, not implied.
 */
import type { LintReport } from "../lint/spec-lint.ts";

export const IMPACT_MARKER = "<!-- acs-ir-impact -->";

export function renderImpactComment(report: LintReport): string {
  const out = [
    IMPACT_MARKER,
    `## Normative impact (ACS ${report.corpus.version ?? "?"} at \`${report.corpus.commit?.slice(0, 7) ?? "unknown"}\`)`,
    "",
    report.ok ? "**No failures, nothing to review.**" : `**${report.findings.length} failure(s), ${report.stale.length} provision(s) to review.**`,
    "",
    "### Changed provisions and their tests (U22)",
    "",
  ];
  if (report.stale.length === 0) out.push("None.");
  else {
    out.push("| provision | why | invalidates | tests now needs-review |", "|---|---|---|---|");
    for (const s of report.stale) {
      const why = s.reasons
        .map((r) => (r.kind === "text_changed" ? "text changed" : r.kind === "dependency_stale" ? `depends on ${r.via}` : `restates ${r.canonical}`))
        .join("; ");
      out.push(`| ${s.id} (\`${s.source_file}:${s.line}\`) | ${why} | ${s.invalidates.join(", ") || "none"} | ${s.tests.join(", ") || "none"} |`);
    }
  }
  out.push("", "### Added provisions with no conformance test (U23)", "");
  out.push(report.added_without_test.length ? report.added_without_test.map((id) => `- ${id}`).join("\n") : "None.");
  out.push("", "### Removed provisions missing a tombstone (U24)", "");
  out.push(
    report.removed_without_tombstone.length
      ? report.removed_without_tombstone.map((id) => `- ${id}: add an entry to \`ir/ids/tombstones.yaml\` (R2.2)`).join("\n")
      : "None.",
  );
  out.push("", "### Unmarked normative statements (U25)", "");
  if (report.unmarked.length === 0) out.push("None.");
  else {
    out.push("| location | keyword | context |", "|---|---|---|");
    for (const u of report.unmarked) out.push(`| \`${u.source}:${u.line}:${u.column}\` | ${u.keyword} | ${u.context.replace(/\|/g, "\\|")} |`);
  }
  const other = report.findings.filter((f) => f.rule !== "unmarked-keyword" && f.rule !== "tombstone");
  if (other.length) {
    out.push("", "### Other lint failures", "");
    for (const f of other) out.push(`- ${f.rule}${f.where ? ` \`${f.where}\`` : ""}: ${f.message}`);
  }
  return out.join("\n") + "\n";
}
