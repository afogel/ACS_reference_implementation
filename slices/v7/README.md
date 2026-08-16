# V7: Conformance matrix

**Demo:** Eight intervention points by five AGT verdicts, every cell resolved — green where ACS v0.1.0 expresses AGT, red with a named reason where it cannot. Plus the Trace pillar, measured as an explicit non-claim.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V7 — authoritative for this slice's scope.

**Affordances:** U30, U32, U33, N40-N44, N47, N48, N49, N52, S10 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances). This slice declares no store of its own; S10 (`mapping.yaml`) is the shared one it reads, and commitment 2 below is about what it is called.

## Names frozen before implementation

No V7 code exists yet, which is the only reason this section can be written at all. This
slice publishes tables, and it measures three different things into them: coverage cells,
trace-pillar rows, and — through V8 — upstream surface diffs. All three get called "the
matrix" in conversation, and Detail C until now had one `renderMatrix()` wired to all
three. Left to implementation time that name gets written once, by whoever builds the
first of the three, and the other two arrive as columns of it. That is not a tidiness
problem: a coverage claim that renders through the same function as everything else beside
it is a coverage claim whose subject is whatever was rendered.

Each numbered sentence below is a commitment a future implementer can be held to. None of
them describes measured behaviour: there is no V7 behaviour to measure yet, so each one
fixes a name and the role that name must fill, and nothing more.

1. **The 8 × 5 is intervention points by *AGT* verdicts, and every description says "AGT".**
   The five columns are AGT's verdict vocabulary — `allow`, `deny`, `warn`, `escalate`,
   `transform` — which is the `Decision` const the pinned SDK exports
   (`agent-control-specification@0.3.1-beta.0`, `dist/src/index.d.ts`; `agt.lock` pins that
   version) and the union `packages/agt-bridge/src/index.ts` declares. That is the enum,
   named in full once; elsewhere "five AGT verdicts" is enough. ACS v0.1.0 has five
   dispositions of its own — `allow`, `deny`, `modify`, `ask`, `defer`
   (`spec/acs/specification/v0.1.0/response-envelope.json`) — and they are a *different*
   five: `warn`, `escalate` and `transform` are not among them; `modify`, `ask` and `defer`
   are not AGT's. `mapping.yaml`'s `verdicts` table is the one place the two lists meet
   (`warn` → `allow` with non-empty `policy_references`, `escalate` → `ask`, `transform` →
   `modify`), and ACS `defer` has no AGT verdict behind it at all (§V3). So an unqualified
   "five verdicts" names both vocabularies and distinguishes neither, in the one document
   whose entire subject is that they are not the same list. The eight rows are AGT's
   intervention points, likewise the SDK's `InterventionPoint` const and exactly the eight
   keys of `mapping.yaml`'s `intervention_points`.

2. **`Mapping`, `MappingTable` and `CoverageMatrix` name three different things, and the
   8 × 5 is never called a mapping.** `Mapping` is S10's data: what `mapping.yaml` declares
   in its `intervention_points`, `verdicts` and `field_synthesis` tables, read by the
   runtime (`packages/guardian/src/map-verdict.ts`) and by this harness from the same file.
   `MappingTable` is U32's rendering of that data, produced by N48 `renderMappingTable()`.
   `CoverageMatrix` is U30's measurements — what N41–N44 return, cell by cell. A type,
   file or variable named for one of the three never holds either of the others. The
   distinction is not cosmetic: the mapping is a declaration this project authored, the
   matrix is a result the harness measured, and a name that covers both lets the
   declaration stand in for its own evidence.

3. **N47 is `renderCoverageMatrix()`, and nothing in this repository is named
   `renderMatrix`.** Detail C wired one `renderMatrix()` to U30, U31 *and* U33. It is now
   three affordances, one per measurement: **N47 `renderCoverageMatrix()` → U30** (the
   cells N41–N44 measure), **N52 `renderTraceRows()` → U33** (N49's rows), and **N53
   `renderUpstreamDiff()` → U31**, which is **V8's** — it has no input until V8's N46
   `diffSurfaces()` exists, so it sits in §V8's table rather than §V7's. Each is told one
   measurement and renders that one; none of them takes a discriminator saying which kind
   of table it is being asked for, which is the union this split exists to prevent.

4. **A trace-pillar row is not a cell of the 8 × 5, and no name in this slice claims to
   emit a trace.** U33's rows pair a required OTel attribute with its v0.1.0 wire source;
   a coverage cell pairs an intervention point with an AGT verdict. They are two tables
   with two shapes, which is why they have two renderers, and a trace row never becomes a
   sixth column. `trace/otel-mapping.json` states its own normativity — a deployment
   emitting OTel for the Trace pillar must use its span names and required attributes
   verbatim — and §V7's scope boundary is that V7 *measures* that pillar and does not build
   an exporter. So the two verbs this slice's names may take are *check* and *render* —
   N49 checks the attributes, N52 renders the rows — and nothing here is called
   `exportTrace`, `traceExporter` or `emitSpan`. A name in the emitting mood would be the
   first half of building the exporter §V7 says is a slice of its own.

5. **The harness imports the Guardian and calls it, and the Inspector's import ban does not
   transfer.** `packages/inspector` imports nothing from `@acs/guardian`, `@acs/agt-bridge` or
   `@acs/host-adapter` and re-declares every entry type it reads, gated by
   `test/invariants.test.ts` — because R5.1/R5.2 are claims about a *third party* reading the
   wire, and the ban is what makes them measurable. C2 and R5.3 are claims about **this
   runtime**: that the translation it performs loses nothing, and that the profile it declares
   is the one it implements. Calling the runtime is the evidence for those, and a harness that
   re-derived the mapping from `mapping.yaml` on its own would publish a table that agrees with
   the file and says nothing about what the Guardian does with it — the exact defect the PR #10
   review found, where `server.ts` hardcoded `"pre_tool_call"` while that table sat there
   claiming to be the mapping. So N41's round trip goes through `resolveInterventionPoint` and
   N42's through `mapVerdict`, both imported, and `Mapping` is imported rather than redeclared.

   The bound runs the other way instead: **the harness takes its expected values from nowhere
   the Guardian could also be wrong about.** The eight rows are AGT's `InterventionPoint` and
   the five columns its `Decision` — both `Readonly` consts the pinned SDK exports
   (`agent-control-specification`, `dist/src/index.d.ts`), which is what makes commitment 1's
   enum a fact rather than a list this repository keeps in step by hand. The mapping's contents
   come from `mapping.yaml` read as a file. A matrix whose axes came from a list the Guardian
   hardcodes would be measuring the Guardian against itself, which is the failure mode the
   import buys and this sentence pays for. `loadMapping` casts the parsed YAML with `as Mapping`
   and validates nothing, so the imported type is a convenience for the harness and never a
   check it may lean on.

6. **N43 is a *recomputation* check, and nothing in this slice is named for a field ACS
   v0.1.0 does not have.** AGT's `InterventionPointResult` carries `inputIdentity`,
   `enforcedIdentity` and the `policyInput` they hash — the distinction A4 was amended to the
   Node SDK to get (§V1 C1). ACS v0.1.0 carries no action-identity field at all: `identity`
   appears in exactly two of the 43 schemas, as `session-start.json`'s `user_identity` and as
   prose in `skill-register.json`, and neither is this. So N43 measures a Guardian-side
   recomputation and says so; a name here that implied the wire carried an identity — an
   `enforced_identity` member on anything envelope-shaped — would be the same collapse
   commitment 2 forbids, one field over. §V7 records what that resolves the R1.4 cell to.

Implementation goes here.
