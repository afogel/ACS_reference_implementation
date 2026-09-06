# Security Policy

## Supported versions

None, and that is not a placeholder. This repository has no tagged release, no
published package, and no CI. `main` is the only thing that exists, and it is a
reference implementation under construction — the README's own "Planned, not
yet built" table is the honest inventory.

So there is no support matrix and no backport path: a fix lands on `main` or it
does not exist. Anything here that is running in front of real traffic is doing
so ahead of every claim this project makes.

## What a vulnerability looks like here

This is a governance tool, so the interesting failures are not the usual ones.
The bug that matters is a **bypass**: any way to make a tool call proceed when
the policy would have stopped it, or to make a host act on a decision the
policy runtime never issued.

Concretely, reports are wanted for:

- A host shim (`hosts/`) that can be made to fail in a way its agent reads as
  "the hook never fired", so the tool call proceeds ungoverned.
- A Guardian (`packages/guardian/`) that can be induced to allow, or to answer
  one request with another request's decision.
- Anything that reaches the Guardian's socket and changes an outcome. The ACS
  wire is unauthenticated at every slice in this tree — the endpoint binds
  loopback precisely because reachability is the only access control it has, so
  a way around that bind is in scope.
- A crafted envelope, policy bundle, or `mapping.yaml` that turns a `deny` into
  anything else, including an error the host treats as permission.

Out of scope, because they are known and written down rather than hidden: the
absence of wire authentication, described in the header of
`packages/guardian/src/server.ts`, and the fail-open on an unreachable Guardian
at the slices that have not built the posture negotiation yet, described in
`docs/demos/v1-runbook.md`. A way to *trigger* either one against a host that
believes it is governed is very much in scope.

## Reporting

Report privately, through GitHub's private vulnerability reporting on this
repository:

**<https://github.com/afogel/ACS_reference_implementation/security/advisories/new>**

Please do not open a public issue, discussion, or pull request for a bypass.
A public report is a working recipe for evading a policy engine, and it reaches
every reader before it reaches a fix.

Include what you have of:

- The shortest sequence that reproduces it — ideally the hook payload or JSON-RPC
  envelope, verbatim, and the commit you ran it against.
- Which side you believe is at fault: the host shim, the Guardian, the mapping,
  or the policy bundle.
- What the correct outcome would have been, and what happened instead.
- Whether it needs anything beyond reaching the Guardian's port — a particular
  policy, a particular host, a race, local file access.

A report with a reproducer and no analysis is more useful than analysis with no
reproducer. Expect an acknowledgement rather than a schedule: there is no
release process here to promise a fix window against.
