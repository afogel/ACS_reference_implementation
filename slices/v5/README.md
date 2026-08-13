# V5: Second host, zero AGT changes

**Demo:** Same Guardian, same bundle, same policy. OpenCode is now governed. `git diff` shows zero lines changed in the Guardian, the bridge, or AGT — the one deployment-side edit is a manifest `tools:` entry, because OpenCode names its shell tool `bash` where Claude Code names it `Bash`, and an unregistered name fails AGT's evaluation closed before any rule runs. `bun run verify:zero-diff` is what proves that claim mechanically rather than by inspection — see [`scripts/verify-zero-diff.sh`](../../scripts/verify-zero-diff.sh).

**Master doc:** [`docs/shaping/acs-reference-impl-slices.md`](../../docs/shaping/acs-reference-impl-slices.md) §V5 — authoritative for this slice's scope.

**Affordances:** U10-U12, N10-N16, S2, S15, S16 — defined in [Detail C](../../docs/shaping/acs-reference-impl-shaping.md#detail-c-affordances).

Implementation goes here.
