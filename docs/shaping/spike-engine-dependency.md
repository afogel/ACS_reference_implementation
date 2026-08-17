---
shaping: true
---

# X4 Spike: Datalog engine as a build dependency

Spike for open decision **D-i** in [`normative-ir-shaping.md`](./normative-ir-shaping.md). Constrains what any slice can demo on a laptop, and therefore blocks slicing.

## Context

Shape E's part **E7** compiles IR predicates to Soufflé. Soufflé is a C++ toolchain. This repo is Bun/TypeScript, and the sibling shaping doc's **R7.1** — *"Starts with one command on a laptop"* — is a Must-have for the reference implementation. If the IR's verify path needs a compiler the contributor must install, the IR either breaks that property or has no laptop demo, and either outcome changes what a first slice can show.

## Goal

Learn what a Datalog engine actually costs on each platform this repo already supports, what the repo's existing dependency posture really is, and whether Soufflé specifically is required by any requirement — so the engine choice is made on measured constraints rather than on the source recommendation's default.

## Questions

| # | Question |
|---|----------|
| **X4-Q1** | What does the repo require on a contributor's machine today, and does it already ship native code? |
| **X4-Q2** | How does Soufflé install on each platform — macOS arm64/x64, Linux x64/arm64, Windows? Prebuilt or source build? |
| **X4-Q3** | What is the actual fact volume a verify run processes? Does Soufflé's scale advantage apply? |
| **X4-Q4** | Is Soufflé's provenance/explanation facility — the source's stated reason for choosing it — required by R3.4, or replaceable? |
| **X4-Q5** | What in-process alternatives are reachable from Bun, and what do they cost in supply-chain and dialect terms? |
| **X4-Q6** | If the engine is not Soufflé locally, what is lost, and can it be recovered another way? |

## Acceptance

Complete when we can state, per platform, what a contributor must install to run `acs-ir verify`; whether that satisfies the sibling R7.1; which requirements depend on Soufflé specifically versus on Datalog semantics generally; and what the resulting constraint on slice 1 is.

---

## Findings

### X4-Q1 — The repo's real dependency posture

The setup story today is `bun install` (Bun 1.3.14). No compiler, no system package.

But the repo is **not** free of native code. `agent-control-specification@0.3.1-beta.0` declares **ten** `optionalDependencies`, all prebuilt binaries:

| Platform | Core engine | Bundled OPA |
|---|---|---|
| `linux-x64-gnu` | ✅ | ✅ |
| `linux-arm64-gnu` | ✅ | ✅ |
| `darwin-x64` | ✅ | ✅ |
| `darwin-arm64` | ✅ | ✅ |
| `win32-x64-msvc` | ✅ | ✅ (`win32-x64`) |

Confirmed on disk: `node_modules/…/agent-control-specification-darwin-arm64/agent-control-specification.darwin-arm64.node`.

**This corrects the framing in D-i.** The repo's invariant is not "no native code." It is:

> **No build toolchain on the contributor's machine. Every native artifact arrives prebuilt through the package manager, for five platforms.**

That is the bar a Datalog engine has to clear, and it is a *stricter and clearer* bar than "no native code" — the AGT SDK is the precedent, and it covers five platforms.

### X4-Q2 — Soufflé installs unevenly, and covers this repo's platforms badly

**Official releases** (`souffle-lang/souffle`, tag `2.5`, published 2025-03-24 — roughly 16 months stale as of this spike):

| Asset | Size | Downloads |
|---|---:|---:|
| `x86_64-ubuntu-2404-souffle-2.5-Linux.deb` | 4.6 MB | 9,901 |
| `x86_64-ubuntu-2204-souffle-2.5-Linux.deb` | 4.5 MB | 3,430 |
| `x86_64-fedora-{39,40,41}`, `x86_64-oraclelinux-9` RPMs | ~3 MB each | 12–49 |

**No macOS asset. No arm64 asset of any kind.**

**Homebrew** (`souffle` 2.5): zero runtime dependencies — a genuinely self-contained binary, which is a point in its favour. But the bottle list is a single entry: **`arm64_tahoe`**. Build dependencies for everyone else: `bison`, `cmake`, `mcpp`, `pkgconf`. Install analytics: **23 installs in 30 days, 175 in 365 days.**

Mapping that onto the five platforms the repo already supports:

| Platform | Soufflé availability |
|---|---|
| `darwin-arm64` on macOS 26 | ✅ brew bottle (this machine: arm64, macOS 26.5.1) |
| `darwin-arm64` on macOS ≤ 25 | ❌ source build |
| `darwin-x64` | ❌ source build |
| `linux-x64` | ✅ official `.deb` / `.rpm` |
| `linux-arm64` | ❌ source build |
| `win32-x64` | ❌ nothing |

**One of six configurations is covered by a prebuilt on macOS, and it is the one this laptop happens to be.** That is the worst possible sampling error: it would look fine here and break for most contributors. A standards project whose conformance verifier requires `bison` and `cmake` on Windows, Intel Mac, and ARM Linux has a reproducibility problem, not a packaging inconvenience.

### X4-Q3 — The workload is tiny, so Soufflé's advantage does not apply

The repo's actual envelope log, `.acs/envelopes.jsonl`, contains **8 entries**. A realistic full session is tens to low hundreds of hooks; a normalized fact set is perhaps 10²–10³ tuples, against ~200 generated rules.

Soufflé exists for 10⁶–10⁹ tuples — whole-program points-to analysis, binary analysis, large security queries. It compiles Datalog to parallel C++ for exactly that reason. **At 10³ facts none of that machinery pays for itself**, and the compile step (Soufflé's own C++ codegen and `g++` invocation, unless run in interpreter mode) is pure latency on a verify run that should be sub-second.

### X4-Q4 — Provenance is replaceable, and the replacement is better here

The source's stated reason for Soufflé was its provenance/explanation facility: *"you want not merely `false`, but 'this requirement failed because of these facts.'"* That maps to **R3.4**.

Soufflé's `--provenance` produces an interactive proof tree for a derived tuple — built for debugging deep mutually-recursive analyses where a tuple's derivation is many rule-firings deep.

ACS conformance rules are not that shape. A provision's rule is typically one join with a negated existential:

```
Violation(req, session, subject, witness) :-
    Hook(session, seq, method),
    !HandshakeBefore(session, seq),
    req = "ACS-REQ-0037", subject = session, witness = method.
```

**The witnesses are the join variables.** Projecting them into the output relation gives R3.4 directly, with no engine feature involved — it is a rule-authoring discipline the compiler can *enforce* (every generated `Violation` must bind its evidence columns), which is strictly better than a facility the compiler cannot check.

For the genuinely recursive family — §7.1 trust monotonicity over transitive `derived_from`, §8.3 `max_lineage_depth` — the lineage chain is expressible as path-carrying transitive closure:

```
Lineage(child, ancestor, path) :- DerivedFrom(child, ancestor), path = cat(child, "<-", ancestor).
Lineage(child, ancestor, path) :- Lineage(child, mid, p), DerivedFrom(mid, ancestor), path = cat(p, "<-", ancestor).
```

That puts `p7<-p5<-p3<-p1` **in the conformance report as data**, rather than requiring an auditor to open an interactive Soufflé session. For a published conformance report, data beats a debugger. **R3.4 does not depend on Soufflé.**

### X4-Q5 — In-process alternatives

**`cozo-node@0.7.6`** — Rust embedded Datalog, 12.4 kB wrapper, prebuilt binaries via `@mapbox/node-pre-gyp`. Delivery model matches the AGT SDK precedent, which is the strongest thing about it. Against it: a single maintainer, last published over a year ago, `node-pre-gyp` is itself legacy, and **CozoScript is its own dialect** — so adopting it means the compiler emits a *third* language (IR → Soufflé for publication, → CozoScript for local, and the two must agree). Adding a dialect to avoid writing an evaluator is a poor trade.

**`datascript@1.7.8`** — a Datalog *query* engine over an in-memory DB, ClojureScript-derived. Recursive rules and stratified negation are not its design centre. Wrong tool.

**`datalogia@0.9.2`** — small, immature, no evidence of the semantics we need.

**Write the evaluator.** Semi-naive fixpoint with stratified negation, transitive closure, and counting aggregation (needed for §6's bounded cascading deferrals). At 10³ facts, indexed naive iteration is adequate — performance is a non-issue.

The decisive argument is **R3.3**: the IR predicate is the authority and the rules are *generated*. So the evaluator does not need to implement Datalog; it needs to implement **the subset the compiler emits**, which we choose. That bounds the correctness burden to something reviewable.

The honest risk: a fixpoint bug in a *conformance verifier* yields a wrong conformance verdict, which is worse than no verdict. That risk is not hypothetical and it needs a mitigation, not a disclaimer.

### X4-Q6 — What is lost, and how it comes back

What Soufflé uniquely offers a **standards** deliverable is not speed or provenance. It is a **portable, human-readable, independently executable artifact**: a `.dl` file an external implementer or auditor can read and run without trusting or even installing our TypeScript. That is squarely in the spirit of the IR — the bridge between prose and executable semantics should not bottom out in one project's code.

That value survives Soufflé never running on a contributor's laptop. Emission and execution are separable.

And it supplies the mitigation X4-Q5 needs: **Soufflé as a differential oracle in CI.** GitHub Actions' default runner is `ubuntu-24.04 x86_64` — precisely the platform with the 4.6 MB official `.deb` and 9,901 downloads. Install it in CI only, run both engines over the same fixtures, and assert identical violation sets.

This inverts the usual objection to two engines. Two engines are dangerous when both are authoritative and may silently disagree. Here one is generated-and-executed locally, the other is generated-and-executed as an oracle, **and agreement is asserted rather than assumed**. Divergence is a compiler bug that fails CI, not a semantic ambiguity nobody notices.

---

## Resolution

**D-i resolved: Soufflé is a CI-only oracle and a published artifact. It is never a local runtime dependency. Local evaluation is in-process TypeScript.**

| Layer | Engine | Platform cost |
|---|---|---|
| Contributor laptop, `acs-ir verify` | In-process TS evaluator over the emitted rule set | `bun install`, nothing else — all five platforms |
| CI differential check | Soufflé 2.5 via official `.deb` on `ubuntu-24.04` | one `apt install`, 4.6 MB, x86_64 only, which is the runner |
| Published alongside the IR | Generated `.dl`, human-readable and citable | none — it is a file |

**Consequences that bear on requirements:**

- **Sibling R7.1 holds unchanged.** No toolchain is added to the laptop path. The repo's real invariant from X4-Q1 — everything prebuilt through the package manager — is preserved, and in fact strengthened, since the TS evaluator adds *no* binary at all.
- **R6.1 survives verbatim.** It requires Soufflé rule *generation*, not Soufflé execution. Reread as written, it is already satisfied by emission.
- **R3.4 does not depend on Soufflé** (X4-Q4). Evidence comes from evidence-projecting rules, which the compiler can enforce.
- **New requirement needed.** The differential-oracle mitigation is load-bearing, so it belongs in R rather than living only in this spike: **R3.8 — where the IR compiles to more than one backend, the backends are held equivalent by differential execution over shared fixtures, and divergence fails CI.**
- **X2's option (c) is dead, and (a) is weakened.** Authoring in Soufflé and extracting metadata (c) would make the laptop path depend on parsing Soufflé and would put authority in the `.dl` rather than the IR, against R3.3. Hand-written Soufflé per provision (a) cannot also produce the in-process rules without a translator — which is option (b) with extra steps. **X2 is therefore narrowed to (b): a typed DSL with multiple compile targets.** D-i has done part of X2's work.

**Slicing constraint — the answer the decision was blocking:**

> Slice 1 can demo `acs-ir verify` on a laptop with `bun install` alone. But the differential oracle must land **in the same slice that first emits a rule**, not later. A slice that ships an unverified hand-rolled fixpoint evaluator is a slice that ships a conformance verdict nobody has checked, and that is the one thing this project cannot ship. Soufflé-in-CI is therefore slice-1 scope, not a follow-up.
