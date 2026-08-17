---
shaping: true
---

# X3 Spike: Marker span rule and table-cell viability

Spike for [`normative-ir-shaping.md`](./normative-ir-shaping.md) parts **E2.2** and **E2.3**. Blocks R1.7, R1.8, R2.5.

## Context

Shape E addresses each normative provision with an invisible `<a id="acs-req-017"></a>` anchor placed in the spec prose, and generates the mechanical half of the IR — `text`, `text_hash`, `level` — by extracting from the marked corpus (E4). Two mechanisms are described but not understood:

- **E2.2, the span rule.** An anchor marks where a provision *starts*. Nothing yet says where it *ends*. Without an end, there is no `text` and no `text_hash`, so R2.5 (generated, never hand-maintained) and R1.8 (one sentence, several provisions) both fail.
- **E2.3, table cells.** A disproportionate share of ACS's keyword-free normative content lives in table cells — §6's *Required fields*, §6.1's and §7's *Required* columns, §10.1's algorithm registry, §17.1's error registry. If raw HTML anchors do not survive Python-Markdown's table processing, the hardest half of the census (R1.7) has no mechanism at all.

Both are cheap to answer empirically and expensive to guess at. Guessing wrong is the failure mode the source named: discovering at provision 150 that the model cannot express something, and having to reinterpret 149 entries.

## Goal

Learn, for every structural position a normative statement actually occupies in the ACS corpus, how a marker attaches to it and how far its text span runs — and which positions need a mechanism beyond a single opening anchor.

## Questions

| # | Question |
|---|----------|
| **X3-Q1** | What block types contain the 203 RFC 2119 keyword occurrences, and in what proportion — paragraph, table cell, list item, heading, blockquote, code fence? |
| **X3-Q2** | How many normative statements share a block with another normative statement? How many share a *sentence*? |
| **X3-Q3** | Does `<a id="…"></a>` survive Python-Markdown under ACS's exact extension set — in a paragraph, mid-sentence, in a list item, in a table cell, and in a table cell that also carries inline code and a link? |
| **X3-Q4** | Is the rendered marker visually invisible — no stray glyph, no whitespace shift, no inherited link styling? |
| **X3-Q5** | Does *anchor to next-anchor-or-block-end* produce a correct span across the corpus, or are explicit end markers needed — and for which cases specifically? |
| **X3-Q6** | How is a provision spanning more than one block addressed — a stem sentence plus a bulleted list (§8.1, §12.2, §13)? |
| **X3-Q7** | Does the extractor need sentence segmentation? If so, where does it fail on ACS prose — `§` references, decimals, abbreviations, inline code containing periods, algorithm names like `ML-DSA-65+ECDSA-P256`? |

## Acceptance

Complete when we can describe, for every structural position normative statements occupy in this corpus, how a marker attaches, how far the span runs, and what the extractor must do to produce a stable `text_hash` — including an enumerated list of the cases a single opening anchor cannot handle and what mechanism each needs instead.

---

## Findings

Method: a structural census script over `spec/acs/docs/**.md` at `c259f57`, plus a minimal MkDocs project reproducing ACS's exact `markdown_extensions` block from `mkdocs.yml`, fed real ACS excerpts with markers inserted in every structural position. Both are reproducible; the census script is at `scratchpad/census.py` and the render harness at `scratchpad/render/`.

### X3-Q1 — Where the 203 occurrences live

| Block type | Occurrences | Blocks | Share |
|---|---:|---:|---:|
| paragraph | 145 | 85 | 71.4% |
| list item | 33 | 26 | 16.3% |
| table cell | 17 | 15 | 8.4% |
| blockquote | 8 | 6 | 3.9% |
| heading | 0 | 0 | — |
| code fence | 0 | 0 | — |
| **Total** | **203** | **132** | |

**Zero occurrences inside inline `` `code` `` spans**, so there is no ambiguity about whether a keyword is being *used* or *mentioned*. Four block types, not six, and headings never carry normative force.

### X3-Q2 — Multi-provision blocks and sentences

| Granularity | Carrying >1 occurrence | Histogram |
|---|---|---|
| Blocks (132 with keywords) | **49 (37%)** | 1→83, 2→30, 3→16, 4→3 |
| Sentences (168 with keywords) | **30 (18%)** | 1→138, 2→26, 3→3, 4→1 |

**A block-granular marker is insufficient for 37% of blocks; a sentence-granular marker for 18% of sentences.** This is the empirical case for R1.8 and the reason a mid-paragraph-placeable marker is required rather than merely convenient.

**Caveat that changes the census design.** An occurrence count is an *upper bound* on provisions, not a provision count. `conformance.md` has *"A Guardian MAY refuse a session if the client does not declare a profile the Guardian's policy requires (e.g. a Guardian whose policy needs provenance MAY refuse a client that does not declare `acs-provenance`)"* — one rule plus a parenthetical restatement of itself, two occurrences. The provision census therefore needs an exclusion reason **`restatement_of: ACS-REQ-NNN`** alongside the non-testable and informative reasons, or the count will imply provisions that do not exist.

### X3-Q3 / X3-Q4 — Marker survival and invisibility

All **21** raw `<a id="…"></a>` markers survived to HTML, in all eight positions tested: paragraph mid-sentence (three in one sentence), immediately before an inline code span, table cell with heavy inline code, table cell containing a link, table cell plain, unordered list item, ordered list item, nested list item, blockquote, and inside a bold lead-in.

Rendered form is `<a id="mk-para-1"></a>` — empty element, **no `href`**, no text node. No glyph, no whitespace shift, and no link styling, because Material's link rules key off `href`. R7.5 holds.

**attr_list is disqualified, for two independent reasons.**

| attr_list form | Paragraph | Table cell |
|---|---|---|
| `{ #id }` trailing, same line | **leaks `{ #id }` as visible page text** | `<td id>` created |
| `{#id}` trailing, same line | **leaks `{#id}` as visible page text** | `<td id>` created |
| `{: #id }` trailing, same line | **leaks `{: #id }` as visible page text** | `<td id>` created |
| `{: #id }` on its own next line | `<p id>` created | n/a |

1. **Granularity.** Where it works it attaches to the whole block — `<p id=…>` or `<td id=…>` — so it can address one provision per paragraph or per cell. §6.1's `policy_references` cell carries three; §10.3's sentence carries four.
2. **It fails loudly in the published output.** Three of four paragraph forms render the braces as visible text. An editor who puts the attribute list on the wrong line publishes `{ #acs-req-017 }` on agentcontrolstandard.ai. Raw `<a id>` has no such failure mode.

**This corrects Fact 2 in the shaping doc**, which asserted `attr_list` markers "render as real, deep-linkable HTML anchors." True only for the own-line block form, and never at the granularity ACS needs.

### X3-Q5 — Block-end termination over-captures

| Block class | Count | Ends in non-normative prose |
|---|---:|---:|
| Exactly 1 keyword occurrence | 83 | **34 (41%)** |
| More than 1 occurrence | 49 | **12 (24%)** |
| **All keyword-bearing blocks** | **132** | **46 (35%)** |

Over-capture is the common case, not the exception. Concrete instances:

| Provision | Prose that block-end termination would absorb |
|---|---|
| `trust.md` — "A Guardian MUST NOT treat an asserted fact as attested." | "The basis of a fact is part of the fact; relying on a fact above its actual basis is an error." |
| `agents.md` — "An Approver MAY be human, agent, or service." | "It receives an ACS-shaped request and returns an ACS-shaped decision." |
| `conformance.md` — "A v0.1.0-conformant deployment MUST implement ACS-Core." | "ACS-Core comprises:" |
| `intent.md` — "Once an Intent is established, `Intent.parsed` MUST NOT be modified…" | "It may grow only through approver action via the ASK flow." |

The four cases are not the same kind of thing, and that is the point: `trust.md`'s tail is rationale, `agents.md`'s is description, `conformance.md`'s is a stem introducing a list, and `intent.md`'s is arguably *normative continuation without a keyword*. Deciding which is which is editorial judgment, and no rule the extractor can apply gets it right 46 times.

**Consequence: the terminator is mandatory, not conditional.** A "add a terminator where needed" rule would place an undetectable judgment on the editor in 35% of blocks. A mandatory pair is uniform, and unpaired anchors are lintable.

### X3-Q6 — Multi-block provisions

`<!--/acs-req-NNN-->` HTML comments survived in **all five** positions tested: paragraph, table cell, list item, blockquote, and **spanning blocks** — start anchor in the stem paragraph, terminator at the end of the final ordered-list item:

```html
<p><a id="t-multi"></a>The Guardian MUST instead substitute one of:</p>
<ol>
<li><code>DEFER</code> with <code>timeout_decision: "deny"</code>.</li>
<li><code>DENY</code> with <code>reason_codes: ["approver_unavailable"]</code>.<!--/t-multi--></li>
</ol>
<p>Trailing explanatory paragraph that must NOT be captured.</p>
```

The trailing paragraph is correctly excluded. This is §9.2's actual shape, and §13's, and §12.2's.

An HTML comment is the right terminator rather than a second `<a id>`: it is invisible by construction, and it keeps the `id` namespace 1:1 with provisions, so every `acs-req-NNN` anchor in the rendered spec is a citable provision and nothing else. The asymmetry is principled — a provision's **start** must be addressable, its **end** need not be.

An inline `<span id="…">…</span>` wrapper also works, but only within a single block: wrapping a paragraph plus a list requires `md_in_html`, which is not in ACS's extension set. Rejected for that reason.

### X3-Q7 — Sentence segmentation is not needed

**Not required by the mechanism.** With an explicit start anchor and an explicit terminator, span boundaries are stated, never inferred, so the extractor never segments sentences.

This matters because segmentation on this corpus is genuinely fragile: the census script needed guards for `§10.3`-style references, decimals inside `300000`-adjacent prose and version strings, six abbreviations (`e.g`, `i.e`, `cf`, `vs`, `approx`, `Sec`), and algorithm names like `ML-DSA-65+ECDSA-P256`. That fragility is now confined to one analysis script and is absent from the production extractor.

---

## Two corpus discoveries

Neither was a spike question; both surfaced while classifying blocks and both change the shaping.

### 1. `concepts/` already has a normative-callout convention

Ten normative statements across six concept files use an explicit blockquote callout: `> **Title (normative).** …`

| File | Callouts |
|---|---|
| `concepts/provenance.md` | *Lineage spans derivation*; *Provenance is framework-assigned* |
| `concepts/intent.md` | *Intent immutability*; *The only conformant path to widen Intent* |
| `concepts/agents.md` | *Decision logging*; *Approver authentication* |
| `concepts/trust.md` | *The rungs do not collapse*; *Deterministic attachment is not a producer claim* |
| `concepts/session-lifecycle.md` | *Intent derivation is auditable* |
| `concepts/identity.md` | *No mandated mechanism* |

The authors already separated normative from explanatory prose in these files, mechanically and consistently. **D-g gets substantially cheaper**: the callouts are a discoverable anchor for the definition-bearing statements, so including `concepts/` does not mean hand-reading every sentence. It also settles `trust.md` — *"A Guardian MUST NOT treat an asserted fact as attested"* is unique normative force that `specification.md` §7.1 does not restate, so `trust.md` is in the corpus.

### 2. The same obligation is stated in two documents

| Obligation | Locations |
|---|---|
| Approver authentication required; Guardian verifies approver identity | `specification.md:257` **and** `concepts/agents.md:21` |
| Approvers must not return ASK | `specification.md:259` **and** `concepts/agents.md:23` |

Both are in `specification.md`'s **orphaned §9 preamble** — the three statements stranded under §8.6 by the missing `## 9.` heading. So the content survives in `agents.md` despite the structural defect in the spec proper.

Intent immutability is **not** a duplicate, and the difference is substantive:

- `concepts/intent.md:13` — *"`Intent.parsed` MUST NOT be modified by the runtime LLM, by tool outputs, or by any data crossing an untrusted channel."* — a prohibition on the data.
- `specification.md:241` — *"any attempt to modify `Intent.parsed` … MUST be ignored or rejected, and SHOULD be recorded as an audit event."* — an obligation on the framework to *handle attempts*, plus a `SHOULD` on auditing.

Two provisions with a dependency, not one provision twice. Distinguishing them needs the `Requirement` / `Definition` split (R1.4) and `depends_on` (R3.7) — which is independent evidence that the taxonomy is carrying weight.

**New IR obligation.** Cross-document restatement needs an explicit relation. Either one location is authoritative and the other carries `restatement_of: ACS-REQ-NNN` (the census exclusion reason from X3-Q2), or both are provisions the IR asserts must agree. The second is more valuable: **an IR can mechanically check that two statements of the same obligation have not drifted apart**, which is a class of spec defect nothing currently catches.

---

## Resolution

**E2.2 span rule — resolved.** A provision's text runs from its `<a id="acs-req-NNN"></a>` anchor to its `<!--/acs-req-NNN-->` terminator. Both are mandatory. There is no implicit boundary rule, therefore no silent over- or under-capture, and no sentence segmentation. Unpaired anchors, unmatched terminators, and nesting are lint failures.

**E2.3 table cells — resolved.** Raw `<a id>` and `<!--/id-->` both work in table cells, including cells carrying inline code and links, and multiple provisions per cell are addressable. §6.1's three-provision cell is expressible.

**Marker cost for the bulk PR (E11.3):** ~200 provisions × 2 markers ≈ 400 insertions, all mechanical, none visible in the rendered site.

**Cases a single opening anchor cannot handle, and their mechanism** — the enumerated list the Acceptance criterion asked for:

| # | Case | Mechanism |
|---|---|---|
| 1 | Block ends in rationale, description, or a list stem (35% of blocks) | Mandatory `<!--/id-->` terminator |
| 2 | Several provisions in one sentence (18% of sentences; §10.3 carries four) | Anchor placed mid-sentence; terminator ends each span |
| 3 | Several provisions in one table cell (§6.1 `policy_references`) | Anchor + terminator inline in the cell |
| 4 | Provision spanning a stem paragraph and a following list (§9.2, §12.2, §13) | Anchor in the stem, terminator in the final list item |
| 5 | Normative continuation with no keyword (`intent.md`'s "It may grow only through…") | Terminator placed after it, by editorial judgment, stated once |
| 6 | Restatement of another provision (`conformance.md`'s parenthetical) | Not marked; census exclusion `restatement_of` |
| 7 | Cross-document restatement (`agents.md` ↔ orphaned §9) | Both marked; IR asserts agreement |

**Acceptance met.** Every structural position is characterized, the span rule is stated, the extractor's requirements are known, and the cases needing more than an opening anchor are enumerated with a mechanism each.

