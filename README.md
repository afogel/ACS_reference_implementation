# ACS Reference Implementation

One wire contract between agent hosts and policy runtimes, so governance integration stops being M×N.

Today every policy vendor writes a module per agent, and every agent waits for a module per vendor. Microsoft's [Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) ships four host packages with four different architectures — a Copilot CLI extension, subprocess hooks for Claude Code and Antigravity, an in-process plugin for OpenCode — and documents the capability divergence between them in its own READMEs.

This repository shows the other shape. A host implements [ACS](https://github.com/Agent-Control-Standard/ACS) once and is governable by any conformant runtime. A runtime implements ACS once and governs any conformant host. AGT's policy engine runs unforked, with its stock Rego bundle deciding, across two structurally different coding agents — and adding the second host costs zero AGT code.

## What this proves

| Claim | How it is demonstrated |
|---|---|
| AGT is completely expressible in ACS | A machine-checked mapping of all eight intervention points and five verdicts, with a round-trip conformance case per cell |
| Interop is real | AGT's published policy library decides, used as shipped, at a pinned upstream commit, with no source changes |
| The collapse is structural | The host adapter contains no AGT-specific code and the AGT bridge contains no host-specific code — verifiable by reading the file list |
| It stays true | The same harness runs against AGT `main` on a schedule, so upstream drift surfaces as a named failing case |

## Layout

```
docs/shaping/     Shaping doc, slice plan, and the AGT integration spike
spec/acs/         The ACS specification, pinned as a submodule
```

The shaping doc is authoritative for requirements, shapes, and the breadboard. The slices doc is authoritative for slice definitions. GitHub issues point at them and never restate them.

## Clone

```bash
git clone --recurse-submodules https://github.com/afogel/ACS_reference_implementation
```

## Status

Shaped and sliced; implementation has not started. Slices V1–V8 are tracked as issues on the project board, each with a stacked pull request.

## License

MIT
