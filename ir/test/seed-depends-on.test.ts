import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedDependsOn } from "../src/census/seed-depends-on.ts";

const thing = readFileSync(join(import.meta.dir, "fixtures", "mini", "docs", "concepts", "thing.md"), "utf8");
const exists = (doc: string): boolean => ["spec/rules.md", "concepts/thing.md"].includes(doc);

describe("seedDependsOn -- Referenced-by footers as candidate depends_on edges", () => {
  const scan = seedDependsOn("concepts/thing.md", thing, exists);

  it("reports the footer and one edge per list item", () => {
    expect(scan.has_footer).toBe(true);
    expect(scan.edges.map((e) => [e.line, e.kind, e.pillar])).toEqual([
      [11, "pillar", "Instrument"],
      [12, "pillar", "Trace"],
      [13, "see_also", null],
    ]);
  });

  it("resolves relative links against the page, splits anchors, and checks the target exists", () => {
    expect(scan.edges[0]?.targets).toEqual([
      { doc: "spec/rules.md", anchor: null, label: "rules", external: false, exists: true },
      { doc: "spec/hooks.md", anchor: "anchor", label: "hooks", external: false, exists: false },
    ]);
  });

  it("keeps an external URL verbatim and never calls it dangling", () => {
    expect(scan.edges[1]?.targets).toEqual([{ doc: "https://example.org/events", anchor: null, label: "events", external: true, exists: true }]);
  });

  it("marks a See-also entry as concept-to-concept rather than a pillar edge", () => {
    expect(scan.edges[2]?.targets[0]).toMatchObject({ doc: "concepts/other.md", exists: false });
  });

  it("reads only the footer, not body links", () => {
    const body = "See [rules](../spec/rules.md) in the body.\n\nNo footer here.";
    expect(seedDependsOn("concepts/x.md", body, exists)).toEqual({ source: "concepts/x.md", has_footer: false, edges: [] });
  });

  it("stops at the first non-list line after the footer", () => {
    const text = "**Referenced by**\n\n- **Instrument**, [r](../spec/rules.md)\n\nA closing paragraph with a [link](../spec/rules.md).";
    expect(seedDependsOn("concepts/x.md", text, exists).edges).toHaveLength(1);
  });
});
