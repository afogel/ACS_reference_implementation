# ACS Normative IR

The requirement catalog for the Agent Control Standard: every normative provision in the pinned spec with a permanent ID, a declared type, and (where testable) a machine-readable predicate, plus the tooling that keeps prose and catalog in step.

**Shaping:** [`docs/shaping/normative-ir-shaping.md`](../docs/shaping/normative-ir-shaping.md) is authoritative for requirements, the shape (E), and the affordances. [`docs/shaping/normative-ir-slices.md`](../docs/shaping/normative-ir-slices.md) is authoritative for slice scope. One README per shipped slice lives under [`slices/`](./slices/).

## The boundary

This tree reads `spec/acs` (the pinned submodule) and nothing else in the repository (R8.2). No import here reaches `packages/`, `hosts/`, `policy/`, or `mapping.yaml`, and nothing outside `ir/` imports from it. It is a workspace of its own so it can be lifted into the spec repository later (R8.3) without carrying reference-implementation choices with it.

## Run

```
bun install
bun run ir census            # writes ir/census/provisions.yaml and prints the report
bun run ir census --check    # exits 1 if the committed census is stale; what CI runs
```

`acs-ir census --corpus <dir>` points the census at another ACS checkout, which is how the tests compare the pinned corpus with the commit the shaping survey measured.

## Layout

| Path | Owner | What it is |
|---|---|---|
| `census/sources.yaml` | authored | The source census (S11): every document under `spec/acs/docs/`, its normative status, and what makes it normative. The corpus is declared here, never inferred from a grep (R1.1). |
| `census/provisions.yaml` | generated | The provision census (S11): every RFC 2119 occurrence, its block type, and whether it is bound, excluded with a reason, or still unbound (R1.3, R1.6). Never hand-edited. |
| `src/corpus.ts` | code | Locates the submodule, lists `docs/**/*.md`, reads the commit and version. |
| `src/markdown-blocks.ts` | code | Line-level block classifier: paragraph, list item, table cell, blockquote, heading, code fence. |
| `src/census/` | code | N10 to N14 and N19: the census runner, the source census check, the keyword sweep, the callout scan, and the footer-seeded dependency edges. |
| `src/render/census.ts` | code | N52: the four V1 report panels. |
| `src/main.ts` | code | The `acs-ir` command line. |
| `test/` | tests | Unit tests on a fixture corpus, plus the pinned corpus held to the survey's reference numbers. |

## What exists so far

| Slice | Status | Delivers |
|---|---|---|
| V1 | shipped | The corpus, inventoried: both censuses, every occurrence still unbound and listed. |
| V2 | next | Twenty provisions marked with invisible anchors and indexed; the generated/authored seam. |
| V3 to V8 | planned | Staleness propagation, spec-lint CI, compiled predicates with the differential oracle, the conformance report, the full conversion, upstreaming. |
