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

5. **The pinned side is `PINNED_AGT_CLONE`, and `upstream` is never spent on the pinned
   ref.** Commitment 1 reserves the `upstream` stem for AGT's `main`, and the conformance
   harness already clones the *pinned* ref for its policy-input schema check — so both
   names now live in one package, and a differ told "upstream" twice is precisely the
   failure commitment 2 describes. That clone's environment variable and its local binding
   are `PINNED_AGT_CLONE` / `PINNED_AGT_CLONE_ENV`
   (`packages/conformance/src/policy-input-schema.ts`), leaving `UPSTREAM_*` free for the
   store N45 fetches into. `scripts/run-conformance.sh` sets the pinned one;
   whatever script drives this slice's watch sets the upstream one, and the two must never
   be read by the same name.

## What this slice measured

Eight surfaces, and eight surfaces are not eight files. `manifest.schema.json`,
`policy-input.schema.json`, `verdict.schema.json` and `snapshot.schema.json` are whole
documents, read out of `policy-engine/spec/schema/` (`wire/` for the latter three) at
whichever ref the clone in hand is checked out to. The intervention-point enum sits
*inside* `manifest.schema.json`, at `/properties/intervention_points/propertyNames/enum`;
the verdict enum sits *inside* `verdict.schema.json`, at `/properties/decision/enum` — both
extracted from documents `readSurfaces()` (`packages/conformance/src/surfaces.ts`) has
already read whole, never fetched a second time. `reserved-reasons.json` is a fifth
document, at `policy-engine/spec/reserved-reasons.json`. The eighth, `data.agt.defaults.config`
keys, has no document at all: it is the set of `cfg.<key>` reads `readSurfaces()` finds by
pattern in `policy-engine/policy/lib/agt_default.rego`, deduped and sorted. One consequence
of that arrangement: a value that moves inside one of the four whole documents is reported
**twice** — once against the document, once against the extracted enum. That is this
arrangement working as built, not a duplicate.

`PinnedSurfaces` and `UpstreamSurfaces` are read out of two separate clones a shell script
makes (`scripts/run-upstream-watch.sh`): one checked out at the ref `agt.lock` pins, handed
in as `PINNED_AGT_CLONE`; one checked out at `main`, handed in as `UPSTREAM_AGT_CLONE`. The
two variables are never read by the same name, and nothing under `packages/conformance/src`
touches the network — cloning, checkout and cleanup are the shell script's job alone.
`diffSurfaces(pinned, upstream)` is told both snapshots and reads neither store itself; it
returns one `SurfaceDiff` per field that moved, naming the surface, the field as a JSON
pointer, what it was, and what it is now. `renderUpstreamDiff()` renders that list; it is
not `renderCoverageMatrix()`, and a `SurfaceDiff` never arrives as a cell of V7's 8 × 5.

A run (`bun run watch:upstream`) reports three things, one beneath the other: the surface
diff; whether the policy input this Guardian actually constructs still validates against
`main`'s **own** copy of `policy-input.schema.json`, not the pinned copy; and whether either
shipped hookmap (`hosts/claude-code/claude-code.hookmap.yaml`,
`hosts/opencode/opencode.hookmap.yaml`) declares a `tools` entry `policy/manifest.yaml`'s
registry has nothing for. A moved surface, a surface that cannot be read at all, a schema
rejection and an unreadable hookmap are each rendered as a line of output, never thrown.
Nothing exits non-zero. The scheduled workflow (`.github/workflows/upstream-watch.yml`) runs
weekly and on manual dispatch.

**What this does not do, stated plainly.** It never fails a build. Forward compatibility is
bought by pinning, not by watching: `agent-control-specification` is pinned at exactly
`0.3.1-beta.0` with no caret, `agt.lock` pins a ref, and nothing on AGT's `main` reaches this
repository until a human bumps the pin. What upstream movement breaks is the truth of the
published claim, not the running implementation. And the hookmap-tools check does not catch
a gate recased to another host's registered name: `policy/manifest.yaml` registers
`run_shell`, `Bash` and `bash` — all three, deliberately, one per host — so a gate recased
from its own host's spelling to the other's is still a registered name and this check passes
it clean. Closing that needs a per-host declaration of the tool names that host actually
dispatches, which no document in this repository carries.
