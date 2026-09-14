/**
 * N63: `differentialCheck()` -- both engines over the same fixtures, held
 * to identical violation sets (R3.8, X4).
 *
 * A fixture is a directory of `.facts` files plus `expected.tsv`, the
 * violations the fixture is meant to produce, one per line as provision,
 * subject values joined by "|", witness values joined by "|" (the unified
 * form; Soufflé's per-provision CSVs are read back into it), and
 * optionally `expected-verdicts.tsv`, the verdict relations' tuples, one
 * per line as relation then columns. The verdict relations are compared
 * between the engines on every fixture, and against the expectation when
 * the file exists. The evaluator runs in-process; Soufflé runs as a subprocess when
 * a binary is available (`SOUFFLE` env var or `souffle` on PATH), which in
 * CI it always is. Divergence in either direction is reported as the
 * tuples only one side derived (U31), and the evaluator is additionally
 * held to `expected.tsv` so a fixture with a wrong expectation is a red
 * check rather than an agreement between two engines about the wrong
 * answer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuleProgram } from "../compile/compile.ts";
import { evaluateProgram, unified } from "./evaluate.ts";
import { readFacts, writeFacts, type FactSet } from "./facts.ts";

export interface FixtureResult {
  fixture: string;
  evaluator: string[];
  souffle: string[] | null;
  expected: string[];
  /** Unified tuples the evaluator derived and the expectation did not, and vice versa. */
  evaluator_vs_expected: { only_evaluator: string[]; only_expected: string[] };
  /** Present only when Soufflé ran. */
  evaluator_vs_souffle: { only_evaluator: string[]; only_souffle: string[] } | null;
  /** The verdict relations' tuples, one per line as relation then columns. */
  verdicts: string[];
  souffle_verdicts: string[] | null;
  /** Present when the fixture has `expected-verdicts.tsv`. */
  verdicts_vs_expected: { only_evaluator: string[]; only_expected: string[] } | null;
  verdicts_vs_souffle: { only_evaluator: string[]; only_souffle: string[] } | null;
  ok: boolean;
}

/** A verdict relation's tuples in the form the fixtures pin: relation, then each column, tab-separated. */
export function verdictRows(verdicts: FactSet): string[] {
  const rows: string[] = [];
  for (const [relation, tuples] of verdicts) for (const t of tuples) rows.push([relation, ...t.map(String)].join("\t"));
  return rows.sort();
}

export interface DifferentialReport {
  souffle: string | null;
  fixtures: FixtureResult[];
  ok: boolean;
}

export function findSouffle(): string | null {
  const fromEnv = process.env.SOUFFLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const which = Bun.spawnSync(["sh", "-c", "command -v souffle"], { stdout: "pipe", stderr: "pipe" });
  const path = which.stdout.toString().trim();
  return which.exitCode === 0 && path ? path : null;
}

export function listFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort();
}

export function differentialCheck(program: RuleProgram, dl: string, fixturesDir: string, souffle: string | null = findSouffle()): DifferentialReport {
  const fixtures = listFixtures(fixturesDir).map((name) => runFixture(program, dl, join(fixturesDir, name), name, souffle));
  return { souffle, fixtures, ok: fixtures.every((f) => f.ok) };
}

export function runFixture(program: RuleProgram, dl: string, dir: string, name: string, souffle: string | null): FixtureResult {
  const facts = readFacts(join(dir, "facts"), program.relations);
  const evaluation = evaluateProgram(program, facts);
  const evaluator = evaluation.violations.map(unified);
  const verdicts = verdictRows(evaluation.verdicts);
  const expected = readExpected(join(dir, "expected.tsv"));
  const expectedVerdicts = existsSync(join(dir, "expected-verdicts.tsv")) ? readExpected(join(dir, "expected-verdicts.tsv")) : null;
  const result: FixtureResult = {
    fixture: name,
    evaluator,
    souffle: null,
    expected,
    evaluator_vs_expected: { only_evaluator: minus(evaluator, expected), only_expected: minus(expected, evaluator) },
    evaluator_vs_souffle: null,
    verdicts,
    souffle_verdicts: null,
    verdicts_vs_expected: expectedVerdicts ? { only_evaluator: minus(verdicts, expectedVerdicts), only_expected: minus(expectedVerdicts, verdicts) } : null,
    verdicts_vs_souffle: null,
    ok: false,
  };
  if (souffle) {
    const ran = runSouffle(souffle, dl, program, facts);
    result.souffle = ran.violations;
    result.souffle_verdicts = ran.verdicts;
    result.evaluator_vs_souffle = { only_evaluator: minus(evaluator, ran.violations), only_souffle: minus(ran.violations, evaluator) };
    result.verdicts_vs_souffle = { only_evaluator: minus(verdicts, ran.verdicts), only_souffle: minus(ran.verdicts, verdicts) };
  }
  const agree = (d: { only_evaluator: string[]; only_expected?: string[]; only_souffle?: string[] } | null): boolean =>
    d === null || (d.only_evaluator.length === 0 && (d.only_expected ?? d.only_souffle ?? []).length === 0);
  result.ok = agree(result.evaluator_vs_expected) && agree(result.evaluator_vs_souffle) && agree(result.verdicts_vs_expected) && agree(result.verdicts_vs_souffle);
  return result;
}

/**
 * Run stock Soufflé on the published program over the fixture's facts and
 * read back every provision's violation CSV in the unified form the
 * fixtures and the evaluator use (provision, subject values joined by
 * "|", witness values joined by "|"), and every verdict relation's CSV as
 * relation then columns.
 */
export function runSouffle(souffle: string, dl: string, program: RuleProgram, facts: ReturnType<typeof readFacts>): { violations: string[]; verdicts: string[] } {
  const work = mkdtempSync(join(tmpdir(), "acs-ir-souffle-"));
  const factsDir = join(work, "facts");
  const outDir = join(work, "out");
  writeFacts(factsDir, program.relations, facts);
  const programPath = join(work, "rules.dl");
  writeFileSync(programPath, dl);
  mkdirSync(outDir, { recursive: true });
  const run = Bun.spawnSync([souffle, "-F", factsDir, "-D", outDir, programPath], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`souffle exited ${run.exitCode}:\n${run.stderr.toString()}\n${run.stdout.toString()}`);
  }
  const rows: string[] = [];
  for (const p of program.provisions) {
    if (p.status !== "compiled" || !p.violation) continue;
    const csv = join(outDir, `${p.violation.name}.csv`);
    if (!existsSync(csv)) continue;
    for (const line of readFileSync(csv, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const cells = line.split("\t");
      rows.push(`${p.id}\t${cells.slice(0, p.subject.length).join("|")}\t${cells.slice(p.subject.length).join("|")}`);
    }
  }
  const verdicts: string[] = [];
  for (const relation of program.verdicts.outputs) {
    const csv = join(outDir, `${relation}.csv`);
    if (!existsSync(csv)) continue;
    for (const line of readFileSync(csv, "utf8").split("\n")) if (line.trim() !== "") verdicts.push(`${relation}\t${line}`);
  }
  return { violations: rows.sort(), verdicts: verdicts.sort() };
}

function readExpected(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .sort();
}

function minus(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
}
