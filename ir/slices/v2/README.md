# V2: Twenty-eight provisions, marked and indexed

**Demo:** `bun run ir markers apply && bun run ir extract && bun run ir render` produces [`ir/dist/provision-index.md`](../../dist/provision-index.md): twenty-eight provisions, each with an opaque ID, node type, level, bound actor, activating profile, evidence class, modality, and verbatim text. `bun run ir census` shows the unbound count fall from 197 to 174.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V2, authoritative for this slice's scope.

**Affordances:** U1, U2, U7, U12, U13, U14, N1, N2, N3, N4, N5, N6, N15, N22 (pulled forward from V4), N50, S2, S3, S4, S5, S6. Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

**Stacked on V1.** This branch's PR is opened against the V1 branch and retargets to `main` when V1 merges.

## What this slice delivers

The generated/authored seam, established here and not crossed by any later slice. `ir/manifest/provisions.json` (S4) is written only by `acs-ir extract`; `ir/provisions/<ID>.yaml` (S5) is written only by a person; `loadCatalog()` (N15) is the one place they are joined, on ID. CI regenerates the manifest and the index from the pinned corpus and refuses a stale committed copy.

| Measurement | Value |
|---|---|
| Provisions marked | 28: 24 Requirements, 2 Definitions, 1 Invariant, 1 Exclusion |
| Block types exercised | paragraph 19, table cell 4, blockquote 3, list item 2 |
| Spans across blocks | 3 (§6 table body, §8.2 formula plus list plus closing sentence, §7.2's two sentences) |
| One sentence, two provisions | 2 (§8.4 MUST and SHOULD; §8.6's two MUSTs) |
| Keyword-free provisions | 10 |
| Keyword occurrences bound | 23 of 197; unbound now 174 |
| Records reviewed against current text | 28 of 28 |

The specimen table from the slices doc maps one row to one entry in [`ir/markers/overlay.yaml`](../../markers/overlay.yaml); each entry's comment names its kind. The §8.5 paragraph supplies three: a permission (ACS-REQ-0021), an obligation conditional on exercising it (ACS-REQ-0022), and a SHOULD (ACS-REQ-0020). Approver authentication supplies the restatement pair (ACS-REQ-0023 on the concept page, ACS-REQ-0024 in §9 with `restates` pointing at it, per `concepts/README.md:33`).

## What the mechanism found, put through twenty-eight real provisions

- **A quote is not enough; a start/end pair is.** Three provisions span blocks. `quote` marks one run of text; `start` + `end` mark a span, and `start` must be unique in the file so an ambiguous quote fails rather than binding the first match.
- **A table body is one provision.** ACS-REQ-0003 anchors in the `ALLOW` row's first cell and terminates in the `DEFER` row's last. The span rule handles it, `block_type` is the anchor's cell, and the text carries pipe syntax. X3 tested cells, not bodies; this is the case that extends it.
- **Two spec/schema disagreements** (recorded in the records' notes, listed for upstream in the slices doc): `defer-details.json` does not require `timeout_decision`, which ACS-REQ-0004 says DEFER MUST include; and the `trust` enum ACS-REQ-0010 constrains is reserved in prose but is not a field of `provenance.json`, so R5.2 has nothing to cite there.
- **One vocabulary gap.** §10's "A verifier MUST recompute" binds whichever party checks a signature. The `actor` field holds one value; ACS-REQ-0018 is recorded as `guardian` with the gap noted, and the field's shape is a question for V5.
- **One editorial call, made and recorded.** X5 read `provenance.md:19` as an Invariant; the slices doc's specimen table types it a Definition. ACS-DEF-0002 follows the table, because the sentence defines what lineage means rather than constraining an actor, and its record says so.

## Names frozen here

- **IDs** are `ACS-{REQ|DEF|INV|EXC}-NNNN`, four digits, allocated from `ir/ids/counter.yaml` by `acs-ir ids next <type>` and never rewound; retired numbers go to `ir/ids/tombstones.yaml`. The anchor is the lowercase form.
- **Markers** are `<a id="acs-req-0001"></a>` and `<!--/acs-req-0001-->`, both mandatory, never nested (X3). `lintMarkerPairing()` runs before anything is extracted.
- **Record fields** (E5.1): `actor`, `reported_against`, `profile` (a list, or `all`), `activation`, `modality_kind` (`obligation | permission | conditional-on-exercise | definition | invariant | exclusion`), `evidence_class` (`wire | schema | guardian-state | deployment-config | non-testable | not-applicable`), `schema_refs` (file plus JSON Pointer), `depends_on`, `restates`, `status`, `since`, `superseded_by`, `reviewed_against`, `note`. `predicate`, `evidence_fields` and `external_facts` arrive with the DSL in V5.
- **`restates` has one direction:** pillar copy to concept-page provision. The catalog refuses the reverse.
- **`text_hash`** is SHA-256 over whitespace-normalized text, so a reflow is not a change.
- **`section_slug`** follows Python-Markdown's slugify and therefore equals the anchor MkDocs publishes; it is informational and never a key.

## Wires to later slices

- `reviewed_against` is carried and compared only for display (a stale record renders as such in the index). Propagation through `depends_on` and `restates` is V3.
- The test-coverage table (U14) lists every provision as untested until V5's fixtures cite IDs.
- The dependency-edge audit still reports all 22 footer entries unmatched: the authored `depends_on` edges here run Requirement to Definition, and matching them against footers is the V3 lint.
- `acs-ir ids next` allocates; nothing yet withdraws. Tombstoning is V4 (`lintTombstone`).

## Not in this slice

No predicates, no staleness propagation, no PR comment. The overlay is the staging mechanism (E3) and the exact payload of the eventual bulk marker PR; the spec submodule is untouched.
