import { describe, expect, it } from "bun:test";
import { lintMarkerPairing } from "../src/lint/marker-pairing.ts";

const ok = 'Intro.\n\n<a id="acs-req-0001"></a>A MUST b.<!--/acs-req-0001--> tail.\n\n| x | <a id="acs-def-0002"></a>cell<!--/acs-def-0002--> |\n';

describe("lintMarkerPairing -- the mandatory terminator, enforced", () => {
  it("yields one span per well-formed pair with the text boundaries the markers state", () => {
    const result = lintMarkerPairing("a.md", ok);
    expect(result.problems).toEqual([]);
    expect(result.spans.map((s) => [s.id, ok.slice(s.start, s.end)])).toEqual([
      ["ACS-REQ-0001", "A MUST b."],
      ["ACS-DEF-0002", "cell"],
    ]);
  });

  it("reports an anchor with no terminator, with its line", () => {
    expect(lintMarkerPairing("a.md", 'x\n<a id="acs-req-0001"></a>open').problems).toEqual(["a.md:2: ACS-REQ-0001 has no terminator"]);
  });

  it("reports a terminator with no anchor", () => {
    expect(lintMarkerPairing("a.md", "x<!--/acs-req-0001-->").problems).toEqual(["a.md:1: terminator for ACS-REQ-0001 with no open anchor"]);
  });

  it("reports a mismatched pair and keeps the anchor open", () => {
    const { problems } = lintMarkerPairing("a.md", '<a id="acs-req-0001"></a>x<!--/acs-req-0002-->');
    expect(problems).toEqual([
      "a.md:1: terminator for ACS-REQ-0002 closes ACS-REQ-0001; the pair must carry one ID",
      "a.md:1: ACS-REQ-0001 has no terminator",
    ]);
  });

  it("reports a nested anchor and a repeated one", () => {
    const { problems } = lintMarkerPairing(
      "a.md",
      '<a id="acs-req-0001"></a>x<a id="acs-req-0002"></a>y<!--/acs-req-0001--><a id="acs-req-0001"></a>z<!--/acs-req-0001-->',
    );
    expect(problems).toEqual(["a.md:1: ACS-REQ-0002 opens inside ACS-REQ-0001; spans must not nest", "a.md:1: ACS-REQ-0001 anchored more than once"]);
  });

  it("ignores anchors and comments that are not provision markers", () => {
    expect(lintMarkerPairing("a.md", '<a id="section-9"></a> <!-- a note --> <!--/not-a-marker-->').spans).toEqual([]);
  });
});
