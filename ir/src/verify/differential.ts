/**
 * N63: `differentialCheck()` -- both engines over the same fixtures, held
 * to identical violation sets (R3.8, X4).
 *
 * A fixture is a directory of `.facts` files plus `expected.tsv`, the
 * unified violations (provision, subject, witness) the fixture is meant to
 * produce. The evaluator runs in-process; Soufflé runs as a subprocess when
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
import { evaluate, unified } from "./evaluate.ts";
import { readFacts, writeFacts } from "./facts.ts";

export interface FixtureResult {
  fixture: string;
  evaluator: string[];
  souffle: string[] | null;
  expected: string[];
  /** Unified tuples the evaluator derived and the expectation did not, and vice versa. */
  evaluator_vs_expected: { only_evaluator: string[]; only_expected: string[] };
  /** Present only when Soufflé ran. */
  evaluator_vs_souffle: { only_evaluator: string[]; only_souffle: string[] } | null;
  ok: boolean;
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
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();
}

export function differentialCheck(program: RuleProgram, dl: string, fixturesDir: string, souffle: string | null = findSouffle()): DifferentialReport {
  const fixtures = listFixtures(fixturesDir).map((name) => runFixture(program, dl, join(fixturesDir, name), name, souffle));
  return { souffle, fixtures, ok: fixtures.every((f) => f.ok) };
}

export function runFixture(program: RuleProgram, dl: string, dir: string, name: string, souffle: string | null): FixtureResult {
  const facts = readFacts(join(dir, "facts"), program.relations);
  const evaluator = evaluate(program, facts).map(unified);
  const expected = readExpected(join(dir, "expected.tsv"));
  const result: FixtureResult = {
    fixture: name,
    evaluator,
    souffle: null,
    expected,
    evaluator_vs_expected: { only_evaluator: minus(evaluator, expected), only_expected: minus(expected, evaluator) },
    evaluator_vs_souffle: null,
    ok: false,
  };
  if (souffle) {
    result.souffle = runSouffle(souffle, dl, program, facts);
    result.evaluator_vs_souffle = { only_evaluator: minus(evaluator, result.souffle), only_souffle: minus(result.souffle, evaluator) };
  }
  result.ok =
    result.evaluator_vs_expected.only_evaluator.length === 0 &&
    result.evaluator_vs_expected.only_expected.length === 0 &&
    (result.evaluator_vs_souffle === null || (result.evaluator_vs_souffle.only_evaluator.length === 0 && result.evaluator_vs_souffle.only_souffle.length === 0));
  return result;
}

/** Run stock Soufflé on the published program over the fixture's facts and read back the unified violations. */
export function runSouffle(souffle: string, dl: string, program: RuleProgram, facts: ReturnType<typeof readFacts>): string[] {
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
  const csv = join(outDir, "violation.csv");
  if (!existsSync(csv)) return [];
  return readFileSync(csv, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .sort();
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
