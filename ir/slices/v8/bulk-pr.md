# Bulk marker PR draft (E11.3, U30)

Open after the proof-of-concept PR has merged. If `main` has moved past `6fce2a0`, first bump the `spec/acs` submodule, re-resolve the overlay (`bun run ir markers apply` reports any quote that no longer resolves), and regenerate the patch with `bun run ir markers patch`. The patch is only ever cut against the pinned text. Sign the commit (`git commit -s`). No tool attribution anywhere (D-f).

```
cd <spec checkout>
git checkout -b feature/provision-anchors
git apply <path>/ir/dist/markers.patch
git commit -s -am "Add provision anchors to every normative provision"
```

If the proof-of-concept PR merged first, the five anchors it added are already in `main`. After the submodule bump, `bun run ir markers apply` reports each of those five as already marked in the corpus (E3.3); delete those five overlay entries and regenerate the patch, which then covers the remaining 150.

Suggested title: **Add provision anchors to every normative provision**

---

Follow-up to the proof-of-concept PR (link) and the Discussion (link). This adds the anchors for the remaining provisions in the v0.1.2 text: 155 provisions in total across 14 files, each an inline `<a id="acs-…"></a>` before the provision text and `<!--/acs-…-->` after it. One-line replacements only; no wording changes; no line added or removed anywhere.

By type: 148 Requirements, 2 Definitions, 4 Invariants, 1 Exclusion. Every RFC 2119 keyword occurrence in the normative documents is either inside one of these spans or accounted for as a restatement, a mention, or roadmap text.

| File | Anchors |
|---|---|
| `spec/instrument/specification.md` | 95 |
| `spec/instrument/hooks.md` | 19 |
| `spec/conformance.md` | 12 |
| `spec/inspect/README.md` | 6 |
| `concepts/agents.md` | 5 |
| `spec/trace/events.md` | 5 |
| `spec/trace/extend_opentelemetry.md` | 3 |
| `concepts/intent.md` | 2 |
| `concepts/session-lifecycle.md` | 2 |
| `spec/instrument/extend_mcp.md` | 2 |
| `concepts/identity.md` | 1 |
| `concepts/provenance.md` | 1 |
| `concepts/trust.md` | 1 |
| `spec/inspect/extend_cyclonedx.md` | 1 |

(Counts are for the v0.1.2 text at `6fce2a0`; recount with `grep -o '<a id="acs-' <file> | wc -l` if the patch was regenerated.)

Checked, as for the proof of concept: `uv run pytest -v` passes; `uv run mkdocs build` renders every page with the anchors present and nothing visible; the patch applies cleanly to the commit it was cut against.

What this enables downstream is described in the Discussion; nothing in this PR depends on it. The anchors are inert in the rendered site except as link targets.
