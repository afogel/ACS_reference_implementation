# V4: The spec PR polices itself

**Demo:** On a copy of the marked corpus, (a) add a sentence containing `MUST` with no marker and (b) delete a marked provision without tombstoning its ID. `bun run ir lint --build <copy>` fails, and the comment it writes lists both: the unmarked statement with `file:line`, and the ID that needs a tombstone.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V4, authoritative for this slice's scope.

**Affordances:** U4, U9, U22, U23, U24, U25, N20, N21, N23, N24, N25, N26, N27, N61. N22 shipped in V2. Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

**Stacked on V3.**

## The demo, captured

`ir/test/spec-lint.test.ts` performs the same two edits. The terminal report (U9):

```
## Lint (U9)

3 failure(s):

### catalog

- ACS-EXC-0001: has a record but is not marked in the corpus

### tombstone

- ACS-EXC-0001: marked in the baseline, gone from the corpus, and not tombstoned (R2.2)

### unmarked-keyword

- `spec/instrument/specification.md:380`: MUST with no marker and no census exclusion: Multi-tenancy is specified in v0.2. Guardians MUST isolate tenants. Per-tenant policy scoping, SessionContext isolation, a…
```

The comment the workflow posts (`ir/.build/impact.md`, N27):

```
<!-- acs-ir-impact -->
## Normative impact (ACS 0.1.2 at `6fce2a0`)

**3 failure(s), 0 provision(s) to review.**

### Changed provisions and their tests (U22)

None.

### Added provisions with no conformance test (U23)

None.

### Removed provisions missing a tombstone (U24)

- ACS-EXC-0001: add an entry to `ir/ids/tombstones.yaml` (R2.2)

### Unmarked normative statements (U25)

| location | keyword | context |
|---|---|---|
| `spec/instrument/specification.md:380:47` | MUST | Multi-tenancy is specified in v0.2. Guardians MUST isolate tenants. Per-tenant policy scoping, SessionContext isolation, a… |
```

Exit status 1. Tombstone the ID and withdraw its record, and only the unmarked `MUST` remains.

## What this slice delivers

`specLint()` (N20) is one pass over the marked corpus, the records, the allocation files, the conformance tests and the pinned schemas, judged against a **baseline**: the committed manifest and census, or with `--baseline <dir>` the base branch's copies of them, so a PR is judged by what it changed and not by what its author regenerated.

| Rule | Affordance | Verdict |
|---|---|---|
| Unpaired, mismatched, or nested markers | N22 | fail |
| An RFC 2119 occurrence not in the baseline census, bound to nothing and excluded by nothing | N21, U25 | fail |
| An ID in the baseline manifest but not the fresh one, or a withdrawn record, with no tombstone; a tombstoned ID back in use | N23, U24 | fail |
| A duplicate or never-allocated ID | N24 | fail |
| A test citing an ID that is neither live nor tombstoned | N25 | fail |
| A schema ref whose pointer does not resolve or that pins no hash | N26 | fail |
| A schema ref whose subschema hash moved | N26, R2.8 | needs-review |
| A changed text, dependency, or restatement (V3) | N16 to N18, U22 | needs-review |
| A provision new since the baseline with no test citing it | U23 | reported |

Failures and needs-review both exit 1. A failure is fixed in the tree; needs-review is cleared by classifying the change and updating the record.

**Two CI workflows (N61).** `checks.yml` runs `bun run ir lint` in the hermetic suite with the tree as its own baseline. The new `spec-lint.yml` runs per pull request and weekly, materializes the base branch's manifest and census with `git show`, lints against them, and posts one comment carrying `impact.md`, updated in place on every push. It is the only workflow with write access, and only to pull-request comments; a fork's PR gets the report in the log and the red check.

## Decisions made here

- **The baseline is what makes "new" mean something.** Only 28 of 202 keyword occurrences in normative sources are marked until V7, so an absolute "unmarked keyword fails" rule would fail every run. N21 fails on occurrences that are unbound now and were not unbound in the baseline census. An occurrence's identity across edits is its source, keyword, and context window, not its line number, so a reflow elsewhere in the file does not make it new, and an edit to its own sentence does. That is the right sensitivity: a changed sentence containing an unmarked MUST should be looked at again.
- **The census reads prose, never markers.** `unmark()` strips the markers from the marked corpus and re-bases each span's offsets, so a context window taken during lint equals the one in the committed census.
- **Schema refs pin a hash (R2.8).** `pinned` is the SHA-256 of the canonicalized subschema at the pointer. The seven records with schema refs carry eight pins. An unpinned ref is a failure whose message says what to pin; a moved subschema is needs-review with the same shape as a moved sentence.
- **The catalog's own failure is kept alongside the tombstone rule.** Deleting a marked provision produces both "has a record but is not marked" and "gone from the corpus, not tombstoned". They are the same event seen from the record side and the ID side, and the fix (withdraw the record, tombstone the ID) clears both.

## Wires to later slices

- N25 lints an empty registry until V5 brings `ir/test/conformance/`; the rule and the U23 column are exercised by tests with synthetic citations.
- U22's "tests now needs-review" column reads the same registry.
- The overlay is still the staging mechanism: with markers in the overlay rather than the prose, deleting a provision from the spec makes `markers apply` fail on the unresolved quote before `lint` runs. The demo therefore runs on the marked copy, which is the shape of the corpus once markers are merged upstream (E3.3).

## Not in this slice

No predicates, no vocabulary, no verifier. V1 to V4 are a working traceability and drift system with zero Datalog, which was the reason for putting them first.
