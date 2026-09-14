/**
 * N51: `renderConformanceReport()` -- P3, the W3C-style conformance report.
 *
 * U11 the verdict summary, U16 the profile-scoped summary (obligations
 * active per claimed profile, met and unmet), U15 one row per provision,
 * U17 evidence for every failure (subject, witness, witnessing facts),
 * U18 the non-testable roster and U34 the exclusion roster, printed rather
 * than omitted, plus the two rosters this verifier adds: what it was not
 * given the facts to evaluate, and what the session never activated. A
 * report that hides what it could not check overstates its coverage.
 */
import type { ProvisionVerdict, Verdict } from "../verify/verdicts.ts";

export interface ReportInput {
  corpus: { version: string | null; commit: string | null };
  trace: string;
  sessions: { session: string; profiles: string[]; negotiated_version: string | null }[];
  negotiated: string[];
  available: string[];
  verdicts: ProvisionVerdict[];
}

const ORDER: Verdict[] = ["fail", "pass", "unevaluated", "not-exercised", "not-activated", "permission", "non-testable", "inexpressible", "exclusion", "invariant", "definition"];

export function renderConformanceReport(input: ReportInput): string {
  const counts = new Map<Verdict, number>();
  for (const v of input.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const review = input.verdicts.filter((v) => v.needs_review).length;
  const out: string[] = [
    `# ACS conformance report`,
    "",
    `ACS ${input.corpus.version ?? "?"} at \`${input.corpus.commit?.slice(0, 7) ?? "unknown"}\`. Trace: \`${input.trace}\`.`,
    "",
    `Sessions: ${input.sessions.length ? input.sessions.map((s) => `\`${s.session}\` (${s.profiles.join(", ")}${s.negotiated_version ? `, ${s.negotiated_version}` : ""})`).join("; ") : "none"}.`,
    `Negotiated profiles: ${input.negotiated.join(", ")}. External facts available: ${input.available.length ? input.available.join(", ") : "none beyond the wire"}.`,
    "",
    "## Summary",
    "",
    ORDER.filter((k) => counts.has(k))
      .map((k) => `${k} ${counts.get(k)}`)
      .join(", ") + (review ? `; ${review} needs-review` : "") + ".",
    "",
    "## Obligations per claimed profile",
    "",
    "| profile | active obligations | met | unmet | unevaluated |",
    "|---|---|---|---|---|",
  ];
  for (const profile of input.negotiated) {
    const active = input.verdicts.filter((v) => v.type === "Requirement" && (v.profile === "all" || v.profile.includes(profile)) && ["pass", "fail", "unevaluated", "not-exercised"].includes(v.verdict));
    const met = active.filter((v) => v.verdict === "pass" || v.verdict === "not-exercised").length;
    const unmet = active.filter((v) => v.verdict === "fail").length;
    const unevaluated = active.filter((v) => v.verdict === "unevaluated").length;
    out.push(`| ${profile} | ${active.length} | ${met} | ${unmet} | ${unevaluated} |`);
  }
  out.push("", "## Verdicts", "", "| provision | verdict | level | actor | profile | reason |", "|---|---|---|---|---|---|");
  for (const v of [...input.verdicts].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.id.localeCompare(b.id))) {
    out.push(`| ${v.id} ${v.title} | ${v.verdict}${v.needs_review ? " (needs-review)" : ""} | ${v.level ?? "—"} | ${v.actor} | ${v.profile === "all" ? "all" : v.profile.join(", ")} | ${(v.reason ?? "").replace(/\|/g, "\\|")} |`);
  }
  const failures = input.verdicts.filter((v) => v.verdict === "fail");
  out.push("", "## Evidence", "");
  if (failures.length === 0) out.push("No violations.");
  for (const v of failures) {
    out.push(`### ${v.id}: ${v.title}`, "", `${v.evidence.length} violation(s).`, "");
    for (const e of v.evidence) {
      out.push(`- subject ${e.subject.map((s) => `${s.name}=${s.value}`).join(", ")}; witness ${e.witness.map((w) => `${w.name}=${w.value}`).join(", ")}`);
      for (const f of e.facts) out.push(`  - ${f.relation}(${f.tuple.join(", ")})`);
    }
    out.push("");
  }
  out.push(...roster("Not evaluated: facts the verifier was not given", input.verdicts.filter((v) => v.verdict === "unevaluated"), (v) => `needs ${v.missing.join(", ")}`));
  out.push(...roster("Not activated by the negotiated profiles", input.verdicts.filter((v) => v.verdict === "not-activated")));
  out.push(...roster("Non-testable roster", input.verdicts.filter((v) => v.verdict === "non-testable" || v.verdict === "inexpressible")));
  out.push(...roster("Exclusion roster: ACS deliberately requires nothing here", input.verdicts.filter((v) => v.verdict === "exclusion")));
  out.push(...roster("Permissions: no obligation from non-exercise", input.verdicts.filter((v) => v.verdict === "permission" || v.verdict === "not-exercised")));
  return out.join("\n") + "\n";
}

function roster(title: string, items: ProvisionVerdict[], detail: (v: ProvisionVerdict) => string = (v) => v.reason ?? ""): string[] {
  const lines = [`## ${title}`, ""];
  if (items.length === 0) lines.push("None.");
  for (const v of items) lines.push(`- ${v.id} ${v.title}: ${detail(v)}`);
  lines.push("");
  return lines;
}
