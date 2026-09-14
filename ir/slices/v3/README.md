# V3: Staleness propagates

**Demo:** Change one word inside the `> **Intent immutability (normative).**` callout in `concepts/intent.md` ("grow" to "widen"). Run `bun run ir lint`. It reports the Invariant as needing review, **and** the §8.4 Requirement that `depends_on` it, **and** the SHOULD downstream of that, none of which contain the edited word. No RFC 2119 keyword moved anywhere.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V3, authoritative for this slice's scope.

**Affordances:** U10, U32, N16, N17, N18, S12. Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

**Stacked on V2.**

## The demo, captured

Run on a copy of the marked corpus with the one-word edit applied (`bun run ir lint --build <copy>`; `ir/test/staleness-demo.test.ts` performs the same edit):

```
## Provisions needing review (U10)

3 provision(s) need review. Nothing is invalid: classify each change as editorial, semantic, or split, then update `reviewed_against` or issue new IDs.

- **ACS-INV-0001** (`concepts/intent.md:13`)
  - its text changed: reviewed against `d13d31e336aa`, now `a361dd9f5a37` (R2.4)
  - invalidates: ACS-REQ-0011
  - tests citing it: none (conformance tests arrive in V5)
- **ACS-REQ-0011** (`spec/instrument/specification.md:244`)
  - it depends on ACS-INV-0001, which needs review (R2.6)
  - invalidates: ACS-REQ-0012
  - tests citing it: none (conformance tests arrive in V5)
- **ACS-REQ-0012** (`spec/instrument/specification.md:244`)
  - it depends on ACS-REQ-0011, which needs review (R2.6)
  - invalidates: nothing downstream
  - tests citing it: none (conformance tests arrive in V5)

## Migration worklist (U32)

1 inline pillar copy still restates a concept-page provision (concepts/README.md:33 promises to replace these with references):

| pillar copy | at | restates | canonical page |
|---|---|---|---|
| ACS-REQ-0024 | spec/instrument/specification.md:262 | ACS-REQ-0023 | concepts/agents.md |
acs-ir lint: wrote .../stale.json; 3 provision(s) need review.
```

Exit status 1. On the unedited corpus the same command reports nothing to review and exits 0, which is what CI now runs.

## What this slice delivers

**One computation, three edge types.** `checkStaleness()` (N16) finds every record whose `reviewed_against` no longer equals its provision's `text_hash` (R2.4). From each such root it walks the catalog's edges in reverse: `depends_on` (N17, R2.6) and `restates` (N18, R2.9). A Requirement that depends on a changed Definition or Invariant is stale though no sentence of its own changed; a pillar copy that restates a changed concept-page provision is stale because the concept page is canonical, and a changed pillar copy never stales the concept page. Each stale entry carries why, what it invalidated, and the conformance tests that cite it.

**Nothing is ever marked invalid.** The output is needs-review. A person classifies the change as editorial, semantic, or split, and clears the flag by updating `reviewed_against` in the record, or by issuing new IDs. `acs-ir lint` exits 1 while anything needs review, so a spec change is never silently fine, and it is never silently broken either.

**The migration worklist is free.** N18 already walks every `restates` edge, so listing them is the to-do list `concepts/README.md:33` promises: which inline pillar copies still await replacement by a reference. One entry today: §9's approver-authentication sentence restating `concepts/agents.md`.

## Decisions made here

- **`restates` is a dependency edge with a fixed direction.** No second hash is pinned for the pair. A changed canonical text stales the pillar copy with reason `restatement_diverged`; a changed pillar copy is its own `text_changed`. This is R2.9's "the concept page wins" expressed as an edge rather than as a comparison of two prose strings, which no tool could judge.
- **Tests are cited by literal ID.** `collectTestCitations()` scans `ir/test/conformance/` for `ACS-XXX-NNNN` literals (R2.7). The directory arrives in V5; until then every stale entry says so in its `tests` line rather than omitting the line.
- **The demo runs on the marked corpus.** Once markers live upstream, editing the prose and re-running is the whole workflow. While the overlay stages them, a reword inside a quoted span also needs the overlay quote updated, and the lint's answer is the same.
- **`acs-ir lint` exists from V3 with staleness only.** V4 adds the unmarked-keyword, tombstone, duplicate-ID, unknown-citation and schema-ref rules around it and the PR comment.

## Wires to later slices

- U32 is printed by `lint`; the census report (P4) will carry it too when V4 makes `specLint()` the one entry point.
- `stale.json` (S12) is written under `ir/.build/` and not committed: it is a report on a state, and the state that matters is the one CI checks.
- The provision index already renders a stale record as such; V4's PR comment (N27) reads `stale.json`.
