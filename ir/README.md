# ACS Normative IR

The requirement catalog for the Agent Control Standard: every normative provision in the pinned spec with a permanent ID, a declared type, and (where testable) a machine-readable predicate, plus the tooling that keeps prose and catalog consistent.

**Shaping:** [`docs/shaping/normative-ir-shaping.md`](../docs/shaping/normative-ir-shaping.md) is authoritative for requirements, the shape (E), and the affordances. [`docs/shaping/normative-ir-slices.md`](../docs/shaping/normative-ir-slices.md) is authoritative for slice scope. One README per shipped slice is under [`slices/`](./slices/).

## The boundary

This tree reads `spec/acs` (the pinned submodule) and nothing else in the repository. No import here reaches `packages/`, `hosts/`, `policy/`, or `mapping.yaml`, and nothing outside `ir/` imports from it. It is a workspace of its own so it can be moved into the spec repository later without including reference-implementation choices.

## Run

```
bun install
bun run ir census            # writes ir/census/provisions.yaml and prints the report
bun run ir markers apply     # materializes the marked corpus under ir/.build/marked/
bun run ir markers patch     # the overlay as a git patch against the spec repo: ir/dist/markers.patch (add --ids for a subset)
bun run ir extract           # writes ir/manifest/provisions.json from the marked corpus
bun run ir render            # writes ir/dist/provision-index.md from manifest + records
bun run ir lint              # spec-lint: failures by rule, records needing review, the migration worklist; exits 1 on either
bun run ir compile           # predicates -> ir/dist/rules.dl (Soufflé), ir/.build/rules.json (evaluator), invariants.tla
bun run ir verify t.jsonl    # conformance report over an envelope log; add --guardian, --deployment, --hmac-key for the external facts
bun run ir verify --facts d  # in-process evaluator over a directory of .facts; prints one line per violation: provision, subject values, witness values
bun run ir differential      # both engines over ir/test/conformance/fixtures; SOUFFLE=/path enables the oracle locally
bun run ir ids next REQ      # allocates the next ACS-REQ-NNNN and bumps the counter
```

Every generated file takes `--check`, which exits 1 when the committed copy is stale. CI runs the census, markers, extract, render, marker-patch, lint and compile checks on every push, and a separate job installs Soufflé 2.5 and runs the differential; `spec-lint.yml` additionally lints each pull request against its base branch and posts the normative-impact comment.

To add a provision: allocate an ID, add an overlay entry quoting the prose, run `markers apply` and `extract`, write `ir/provisions/<ID>.yaml` with `reviewed_against` set to the manifest's `text_hash`, run `render` and `census`, and commit all of it. A keyword occurrence that restates a provision already carried gets an entry in `census/exclusions.yaml` instead of a record.

When the spec changes under a provision, `lint` lists it and everything downstream of it. Classify the change (editorial, semantic, or split), then update the record's `reviewed_against`, or allocate new IDs and tombstone the old one.

`acs-ir census --corpus <dir>` points the census at another ACS checkout, which is how the tests compare the pinned corpus with the commit the shaping survey measured.

## Layout

| Path | Owner | What it is |
|---|---|---|
| `census/sources.yaml` | authored | The source census: every document under `spec/acs/docs/`, its normative status, and what makes it normative. The corpus is declared here, never inferred from a grep. |
| `census/exclusions.yaml` | authored | Census exclusions: keyword occurrences that carry no provision of their own, each by verbatim quote with a reason (`restatement_of` a named provision, `mention`, `roadmap`, `rationale`). Read by the census and by spec-lint. |
| `census/provisions.yaml` | generated | The provision census: every RFC 2119 occurrence, its block type, and whether it is bound, excluded with a reason, or still unbound. Never hand-edited. |
| `markers/overlay.yaml` | authored | The staging overlay: where each provision's anchor and terminator go, by verbatim quote against the pinned corpus. Retired once markers are merged upstream. |
| `ids/counter.yaml`, `ids/tombstones.yaml` | authored via `acs-ir ids next` | Monotonic ID allocation and retired IDs. |
| `manifest/provisions.json` | generated | The mechanical half of every provision: id, type, source, line, block type, section slug, level, text, text hash. Written only by `acs-ir extract`. |
| `provisions/<ID>.yaml` | authored | The semantic half: actor, profile, activation, modality, evidence class, schema refs, dependencies, restatement, status. One record per provision, joined to the manifest by ID. |
| `dist/provision-index.md` | generated | The human-readable catalog. |
| `vocabulary/relations.yaml` | authored | The fact vocabulary: every relation a predicate may name, typed, with its source (wire, external, guardian-state, deployment, static). |
| `dist/markers.patch`, `dist/markers-poc.patch` | generated | The overlay as unified diffs against the spec repository: the bulk marker PR's payload and the five-provision proof of concept. Both apply to the pinned checkout; the test suite proves it. |
| `dist/rules.dl` | generated | The published Soufflé program: runnable by an auditor with stock Soufflé 2.5 and a directory of `.facts`. |
| `test/conformance/fixtures/<name>/` | authored | `.facts` per relation plus `expected.tsv`, the violations both engines must derive, one per line as provision, subject values, witness values. Cites provision IDs. |
| `.build/rules.json`, `.build/invariants.tla` | generated, ignored | The evaluator's rule set and the declared invariant list. |
| `.build/marked/` | generated, ignored | The marked copy of the corpus the extractor reads. |
| `.build/stale.json`, `.build/lint.json`, `.build/impact.md` | generated, ignored | Provisions needing review and the worklist, the full lint report, and the PR comment, written by `acs-ir lint`. |
| `src/corpus.ts` | code | Locates the submodule, lists `docs/**/*.md`, reads the commit and version. |
| `src/markdown-blocks.ts` | code | Line-level block classifier: paragraph, list item, table cell, blockquote, heading, code fence. |
| `src/census/` | code | The census runner, the source census check, the keyword sweep, the callout scan, the footer-seeded dependency edges, and the authored exclusions. |
| `src/ids.ts` | code | Provision identity and allocation. |
| `src/markers/overlay.ts` | code | Overlay parsing, quote resolution, marker insertion; refuses an anchor that would precede a block marker, and an entry whose marker the corpus already carries. |
| `src/markers/patch.ts` | code | The overlay as a git patch against the spec repository. |
| `src/lint/marker-pairing.ts` | code | Unpaired, mismatched, or nested markers fail before extraction. |
| `src/lint/spec-lint.ts` | code | Spec-lint against a baseline; unmarked keywords, tombstones, IDs, citations, schema refs. |
| `src/lint/schema-refs.ts` | code | JSON Pointer resolution and the pinned subschema hash. |
| `src/lint/unmark.ts` | code | The marked corpus read back as prose plus spans. |
| `src/extract/extract.ts` | code | Span reading, text hashing, the manifest. |
| `src/catalog/catalog.ts` | code | Record parsing and the manifest-to-record join. |
| `src/catalog/staleness.ts` | code | Needs-review from a changed text, a changed dependency, or a changed canonical restatement; the migration worklist. |
| `src/catalog/test-citations.ts` | code | Which conformance tests cite which IDs (empty until V5). |
| `src/compile/` | code | The vocabulary, the predicate parser, the compiler, the Soufflé emitter, the TLA+ invariant list. |
| `src/verify/` | code | The trace normalizer, the ordinary-code facts (JCS, chain hashes, HMAC), Ajv over the pinned schemas, the semi-naive evaluator, verdicts, fact files, the differential oracle. |
| `test/fixtures/trace/generate.ts` | code | Generates the clean and violating envelope logs, with a Guardian dump and deployment facts, that `verify` is tested against. |
| `.build/conformance-report.md` | generated, ignored | The report `acs-ir verify <trace>` last produced. |
| `src/render/` | code | The census report, the provision index, the lint report, the stale list and worklist, the impact comment, the compile summary and the differential report, the conformance report. |
| `src/main.ts` | code | The `acs-ir` command line. |
| `test/` | tests | Unit tests on a fixture corpus, plus the pinned corpus held to the survey's reference numbers. |

## What exists so far

| Slice | Status | Delivers |
|---|---|---|
| V1 | shipped | The corpus, inventoried: both censuses, every occurrence still unbound and listed. |
| V2 | shipped | Twenty-eight provisions marked with invisible anchors and indexed; the generated/authored seam. |
| V3 | shipped | Staleness propagates: a change to a concept page marks the unchanged Requirements that depend on it as needing review. |
| V4 | shipped | The spec PR polices itself: spec-lint against a baseline, and the normative-impact comment. |
| V5 | shipped | Twenty-one predicates compiled to Soufflé and to the in-process evaluator; both engines agree over shared fixtures. |
| V6 | shipped | The conformance report over an envelope log: verdicts with evidence, scoped to negotiated profiles, rosters printed. |
| V7 | shipped | The full conversion: 155 provisions, 34 authored exclusions, zero unbound occurrences; the inexpressible set enumerated. |
| V8 | shipped (tooling and drafts) | `markers patch` writes the bulk and proof-of-concept patches; the Discussion and both PR texts are drafted under `slices/v8/`. Posting them upstream is the maintainer's step. |
