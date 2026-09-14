# V8: Upstream

**Demo:** `bun run ir markers patch` cuts `ir/markers/overlay.yaml` into a unified diff against the spec repository. Applied to a checkout of ACS v0.1.2 and built with MkDocs, `…/spec/instrument/specification/#acs-req-0007` scrolls to *"Required at session start, before any hook traffic."*, the sentence reads unchanged, and no identifier is visible on the page.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V8, authoritative for this slice's scope.

**Affordances:** U8, N60 (tooling, shipped here); U28, U29, U30 (governance, drafted here, posted by the maintainer); U26, U27 (verified on a local build). Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

**Stacked on V7.**

## The demo, captured

The patched page, as MkDocs renders it:

```html
<a id="acs-req-0007"></a>Required at session start, before any hook traffic.
```

The build preserves the closing comment as a comment. Stripping tags and comments from the rendered HTML leaves no `<a id`, no `<!--/`, and no `acs-req-` anywhere in the visible text. The spec repository's own guards (`tests/test_spec_structure.py`, `tests/test_hook_taxonomy.py`) pass on the patched tree.

The two patches:

| file | provisions | corpus files | lines |
|---|---|---|---|
| `ir/dist/markers.patch` | 155 | 14 | 746 |
| `ir/dist/markers-poc.patch` | 5 | 2 | 61 |

Every hunk is a one-line replacement: a marker never contains a line break, so the marked file has exactly the lines of the unmarked one.

## What this slice delivers

**`materializeMarkerPatch()` (N60) and `acs-ir markers patch` (U8).** The same resolved spans that the local applier writes under `ir/.build/marked/` are emitted as a unified diff with paths relative to the spec repository root. `--ids` cuts a subset for the proof-of-concept PR. Both files are committed and `--check`ed in CI, so a reviewer reads the exact payload.

**E3.3 proven before the patch is sent.** The test suite copies the pinned corpus, applies the bulk patch with `git apply`, and extracts provisions from the patched tree with no overlay involved. The text hashes equal the committed manifest's. When the bulk PR merges, the overlay is deleted and the extractor reads the submodule. Nothing else changes.

**The three governance texts, drafted:**

- [`discussion.md`](./discussion.md): the mechanism proposal with the five worked provisions (E11.1, R8.6): ACS-REQ-0007 (a wire obligation with a two-rule predicate), ACS-REQ-0010 (profile-scoped, recursive lineage closure), ACS-REQ-0013 (the check is ordinary code, the rule is one line), ACS-INV-0001 (an invariant, verified through the Requirement that depends on it), ACS-EXC-0001 (a deliberate non-requirement).
- [`poc-pr.md`](./poc-pr.md): the five-provision PR (E11.2).
- [`bulk-pr.md`](./bulk-pr.md): the mechanical PR for the rest (E11.3), including what to do if the proof of concept merges first.

All three are to be posted under the `afogel` identity with no tool attribution of any kind (D-f); the drafts contain none.

## Decisions made here

- **Two placement rules the applier now enforces.** An anchor must not precede a list, quote, table or heading marker on its line, because inline HTML there pushes the marker off the line start and the renderer does not recognize the block; the bulk patch had one such case (§8.1's `- **SHOULD:**` item, ACS-REQ-0060) and the quote was moved inside the item. And an overlay entry whose anchor the corpus already carries is refused rather than applied twice, which is how the overlay retires entry by entry as markers are merged upstream.
- **The patch carries a header naming the corpus it was cut against.** `git apply` ignores text before the first `diff --git`, and a reviewer should not have to guess which commit the line numbers refer to.
- **Terminators are HTML comments, and MkDocs preserves them.** Python-Markdown passes inline HTML and comments through. The built page keeps them as comments. A renderer that strips comments would lose the terminator but not the anchor, and the deep links would still work.
- **Posting is not tooling.** `CONTRIBUTING.md` routes spec changes through a Discussion first, commits are DCO-signed, and the identity on all of it is the maintainer's. The slice ends at the drafts.

## What remains, and who does it

1. Post the Discussion (U28). Ariel, from `discussion.md`.
2. On acceptance of the mechanism, open the proof-of-concept PR from `ir/dist/markers-poc.patch` (U29). Ariel, from `poc-pr.md`.
3. On merge, open the bulk PR from `ir/dist/markers.patch` (U30). Ariel, from `bulk-pr.md`. If `main` has moved, bump the submodule first and regenerate. `markers apply` reports any quote that no longer resolves and any entry already marked.
4. After the bulk PR merges: delete `ir/markers/overlay.yaml`, point the extractor at the submodule, and drop the `markers apply` step from CI. That is the E3.3 retirement, and it is a one-commit change.
