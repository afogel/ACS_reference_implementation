/**
 * N27: `renderImpactComment()` -- the normative-impact comment a spec PR
 * gets (P5).
 *
 * The comment leads with one or two sentences a reviewer can act on: how
 * many rules were added without a test, how many provisions changed and
 * how many tests that puts under review, what was removed without a
 * tombstone, what normative text is unmarked. Each non-empty section
 * follows as a collapsible table with the provision's title, actor and
 * place in the spec, opened when it is short and collapsed when it is
 * long. Empty sections are not rendered; when nothing happened the whole
 * comment is the one sentence saying so.
 */
import type { LintReport } from "../lint/spec-lint.ts";

export const IMPACT_MARKER = "<!-- acs-ir-impact -->";

/** Tables up to this many rows open by default; longer ones start collapsed. */
const OPEN_UP_TO = 10;

export function renderImpactComment(report: LintReport): string {
  const out = [IMPACT_MARKER, `## Normative impact (ACS ${report.corpus.version ?? "?"} at \`${report.corpus.commit?.slice(0, 7) ?? "unknown"}\`)`, "", summary(report)];
  const where = (file: string, line: number): string => {
    const label = `${file.split("/").pop()}:${line}`;
    return report.spec_url ? `[${label}](${report.spec_url}/${file}#L${line})` : `\`${label}\``;
  };
  const title = (id: string): string => report.titles[id] ?? "";

  if (report.added_without_test.length) {
    out.push(
      ...section(
        `Added without a conformance test (${report.added_without_test.length})`,
        report.added_without_test.length,
        ["| provision | title | actor | where |", "|---|---|---|---|", ...report.added_without_test.map((a) => `| ${a.id} | ${cell(a.title)} | ${a.actor} | ${where(a.source_file, a.line)} |`)],
      ),
    );
  }
  if (report.added_untestable.length) {
    const counts = new Map<string, number>();
    for (const a of report.added_untestable) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    const breakdown = [...counts.entries()]
      .sort(([a], [b]) => reasonOrder(a) - reasonOrder(b))
      .map(([status, n]) => `${n} ${plural(n, status)}`)
      .join(", ");
    out.push(
      ...section(
        `Added, no test possible (${report.added_untestable.length}: ${breakdown})`,
        report.added_untestable.length,
        ["| provision | title | why no test |", "|---|---|---|", ...report.added_untestable.map((a) => `| ${a.id} | ${cell(a.title)} | ${a.status} |`)],
      ),
    );
  }
  if (report.stale.length) {
    out.push(
      ...section(`Changed provisions and the tests now under review (${report.stale.length})`, report.stale.length, [
        "| provision | title | why | invalidates | tests to review | where |",
        "|---|---|---|---|---|---|",
        ...report.stale.map((s) => {
          const why = s.reasons
            .map((r) => (r.kind === "text_changed" ? "text changed" : r.kind === "dependency_stale" ? `depends on ${r.via}` : `restates ${r.canonical}`))
            .join("; ");
          return `| ${s.id} | ${cell(title(s.id))} | ${why} | ${s.invalidates.join(", ") || "none"} | ${s.tests.join(", ") || "none"} | ${where(s.source_file, s.line)} |`;
        }),
      ]),
    );
  }
  if (report.removed_without_tombstone.length) {
    out.push(
      ...section(
        `Removed without a tombstone (${report.removed_without_tombstone.length})`,
        report.removed_without_tombstone.length,
        report.removed_without_tombstone.map((id) => `- ${id}${title(id) ? ` ${title(id)}` : ""}: add an entry to \`ir/ids/tombstones.yaml\``),
      ),
    );
  }
  if (report.unmarked.length) {
    out.push(
      ...section(`Unmarked normative statements (${report.unmarked.length})`, report.unmarked.length, [
        "| where | keyword | context |",
        "|---|---|---|",
        ...report.unmarked.map((u) => `| ${where(u.source, u.line)} | ${u.keyword} | ${cell(u.context)} |`),
      ]),
    );
  }
  const other = report.findings.filter((f) => f.rule !== "unmarked-keyword" && f.rule !== "tombstone");
  if (other.length) {
    out.push(...section(`Other lint failures (${other.length})`, other.length, other.map((f) => `- ${f.rule}${f.where ? ` \`${f.where}\`` : ""}: ${f.message}`)));
  }
  return out.join("\n") + "\n";
}

/** The first line: what this change did to the catalog, in sentences, then whether the lint passed. */
function summary(report: LintReport): string {
  const parts: string[] = [];
  const added = report.added_without_test.length;
  if (added) parts.push(`${added} ${plural(added, "rule")} added without a conformance test.`);
  if (report.stale.length) {
    const tests = new Set(report.stale.flatMap((s) => s.tests)).size;
    parts.push(`${report.stale.length} ${plural(report.stale.length, "provision")} changed${tests ? `; ${tests} ${plural(tests, "test")} need review` : ", none cited by a test"}.`);
  }
  const removed = report.removed_without_tombstone.length;
  if (removed) parts.push(`${removed} ${plural(removed, "provision")} removed without a tombstone.`);
  const unmarked = report.unmarked.length;
  if (unmarked) parts.push(`${unmarked} unmarked normative ${plural(unmarked, "statement")}.`);
  if (parts.length === 0) parts.push("Nothing added, changed, removed, or unmarked.");
  const verdict = report.ok ? "" : ` The lint fails with ${report.findings.length} ${plural(report.findings.length, "finding")}.`;
  return `**${parts.join(" ")}**${verdict}`;
}

function section(heading: string, rows: number, body: string[]): string[] {
  return ["", `<details${rows <= OPEN_UP_TO ? " open" : ""}><summary>${heading}</summary>`, "", ...body, "", "</details>"];
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The reasons a provision takes no test, in the order the breakdown lists them: obligations that cannot be tested first, then what is not an obligation. */
const REASONS = ["permission", "non-testable", "inexpressible", "alias", "definition", "invariant", "exclusion"];

function reasonOrder(status: string): number {
  const i = REASONS.indexOf(status);
  return i === -1 ? REASONS.length : i;
}

const PLURALS: Record<string, string> = { alias: "aliases", "non-testable": "non-testable", inexpressible: "inexpressible" };

function plural(n: number, noun: string): string {
  if (n === 1) return noun;
  return PLURALS[noun] ?? `${noun}s`;
}
