/**
 * The Guardian's destination extractor: what stands between an ACS
 * `raw_command` and AGT's stock egress gate.
 *
 * NOT the gate. `policy/lib/egress.rego` is the gate, `cfg.egress` is its
 * configuration, `egress_destination_not_allowed` is the reason it emits, and
 * every one of those is AGT's, vendored byte-identical and not authored here.
 * This module supplies one of that gate's own declared inputs -- its FIFTH
 * default destination path, `["annotations", "egress", "destination"]`, which
 * is to say AGT anticipated exactly this seam and published the address for
 * it.
 *
 * WHY EXTRACTION RATHER THAN FORWARDING. The gate's `host_of()` splits on
 * `://` and then on `/`, so handed `curl https://evil.test/x` whole it answers
 * `curl https`. Pointing a destination path at `raw_command` produces a
 * garbage host, not a destination.
 *
 * WHY IT READS THE PRELIMINARY DOCUMENT ITSELF. A manifest's
 * `annotations.<name>.from` is a liveness precondition, not a projection: the
 * SDK requires the path to resolve (an unresolvable one denies the whole call
 * on runtime_error:path_missing, before this function is called at all) and
 * then hands the dispatcher the entire preliminary policy input rather than
 * the value it resolved. Measured. So the command is read here, from the
 * snapshot, by name.
 */

/**
 * The tool-argument names AGT's own gate already reads a destination out of --
 * `default_destination_paths` in `policy/lib/egress.rego`, minus the
 * annotation path this module writes.
 *
 * When one of them is already a string on the snapshot, this module answers
 * nothing. `destination(rules)` is a COMPLETE Rego rule over every configured
 * path, so two paths resolving to different strings has no single answer:
 * measured, that is `deny runtime_error:policy_invocation_failed` -- a total
 * deny wearing a runtime-error reason, on a call nobody decided about. The
 * tool's own argument is the better evidence anyway: it is what the tool will
 * actually reach for, where a command line is what someone typed.
 */
const ARGUMENTS_AGT_ALREADY_READS = ["url", "endpoint", "host", "domain"] as const;

/**
 * The first absolute http(s) URL in a command line.
 *
 * Scheme-anchored on purpose. A bare-host pattern would match package names,
 * file paths and flag values, and every false positive here becomes a denial
 * of a step nobody meant to govern. The character class ends the match at
 * whitespace and at the shell metacharacters that end a word, so a trailing
 * `; ls` or `| tee` is not swallowed into the host.
 *
 * First match, not every match: the gate takes one destination. A command
 * reaching two hosts has its first examined and the rest unexamined, which is
 * this module's stated miss direction rather than a hidden one.
 */
const DESTINATION_IN_COMMAND = /\bhttps?:\/\/[^\s'"`;|&()<>]+/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Answers `{destination}` when it finds one, `{}` when it does not.
 *
 * Never a throw and never `null`, and both halves are load-bearing. AGT turns
 * any annotator failure -- thrown or rejected -- into its own
 * `runtime_error:annotation_failed` deny, which lands on EVERY call in the
 * deployment, benign ones included, and reads like a policy decision. And a
 * command with no destination is not a failure: the gate is `undefined` when
 * nothing resolves, and the call falls through to the other gates. So an
 * obfuscated or novel egress form is UNEXAMINED here, not denied -- the
 * failure direction the runbook states plainly, because the demo's shape
 * invites the opposite reading.
 *
 * `name` and `config` are part of the dispatcher contract and are not read:
 * this function is the one annotator this Guardian has, and routing by name is
 * its caller's job.
 */
export function annotateEgressDestination(_name: string, _config: unknown, preliminary: unknown): unknown {
  if (!isPlainObject(preliminary)) return {};
  const snapshot = preliminary.snapshot;
  if (!isPlainObject(snapshot)) return {};
  const toolCall = snapshot.tool_call;
  if (!isPlainObject(toolCall)) return {};

  const args = isPlainObject(toolCall.args) ? toolCall.args : {};
  for (const argument of ARGUMENTS_AGT_ALREADY_READS) {
    if (typeof args[argument] === "string") return {};
  }

  const rawCommand = toolCall.raw_command;
  if (typeof rawCommand !== "string") return {};

  const found = DESTINATION_IN_COMMAND.exec(rawCommand);
  return found === null ? {} : { destination: found[0] };
}
