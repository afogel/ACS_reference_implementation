#!/usr/bin/env bun
/**
 * `acs-ir` -- the IR's command line (P1).
 *
 *   acs-ir census        [--check] [--corpus <dir>] [--sources <file>] [--overlay <file>] [--exclusions <file>] [--out <file>] [--quiet]
 *   acs-ir markers apply [--corpus <dir>] [--overlay <file>] [--build <dir>]
 *   acs-ir markers patch [--check] [--corpus <dir>] [--overlay <file>] [--ids <ID,ID,...>] [--out <file>]
 *   acs-ir extract       [--check] [--corpus <dir>] [--build <dir>] [--out <file>]
 *   acs-ir render        [--check] [--manifest <file>] [--provisions <dir>] [--out <file>]
 *   acs-ir lint          [--corpus <dir>] [--build <dir>] [--baseline <dir>] [--provisions <dir>] [--ids <dir>]
 *                        [--schemas <dir>] [--conformance <dir>] [--sources <file>] [--exclusions <file>]
 *   acs-ir compile       [--check] [--manifest <file>] [--provisions <dir>] [--vocabulary <file>] [--dist <dir>] [--build <dir>]
 *   acs-ir verify        <trace.jsonl> [--guardian <dir>] [--deployment <dir>] [--hmac-key <hex|file>] [--out <file>] [--json <file>]
 *   acs-ir verify        --facts <dir> [--build <dir>]
 *   acs-ir differential  [--fixtures <dir>] [--build <dir>] [--dist <dir>] [--souffle <path>]
 *   acs-ir ids next <REQ|DEF|INV|EXC> [--ids <dir>]
 *
 * `compile` turns every predicate into the published Soufflé program
 * (`ir/dist/rules.dl`), the evaluator's rule set (`ir/.build/rules.json`)
 * and the declared invariant list (`ir/.build/invariants.tla`); a type
 * error, an unsafe rule, an unstratifiable predicate, or a Requirement
 * with neither a predicate nor an inexpressible reason exits 1.
 * `verify --facts` runs the in-process evaluator over a directory of
 * `.facts` and prints the violations. `differential` runs both engines
 * over every fixture and exits 1 on any divergence (R3.8).
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
import { materializeMarkerPatch } from "./markers/patch.ts";
import { renderCensus } from "./render/census.ts";
import { renderProvisionIndex } from "./render/provision-index.ts";
import { renderImpactComment } from "./render/impact.ts";
import { renderLint } from "./render/lint.ts";
import { defaultSchemaDir } from "./lint/schema-refs.ts";
import { loadBaseline, specLint } from "./lint/spec-lint.ts";
import { compileProgram, type RuleProgram } from "./compile/compile.ts";
import { emitSouffleProgram } from "./compile/emit-souffle.ts";
import { emitTlaInvariants } from "./compile/emit-tla.ts";
import { defaultVocabularyPath, loadVocabulary } from "./compile/vocabulary.ts";
import { differentialCheck, findSouffle } from "./verify/differential.ts";
import { evaluate, unified } from "./verify/evaluate.ts";
import { readFacts } from "./verify/facts.ts";
import { renderCompile, renderDifferential } from "./render/compile.ts";
import { renderConformanceReport } from "./render/report.ts";
import { checkStaleness } from "./catalog/staleness.ts";
import { computeExternalFacts } from "./verify/external-facts.ts";
import { normalizeTrace, readTrace } from "./verify/normalize-trace.ts";
import { loadSchemas } from "./verify/schemas.ts";
import { judge } from "./verify/verdicts.ts";

const USAGE = [
  "usage:",
  "  acs-ir census        [--check] [--corpus <dir>] [--sources <file>] [--overlay <file>] [--exclusions <file>] [--out <file>] [--quiet]",
  "  acs-ir markers apply [--corpus <dir>] [--overlay <file>] [--build <dir>]",
  "  acs-ir markers patch [--check] [--corpus <dir>] [--overlay <file>] [--ids <ID,ID,...>] [--out <file>]",
  "  acs-ir extract       [--check] [--corpus <dir>] [--build <dir>] [--out <file>]",
  "  acs-ir render        [--check] [--manifest <file>] [--provisions <dir>] [--out <file>]",
  "  acs-ir lint          [--corpus <dir>] [--build <dir>] [--baseline <dir>] [--provisions <dir>] [--ids <dir>] [--schemas <dir>] [--conformance <dir>] [--sources <file>] [--exclusions <file>]",
  "  acs-ir compile       [--check] [--manifest <file>] [--provisions <dir>] [--vocabulary <file>] [--dist <dir>] [--build <dir>]",
  "  acs-ir verify        <trace.jsonl> [--guardian <dir>] [--deployment <dir>] [--hmac-key <hex|file>] [--out <file>] [--json <file>]",
  "  acs-ir verify        --facts <dir> [--build <dir>]",
  "  acs-ir differential  [--fixtures <dir>] [--build <dir>] [--dist <dir>] [--souffle <path>]",
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
      if (rest[0] === "patch") return markersPatch(rest.slice(1));
      break;
    case "extract":
      return extract(rest);
    case "render":
      return render(rest);
    case "lint":
      return lint(rest);
    case "compile":
      return compile(rest);
    case "verify":
      return verify(rest);
    case "differential":
      return differential(rest);
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
    exclusionsFile: flagValue(rest, "--exclusions"),
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

function markersPatch(rest: string[]): number {
  const check = rest.includes("--check");
  const corpus = loadCorpus(flagValue(rest, "--corpus"));
  const overlayFile = flagValue(rest, "--overlay") ?? join(defaultMarkersDir(), "overlay.yaml");
  const idsFlag = flagValue(rest, "--ids");
  const only = idsFlag === undefined ? null : new Set(idsFlag.split(",").map((s) => s.trim()).filter(Boolean));
  const out = flagValue(rest, "--out") ?? join(defaultDistDir(), only === null ? "markers.patch" : "markers-subset.patch");
  const entries = existsSync(overlayFile) ? parseOverlay(readFileSync(overlayFile, "utf8")) : [];
  const resolution = resolveOverlay(entries, (file) => (corpus.files.includes(file) ? readSource(corpus, file) : null));
  if (resolution.problems.length > 0) {
    for (const p of resolution.problems) console.error(`overlay: ${p}`);
    console.error(`acs-ir markers patch: ${resolution.problems.length} problem(s); nothing written.`);
    return 1;
  }
  let patch: ReturnType<typeof materializeMarkerPatch>;
  try {
    patch = materializeMarkerPatch(corpus, resolution.spans, (file) => readSource(corpus, file), only);
  } catch (error) {
    console.error(`acs-ir markers patch: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.error(`acs-ir markers patch: ${patch.provisions.length} provision(s) across ${patch.files.length} file(s), against ${corpus.root}.`);
  return deliver("markers patch", out, patch.patch, check);
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
  return deliver("render", out, renderProvisionIndex(catalog, manifest.corpus, collectTestCitations(flagValue(rest, "--conformance") ?? defaultConformanceDir())), check);
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
    exclusionsFile: flagValue(rest, "--exclusions") ?? join(defaultCensusDir(), "exclusions.yaml"),
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

function defaultDistDir(): string {
  return resolve(import.meta.dir, "..", "dist");
}

function compile(rest: string[]): number {
  const check = rest.includes("--check");
  const manifestFile = flagValue(rest, "--manifest") ?? defaultManifestPath();
  const provisionsDir = flagValue(rest, "--provisions") ?? defaultProvisionsDir();
  const distDir = flagValue(rest, "--dist") ?? defaultDistDir();
  const buildRoot = flagValue(rest, "--build") ?? defaultBuildDir();
  if (!existsSync(manifestFile)) {
    console.error(`acs-ir compile: ${manifestFile} does not exist; run \`acs-ir extract\` first.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const records = loadRecords(provisionsDir);
  const catalog = loadCatalog(manifest, records.records);
  const problems = [...records.problems, ...catalog.problems];
  if (problems.length > 0) {
    for (const p of problems) console.error(`catalog: ${p}`);
    console.error(`acs-ir compile: ${problems.length} problem(s); nothing compiled.`);
    return 1;
  }
  const vocabulary = loadVocabulary(flagValue(rest, "--vocabulary") ?? defaultVocabularyPath());
  const program = compileProgram(vocabulary, catalog.entries, manifest.corpus);
  process.stdout.write(renderCompile(program));
  if (program.problems.length > 0) {
    console.error(`acs-ir compile: ${program.problems.length} predicate(s) failed to compile; nothing written.`);
    return 1;
  }
  mkdirSync(buildRoot, { recursive: true });
  writeFileSync(join(buildRoot, "rules.json"), JSON.stringify(program, null, 2) + "\n");
  writeFileSync(join(buildRoot, "invariants.tla"), emitTlaInvariants(catalog.entries, manifest.corpus));
  return deliver("compile", join(distDir, "rules.dl"), emitSouffleProgram(program), check);
}

function loadProgram(buildRoot: string): RuleProgram | null {
  const path = join(buildRoot, "rules.json");
  if (!existsSync(path)) {
    console.error(`${path} does not exist; run \`acs-ir compile\` first.`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as RuleProgram;
}

function verify(rest: string[]): number {
  const factsDir = flagValue(rest, "--facts");
  const buildRoot = flagValue(rest, "--build") ?? defaultBuildDir();
  const program = loadProgram(buildRoot);
  if (!program) return 1;
  if (factsDir) {
    const violations = evaluate(program, readFacts(factsDir, program.relations));
    process.stdout.write(violations.length ? violations.map(unified).join("\n") + "\n" : "");
    console.error(`acs-ir verify: ${violations.length} violation(s) over ${factsDir}.`);
    return 0;
  }
  const trace = rest.find((a) => !a.startsWith("--") && !flagValues(rest).has(a));
  if (!trace) {
    console.error(USAGE);
    return 2;
  }
  // N40: the whole pipeline.
  const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
  const records = loadRecords(flagValue(rest, "--provisions") ?? defaultProvisionsDir());
  const catalog = loadCatalog(manifest, records.records);
  const normalized = normalizeTrace(readTrace(trace));
  const schemas = loadSchemas(flagValue(rest, "--schemas") ?? defaultSchemaDir());
  const external = computeExternalFacts(normalized, program.relations, schemas, {
    hmacKey: readKey(flagValue(rest, "--hmac-key")),
    guardianDir: flagValue(rest, "--guardian") ?? null,
    deploymentDir: flagValue(rest, "--deployment") ?? null,
  });
  const facts = new Map(normalized.facts);
  for (const rel of program.relations) if (rel.source === "static") facts.set(rel.name, rel.facts.map((t) => [...t]));
  for (const [relation, tuples] of external.facts) facts.set(relation, [...(facts.get(relation) ?? []), ...tuples]);
  const violations = evaluate(program, facts);
  const negotiated = [...new Set(normalized.sessions.flatMap((s) => s.profiles))];
  const stale = new Set(checkStaleness(catalog).stale.map((s) => s.id));
  const verdicts = judge(program, catalog, violations, facts, negotiated.length ? negotiated : ["acs-core"], external.available, stale);
  const input = { corpus: program.corpus, trace, sessions: normalized.sessions, negotiated: negotiated.length ? negotiated : ["acs-core"], available: [...external.available].sort(), verdicts };
  const report = renderConformanceReport(input);
  process.stdout.write(report);
  mkdirSync(buildRoot, { recursive: true });
  const out = flagValue(rest, "--out") ?? join(buildRoot, "conformance-report.md");
  writeFileSync(out, report);
  writeFileSync(flagValue(rest, "--json") ?? join(buildRoot, "conformance-report.json"), JSON.stringify(input, null, 2) + "\n");
  const failed = verdicts.filter((v) => v.verdict === "fail").length;
  console.error(`acs-ir verify: ${failed} provision(s) violated; wrote ${out}.`);
  return failed === 0 ? 0 : 1;
}

/** The values consumed by flags, so a positional argument is never one of them. */
function flagValues(argv: string[]): Set<string> {
  const values = new Set<string>();
  argv.forEach((a, i) => {
    if (a.startsWith("--") && !["--check", "--quiet"].includes(a) && argv[i + 1] !== undefined) values.add(argv[i + 1] as string);
  });
  return values;
}

function readKey(spec: string | undefined): Buffer | null {
  if (!spec) return null;
  if (existsSync(spec)) return Buffer.from(readFileSync(spec, "utf8").trim(), "hex");
  return Buffer.from(spec, "hex");
}

function differential(rest: string[]): number {
  const buildRoot = flagValue(rest, "--build") ?? defaultBuildDir();
  const program = loadProgram(buildRoot);
  if (!program) return 1;
  const dl = readFileSync(join(flagValue(rest, "--dist") ?? defaultDistDir(), "rules.dl"), "utf8");
  const fixtures = flagValue(rest, "--fixtures") ?? resolve(import.meta.dir, "..", "test", "conformance", "fixtures");
  const souffle = flagValue(rest, "--souffle") ?? findSouffle();
  const report = differentialCheck(program, dl, fixtures, souffle);
  process.stdout.write(renderDifferential(report));
  writeFileSync(join(buildRoot, "differential.json"), JSON.stringify(report, null, 2) + "\n");
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
