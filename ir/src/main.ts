#!/usr/bin/env bun
/**
 * `acs-ir` -- the IR's command line (P1).
 *
 *   acs-ir census        [--check] [--corpus <dir>] [--sources <file>] [--overlay <file>] [--out <file>] [--quiet]
 *   acs-ir markers apply [--corpus <dir>] [--overlay <file>] [--build <dir>]
 *   acs-ir extract       [--check] [--corpus <dir>] [--build <dir>] [--out <file>]
 *   acs-ir render        [--check] [--manifest <file>] [--provisions <dir>] [--out <file>]
 *   acs-ir lint          [--corpus <dir>] [--build <dir>] [--baseline <dir>] [--provisions <dir>] [--ids <dir>]
 *                        [--schemas <dir>] [--conformance <dir>] [--sources <file>]
 *   acs-ir ids next <REQ|DEF|INV|EXC> [--ids <dir>]
 *
 * `lint` is spec-lint (E9): it re-extracts from the marked corpus, joins the
 * catalog, and judges the tree against a baseline (the committed generated
 * files, or `--baseline <dir>` holding a base branch's `manifest/` and
 * `census/`). Failures (unpaired markers, a new unmarked keyword, a removed
 * provision with no tombstone, a duplicate or unallocated ID, an unknown
 * test citation, an unresolvable or unpinned schema ref) and needs-review
 * (a changed text, dependency, restatement or subschema) both exit 1. It
 * writes `ir/.build/impact.md`, the PR comment, beside `stale.json` and
 * `lint.json`.
 *
 * Each generated file (`ir/census/provisions.yaml`, `ir/manifest/provisions.json`,
 * `ir/dist/provision-index.md`) is committed so its diff is reviewable, and
 * `--check` exits 1 when the committed copy is stale, so CI can refuse a
 * corpus or overlay change nobody regenerated for. Exit 1 also on any
 * problem the source census, the overlay, the marker pairing, or the
 * catalog join reports: an undeclared document, an ambiguous quote, an
 * unpaired anchor, or a marked provision with no record is a failure, not a
 * warning.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadRecords, loadCatalog, defaultProvisionsDir } from "./catalog/catalog.ts";
import { collectTestCitations, defaultConformanceDir } from "./catalog/test-citations.ts";
import { defaultCensusDir, runCensus } from "./census/run-census.ts";
import { loadCorpus, readSource } from "./corpus.ts";
import { defaultManifestPath, extractProvisions, type Manifest } from "./extract/extract.ts";
import { allocateId, defaultIdsDir, PROVISION_TYPES, type ProvisionType } from "./ids.ts";
import { applyOverlay, defaultBuildDir, defaultMarkersDir, parseOverlay, resolveOverlay } from "./markers/overlay.ts";
import { renderCensus } from "./render/census.ts";
import { renderProvisionIndex } from "./render/provision-index.ts";
import { renderImpactComment } from "./render/impact.ts";
import { renderLint } from "./render/lint.ts";
import { defaultSchemaDir } from "./lint/schema-refs.ts";
import { loadBaseline, specLint } from "./lint/spec-lint.ts";

const USAGE = [
  "usage:",
  "  acs-ir census        [--check] [--corpus <dir>] [--sources <file>] [--overlay <file>] [--out <file>] [--quiet]",
  "  acs-ir markers apply [--corpus <dir>] [--overlay <file>] [--build <dir>]",
  "  acs-ir extract       [--check] [--corpus <dir>] [--build <dir>] [--out <file>]",
  "  acs-ir render        [--check] [--manifest <file>] [--provisions <dir>] [--out <file>]",
  "  acs-ir lint          [--corpus <dir>] [--build <dir>] [--baseline <dir>] [--provisions <dir>] [--ids <dir>] [--schemas <dir>] [--conformance <dir>] [--sources <file>]",
  "  acs-ir ids next <REQ|DEF|INV|EXC> [--ids <dir>]",
].join("\n");

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "census":
      return census(rest);
    case "markers":
      if (rest[0] === "apply") return markersApply(rest.slice(1));
      break;
    case "extract":
      return extract(rest);
    case "render":
      return render(rest);
    case "lint":
      return lint(rest);
    case "ids":
      if (rest[0] === "next") return idsNext(rest.slice(1));
      break;
  }
  console.error(USAGE);
  return 2;
}

function census(rest: string[]): number {
  const check = rest.includes("--check");
  const quiet = rest.includes("--quiet");
  const out = flagValue(rest, "--out") ?? join(defaultCensusDir(), "provisions.yaml");
  const run = runCensus({
    corpusRoot: flagValue(rest, "--corpus"),
    sourcesFile: flagValue(rest, "--sources"),
    overlayFile: flagValue(rest, "--overlay"),
  });
  if (!quiet || run.sources.problems.length > 0) process.stdout.write(renderCensus(run.sources, run.provisions));
  if (run.yaml === null) {
    console.error(`acs-ir census: ${run.sources.problems.length} problem(s); nothing written.`);
    return 1;
  }
  return deliver("census", out, run.yaml, check);
}

function markersApply(rest: string[]): number {
  const corpus = loadCorpus(flagValue(rest, "--corpus"));
  const overlayFile = flagValue(rest, "--overlay") ?? join(defaultMarkersDir(), "overlay.yaml");
  const buildDir = join(flagValue(rest, "--build") ?? defaultBuildDir(), "marked");
  const entries = existsSync(overlayFile) ? parseOverlay(readFileSync(overlayFile, "utf8")) : [];
  const resolution = resolveOverlay(entries, (file) => (corpus.files.includes(file) ? readSource(corpus, file) : null));
  if (resolution.problems.length > 0) {
    for (const p of resolution.problems) console.error(`overlay: ${p}`);
    console.error(`acs-ir markers apply: ${resolution.problems.length} problem(s); nothing written.`);
    return 1;
  }
  const written = applyOverlay(corpus, resolution.spans, (file) => readSource(corpus, file), buildDir);
  console.error(`acs-ir markers apply: ${resolution.spans.length} provisions marked across ${written.length} files in ${buildDir}`);
  return 0;
}

function extract(rest: string[]): number {
  const check = rest.includes("--check");
  const corpus = loadCorpus(flagValue(rest, "--corpus"));
  const buildDir = join(flagValue(rest, "--build") ?? defaultBuildDir(), "marked");
  const out = flagValue(rest, "--out") ?? defaultManifestPath();
  if (!existsSync(buildDir)) {
    console.error(`acs-ir extract: ${buildDir} does not exist; run \`acs-ir markers apply\` first.`);
    return 1;
  }
  const extraction = extractProvisions(buildDir, corpus.files, { version: corpus.version, commit: corpus.commit });
  if (extraction.problems.length > 0) {
    for (const p of extraction.problems) console.error(`extract: ${p}`);
    console.error(`acs-ir extract: ${extraction.problems.length} problem(s); nothing written.`);
    return 1;
  }
  console.error(`acs-ir extract: ${extraction.manifest.provisions.length} provisions.`);
  return deliver("extract", out, JSON.stringify(extraction.manifest, null, 2) + "\n", check);
}

function render(rest: string[]): number {
  const check = rest.includes("--check");
  const manifestFile = flagValue(rest, "--manifest") ?? defaultManifestPath();
  const provisionsDir = flagValue(rest, "--provisions") ?? defaultProvisionsDir();
  const out = flagValue(rest, "--out") ?? join(dirname(defaultManifestPath()), "..", "dist", "provision-index.md");
  if (!existsSync(manifestFile)) {
    console.error(`acs-ir render: ${manifestFile} does not exist; run \`acs-ir extract\` first.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const records = loadRecords(provisionsDir);
  const catalog = loadCatalog(manifest, records.records);
  const problems = [...records.problems, ...catalog.problems];
  if (problems.length > 0) {
    for (const p of problems) console.error(`catalog: ${p}`);
    console.error(`acs-ir render: ${problems.length} problem(s); nothing written.`);
    return 1;
  }
  return deliver("render", out, renderProvisionIndex(catalog, manifest.corpus), check);
}

function lint(rest: string[]): number {
  const corpus = loadCorpus(flagValue(rest, "--corpus"));
  const buildRoot = flagValue(rest, "--build") ?? defaultBuildDir();
  const markedDir = join(buildRoot, "marked");
  if (!existsSync(markedDir)) {
    console.error(`acs-ir lint: ${markedDir} does not exist; run \`acs-ir markers apply\` first.`);
    return 1;
  }
  const baselineDir = flagValue(rest, "--baseline") ?? resolve(import.meta.dir, "..");
  const report = specLint({
    corpus,
    markedDir,
    sourcesFile: flagValue(rest, "--sources") ?? join(defaultCensusDir(), "sources.yaml"),
    provisionsDir: flagValue(rest, "--provisions") ?? defaultProvisionsDir(),
    idsDir: flagValue(rest, "--ids") ?? defaultIdsDir(),
    schemaDir: flagValue(rest, "--schemas") ?? defaultSchemaDir(),
    citations: collectTestCitations(flagValue(rest, "--conformance") ?? defaultConformanceDir()),
    baseline: loadBaseline(baselineDir),
  });
  process.stdout.write(renderLint(report));
  mkdirSync(buildRoot, { recursive: true });
  writeFileSync(join(buildRoot, "stale.json"), JSON.stringify({ corpus: report.corpus, stale: report.stale, worklist: report.worklist }, null, 2) + "\n");
  writeFileSync(join(buildRoot, "lint.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(buildRoot, "impact.md"), renderImpactComment(report));
  console.error(
    `acs-ir lint: ${report.findings.length} failure(s), ${report.stale.length} provision(s) need review; wrote ${join(buildRoot, "impact.md")}.`,
  );
  return report.ok ? 0 : 1;
}

function idsNext(rest: string[]): number {
  const type = rest[0];
  if (!PROVISION_TYPES.includes(type as ProvisionType)) {
    console.error(USAGE);
    return 2;
  }
  const id = allocateId(type as ProvisionType, flagValue(rest, "--ids") ?? defaultIdsDir());
  console.log(id);
  return 0;
}

/** Write a generated file, or with `--check` compare it to the committed copy and refuse a stale one. */
function deliver(command: string, out: string, content: string, check: boolean): number {
  if (check) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (current === content) {
      console.error(`acs-ir ${command} --check: ${out} is up to date.`);
      return 0;
    }
    console.error(
      current === null
        ? `acs-ir ${command} --check: ${out} does not exist. Run \`bun run ir ${command}\` and commit the result.`
        : `acs-ir ${command} --check: ${out} is stale (first difference at line ${firstDifference(current, content)}). Run \`bun run ir ${command}\` and commit the result.`,
    );
    return 1;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  console.error(`acs-ir ${command}: wrote ${out}`);
  return 0;
}

function firstDifference(a: string, b: string): number {
  const as = a.split("\n");
  const bs = b.split("\n");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) if (as[i] !== bs[i]) return i + 1;
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
