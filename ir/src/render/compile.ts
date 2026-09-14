/**
 * The compile summary (per provision: compiled, alias, permission,
 * non-testable, inexpressible, no-predicate) and U31, the differential
 * divergence report: provision, fixture, and the tuples only one engine derived.
 */
import type { RuleProgram } from "../compile/compile.ts";
import type { DifferentialReport } from "../verify/differential.ts";

export function renderCompile(program: RuleProgram): string {
  const out = ["## Compile", ""];
  const counts = new Map<string, number>();
  for (const p of program.provisions) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  out.push(`${program.provisions.length} provisions: ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}.`, "");
  out.push("| provision | status | subject | witness | external facts | detail |", "|---|---|---|---|---|---|");
  for (const p of program.provisions) {
    out.push(
      `| ${p.id} | ${p.status} | ${p.subject.join(", ")} | ${p.witness.join(", ")} | ${p.external_facts.map((e) => `${e.relation} (${e.source})`).join(", ")} | ${p.reason ?? ""}${p.alias_of ? ` ${p.alias_of}` : ""} |`,
    );
  }
  if (program.problems.length) {
    out.push("", "### Predicates that did not compile", "");
    for (const p of program.problems) out.push(`- ${p.message}`);
  }
  return out.join("\n") + "\n";
}

export function renderDifferential(report: DifferentialReport): string {
  const out = ["## Differential (U31)", "", report.souffle ? `Soufflé: ${report.souffle}` : "Soufflé: not available; evaluator checked against expectations only.", ""];
  for (const f of report.fixtures) {
    out.push(`### ${f.fixture}: ${f.ok ? "agree" : "DIVERGE"} (evaluator ${f.evaluator.length}, expected ${f.expected.length}${f.souffle ? `, souffle ${f.souffle.length}` : ""})`);
    const rows: string[] = [];
    for (const t of f.evaluator_vs_expected.only_evaluator) rows.push(`- only the evaluator, not expected: ${t}`);
    for (const t of f.evaluator_vs_expected.only_expected) rows.push(`- expected, not derived by the evaluator: ${t}`);
    for (const t of f.evaluator_vs_souffle?.only_evaluator ?? []) rows.push(`- only the evaluator, not Soufflé: ${t}`);
    for (const t of f.evaluator_vs_souffle?.only_souffle ?? []) rows.push(`- only Soufflé, not the evaluator: ${t}`);
    out.push(...rows, "");
  }
  return out.join("\n") + "\n";
}
