# V7: All 208

**Demo:** `bun run ir census` reports zero unbound occurrences. Every RFC 2119 occurrence in the pinned corpus is bound to a provision or excluded with a machine-readable reason, the provision index lists 155 provisions across all five node types, and `acs-ir verify` judges every profile.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V7, authoritative for this slice's scope.

**Affordances:** none new. E8 (the census) is the gate; E8.2 (authored exclusions) is the one piece of mechanism this slice added because the conversion needed it.

**Stacked on V6.**

## The demo, captured

```
totals:
  occurrences: 208
  bound: 163
  excluded: 45
  unbound: 0
```

The 45 exclusions: 11 by source status (occurrences in informative or editorial documents, as in V1) and 34 authored in `ir/census/exclusions.yaml`: 29 restatements of a provision carried elsewhere, 3 roadmap statements ("expected to promote PQC to RECOMMENDED"), 2 pieces of rationale that repeat a keyword without adding an obligation.

The catalog: 148 Requirements, 2 Definitions, 4 Invariants, 1 Exclusion. Compiled:

| status | count |
|---|---|
| compiled | 69 |
| permission | 39 |
| non-testable | 25 |
| inexpressible | 12 |
| no-predicate (Definitions, Invariants, the Exclusion) | 7 |
| alias | 3 |

The clean envelope log, under `acs-ir verify`:

```
pass 63, not-exercised 2, not-activated 23, permission 33, non-testable 17, inexpressible 10, exclusion 1, invariant 4, definition 2.

| profile | active obligations | met | unmet | unevaluated |
|---|---|---|---|---|
| acs-core | 58 | 58 | 0 | 0 |
| acs-provenance | 7 | 7 | 0 | 0 |
```

The 23 not-activated rows are the ACS-Audit, ACS-Inspect and ACS-Crypto provisions; the clean session negotiated neither, so they are reported as not activated (R4.3) rather than passed.

## What this slice delivers

**Every occurrence accounted for.** 127 new records and 127 new overlay entries, on top of V2's 28. The unbound count went from 174 to 0. R1.6 holds in the strict form: bound, excluded with a reason, or unbound, and the third set is empty.

**Authored exclusions (E8.2).** The slices doc expected the occurrence count to be an upper bound on provisions, not a count, and it was. The spec restates rules inside their own parentheticals ("deployments claiming ACS-Audit MUST populate `request_hash`" appears inside the sentence that already makes `request_hash` a SHOULD), talks about keywords, and describes roadmap intent in normative sources. `ir/census/exclusions.yaml` names each such occurrence by a verbatim quote and a reason from a closed set: `restatement_of` (with the provision that carries the rule), `mention`, `roadmap`, `rationale`. The census fails when a quote does not resolve, resolves more than once, or covers more than one keyword occurrence, so an exclusion cannot quietly swallow a second obligation. Spec-lint reads the same file: a keyword with neither a marker nor an exclusion is still a failure (N21).

**The vocabulary grew from 42 relations to 76.** The new wire relations restate what the normalizer can read from the log without judging it: signature algorithms per envelope and per session, request nonces, the intent parser's origin and scope mode, compaction entries and summaries, skill registration and load with digests, AgBOM components and their fields, error data, DEFER timeout decisions, modification fields, reason codes, the skew window. The new guardian-state relations are what a Guardian's dump carries: ContextEntry fields and step types, decision-log fields, agent audit events, agent step outcomes, whether an intent derivation was recorded. The new external relations are computed in ordinary code: timestamp-out-of-window, modification target overlap, the strict-mode schema check. The new deployment relations are two declared facts: whether policy requires provenance, and whether strict mode is forbidden.

**The inexpressible set is enumerated, as R3.6 requires.** Twelve provisions carry `predicate: {inexpressible: reason}` and are reported on the roster:

| provision | why no predicate |
|---|---|
| ACS-REQ-0029 | no relation records whether an envelope carried a field outside its schema, nor how the receiver treated it |
| ACS-REQ-0033 | needs a view across sessions of one deployment; one envelope log holds one session |
| ACS-REQ-0036 | whether replay- or ledger-backed policy state matters is a deployment judgment no relation records |
| ACS-REQ-0044 | the deployment's audit log has no kind for a malformed MODIFY; audit event kinds are deployment-defined |
| ACS-REQ-0045 | whether the agent acted before the decision arrived needs agent-side timing; the outcome relation carries what happened, not when |
| ACS-REQ-0057 | no relation records a policy override of the default trust mapping or the audit metadata that would carry it |
| ACS-REQ-0083 | the verifier implements HMAC-SHA256 only; a hybrid signature yields `unverifiable`, so component failure is not an available fact |
| ACS-REQ-0089 | no relation identifies which payload fields are resource identifiers; the hook schemas do not mark them |
| ACS-REQ-0109 | completeness of the hook stream can only be judged against an independent record of the agent's actions |
| ACS-REQ-0122 | `load_path` and `composed_skills` are not vocabulary relations |
| ACS-REQ-0128 | the conjunction of every acs-core provision; reported as the profile summary (U16), not as one predicate |
| ACS-REQ-0136 | component mutations that did not produce `agbom/changed` are, by definition, not in the log |

Each is a candidate for a later vocabulary addition, and each names what that addition would have to carry.

**Both engines still agree.** The conformant fixture derives nothing on either engine; the violating fixture derives 33 tuples on both, the 24 from V5 plus nine deliberate V7 breaches its README lists.

## Decisions made here

- **Non-testable records carry `predicate: null`, with the reason in the note.** The compiler refuses a predicate on a non-testable provision (R4.4), so the reason a provision cannot be falsified is prose on the record, not a predicate block.
- **Four allocated IDs are unused: ACS-REQ-0042, 0049, 0085, 0115.** They were allocated during the conversion for occurrences that turned out, on reading, to restate a provision already carried, and became exclusions instead. The counter is monotonic and they were never marked, so they are gaps, not tombstones.
- **A span that contains another provision's occurrence is split, not nested.** §8.1's SHOULD list item contains both the ACS-Audit MUST for `request_hash` and the `previous_hash` rule; ACS-REQ-0060 was narrowed to the clause before them so the applier's no-nesting rule (N2) holds.
- **The differential fixtures satisfy every profile.** The differential compares engines, not verdicts, so profile-scoped predicates fire as raw tuples there. Rather than filter, the conformant fixture now carries an `agbom/snapshot` before its hooks, both ACS-Crypto algorithms, and full ContextEntry and decision-log fields, and the violating fixture breaches a chosen few. Scoping stays in the report layer, where R4.3 puts it.
- **§7.2's default trust mapping is checked as a SHOULD on the wire.** A `user_input` object populated `untrusted` is reported against ACS-REQ-0027; a policy override (ACS-REQ-0056) would need the audit metadata the mapping rule cannot see, so an overriding deployment sees a RECOMMENDED-level finding, not a MUST failure.

## Findings for upstream, from this slice

- `hooks.md` uses `MAY NOT`, which is not an RFC 2119 term; the record for ACS-REQ-0113 reads it as the prohibition the sentence means.
- Whether the handshake request is itself signed under §10 is not stated; the per-session key is derived from the `session_id` the handshake establishes. ACS-REQ-0081 exempts it, with the question noted.

Both are added to the accumulated findings table in the slices doc.

## Not in this slice

The V8 upstream work: `acs-ir markers patch`, the Discussion, the proof-of-concept PR and the bulk marker PR. The overlay now holds the full catalog, so the bulk patch has its input.
