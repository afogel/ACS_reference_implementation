# V1: The corpus, inventoried

**Demo:** `bun run ir census` prints two reports. The source census lists all eight concept pages and every pillar document with its normative status and what makes it normative. The provision census reports every RFC 2119 keyword occurrence by block type, the ten `(normative)` callouts, and the eight `Referenced by` footers as candidate dependency edges. Nothing is bound yet: 197 occurrences in normative sources are listed as unbound, and 11 in informative or editorial sources are excluded with that reason.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V1, authoritative for this slice's scope.

**Affordances:** U3, U19, U20, U21, U33, N10, N11, N12, N13, N14, N19, N52, S1, S11. Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

## What this slice delivers

The complete inventory of what the later slices must capture, measured against the pinned corpus at ACS v0.1.2 (`6fce2a0`), and reviewable by a spec editor who has never seen the IR (R1.9).

| Measurement | Value |
|---|---|
| Documents in the corpus | 38 |
| Declared normative / informative / editorial | 19 / 18 / 1 |
| RFC 2119 keyword occurrences | 208 in 134 blocks |
| By block type | paragraph 145, list item 33, table cell 22, blockquote 8; heading, code fence, inline code 0 |
| By keyword | MUST 73, MAY 44, SHOULD 34, MUST NOT 23, OPTIONAL 21, RECOMMENDED 8, REQUIRED 5 |
| Bound / excluded / unbound | 0 / 11 / 197 |
| `(normative)` callouts in `concepts/` | 10, across 6 pages |
| Other `(normative)` tags | 8 headings, 1 lead-in and 2 citations in `specification.md`; 2 mentions in `concepts/README.md` |
| `Referenced by` footers | 8 pages, 22 pillar entries, 0 dangling links, 22 with no provision depending back |

The shaping survey measured 203 occurrences at `c259f57` (v0.1.0). Pointed at that commit, this scan reproduces the survey exactly: 203 in 132 blocks, paragraph 145, list item 33, table cell 17, blockquote 8. The five new occurrences at v0.1.2 are all in table cells in `identity/overview.md` and `identity/standards.md`, two pages that describe themselves as not yet normative. The source census declares them informative, so they are excluded rather than counted as obligations.

## The three things the census decides

**Corpus membership is declared, not grepped (R1.1).** `ir/census/sources.yaml` lists every file under `spec/acs/docs/` with a status and, for normative ones, what makes them normative. `acs-ir census` fails when the tree and the declaration disagree in either direction. Under that declaration, `concepts/provenance.md`, with zero keywords and two invariants, is a normative source, and `identity/overview.md`, with three MUSTs that restate §6.4, is not.

**Every occurrence is in exactly one state (R1.6).** Bound to a provision ID, excluded with a machine-readable reason, or unbound. In V1 the reasons are `informative_source` and `editorial_source`; V2 adds the bindings and the finer exclusions X3 found necessary, such as `restatement_of`.

**Node type is not assigned here (E1.4).** The callout scan reports candidates and their tag shape. X5 showed the callouts are a mix of Invariants, Requirements and one Exclusion, so typing is the editor's judgment in V2's authored records.

## Wires to later slices

- `by_node_type` is carried per source from V1, all zeros, so the report's shape does not change when V2 starts filling it.
- The dependency-edge audit (U33) reports every footer entry as having no provision depending back. That column fills in V2, when authored `depends_on` edges exist to lint against.
- The migration worklist (U32) and exclusion roster (U34) panels are absent, not empty. They belong to V3 and V6.

## Names frozen here

- **Source status** is `normative | informative | editorial`. Editorial is `concepts/README.md` alone: the spec's policy about its own structure, the source of the taxonomy, not a source of provisions.
- **`normative_by`** is `self` (a pillar specification, or a document `conformance.md` binds) or `reference` (force delegated by a citation, listed in `referenced_by`). A citation from an informative page confers nothing.
- **Block types** are the four X3 counted plus the three that must stay at zero: `paragraph`, `list_item`, `table_cell`, `blockquote`, `heading`, `code_fence`, `thematic_break`.
- **Normative tag kinds** are `callout`, `heading`, `lead_in`, `citation`.

## Not in this slice

No markers, no IDs, no provisions, no predicates. The unbound count is the number every later slice reduces.
