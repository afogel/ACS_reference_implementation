---
shaping: true
---

# X5 Spike: Provision taxonomy — do Invariants have members?

Spike for open decisions **D-h** (extract `Invariant` in the first pass, or defer) and **D-g** (where the informative line falls inside `concepts/`) in [`normative-ir-shaping.md`](./normative-ir-shaping.md). The same evidence resolves both.

## Context

E1.1 declares four node types — `Requirement`, `Definition`, `Invariant`, `Informative`. D-h asked whether `Invariant` is worth extracting now: R6.2 wants a declared invariant list for TLA+, but no provision family in the shaping doc's survey obviously yielded an Invariant that wasn't just a Requirement wearing a different hat.

The cost is asymmetric. Deferring means later allocating new IDs, re-marking prose, and **re-authoring `depends_on` edges across the whole catalog** — retrofitting the graph is the expensive part. Including it now costs one branch of a taxonomy that already exists. But shipping a node type with no members is its own smell, and R3.6's spirit says don't claim what you don't have.

## Goal

Determine whether the corpus contains normative propositions that are neither obligations on an actor nor definitions of a term — and if so, how they are distinguished in the prose as written.

## Questions

| # | Question |
|---|----------|
| **X5-Q1** | Does the corpus use the word "invariant", and if so, does it mean what the IR would mean by it? |
| **X5-Q2** | Are there normative propositions that are not obligations and not definitions? Name them. |
| **X5-Q3** | Does the `> **… (normative).**` callout convention map onto node types, or only onto "normative"? |
| **X5-Q4** | Where a statement appears in both `concepts/` and a pillar, which is authoritative? |
| **X5-Q5** | Do the concept pages already encode dependency direction, and can the IR reuse it? |
| **X5-Q6** | For D-g: is non-callout prose in the concept pages normative? |

## Acceptance

Complete when we can say whether `Invariant` has identifiable members, how a node type is assigned to a marked statement, which document wins when two disagree, and what fraction of R3.7's dependency edges already exist in prose.

---

## Findings

### X5-Q1 / X5-Q2 — ACS already documents this taxonomy, and it is an altitude rule

`concepts/README.md` is not prose about concepts. It is **the spec's own editorial policy for where normative content lives**:

> **Cross-cutting invariants** (true across pillars) are defined here and tagged **(normative)**. They belong above the pillars because that is where they are true. *e.g. "`Intent.parsed` MUST NOT be modified by the LLM or by data crossing an untrusted channel."* — `concepts/README.md:11`

> When you add a concept, hoist the invariant and leave the mechanics. If a requirement is restated in two pillars, or buried in one but relied on by another, it is at the wrong altitude. — `concepts/README.md:14`

> Every page carries the canonical definition, any cross-cutting invariants tagged **(normative)**, and a **Referenced by** footer pointing into the pillars that consume the concept. The graph is navigable in both directions. — `concepts/README.md:31`

And the pillar side states the split from its own end:

> **Intent immutability enforcement (normative).** **The invariant is defined in [Concepts › Intent]** […] **The framework MUST enforce it**: any attempt to modify `Intent.parsed` […] MUST be ignored or rejected — `specification.md:241`

> The mechanics of the ASK flow live in the Instrument pillar; **the invariant (that this is the *only* path) lives here.** — `concepts/intent.md:23`

> The framework's **enforcement and audit obligations** are specified in [§8.4]. — `concepts/intent.md:15`

**ACS is already a three-altitude document**: `concepts/` carries canonical **Definitions** and cross-cutting **Invariants**; the pillars carry the enforcement **Requirements** that maintain them. The IR's taxonomy is not imposed on the spec — it is *discovered in it*, and the authors wrote down the rule.

Identified Invariants with no enforcing-obligation content of their own:

| Invariant | Source | Enforced by |
|---|---|---|
| `Intent.parsed` is fixed once established | `intent.md:13` | `specification.md:241` (§8.4) |
| An approver's `intent_extension` is the *only* path to widen `Intent.parsed` | `intent.md:21` | `specification.md:271` (§9.1) |
| The framework, not the LLM, assigns `origin`, `source_id`, `derived_from` | `provenance.md:27` | `specification.md:202` (§7.2) |
| `derived_from` lineage is the union of the lineage of its inputs | `provenance.md:19` | §7, §8.3 |
| A deterministically attached fact is never a producer claim | `trust.md:27` | §7.1 |
| The rungs do not collapse — asserted is not attested | `trust.md:25` | §7.1, §10 |

**`Invariant` has members. D-h resolves toward extracting them now.**

### X5-Q3 — The callout marks "normative", not "invariant"

The ten `> **… (normative).**` callouts found in X3 are a **mix** of node types:

| Callout | Actual type |
|---|---|
| `intent.md` Intent immutability | Invariant |
| `intent.md` The only conformant path to widen Intent | Invariant |
| `provenance.md` Provenance is framework-assigned | Invariant |
| `provenance.md` Lineage spans derivation | Invariant |
| `trust.md` The rungs do not collapse | Invariant |
| `trust.md` Deterministic attachment is not a producer claim | Invariant |
| `agents.md` Decision logging — *"A Guardian MUST log every decision…"* | **Requirement** |
| `agents.md` Approver authentication — *"The Guardian MUST verify…"* | **Requirement** |
| `session-lifecycle.md` Intent derivation is auditable — *"the audit chain MUST record…"* | **Requirement** |
| `identity.md` No mandated mechanism — *"ACS mandates no authentication mechanism"* | **neither** (see X5-Q2b) |

So the extractor can find candidates mechanically, but **node type is per-provision editorial judgment**. That is the right division: the tool marks, the editor types.

Worth noting for the spec editors rather than for the IR: three of these callouts are obligations on the Guardian sitting at concepts altitude, which by `README.md:14`'s own rule ("hoist the invariant and leave the mechanics") is the wrong altitude. The IR will surface that as data rather than argue it.

### X5-Q2b — A fourth class the taxonomy has no home for

**19 statements assert that ACS imposes no requirement.** Not "we can't test this" — *"there is nothing here to test, deliberately."*

| Statement | Source |
|---|---|
| "Authentication mechanism declared in handshake; spec mandates none." | §11 |
| "`tenant_id` reserved as an optional envelope field. No isolation rules in v0.1." | §14 |
| "ACS does not put this declaration on the wire in v0.1; it is part of the Guardian's policy bundle." | §9.2 |
| "ACS v0.1 defines no in-band key-exchange" | §10 |
| "Whether a Guardian can attach mid-flight to a session that started unguarded is undefined in v0.1" | §4.1 |
| "`protocols/A2A/*` is reserved […] no normative wrapping semantics are defined in v0.1" | `hooks.md:35` |
| "v0.1 does not require Guardians to populate it" (`trust`) | §7.1 |
| "ACS-Core does NOT require: field-level Provenance objects, Trace event emission, AgBOM…" | `conformance.md:28` |
| "It does NOT assert that a deployment's policies are strict […] A permissive Guardian is a conformant but permissive deployment, not a violation." | `conformance.md:30` |
| "**No mandated mechanism (normative).** ACS mandates no authentication mechanism." | `identity.md:21` |
| plus the whole §15 *Out of Scope (Deferred)* table — 10 rows | §15 |

These are **normative** — `identity.md:21` is explicitly tagged so — and they are not Informative, because Informative means "ignored by conformance" while these actively *constrain the verifier*. They are the difference between:

- **`non-testable`** (R4.4): ACS requires something, and no trace can falsify it. §12.2's prompt-construction rules.
- **deliberately unspecified**: ACS requires nothing here. §14's multi-tenant isolation.

A verifier that conflates the two either invents requirements ACS never made, or hides the spec's deliberate silences behind the same label as its blind spots. `conformance.md:30` is the sharpest case: *"A permissive Guardian is a conformant but permissive deployment, not a violation"* — that sentence exists precisely to stop a verifier from reporting a violation, which makes it a first-class input to the verifier rather than commentary.

**Recommendation: a fifth node type, `Exclusion` (`ACS-EXC-NNN`).** This is an addition beyond the four types the shaping doc declared, so it is called out as such. Three reasons it should be a type rather than an attribute:

1. **Citable.** An implementer wants to point at *"ACS-EXC-0004: multi-tenant isolation is unspecified in v0.1"* when explaining a design choice to an auditor.
2. **It has a lifecycle.** Every §15 row is "deferred to v0.2." When v0.2 specifies one, the Exclusion is `superseded_by` the Requirements that replace it — exactly the R2.5/R2.3 machinery, and a genuinely useful thing to be able to diff across versions.
3. **It is what generalizes R4.7.** R4.7 currently names one case (policy strictness ≠ protocol conformance). `Exclusion` makes the whole class mechanical instead of a single remembered caveat.

### X5-Q4 — The spec supplies its own precedence rule

X3 found the same obligation stated in two documents and asked which wins. The answer was already written:

> **Migration note.** These pages are being established as the source of truth. The pillar specifications still carry some of these definitions inline; those will be updated to reference these pages rather than restate them. **Until that pass lands, treat these pages as canonical where they disagree with a pillar's inline copy.** — `concepts/README.md:33`

So **R2.9's `restates` relation has a direction**: the `concepts/` provision is authoritative, the pillar's inline copy is the restatement. X3's finding — approver authentication in both `specification.md:257` and `agents.md:21` — is not an accident, it is a **known, in-progress migration the authors have declared**.

Which turns the cross-document agreement check (E9.7) into something more useful than a lint: **it enumerates exactly which inline pillar copies still need to be replaced by references.** That is the migration `README.md:33` promises, as a worklist, generated. A spec editor gets a to-do list they currently have to find by hand.

### X5-Q5 — A third of the dependency graph is already authored

**Eight of nine concept pages carry a `Referenced by` footer** pointing into the pillar sections that consume the concept:

| Page | Referenced by |
|---|---|
| `trust.md` | Instrument §7, §10, §8; conformance ACS-Crypto/Audit/Provenance; Trace events |
| `provenance.md` | Instrument §7, `preCompact` laundering guard in hooks; Trace extend_ocsf |
| `intent.md` | Instrument §8, §9; Trace events |
| `identity.md` | Instrument `user_identity`, Approver identity §9, handshake; Trace extend_ocsf |
| `capability.md` | Instrument `Intent.parsed` check, `policy_data`; Inspect `tool.capability` |
| `session-lifecycle.md` | Instrument §8, `steps/*`, lifecycle hooks; Trace events |
| `skill.md` | Instrument skill hooks; Inspect `skill` component type |
| `agents.md` | Instrument hooks/dispositions/ASK §9; Trace events |

That is **R3.7's `depends_on` graph, authored in prose, in the reverse direction** (Definition/Invariant → the Requirements that consume it). The IR can seed `depends_on` from these footers rather than deriving all of it from scratch, and can then lint the two against each other — a footer pointing at a section with no provision depending back on it is either a missing edge or a stale footer.

**This is the decisive argument against deferring.** Deferring `Invariant` means declining edges that already exist and would have to be re-derived later.

### X5-Q6 — D-g answered by the same sentence

`README.md:31` says every page carries *"the canonical definition, any cross-cutting invariants tagged (normative), and a Referenced by footer."* So within a concept page:

- **callouts** → Invariants (and, per X5-Q3, sometimes Requirements)
- **non-callout body prose** → the canonical **Definition**. It is normative — it is what §7 and §8.4 delegate to.
- **`Referenced by` footer** → dependency edges, not a provision
- **`README.md` itself** → editorial policy about the spec's own structure. Informative for conformance, and the *source of the taxonomy* rather than a source of provisions.

All eight concept pages are in the corpus, including `capability.md` and `skill.md`, which have no callouts but do carry definitions and footers.

---

## Resolution

**D-h resolved: extract `Invariant` in the first pass.** It has at least six identifiable members, the spec's own editorial policy defines the category and its altitude, and eight `Referenced by` footers already encode the dependency edges that retrofitting would force us to re-author.

**D-g resolved: all eight concept pages are in the corpus.** Callouts are Invariants (or Requirements — editorial judgment per X5-Q3); non-callout body prose is the canonical Definition and is normative; `concepts/README.md` is the taxonomy's source, not a provision source.

**New: a fifth node type, `Exclusion` (`ACS-EXC-NNN`)** — 19 statements assert ACS requires nothing in some area, which is distinct from Informative (ignored by conformance) and from `non-testable` (required but unobservable). Flagged as an addition beyond the four types originally declared.

**Requirements this produces:**

- **R1.4 updated** — five node types, not four.
- **R2.9 gains a direction** — the `concepts/` provision is authoritative; the pillar copy is the restatement, per `concepts/README.md:33`.
- **New R4.8** — a deliberate non-requirement is represented distinctly from an untestable one. The verifier never reports a violation in an area ACS leaves open, and the report distinguishes *"ACS says nothing here"* from *"we cannot observe this."*
- **New R6.6** — the cross-document agreement check emits the migration worklist `concepts/README.md:33` promises: which inline pillar copies still need replacing by references.
- **E1.3 gains a seed source** — `depends_on` is seeded from `Referenced by` footers and linted against them in both directions.

**No slicing constraint.** Unlike X4, nothing here changes what a slice can demo. It changes how many node types slice 1 extracts and where it looks, both of which are scope-within-a-slice rather than boundaries between slices.
