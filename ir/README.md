# ACS Normative IR

The requirement catalog for the Agent Control Standard: every normative provision in the pinned spec with a permanent ID, a declared type, and (where testable) a machine-readable predicate, plus the tooling that keeps prose and catalog in step.

**Shaping:** [`docs/shaping/normative-ir-shaping.md`](../docs/shaping/normative-ir-shaping.md) is authoritative for requirements, the shape (E), and the affordances. [`docs/shaping/normative-ir-slices.md`](../docs/shaping/normative-ir-slices.md) is authoritative for slice scope. One README per shipped slice lives under [`slices/`](./slices/).

## The boundary

This tree reads `spec/acs` (the pinned submodule) and nothing else in the repository (R8.2). No import here reaches `packages/`, `hosts/`, `policy/`, or `mapping.yaml`, and nothing outside `ir/` imports from it. It is a workspace of its own so it can be lifted into the spec repository later (R8.3) without carrying reference-implementation choices with it.

## Run

```
bun install
bun run ir census            # writes ir/census/provisions.yaml and prints the report
bun run ir markers apply     # materializes the marked corpus under ir/.build/marked/
bun run ir extract           # writes ir/manifest/provisions.json from the marked corpus
bun run ir render            # writes ir/dist/provision-index.md from manifest + records
bun run ir lint              # reports every record that needs review, and the migration worklist; exits 1 if any
bun run ir ids next REQ      # allocates the next ACS-REQ-NNNN and bumps the counter
```

Every generated file takes `--check`, which exits 1 when the committed copy is stale. CI runs the census, markers, extract and render checks on every push.

To add a provision: allocate an ID, add an overlay entry quoting the prose, run `markers apply` and `extract`, write `ir/provisions/<ID>.yaml` with `reviewed_against` set to the manifest's `text_hash`, run `render` and `census`, and commit all of it.

When the spec changes under a provision, `lint` names it and everything downstream of it. Classify the change (editorial, semantic, or split), then update the record's `reviewed_against`, or allocate new IDs and tombstone the old one.

`acs-ir census --corpus <dir>` points the census at another ACS checkout, which is how the tests compare the pinned corpus with the commit the shaping survey measured.

## Layout

| Path | Owner | What it is |
|---|---|---|
| `census/sources.yaml` | authored | The source census (S11): every document under `spec/acs/docs/`, its normative status, and what makes it normative. The corpus is declared here, never inferred from a grep (R1.1). |
| `census/provisions.yaml` | generated | The provision census (S11): every RFC 2119 occurrence, its block type, and whether it is bound, excluded with a reason, or still unbound (R1.3, R1.6). Never hand-edited. |
| `markers/overlay.yaml` | authored | The staging overlay (S2): where each provision's anchor and terminator go, by verbatim quote against the pinned corpus. Retires when markers land upstream. |
| `ids/counter.yaml`, `ids/tombstones.yaml` | authored via `acs-ir ids next` | Monotonic ID allocation and retired IDs (S6). |
| `manifest/provisions.json` | generated | The mechanical half of every provision (S4): id, type, source, line, block type, section slug, level, text, text hash. Written only by `acs-ir extract`. |
| `provisions/<ID>.yaml` | authored | The semantic half (S5): actor, profile, activation, modality, evidence class, schema refs, dependencies, restatement, status. One record per provision, joined to the manifest by ID. |
| `dist/provision-index.md` | generated | The human-readable catalog (P2). |
| `.build/marked/` | generated, ignored | The marked copy of the corpus (S3) the extractor reads. |
| `.build/stale.json` | generated, ignored | Provisions needing review and the migration worklist (S12), written by `acs-ir lint`. |
| `src/corpus.ts` | code | Locates the submodule, lists `docs/**/*.md`, reads the commit and version. |
| `src/markdown-blocks.ts` | code | Line-level block classifier: paragraph, list item, table cell, blockquote, heading, code fence. |
| `src/census/` | code | N10 to N14 and N19: the census runner, the source census check, the keyword sweep, the callout scan, and the footer-seeded dependency edges. |
| `src/ids.ts` | code | N3: provision identity and allocation. |
| `src/markers/overlay.ts` | code | N1, N2: overlay parsing, quote resolution, marker insertion. |
| `src/lint/marker-pairing.ts` | code | N22: unpaired, mismatched, or nested markers fail before extraction. |
| `src/extract/extract.ts` | code | N4 to N6: span reading, text hashing, the manifest. |
| `src/catalog/catalog.ts` | code | N15: record parsing and the manifest-to-record join. |
| `src/catalog/staleness.ts` | code | N16 to N18: needs-review from a changed text, a changed dependency, or a changed canonical restatement; the migration worklist. |
| `src/catalog/test-citations.ts` | code | Which conformance tests cite which IDs (empty until V5). |
| `src/render/` | code | N52 the census report, N50 the provision index, U10/U32 the stale list and worklist. |
| `src/main.ts` | code | The `acs-ir` command line. |
| `test/` | tests | Unit tests on a fixture corpus, plus the pinned corpus held to the survey's reference numbers. |

## What exists so far

| Slice | Status | Delivers |
|---|---|---|
| V1 | shipped | The corpus, inventoried: both censuses, every occurrence still unbound and listed. |
| V2 | shipped | Twenty-eight provisions marked with invisible anchors and indexed; the generated/authored seam. |
| V3 | shipped | Staleness propagates: a changed concept page names the unchanged Requirements that depend on it. |
| V4 to V8 | planned | Spec-lint CI, compiled predicates with the differential oracle, the conformance report, the full conversion, upstreaming. |
