#!/usr/bin/env bash
# R3.4, mechanically. The second host must cost zero lines in the Guardian, the
# bridge, or AGT -- the slice's demo IS this diff. Same shape as verify-pin.sh:
# a check that needs git history, so it is a script rather than a bun test.
set -euo pipefail
base="${1:-slice/v4}"
# `policy/lib/` -- the pinned bundle and its config -- NOT `policy/` wholesale.
# What R2.2/R2.3 and `verify:pin` protect is the unforked bundle: zero Rego
# authored, every `.rego` byte-identical, `data.agt.defaults.config`
# unchanged. `policy/manifest.yaml` (and its drift mirror) is the
# deployment's tool REGISTRY, not its policy, and a deployment governing two
# hosts registers both hosts' tool names -- OpenCode calls its shell tool
# `bash` where Claude Code calls it `Bash`, and an unregistered name fails
# AGT's evaluation closed before any rule runs. Freezing `policy/` wholesale
# would fail this script on a change the slice legitimately requires, and the
# fix would be to loosen the check until it passed -- exactly the mistake
# this script exists not to make.
frozen='^(packages/guardian/src/|packages/agt-bridge/src/|policy/lib/|agt\.lock$|mapping\.yaml$)'
changed="$(git diff --name-only "$base"...HEAD | grep -E "$frozen" || true)"
if [ -n "$changed" ]; then
  echo "verify-zero-diff: R3.4 violated -- these are frozen for this slice:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "verify-zero-diff: zero changed lines under the Guardian, the bridge, or AGT (vs $base)"
