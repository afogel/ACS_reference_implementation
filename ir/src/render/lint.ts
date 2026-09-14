/**
 * U9: lint failures by rule with `file:line`, then the V3 panels. What
 * `acs-ir lint` prints to the terminal.
 */
import type { LintReport } from "../lint/spec-lint.ts";
import { renderStale } from "./stale.ts";

export function renderLint(report: LintReport): string {
  const out: string[] = ["## Lint", ""];
  if (report.findings.length === 0) {
    out.push("No failures.");
  } else {
    const byRule = new Map<string, typeof report.findings>();
    for (const f of report.findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    out.push(`${report.findings.length} failure(s):`, "");
    for (const [rule, findings] of byRule) {
      out.push(`### ${rule}`, "");
      for (const f of findings) out.push(`- ${f.where ? `\`${f.where}\`: ` : ""}${f.message}`);
      out.push("");
    }
  }
  if (report.changed.length) {
    out.push("", `Provisions whose text differs from the baseline: ${report.changed.map((c) => `${c.id} (${c.source_file}:${c.line})`).join(", ")}.`);
  }
  out.push("", renderStale({ stale: report.stale, worklist: report.worklist }).trimEnd());
  return out.join("\n") + "\n";
}
