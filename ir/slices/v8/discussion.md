# Discussion draft (E11.1, U28)

Post to <https://github.com/GenAI-Security-Project/agent-control-standard/discussions> under the `afogel` identity. No tool attribution anywhere in the text (shaping doc D-f). The five worked provisions below are the ones `ir/dist/markers-poc.patch` marks; the patch is attached as the proof-of-concept PR once the mechanism has feedback.

Category: Ideas. Suggested title: **Stable provision anchors in the spec: a proposal, with five worked examples**

---

## Proposal: stable IDs for every normative provision, as invisible anchors in the Markdown

ACS v0.1.2 carries 208 RFC 2119 keyword occurrences across 19 normative documents. Today the only way to cite one is by section number and quotation, and neither is stable across an edit: a renumbered section or a reworded sentence breaks every conformance test, audit finding and implementation comment that pointed at it, and nothing reports the break.

I am proposing that each normative provision get a permanent identifier, carried in the source as an HTML anchor and a closing comment around the provision's text:

```markdown
<a id="acs-req-0007"></a>Required at session start, before any hook traffic.<!--/acs-req-0007-->
```

Rendered, nothing changes. The sentence reads exactly as it does now, and `…/spec/instrument/specification/#acs-req-0007` becomes a deep link to it. I have built the site with MkDocs from a patched checkout and the repository's own guards (`tests/test_spec_structure.py`, `tests/test_hook_taxonomy.py`) pass unchanged; the anchor is in the HTML, the closing comment is preserved as a comment, and no marker text is visible.

### What the IDs make possible

I have been maintaining a catalog against the pinned v0.1.2 text that gives every provision a type (Requirement, Definition, Invariant, Exclusion), an actor, a profile, and, where the wire or the Guardian's records can falsify it, a machine-checkable predicate. With IDs in the source, the whole chain is mechanical:

1. **prose → ID**: the marked span is the provision's text; a hash of it is stored with the catalog record, so any edit to the sentence flags the record for review, and anything that depends on the record is flagged with it.
2. **ID → predicate**: a Datalog rule over a fixed vocabulary of facts read from the envelope log (and from the Guardian's own records, where the obligation is about those).
3. **predicate → rule**: the rule compiles to a Soufflé program an auditor can run with stock Soufflé over a directory of `.facts`, and to an in-process evaluator. CI checks that the two engines agree on shared fixtures.
4. **rule → tests**: conformance fixtures cite provision IDs and nothing else, so a spec change reaches the tests that exercise it by ID, never by text search.

The catalog is not what I am proposing to upstream here. The proposal is only the anchors, because they are the one part that has to be in the spec source to be stable.

### Five worked provisions

Each shows the marked prose, the record, the rule, and what the tests do with it. They were chosen to come from different families.

#### 1. A wire obligation on the Observed Agent: `ACS-REQ-0007`

`spec/instrument/specification.md` §4, marked:

```markdown
<a id="acs-req-0007"></a>Required at session start, before any hook traffic.<!--/acs-req-0007-->
```

Record: actor `observed-agent`, profile `acs-core`, obligation, evidence class `wire`.

Rule:

```
violation(Seq, Session, Method) :- hook(Seq, Session, Method), not handshake_before(Session, Seq).
handshake_before(Session, Seq) :- handshake(H, Session), hook(Seq, Session, _), H < Seq.
```

Test: the violating fixture fires `steps/toolCallRequest` at seq 2 and the handshake at seq 3; both engines derive `ACS-REQ-0007 · 2 · session-violating|steps/toolCallRequest`. On a real envelope log the report reads:

```
### ACS-REQ-0007: Handshake precedes any hook traffic
- subject Seq=1; witness Session=0f8fad5b-…, Method=steps/userMessage
  - hook(1, 0f8fad5b-…, steps/userMessage)
```

#### 2. A profile-scoped obligation with a recursive rule: `ACS-REQ-0010`

§7.1, marked:

```markdown
<a id="acs-req-0010"></a>For data with `origin: agent_generated`, the framework MUST compute `trust` as the minimum trust of the entries in `derived_from` (monotonicity rule).<!--/acs-req-0010-->
```

Record: actor `framework`, profile `acs-provenance`, depends on `ACS-DEF-0002` (the trust levels) and `ACS-REQ-0009` (lineage stays within the session). A session that did not negotiate `acs-provenance` is never judged against it.

Rule (the lineage closure carries the path so the finding can show it):

```
violation(Seq, Pid, Ancestor, Path, Level, AncestorLevel) :-
    trust(Seq, Pid, Level), provenance(Seq, _, Pid, "agent_generated"),
    ancestor(Pid, Ancestor, Path), trust(_, Ancestor, AncestorLevel),
    trust_rank(Level, Rank), trust_rank(AncestorLevel, AncestorRank), Rank > AncestorRank.
ancestor(Pid, Parent, Path) :- derived_from(_, Pid, Parent), Path = cat(Pid, "<-", Parent).
ancestor(Pid, Ancestor, Path) :- derived_from(_, Pid, Parent), ancestor(Parent, Ancestor, Rest), Path = cat(Pid, "<-", Rest).
```

Test: `prov-agent` is `agent_generated` and `trusted` while its ancestor `prov-user-input` is `untrusted`; the finding's witness is `prov-user-input|prov-agent<-prov-user-input|trusted|untrusted`.

#### 3. An obligation whose check is ordinary code, not Datalog: `ACS-REQ-0013`

§8.2, marked as one span from the formula through the closing paragraph:

```markdown
<a id="acs-req-0013"></a>`entry_hash = lowercase-hex(SHA-256(content_bytes || prev_hash_bytes))` where:

1. `content_bytes` is the UTF-8 encoding of the RFC 8785 (JCS) canonicalization …
2. `prev_hash_bytes` is the raw 32-byte decoding of `previous_hash`, …
3. `||` denotes byte concatenation.

Conformant Guardians MUST compute `entry_hash` this way; … Alternative canonicalization schemes are not permitted in v0.1.<!--/acs-req-0013-->
```

Record: actor `guardian`, profile `acs-core`, evidence class `guardian-state`, and two schema references pinned by hash (`context-entry.json#/properties/entry_hash`, `…/previous_hash`) so a schema change flags the record too.

The rule is one line, because SHA-256 and JCS are computed outside Datalog:

```
violation(Session, EntryId, Claimed, Recomputed) :-
    context_entry(Session, EntryId, _, Claimed), entry_hash_recomputed(EntryId, Recomputed), Claimed != Recomputed.
```

`entry_hash_recomputed` is computed by the verifier from the Guardian's exported ContextEntry objects, following the section exactly. Test: entry `entry-1` claims `hash-claimed`, recomputation gives `hash-recomputed`.

#### 4. An invariant on a concept page: `ACS-INV-0001`

`concepts/intent.md`, marked inside the callout:

```markdown
> <a id="acs-inv-0001"></a>**Intent immutability (normative).** Once an Intent is established, `Intent.parsed` MUST NOT be modified … via the ASK flow.<!--/acs-inv-0001-->
```

An invariant is not an obligation on any one party, so it carries no rule of its own. It is verified through the Requirements that enforce it. `ACS-REQ-0011` (§8.4, the Guardian's check on `Intent.parsed`) declares `depends_on: [ACS-INV-0001]`. The demonstration I find most useful: change one word in this callout, and the tooling lists `ACS-REQ-0011` and the Requirement downstream of it as needing review, with the tests that cite them, even though their own text did not change.

#### 5. A deliberate non-requirement: `ACS-EXC-0001`

§14, marked:

```markdown
<a id="acs-exc-0001"></a>`tenant_id` reserved as an optional envelope field. No isolation rules in v0.1.<!--/acs-exc-0001-->
```

Record type Exclusion. A conformance report lists it on an exclusion roster ("ACS deliberately requires nothing here") so that "not checked because unspecified" is distinguishable from "not checked because no trace can falsify it". Giving the gap an ID means a future version that specifies tenant isolation retires `ACS-EXC-0001` explicitly, instead of the gap disappearing unrecorded.

### The mechanism, in detail

- **ID form:** `ACS-{REQ|DEF|INV|EXC}-NNNN`, four digits, allocated once and never reused. A removed provision keeps its number in a tombstone list; a rewritten one gets a new number if the meaning changed.
- **Anchor form:** `<a id="acs-req-0007"></a>` immediately before the provision text and `<!--/acs-req-0007-->` immediately after. Both are inline; neither adds a line. Spans do not nest or overlap. A provision that spans blocks (a stem sentence and its list, as in §8.2) is one span.
- **A placement rule, found by applying the patch:** an anchor never precedes a list, quote, table or heading marker on its line, because that pushes the marker off the line start. The tooling refuses such a placement.
- **What is not in the source:** the record (actor, profile, predicate, dependencies) is kept outside the spec and joins on the ID. The spec carries only the anchors.
- **Editorial cost:** an author who rewords a marked sentence does nothing new; the hash comparison happens downstream. An author who adds a new normative sentence adds an anchor with the next number. A lint that fails on an RFC 2119 keyword with no anchor is available if the project wants it in CI.

### What I am asking

1. Whether the mechanism is acceptable in principle: invisible inline anchors, one per provision, with IDs of this form.
2. Whether a small proof-of-concept PR marking exactly the five provisions above is the right next step. I have it ready.
3. If both, whether a single mechanical PR for the remaining 150 (14 files, one-line insertions only, no wording changes) is preferred over batching by document.

Two small findings from the exercise, reported separately from the proposal: `hooks.md` uses `MAY NOT`, which is not an RFC 2119 term; and `defer-details.json` does not require `timeout_decision`, which §6 says DEFER MUST include.
