# V8: Upstream contract watch

**Demo:** Point the harness at AGT `main`. A changed enum value is reported as a `SurfaceDiff` naming the surface and the field that moved.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V8 — authoritative for this slice's scope.

**Affordances:** U31, N45, N46, N53, S12, S11 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances). S12 (upstream AGT surfaces) is the store this slice declares, the one N45 fetches into; S11 (`agt.lock`) is the shared one it reads for the pinned side, and commitment 2 below is about what the two are called.

## Names frozen before implementation

No V8 code exists yet, which is the only reason this section can be written at all. `drift`
is the word this slice was named for, and it is already spent: `policy/lib/drift.rego` is
AGT's stock gate, `input.annotations.drift_score` is the input it reads,
`drift.warn_threshold` under `data.agt.defaults.config` is the number it compares against
(`policy/lib/agt_default.rego`), `drift_detected` is the reason it emits, and V3 added
`policy/manifest.drift.yaml` — a second manifest over the same pinned bundle — because that
gate is unreachable without a manifest-declared annotator (§V3). Every one of those is about
a *model's behaviour* moving. This slice is about the *upstream contract* moving: AGT's
schemas and enums at `main`, against the ref `agt.lock` pins. Two subjects, one English
word, and the collision arrives before there is anything to inherit it — left to
implementation time the first file is called `drift.ts` and is read as the gate.

Each numbered sentence below is a commitment a future implementer can be held to. None of
them describes measured behaviour: there is no V8 behaviour to measure yet, so each one
fixes a name and the role that name must fill, and nothing more.

1. **The stem is `upstream`, and nothing this slice builds is named `drift`.** The three
   functions are `fetchUpstreamSurfaces()` (N45), `diffSurfaces()` (N46) and
   `renderUpstreamDiff()` (N53); the types are `PinnedSurfaces`, `UpstreamSurfaces` and
   `SurfaceDiff`; the file that holds them is named for one of those and never `drift.ts`.
   The slice is the **upstream contract watch** — the H1 above, §V8's heading and index row,
   and the shaping doc's C6 part all say so, and U31 is the *surface-diff detail* in both
   affordance tables and in the breadboard's own node label. The other direction is a
   commitment too: this slice renames nothing in V3's family. `drift.rego`, `drift_score`,
   `drift_detected`, `drift.warn_threshold` and `policy/manifest.drift.yaml` are the other
   noun, they are shipped, and V8 leaves every one of them where it is.

2. **`PinnedSurfaces` and `UpstreamSurfaces` are a twin pair, one per side of the diff, and
   neither is ever just `Surfaces`.** Both hold the same eight surfaces §V8 lists —
   `manifest.schema.json`, `policy-input.schema.json`, `verdict.schema.json`,
   `snapshot.schema.json`, the intervention-point enum, the verdict enum,
   `reserved-reasons.json`, and the stock bundle's `data.agt.defaults.config` keys — and
   differ only in where they were read from. `PinnedSurfaces` is that set at the ref
   `agt.lock` records (S11 — the same `agt_ref` `scripts/verify-pin.sh` clones to prove
   `policy/lib` is byte-identical to upstream). `UpstreamSurfaces` is that set at `main`
   (S12 — what N45 fetches). One shape, two sources, and the name says which source. A
   single `Surfaces` type serving both is the shape in which a run that read the pinned side
   twice still reports a clean diff, because nothing in the type says where either argument
   came from.

3. **`diffSurfaces(pinned, upstream)` is told both snapshots and reads neither store
   itself.** Its parameters are a `PinnedSurfaces` and an `UpstreamSurfaces`, in that order;
   it returns `SurfaceDiff`s, and that is the whole of what it does. It does not open
   `agt.lock`, does not resolve a git ref, and does not reach the network — fetching is
   N45's job, and reading the pinned side belongs to whatever assembles the run. §V8's S11
   row and the breadboard's `S11 -.-> N46` edge are that data arriving at the differ, not
   the differ going to fetch it. The precedent is already in this stack and it cost a review
   round: `governStep` derived the tool it had been scoped on rather than being handed the
   one its caller had already checked, and the repair was to make it an argument —
   `GovernStepInput.scopedTool` in `packages/host-adapter/src/govern-step.ts`, which now
   throws rather than derive a second name whenever the hookmap entry declares a `tools`
   list and the call named no scoped tool. That repair had to travel through two hosts.
   Here it is a sentence, because there is no signature yet.

4. **A `SurfaceDiff` is not a cell of V7's 8 × 5, and N46's output renders through
   `renderUpstreamDiff()`.** A coverage cell pairs an intervention point with an AGT
   verdict; N41–N44 measure those and N47 `renderCoverageMatrix()` renders them
   (`slices/v7/README.md`, commitment 3). A changed enum value is not one of those pairs —
   it is a named surface, a named field, and what that field was against what it is now — so
   it is a `SurfaceDiff`, N53 `renderUpstreamDiff()` renders it, and U31 is where it lands.
   This slice's demo sentence used to say a changed enum "turns a cell red", and the wiring
   that made that sentence plausible is exactly what V7's split removed: one `renderMatrix()`
   was wired to U30, U31 **and** U33, so an upstream diff would have arrived as a column of
   the coverage matrix. At that point the matrix stops answering "does ACS v0.1.0 express
   AGT" and starts answering "what did the harness notice", which is a different claim
   published under the first one's name.

Implementation goes here.
