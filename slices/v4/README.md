# V4: Output redaction on Claude Code

**Demo:** AGT's own package documents that Claude Code cannot *reliably* redact tool output. Here it is, redacted, by AGT's stock `redact` policy — in the tool's own output shape, which is the condition that makes it reliable.

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V4 — authoritative for this slice's scope.

**Affordances:** U3 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

## What this slice delivers

A secret-bearing `Bash` result comes back **redacted by AGT's stock `redact` rule, in the
tool's own output shape, with every sibling field intact** — over the same ACS wire, against
the same pinned, unforked bundle, with zero Rego authored. Claude Code's `PostToolUse` event is
registered as a second gate beside V1's `PreToolUse`, mapped to ACS `steps/toolCallResult`, and
a `transform` verdict at that point becomes an ACS `modify` carrying
`modifications.redactions`, which the host adapter applies to produce `updatedToolOutput`.
[`docs/demos/v4-runbook.md`](../../docs/demos/v4-runbook.md) has the real captured output for
every claim on this page, including the envelope pair as it crossed the wire.

**Framing, and it is the substance rather than a courtesy (R4.3).** The claim is that per-host
modules freeze capability at the moment they are written, while one contract picks up new host
capability for every runtime at once. It is **not** that AGT got something wrong; their README
was accurate when written, and it is accurate now. Quoted in full from
`agent-governance-claude-code/README.md:39` at the pinned ref, under its own heading
**`## Important parity gaps`**: *"`PostToolUse` in Claude cannot reliably redact tool output
after the tool has already executed, so this package does not claim Copilot-style output
suppression parity."* Read precisely — "cannot **reliably**", and "does not **claim** parity" —
that is a scoping statement about the package, never "AGT can't redact output". And this
slice's own evidence is *why* the wording is right: the naive replacement is silently discarded
and the original delivered, and the documented blocking form suppresses nothing. Meeting the
reliability condition turns out to be a contract-level job done once for every runtime.

Five things had to exist before that claim could be made honestly, and all five are structural
rather than configuration:

- **The shape is the mechanism.** Claude Code validates a replacement against the tool's own
  output schema and **silently delivers the original** when it does not match, with only a
  stderr line to show it (F1, measured against 2.1.227 during planning). So the adapter never
  constructs a replacement: it patches a **clone of the object the host handed it** at the leaf
  the hookmap names (`outputs.within` / `outputs.from`, `packages/host-adapter/src/result-output.ts`),
  and where it cannot, a preflight in `governStep` blocks with exit 2 **before a decision is
  asked for**. A redaction the host declines is not a redaction.
- **`decisions` moved under the hook.** The shape a host reads back is a property of the *gate*
  — `PreToolUse` answers with a permission field, `PostToolUse` answers by replacing what the
  tool produced, and neither field exists on the other event. One shared block could only ever
  have described one of them, so the block, `renderDecision` and all three
  "every decision must render something" gates learned the hook. That is what makes V5's
  `N12` — "`renderDecision()` — same module as `N3`" — literally true: a second *hook* forced
  the split a second *host* would have forced anyway.
- **`mapVerdict`'s `modifications` synthesis is per intervention point.** The same AGT
  `transform` is a `parameter_overrides` keyed by argument name at the request gate and a
  `redactions` entry at the result gate, because the two gates edit different documents. So
  `modifications` moved out of `mapping.yaml`'s point-independent `field_synthesis` and into
  each `intervention_points` row. A point with **no** synthesis rule cannot express a transform
  at all, and `mapVerdict` throws into the honoured-deny path rather than returning a `modify`
  the host has nothing to apply.
- **A deny at this gate has to withhold.** `decision: block` alone injects a reason and
  suppresses nothing — the tool has already run and its result has already formed — so it would
  *report* a withholding that never happened, the same "reported but never took effect" defect
  V3 found when V1 copied a raw `modifications` object into `updatedInput`. A result-gate deny
  renders `block` **and** a shape-preserving replacing output. The two modifications this host
  cannot apply (`modified_content`, and a redaction that never reaches the projected leaf) both
  become withholding denies for that reason.

- **The handshake had to say the gate exists.** A slice that adds a method to the wire has not
  finished until the wire says so. Until V4 corrected them, the ClientHello offered
  `steps/toolCallRequest` alone and the ServerHello answered with the same one method, while
  both sides sent, evaluated and honoured `steps/toolCallResult` — and `handshake.json` defines
  `methods_evaluated` as the "Subset of the client's methods_implemented that this Guardian will
  actually evaluate", adding that a client "MUST treat" anything absent from it as
  ALLOW-by-default. So a conformant host was being told, by the Guardian's own answer, to ignore
  every decision this slice's gate makes. Nothing in this deployment reads the field, which is
  precisely why nothing caught it. Both declarations now name both methods, and neither is left
  to a literal someone must remember to edit:
  `test/handshake-declares-what-it-evaluates.test.ts` drives a candidate envelope for every
  method `mapping.yaml` maps through a live Guardian and asserts the set it does **not** answer
  `method_not_dispatched` for is *exactly* what the ServerHello declares — equality in both
  directions, because over-declaring claims enforcement that does not exist and is the worse
  failure. Two further cases hold the spec's subset rule against the ClientHello the adapter
  really sends, and require every `acs_method` the shipped hookmap maps to be one the adapter
  declares.

Also delivered, and each one is a place a gate learned a distinction rather than a guard being
relaxed: array-index descent in `N7`'s `modifications.ts` (`/outputs/0/value` *is* the redaction
path for a result payload, and V3 rejected array descent outright), a payload schema for
`steps/toolCallResult` in `validateEnvelope` — which moves a boundary, since a malformed result
envelope now gets N27's honoured `envelope_invalid` **deny** where it used to fall through to a
bare JSON-RPC error the host reads as *no decision arrived* — `assembleResultSnapshot` as a
**sibling** of `assembleSnapshot` rather than a branch inside it, and a widened fourth invariant
gate: `packages/host-adapter/src` may not name `updatedToolOutput` either.

**Corrected from V3, and the correction is stronger than the note it replaces.**
[`slices/v3/README.md`](../v3/README.md)'s list says a `modifications.modified_content` refusal
"is a property of this adapter", because this adapter has no mapping from an opaque replacement
string onto `updatedInput`, an arguments *object*. V3 said what was true when V3 shipped. V4
reaches the same refusal from the other gate for the same reason — `updatedToolOutput` must
match a structured output shape too — which upgrades the claim from "this adapter has no
mapping" to **"this host has no target"**, at either gate. Stated precisely for the matrix that
carries it (V7's): both documents §6.3's pointers can address here are field-addressed
structures, and an opaque string is a field of neither. That is a fact about the payload shapes
these two gates govern, not a gap in §6.3 and not a missing branch in the adapter — a step
whose payload *is* an opaque body would have an obvious target for it. The same V3 row also
says "`mapping.yaml` synthesizes `parameter_overrides` and `mapVerdict` throws on anything
else" — quoted with its subjects where V3 put them, because the synthesis rule is `mapping.yaml`'s
and the throw is `mapVerdict`'s, and those are not the same thing to get wrong. What changes is
the first half: the synthesis is now **per intervention point** — `parameter_overrides` at the
request gate, `redactions` at the result gate. `mapVerdict` still throws on anything else.

**The `redact` rule ships in `policy/lib/data.json`, and one consequence reaches V3's runbook.**
V3 added that rule for one capture and reverted it; V4's tracked file carries it permanently,
beside `patterns`, together with a `post_tool_call` intervention point in `policy/manifest.yaml`.
Both edits are additive. A *separate* config document was considered and rejected: config lives
inside the bundle directory, so a second config means a second **bundle** — a fork of the
pinned `.rego` files, which is exactly what R2.2/R2.3 forbid and `verify:pin` exists to catch.
Because AGT's stock priority chain consults `redact_verdict` at **every** point, the shipped
rule also rewrites a *command* carrying a secret at V1's request gate; V3's `transform` section
now reproduces with no edit at all, and the three sentences in
[`docs/demos/v3-runbook.md`](../../docs/demos/v3-runbook.md) that describe editing and reverting
it are corrected in place there.

## What is explicitly not in this slice

- **A redaction that explains itself in the transcript.** The mechanism is closed and the demo
  is not, and the difference matters. `PostToolUse`'s `modify` entry declares
  `hookSpecificOutput.additionalContext` from the decision's `reasoning` — this event's own
  field for text the model reads — and it is exercised end to end against a Guardian that sends
  one. But the **pinned bundle's redaction verdict carries no text for it**: `mapping.yaml:103-104`
  sources `reasoning` from `verdict.message`, and `policy/lib/redact.rego:40-47` emits
  `{decision, reason, transform}` with no `message`. So live, in this deployment, **the
  redaction reaches the model unexplained** — it is handed altered output with nothing saying it
  was altered, and may read `[REDACTED]` as the command's own answer. Permanent until the
  mapping or the Rego rule changes, and neither is a host-adapter change. V7's matrix should
  carry the cell.
- **A per-modification landing check — so two holes V4 measured stay open, deliberately.** The
  check V4 ships asks *did the leaf change*, which is narrower than the claim a `modify` makes.
  A `modifications` object **bundling** a leaf redaction with a non-leaf edit therefore passes:
  the leaf changed, the non-leaf edit was silently dropped, and the whole `modify` is reported
  applied. And the same question goes unasked at the request gate, where a
  `parameter_overrides` rewriting a command to itself reports as honoured while the original
  runs. Nothing leaks in either case — what remains is a false audit and transcript record.
  The **result-gate** half is pinned as current behaviour by four generated cases in
  `packages/host-adapter/test/validate-decision.test.ts` ("reports applied for a bundle whose
  non-leaf half is dropped (recorded, not closed)"), which will fail when the fix lands; the
  **request-gate** half is measured and recorded in prose only, with no test pinning it — worth
  knowing before assuming a red test will announce it.
  The honest form is **one** check, not two ("every modification changed the document at its
  own target", per-modification, in the apply step), which is the argument for parking it in
  V5 rather than doing it twice by gate. Neither hole is reachable through the shipped bundle,
  since `mapVerdict` emits exactly one redaction.
- **An audit entry that cannot outlive the decision it claims.** The shim's own wrapper checks
  (`asClaudeCodeOutput`) exit 2 and block, but the failure posture has already written an audit
  line reading `outcome: "proceeded"` by the time they fire — so the durable record says a step
  proceeded while the process blocked it. Measured twice, independently. What an audit entry
  *should* say when the decision it records could not be delivered is a question about the
  **audit sink's contract**, and answering it inside a result-gate fix round would settle a
  cross-cutting contract from the wrong end. R1.7's distinction, now written down: "every
  fail-open proceed is audited" holds; **"every audited proceed happened" does not.**
- **A preflight that blocks only what policy would have blocked.** It turns a would-be **allow**
  into exit 2 whenever the hookmap's named leaf is present and not a string. That is a
  deliberate over-block on the safe side — it blocks deliveries policy would have permitted —
  and it is the price of never delivering an output a replacement cannot be built for.
- **A refusal that never withholds a legitimate result.** A replacement *equal to* the original
  is refused, because the landing check cannot distinguish "policy rewrote this to the same
  bytes" from "nothing was applied". Unreachable with the **shipped config** rather than
  unreachable outright: `redact.replacement` is user-editable, so a replacement equal to the
  matched text yields an identical value, at the cost of withholding a legitimate tool result
  entirely.
- **A host that *acts* on the negotiated method set.** Both sides now declare the result method
  (see above), so the wire is honest for a host that reads `methods_evaluated` — but this host
  is not one: it asks the Guardian at every hook its hookmap maps, whatever the ServerHello
  said. Reading the negotiated set and standing down for a method the Guardian does not evaluate
  belongs to no slice yet.
- **A failing tool call.** Claude Code fires a separate `PostToolUseFailure` event (present in
  2.1.227's hook schema) which this slice does not wire, so `PostToolUse` genuinely means
  success and `exit_status` is a hookmap **literal**, not a field read — the payload carries no
  exit code to derive one from, and deriving it from `interrupted` would invent a value the host
  never sent.
- **Correlating a result with the call that produced it.** ACS's result payload requires `tool`,
  `exit_status` and `outputs` and carries **no tool arguments**, so the Guardian synthesizes
  `tool_call: { name }` from `payload.tool.name` — load-bearing, because AGT resolves
  `tool_name_from` before policy runs and fails closed without it. A policy wanting both the
  call and its result must correlate through `request_id_ref`, which is **V6's** session chain.
- **Redaction anywhere but the one projected leaf.** §6.3's pointers address the whole ACS
  result payload, which has fields beside the one this gate can hand back (`exit_status`,
  `tool.name`). A redaction addressing those applies cleanly and changes nothing the model
  reads, so it is refused as a withholding deny rather than reported as applied.
- **Session state and provenance carriage** — that is V6, unchanged from V3's list.

The implementation plan this slice followed, task by task, is
[`docs/superpowers/plans/2026-08-11-v4-output-redaction.md`](../../docs/superpowers/plans/2026-08-11-v4-output-redaction.md).
