import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { loadCatalog, loadRecords } from "../src/catalog/catalog.ts";
import { defaultManifestPath, type Manifest } from "../src/extract/extract.ts";
import { renderProvisionIndex } from "../src/render/provision-index.ts";

describe("renderProvisionIndex -- P2 from the real catalog", () => {
  const manifest = JSON.parse(readFileSync(defaultManifestPath(), "utf8")) as Manifest;
  const catalog = loadCatalog(manifest, loadRecords().records);
  const index = renderProvisionIndex(catalog, manifest.corpus, new Map([["ACS-REQ-0007", ["fixtures/violating/expected.tsv"]]]));

  it("renders the index (U12), a detail per provision (U13), and the coverage table (U14)", () => {
    expect(index).toContain("| [ACS-REQ-0007](#acs-req-0007) | Requirement | MUST | observed-agent | acs-core | wire | obligation | active | spec/instrument/specification.md:65 | Handshake precedes any hook traffic |");
    expect(index).toContain("### ACS-REQ-0007\n\n**Handshake precedes any hook traffic.** Requirement. `spec/instrument/specification.md:65` (paragraph, §`4-capability-negotiation-handshake`). Anchor: `#acs-req-0007`.\n\n> Required at session start, before any hook traffic.");
    expect(index).toContain("- Restates: [ACS-REQ-0023](#acs-req-0023)");
    expect(index).toContain("| ACS-EXC-0001 | none |");
    expect(index).not.toContain("**stale**");
    expect(index).toContain("| ACS-REQ-0007 | fixtures/violating/expected.tsv |");
  });

  it("quotes a multi-block provision line by line", () => {
    expect(index).toContain("> `entry_hash = lowercase-hex(SHA-256(content_bytes || prev_hash_bytes))` where:\n> \n> 1. `content_bytes`");
  });
});
