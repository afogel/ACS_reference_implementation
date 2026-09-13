#!/usr/bin/env bun
/**
 * `acs-ir` -- the IR's command line (P1).
 *
 *   acs-ir census [--check] [--corpus <dir>] [--sources <file>] [--out <file>] [--quiet]
 *
 * `census` writes `ir/census/provisions.yaml` and prints the report.
 * `--check` writes nothing and exits 1 if the committed file is stale, so
 * CI can refuse a corpus change that nobody regenerated the census for.
 * Exit 1 also when the source census has problems: an undeclared document
 * is a census failure, not a warning (R1.1, R1.6).
 *
 * Later slices add `markers apply`, `extract`, `lint`, `compile`, `verify`
 * and `render` beside this one command.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCensusDir, runCensus } from "./census/run-census.ts";
import { renderCensus } from "./render/census.ts";

const USAGE = `usage: acs-ir census [--check] [--corpus <dir>] [--sources <file>] [--out <file>] [--quiet]`;

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== "census") {
    console.error(USAGE);
    return 2;
  }
  const check = rest.includes("--check");
  const quiet = rest.includes("--quiet");
  const out = flagValue(rest, "--out") ?? join(defaultCensusDir(), "provisions.yaml");

  const run = runCensus({ corpusRoot: flagValue(rest, "--corpus"), sourcesFile: flagValue(rest, "--sources") });
  if (!quiet || run.sources.problems.length > 0) process.stdout.write(renderCensus(run.sources, run.provisions));
  if (run.yaml === null) {
    console.error(`acs-ir census: ${run.sources.problems.length} problem(s) in the source census; nothing written.`);
    return 1;
  }

  if (check) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (current === run.yaml) {
      console.error(`acs-ir census --check: ${out} is up to date.`);
      return 0;
    }
    console.error(
      current === null
        ? `acs-ir census --check: ${out} does not exist. Run \`bun run ir census\` and commit the result.`
        : `acs-ir census --check: ${out} is stale (first difference at line ${firstDifference(current, run.yaml)}). Run \`bun run ir census\` and commit the result.`,
    );
    return 1;
  }

  writeFileSync(out, run.yaml);
  console.error(`acs-ir census: wrote ${out}`);
  return 0;
}

function firstDifference(a: string, b: string): number {
  const as = a.split("\n");
  const bs = b.split("\n");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) if (as[i] !== bs[i]) return i + 1;
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
