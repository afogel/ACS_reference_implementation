import { describe, expect, it } from "bun:test";
import { anchorFor, markText, parseOverlay, resolveOverlay, resolveQuote, terminatorFor, type MarkerEntry } from "../src/markers/overlay.ts";

const text = "Alpha MUST beta.\n\n- gamma\n- delta MAY epsilon\n\nAlpha MUST beta again.\n";
const entry = (id: string, start: string, end = start): MarkerEntry => ({ id, source: "x.md", start, end });

describe("resolveQuote -- a quote binds exactly one place or nothing", () => {
  it("resolves a unique quote to its offsets", () => {
    expect(resolveQuote(entry("ACS-REQ-0001", "delta MAY epsilon"), text)).toEqual({ id: "ACS-REQ-0001", source: "x.md", start: 28, end: 45 });
  });

  it("resolves a start/end pair to the span from start to the first end after it", () => {
    const span = resolveQuote(entry("ACS-REQ-0002", "- gamma", "epsilon"), text);
    expect(text.slice(span.start, span.end)).toBe("- gamma\n- delta MAY epsilon");
  });

  it("refuses a start that occurs more than once, rather than binding the first", () => {
    expect(() => resolveQuote(entry("ACS-REQ-0003", "Alpha MUST beta"), text)).toThrow("occurs more than once");
  });

  it("refuses a missing start, a missing end, and an empty quote", () => {
    expect(() => resolveQuote(entry("ACS-REQ-0004", "omega"), text)).toThrow("start quote not found");
    expect(() => resolveQuote(entry("ACS-REQ-0005", "delta", "gamma"), text)).toThrow("end quote not found after start");
    expect(() => resolveQuote(entry("ACS-REQ-0006", ""), text)).toThrow("empty quote");
  });
});

describe("resolveOverlay -- the whole overlay against the corpus", () => {
  const read = (source: string): string | null => (source === "x.md" ? text : null);

  it("collects spans and reports overlap, duplicates, and unknown sources as problems", () => {
    const { spans, problems } = resolveOverlay(
      [
        entry("ACS-REQ-0001", "delta MAY epsilon"),
        entry("ACS-REQ-0002", "- gamma", "epsilon"),
        entry("ACS-REQ-0001", "again"),
        { ...entry("ACS-REQ-0003", "x"), source: "missing.md" },
      ],
      read,
    );
    expect(spans.map((s) => s.id)).toEqual(["ACS-REQ-0001", "ACS-REQ-0002", "ACS-REQ-0001"]);
    expect(problems).toEqual([
      'ACS-REQ-0002: anchor would precede the block marker "-" in x.md; start the quote after it',
      "ACS-REQ-0001: appears more than once in the overlay",
      "ACS-REQ-0003: source missing.md is not in the corpus",
      "ACS-REQ-0001 and ACS-REQ-0002 overlap in x.md; spans must not nest or cross",
    ]);
  });

  it("accepts a quote that starts after the block marker, and refuses one on a heading, a quote, a table row or a numbered item", () => {
    const page = "# Title MUST\n\n> Quoted MUST\n\n| a | b MUST |\n\n1. first MAY\n\n- gamma\n";
    const readPage = (source: string): string | null => (source === "p.md" ? page : null);
    const ok = resolveOverlay([{ ...entry("ACS-REQ-0001", "gamma"), source: "p.md" }, { ...entry("ACS-REQ-0002", "Quoted MUST"), source: "p.md" }], readPage);
    expect(ok.problems).toEqual([]);
    const bad = resolveOverlay(
      [
        { ...entry("ACS-REQ-0003", "# Title MUST"), source: "p.md" },
        { ...entry("ACS-REQ-0004", "> Quoted MUST"), source: "p.md" },
        { ...entry("ACS-REQ-0005", "| a | b MUST |"), source: "p.md" },
        { ...entry("ACS-REQ-0006", "1. first MAY"), source: "p.md" },
      ],
      readPage,
    );
    expect(bad.problems.map((p) => p.split(":")[0])).toEqual(["ACS-REQ-0003", "ACS-REQ-0004", "ACS-REQ-0005", "ACS-REQ-0006"]);
  });

  it("retires an entry whose marker the corpus already carries (E3.3), rather than marking it twice", () => {
    const marked = text.replace("delta MAY epsilon", `${anchorFor("ACS-REQ-0001")}delta MAY epsilon${terminatorFor("ACS-REQ-0001")}`);
    const { spans, problems } = resolveOverlay([entry("ACS-REQ-0001", "delta MAY epsilon")], (source) => (source === "x.md" ? marked : null));
    expect(spans).toEqual([]);
    expect(problems).toEqual(["ACS-REQ-0001: already marked in x.md; remove its overlay entry, the corpus carries the marker now"]);
  });
});

describe("markText -- anchors and terminators are inserted exactly around the span", () => {
  it("wraps each span and leaves everything else byte-identical", () => {
    const span = resolveQuote(entry("ACS-REQ-0001", "delta MAY epsilon"), text);
    const marked = markText(text, [span]);
    expect(marked).toBe(text.replace("delta MAY epsilon", `${anchorFor("ACS-REQ-0001")}delta MAY epsilon${terminatorFor("ACS-REQ-0001")}`));
    expect(anchorFor("ACS-REQ-0001")).toBe('<a id="acs-req-0001"></a>');
    expect(terminatorFor("ACS-REQ-0001")).toBe("<!--/acs-req-0001-->");
  });

  it("handles adjacent spans without one's terminator displacing the other's anchor", () => {
    const a = resolveQuote(entry("ACS-REQ-0001", "Alpha MUST beta."), text);
    const b = resolveQuote(entry("ACS-REQ-0002", "- gamma"), text);
    const marked = markText(text, [b, a]);
    expect(marked).toStartWith('<a id="acs-req-0001"></a>Alpha MUST beta.<!--/acs-req-0001-->\n\n<a id="acs-req-0002"></a>- gamma<!--/acs-req-0002-->');
  });
});

describe("parseOverlay -- the authored file's shape", () => {
  it("accepts quote or start/end, never both, and requires a well-formed id", () => {
    expect(parseOverlay('markers:\n  - id: ACS-REQ-0001\n    source: a.md\n    quote: "x"\n')).toEqual([{ id: "ACS-REQ-0001", source: "a.md", start: "x", end: "x" }]);
    expect(() => parseOverlay('markers:\n  - id: ACS-REQ-0001\n    source: a.md\n    quote: "x"\n    end: "y"\n')).toThrow("use one");
    expect(() => parseOverlay('markers:\n  - id: REQ-1\n    source: a.md\n    quote: "x"\n')).toThrow("needs an id");
    expect(() => parseOverlay("nope: []")).toThrow("expected a top-level `markers:` list");
  });
});
