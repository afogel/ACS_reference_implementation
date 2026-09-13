/**
 * N19: `seedDependsOn()` -- parse a concept page's `**Referenced by**`
 * footer into candidate dependency edges.
 *
 * X5 found eight concept pages already carry the `depends_on` graph in
 * prose, in the reverse direction: the concept names the pillar sections
 * that consume it. The IR seeds R3.7's edges from these footers and, once
 * provisions exist (V2), lints the two against each other in both
 * directions (U33): a footer entry with no provision depending back is a
 * missing edge or a stale footer. In V1 every entry is unmatched, and the
 * audit says so rather than hiding the column.
 *
 * Only the footer is read. Body prose links are the page's own
 * cross-references, not dependency claims.
 */
import { posix } from "node:path";

export interface FooterTarget {
  /** Target document, relative to `docs/`; external URLs are kept verbatim. */
  doc: string;
  anchor: string | null;
  label: string;
  external: boolean;
  exists: boolean;
}

export interface FooterEdge {
  /** The concept page carrying the footer, relative to `docs/`. */
  from: string;
  line: number;
  /** `pillar`: an entry naming a pillar that consumes the concept. `see_also`: concept-to-concept, not a dependency claim. */
  kind: "pillar" | "see_also";
  pillar: string | null;
  targets: FooterTarget[];
  /** The list item's text, whitespace-collapsed. */
  text: string;
}

export interface FooterScan {
  source: string;
  has_footer: boolean;
  edges: FooterEdge[];
}

const FOOTER = /^\*\*Referenced by\*\*\s*$/;
const ITEM = /^\s*[-*+]\s+(.*)$/;
const PILLAR = /^\*\*([^*]+)\*\*/;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function seedDependsOn(source: string, text: string, exists: (doc: string) => boolean): FooterScan {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => FOOTER.test(l));
  if (start === -1) return { source, has_footer: false, edges: [] };

  const edges: FooterEdge[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    const item = ITEM.exec(raw);
    if (!item) break;
    const body = item[1] ?? "";
    const seeAlso = /^see also\b/i.test(body);
    const pillar = seeAlso ? null : (PILLAR.exec(body)?.[1]?.trim() ?? null);
    edges.push({
      from: source,
      line: i + 1,
      kind: seeAlso ? "see_also" : "pillar",
      pillar,
      targets: parseTargets(source, body, exists),
      text: body.replace(/\s+/g, " ").trim(),
    });
  }
  return { source, has_footer: true, edges };
}

function parseTargets(source: string, body: string, exists: (doc: string) => boolean): FooterTarget[] {
  const targets: FooterTarget[] = [];
  for (const match of body.matchAll(LINK)) {
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    if (/^[a-z]+:/i.test(href)) {
      targets.push({ doc: href, anchor: null, label, external: true, exists: true });
      continue;
    }
    const [path = "", anchor] = href.split("#", 2);
    const doc = path === "" ? source : posix.normalize(posix.join(posix.dirname(source), path));
    targets.push({ doc, anchor: anchor ?? null, label, external: false, exists: exists(doc) });
  }
  return targets;
}
