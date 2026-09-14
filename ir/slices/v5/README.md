# V5: Predicates compile, and both engines agree

**Demo:** `bun run ir compile` turns twenty-one IR predicates into two artifacts, the published `ir/dist/rules.dl` and the evaluator's `ir/.build/rules.json`. `bun run ir differential` runs the in-process evaluator and Soufflé 2.5 over the same two fixtures: **identical violation sets**, 0 on the conformant session and 24 on the violating one. A deliberately weakened rule makes the check fail and prints the tuples only one engine derived.

**Master doc:** [`docs/shaping/normative-ir-slices.md`](../../../docs/shaping/normative-ir-slices.md) §V5, authoritative for this slice's scope.

**Affordances:** U5, U31, N30, N31, N32, N33, N34, N35, N36, N40 (as `verify --facts`), N41 (deferred to V6, see below), N44, N62, N63, S7, S8, S9, S14, S15, S16. Defined in [Detail E](../../../docs/shaping/normative-ir-shaping.md#detail-e-affordances).

**Stacked on V4.**

## The demo, captured

```
## Compile

28 provisions: 4 no-predicate, 21 compiled, 1 non-testable, 1 permission, 1 alias.
acs-ir compile: wrote ir/dist/rules.dl

## Differential (U31)

Soufflé: /usr/bin/souffle

### conformant: agree (evaluator 0, expected 0, souffle 0)

### violating: agree (evaluator 24, expected 24, souffle 24)
```

With the negation dropped from ACS-REQ-0004's rule in the evaluator's copy only (`ir/test/differential.test.ts` does this):

```
### violating: DIVERGE (evaluator 27, expected 24, souffle 24)
- only the evaluator, not Soufflé: ACS-REQ-0004	40	resolution_method
- only the evaluator, not Soufflé: ACS-REQ-0004	50	resolution_method
- only the evaluator, not Soufflé: ACS-REQ-0004	50	resolution_timeout_ms
- only the evaluator, not Soufflé: ACS-REQ-0004	50	timeout_decision
```

## X1 and X2, answered by building

The shaping doc left two mechanisms flagged: the fact vocabulary (E6) and the predicate language with its compiler (E7). Both were to be designed by putting twenty-odd semantically diverse provisions through a compiler, not by inspection. That is what this slice did.

**The vocabulary (S7, [`ir/vocabulary/relations.yaml`](../../vocabulary/relations.yaml)).** 44 relations over two scalar types, each tagged with where its tuples come from: `wire` (derived from the envelope log), `external` (hashes, JCS, signatures, schema validation: ordinary code, E7.1), `guardian-state` (the Guardian's own decision log and session context), `deployment` (configuration the verifier is told), `static` (fixed by the spec and shipped inside the program: the §6 required-fields table, the DEFER reason enum, the trust ranking, the content-bearing hook set). The external-fact boundary is therefore derived per provision, not authored: the compiler lists the non-wire relations each predicate reads.

**The language ([`ir/src/compile/predicate.ts`](../../src/compile/predicate.ts)).** Datalog rules as strings in the record's `predicate` block: atoms, `not`, the six comparators, `Var = expr` assignment, `cat` and `to_string`, and `count`. A `violation(subject..., witness...)` head plus helper relations. That is the entire language, because every construct is emitted twice and held equivalent. A construct only one engine had would be a construct nobody had checked.

**The compiler ([`ir/src/compile/compile.ts`](../../src/compile/compile.ts)).** Types every variable against the vocabulary, infers helper column types to a fixpoint, rejects unsafe rules (a negated or compared variable nothing binds), stratifies by SCC and refuses negation inside a cycle, and enforces N36: the violation head is exactly the declared subject then witness variables, both non-empty, all bound. A Requirement with neither a predicate nor a declared `inexpressible` reason does not compile (R3.1, R3.6). Helpers are renamed per provision so twenty-one predicates share one program without collision.

**Two targets, one authority (R3.3, R3.8).** `emitSouffleProgram()` writes the `.dl` an auditor runs with stock Soufflé over a directory of `.facts`; `rules.json` is the same typed program for the evaluator, which is a semi-naive fixpoint per stratum. Both produce the unified `violation(provision, subject, witness)` with values joined by `|`, which is what `differentialCheck()` compares, and what `expected.tsv` in each fixture pins so two engines cannot agree on a wrong answer.

## What the twenty-one provisions forced

| Provision | What it forced |
|---|---|
| ACS-REQ-0006 cascading deferrals | `count` aggregation and a `deployment` fact for the bound |
| ACS-REQ-0007 handshake first | a helper relation and a numeric ordering comparison over `seq` |
| ACS-REQ-0010 trust monotonicity | recursion with a path-carrying witness (`Path = cat(Pid, "<-", Rest)`), the static `trust_rank` table, and `>` over ranks |
| ACS-REQ-0013 chain hashing | the first `external` relation: `entry_hash_recomputed` is SHA-256 over JCS done in code, never in Datalog |
| ACS-REQ-0003 required fields | a static relation with seven tuples representing the §6 table |
| ACS-REQ-0014 unique `provenance_id` | a fingerprint relation, because "unique" means two distinct objects, not two mentions |
| ACS-REQ-0011 Intent fixed | three `guardian-state` snapshots (`intent_parsed`, `intent_established`, `intent_extension`); `Intent.parsed` is not on the wire after establishment |
| ACS-REQ-0024 restatement | `predicate: alias_of`, verified through the canonical copy; the compiler refuses an alias of anything but the restated provision |
| ACS-REQ-0019, ACS-REQ-0021 | the compiler refuses a predicate on a non-testable or a permission, and lists them by status instead (R4.4, R4.6) |

**Inexpressible count: zero, this time.** The vocabulary derived from these specimens expressed all of them. V7 is where `flagInexpressible()` runs over the other 180 occurrences, and a non-empty count there is expected.

## Decisions made here

- **Soufflé is an oracle and a deliverable, never a local dependency (X4, R3.9).** Local development needs only `bun install`. CI installs the pinned 2.5 `.deb` (SHA-256 verified) and runs both engines. Locally, `SOUFFLE=/path/to/souffle bun run ir differential` does the same, and the test that needs the oracle reports that it was not exercised rather than passing vacuously.
- **`count` counts distinct solutions of the aggregate body**, as Soufflé does. A wildcard column contributes each tuple.
- **The recursive lineage closure assumes a DAG.** A `derived_from` cycle would not terminate in either engine's path-carrying form. A cycle is itself a defect a future rule can report.
- **N41 `normalizeTrace()` is deferred to V6** with N42 and N43, because the wire relations are only useful once the external facts they join with exist. V5's fixtures are hand-authored `.facts`, which is the form the differential needs regardless.
- **S15 is emitted and unread.** `ir/.build/invariants.tla` lists the one Invariant with its enforcing Requirement; the TLA+ model is a later work stream (R6.2).

## Wires to later slices

- The test-coverage table (U14) is now populated: 24 of 28 provisions are cited by a fixture; N25 lints the same citations.
- `verify --facts <dir>` runs the evaluator over hand-written facts; `verify <trace>` over an envelope log, with profile scoping, modality application and evidence attachment (N41, N42, N43, N45 to N47), is V6.

## Not in this slice

No conformance report, no profile scoping, no exclusion roster. The verdicts exist as tuples. V6 adds the report that presents them.
