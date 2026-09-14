# Proof-of-concept PR draft (E11.2, U29)

Open after the Discussion has feedback. Fork the spec repository, branch `feature/provision-anchors-poc`, apply `ir/dist/markers-poc.patch` from the repository root, sign the commit (`git commit -s`, the DCO), and open against `main`. No tool attribution anywhere (D-f).

```
cd <spec checkout>
git checkout -b feature/provision-anchors-poc
git apply <path>/ir/dist/markers-poc.patch
git commit -s -am "Add provision anchors for five normative provisions"
```

Suggested title: **Add provision anchors for five normative provisions**

---

Follow-up to the Discussion on stable provision anchors (link). This marks the five provisions worked through there, and nothing else:

| ID | Where | Provision |
|---|---|---|
| `ACS-REQ-0007` | `spec/instrument/specification.md` §4 | Required at session start, before any hook traffic. |
| `ACS-REQ-0010` | `spec/instrument/specification.md` §7.1 | `agent_generated` trust is the minimum over its lineage |
| `ACS-REQ-0013` | `spec/instrument/specification.md` §8.2 | The `entry_hash` computation |
| `ACS-INV-0001` | `concepts/intent.md` | Intent immutability |
| `ACS-EXC-0001` | `spec/instrument/specification.md` §14 | Multi-tenant isolation is unspecified in v0.1 |

Each insertion is `<a id="acs-…"></a>` before the provision text and `<!--/acs-…-->` after it, on the same line. No wording changes. Two files, five one-line replacements.

Checked:

- `uv run pytest -v` passes (the structure and hook-taxonomy guards read the patched files).
- `uv run mkdocs build` renders the pages with the anchors in the HTML and no visible marker text; `…/spec/instrument/specification/#acs-req-0007` scrolls to the sentence.
- The patch was cut from the v0.1.2 text at `6fce2a0` and applies cleanly to `main` at that commit.

If this is accepted, the remaining 150 provisions follow as one mechanical PR (14 files, one-line insertions only), or batched by document if that is easier to review.
