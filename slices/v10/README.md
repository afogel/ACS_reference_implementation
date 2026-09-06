# V10: A hook AGT has no host for

**Demo:** Load a skill whose bytes changed since it was approved. AGT's stock `content_hash` gate denies it, driven by `steps/skillLoad` — an ACS hook no AGT host package implements, deciding through AGT's own unforked bundle.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V10 — authoritative for this slice's scope. Its measurements are in [`docs/shaping/spike-unreached-gates.md`](../../docs/shaping/spike-unreached-gates.md).

**Affordances:** N56 is this slice's own; N21 and N28 change; S10, S7, S8 gain declarations. Defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

**Depends on V9 and cannot be reordered.** A skill-load snapshot has no `command` argument, so under the pre-V9 manifest it hits `runtime_error:path_missing` before `content_hash` is ever consulted — the identical wall V9 measured for `WebFetch`. The normalised policy-target leaf is the dependency, not the egress gate.

## Why this gate is reachable at all

Two facts, both measured against the pinned SDK, neither obvious from reading AGT.

**AGT's `$defs/tool` is `additionalProperties: true`,** so a manifest tool entry may declare a `content_hash` — legal rather than merely tolerated. And the SDK carries it through. Reading AGT's own `policyInput` back out of the bridge's evidence path, `input.tool` came back as:

```json
{"content_hash":"sha-256:APPROVED","id":"code-reviewer","type":"Tool","name":"code-reviewer"}
```

With `config.content_hash.enforce: true` and the observed hash at `snapshot.tool_call.content_hash`, all three stock behaviours fire:

| Observed | Verdict |
|---|---|
| matches the declared | `allow` |
| differs | `deny` `tool_content_hash_mismatch` — *"declared sha-256:APPROVED but observed sha-256:POISONED"* |
| absent | `deny` `tool_content_hash_mismatch` — *"manifest declared tool.content_hash but snapshot.tool_call.content_hash was missing"* |

The gate needs exactly one thing from this side: a `snapshot.tool_call.content_hash`. ACS supplies it at `steps/skillLoad`.

## The two documents were written independently about the same threat

`hooks/skill-load.json` requires `digest {algorithm, value}` and says what a Guardian is to do with it:

> The Guardian compares it against the digest it approved at `steps/skillRegister`; a mismatch means the artifact changed between registration and load (tamper or swap).
>
> A load the Guardian cannot tie to an approved registration, or whose digest differs from the approved one, is unverifiable and SHOULD be denied.

That is, clause for clause, what `content_hash.rego` decides. Neither document cites the other.

## Names frozen before implementation

No V10 code exists yet. The collision here is not a word — it is a **subject**, and it is the one this slice is most able to overclaim.

AGT's gate is about a **tool**. ACS v0.1.0 puts the integrity digest on a **skill**. The AgBOM makes the split deliberate rather than incidental: `skill_fields.definition` is required to carry `{ref, digest}` and is described as *"the surface attackers poison"*, while `tool_fields` requires only `capability`. Same control, different component class.

1. **The published claim is "AGT's unforked rule decides an ACS-native subject", never "ACS carries AGT's tool hash".** Every artifact this slice produces — the runbook, V7's matrix cell, the PR description — states the component-class difference rather than eliding it. The demo is more interesting *because* the subjects differ, not less.

2. **`assembleSkillLoadSnapshot()` (N56) is a sibling of the two existing assemblers, not a mode of either.** `assemble-snapshot.ts`'s own header states the rule: AGT-SNAPSHOT-1.0.md §2.5 gives each intervention point its own snapshot shape. This one shares no member with either tool-call snapshot but `envelope.budgets`.

3. **The mapping between `skill_id` and `tool_call.name` is declared in `mapping.yaml`, never hardcoded in the assembler.** That file's header already forbids exactly this: no field derivations in code that are not declared there. A skill id becoming a tool name is a derivation, and it is the one a reader will most want to find in a table.

4. **`digest.algorithm` is carried, not discarded.** `content_hash.rego` compares two strings and does not parse them, so a declared `sha-256:X` and an observed `sha-512:X` would compare unequal for the right reason by luck rather than by design. The composed observed value includes the algorithm so the comparison is honest at both ends.

## The limit, stated here rather than discovered in the demo

**The approved digest is manifest-static, and it cannot be otherwise from this side.** `content_hash.rego` reads the declared hash from `input.tool.content_hash` and nowhere else. `input.tool` is resolved by the SDK from the manifest's `tools:` catalog, keyed by `tool_call.name`. There is no config hook — no `declared_paths` counterpart to `egress`'s `destination_paths` — and annotations are not consulted.

So a digest a Guardian approved at `steps/skillRegister` **cannot reach this gate through session state.** This slice declares the approved digest in the manifest and says so. The `(skill_id, digest)` binding ACS actually specifies — persist at registration, check the pair at load — is a Guardian-side control AGT has no part in, and V10 does not build it.

Closing the gap the other way would mean AGT accepting a declared hash from the snapshot, which weakens AGT's own trust model. That is an upstream conversation, not a slice.

## Which hooks this implementation instruments

D3 closes here, so the number belongs here — and the denominator with it, because two correct counts are in circulation. `hooks/` holds 29 files: seven are `.acs-provenance` profile variants of a sibling, leaving **22 hook payload schemas**, of which **19 are `steps/*`** and three are not (`agbom/snapshot`, `agbom/changed`, `system/ping`). R5.4 asks which `steps/*` hooks are instrumented, so 19 is the denominator, and it is the figure V1 planning established against `specification.md` §5's stale table of 16.

This implementation instruments **three of the nineteen**: `steps/toolCallRequest`, `steps/toolCallResult`, `steps/skillLoad`. What speaks to a conformant client is `buildServerHello`'s `methods_evaluated` — a method omitted there tells the client, in `handshake.json`'s own words, to treat that gate as ALLOW-by-default.

Three of nineteen is the honest figure, and it is the frame this slice's headroom claim sits inside: the argument is not that ACS's surface is covered, it is that one of its uncovered hooks already drives an unforked AGT rule.
