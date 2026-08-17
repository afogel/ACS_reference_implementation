# V8 demo runbook: the upstream contract watch, captured

**The demo, in words.** Point the harness at AGT's `main` branch, with the ref this
repository already pins on the other side. A field that moved between the two comes back
named: which surface it lives in, which field within that surface, what the field used to be,
and what it is now.

This runbook is written from real, reproducible runs. A shell script shallow-clones AGT
twice — once at the ref this repository pins, once at its current `main` — into fresh
temporary directories, and hands both clones to the watch by environment variable. Nothing
here is composed or hand-edited: every block below is pasted from an actual run.

## Prerequisites

- `bun` installed, `bun install` run once at the repo root.
- **Network access to GitHub.** The watch clones AGT twice before it runs at all — the
  pinned ref and `main` — so both the surface comparison and the schema re-check below are
  against real, freshly cloned files, never a cached or vendored copy. With no network, the
  clone step fails before the watch itself runs.
- **`trash` on PATH.** The script refuses to run without it: `rm -rf` is not permitted in
  this repo, and both temporary clones are cleaned up with `trash` in an `EXIT` trap.

## The command, captured

```bash
$ bun run watch:upstream
```

```
$ bash scripts/run-upstream-watch.sh
Upstream contract watch: no watched surface moved between the pinned ref and main.

Policy-input schema against main: the policy input we send still validates against main (checked at pre_tool_call, post_tool_call).

Hookmap tools against the policy manifest: every declared tool is registered.
```

Exit code `0`. The command was run a second time from the same tree, and the two captures
matched byte for byte.

## Reading a clean run

Three lines, one beneath the other, and each answers a different question.

**The first line** compares every field of every watched surface between the pinned ref and
`main`, field by field. Nothing moved between the two refs at capture time, so the line says
so instead of listing rows — the section below shows what a listed row looks like.

**The second line** takes the policy input this Guardian actually constructs today and
re-validates it against `main`'s **own** copy of the wire schema, not the pinned copy. A
field can be added or tightened on `main` without ever showing up as a moved field in the
first line, and still be the exact field a stricter schema now rejects — this line is what
would catch that.

**The third line** reads the two hookmaps this repository ships and checks every tool name
each one declares against the policy manifest's own registry of tool names a host actually
dispatches. Nothing undeclared was found. This line does **not** catch a hookmap tool name
that was recased to a name a *different* host's registry entry happens to match — the
registry knowingly carries one entry per host, so a name valid for one host is a registered
name regardless of which host's gate it appears on.

A clean answer on all three lines is the truthful state of these two refs today. On its own,
though, it reads exactly like a watch that is silently broken — nothing above shows what a
real, reported movement looks like. That is what the next section is for.

## What a moved surface looks like

Captured separately, against two real clones edited on purpose, and not the state of AGT
today. The six watched source files were first compared byte for byte
between the pinned ref and `main` and found identical. The run was then repeated after adding
one value to `main`'s verdict enum, and again after renaming a watched schema file on `main`.
Nothing about the watch itself changed between any of these runs — only the clone did.

```
Controller check, run after Task 5 committed. Two real shallow clones of
agent-governance-toolkit: one at agt.lock's pinned ref
81955d48025c6b11deb3fc9dabf89f74f4145775, one at refs/heads/main, which was
at 7d0cef5d9820a865c3c19b07bd39ecf7053b58a1 when this was captured.

The six watched source files were compared byte-for-byte between the two
clones first. All six are identical, so "no watched surface moved" is the
truthful answer for these two refs -- upstream's history moved, the watched
contract surfaces did not:

  same: policy-engine/spec/schema/manifest.schema.json
  same: policy-engine/spec/schema/wire/policy-input.schema.json
  same: policy-engine/spec/schema/wire/verdict.schema.json
  same: policy-engine/spec/schema/wire/snapshot.schema.json
  same: policy-engine/spec/reserved-reasons.json
  same: policy-engine/policy/lib/agt_default.rego

A watch that answers "nothing moved" proves nothing on its own -- a broken
watch answers the same way. So the upstream clone's verdict schema was then
edited to add one enum value, and the run repeated against the same two
clones. Nothing in the harness was changed between the two runs.

=== run against the two clones, unmodified ===

Upstream contract watch: no watched surface moved between the pinned ref and main.

=== the upstream clone's verdict enum, after adding one value ===

allow, deny, warn, escalate, transform, quarantine

=== the same run, against the edited clone ===

Upstream contract watch: 2 fields moved between the pinned ref and main.

verdict.schema.json
| field | pinned | main |
|---|---|---|
| `/properties/decision/enum/5` | (absent) | "quarantine" |

verdict enum
| field | pinned | main |
|---|---|---|
| `/5` | (absent) | "quarantine" |

Three things this establishes, none of them from reading the code:

1. The watch detects a moved enum value and names it: the surface, the field
   by JSON pointer, and what it was against what it is now.
2. A moved value inside a document the watch also reads whole is reported
   twice -- once against the document, once against the extracted enum. That
   is the arrangement working as intended, not a duplicate.
3. The verdict enum at the pinned ref really is the five values allow, deny,
   warn, escalate and transform, which is what the surfaces table claims.

=== a relocated surface, checked after the run learned to report one ===

A moved enum VALUE is the easy case. The harder one is a surface that is not
where it was at all -- the watch reads it by path, so a renamed or relocated
file is the loudest thing upstream can do. The upstream clone's
verdict.schema.json was renamed to verdict-v2.schema.json and the run
repeated:

Upstream contract watch: could not read main's surfaces -- readSurfaces: expected an AGT surface at policy-engine/spec/schema/wire/verdict.schema.json, and the clone has no such file

Exit code 0. The run names the surface it could not read and which side it
was reading, and it reports rather than refusing -- so the scheduled job
publishes the finding instead of dying with the error buried in a raw log.

=== and the moved enum again, with the schema question now asked of main ===

Upstream contract watch: 2 fields moved between the pinned ref and main.

verdict.schema.json
| field | pinned | main |
|---|---|---|
| `/properties/decision/enum/5` | (absent) | "quarantine" |

verdict enum
| field | pinned | main |
|---|---|---|
| `/5` | (absent) | "quarantine" |

Policy-input schema against main: the policy input we send still validates against main (checked at pre_tool_call, post_tool_call).

Exit code 0. Both halves are visible in one run: what moved textually, and
whether the document this repository sends is still one the contract as it
stands today would accept.
```

## What this file is, and is not

This file is the **evidence** — real, reproducible runs, pasted verbatim, one clean and one
against clones edited on purpose to show what a reported movement looks like. It does not
declare which contract surfaces this project watches or what a run does and does not close;
that declaration lives beside the code it describes, not beside the captured output.

## Verify

```bash
bun test          # 920 pass, 1 skip, 0 fail; the watch self-skips here, since bun test
                  # sets neither clone variable, so the suite stays covered with no network
bun run typecheck
bun run verify:pin        # re-clones AGT and byte-diffs the pinned bundle against it --
                          # needs network
```
