import { describe, expect, it } from "bun:test";
import { loadMapping } from "guardian";
import { renderMappingTable } from "../src/render.ts";

describe("N48 -- renderMappingTable renders S10 and nothing else", () => {
  const table = renderMappingTable(loadMapping("mapping.yaml"));

  it("names every AGT intervention point mapping.yaml declares, with its ACS method", () => {
    expect(table).toContain("pre_tool_call");
    expect(table).toContain("steps/toolCallRequest");
    expect(table).toContain("post_model_call");
  });

  it("says what an unmapped point is, rather than leaving its ACS column blank", () => {
    expect(table).toMatch(/post_model_call.*no ACS v0\.1\.0 target/s);
  });

  it("renders AGT's five verdicts against ACS's five dispositions without calling either list 'the five'", () => {
    expect(table).toContain("warn");
    expect(table).toContain("escalate");
    // R1.2's discriminator is part of the mapping and must be visible in it.
    expect(table).toMatch(/warn.*policy_references/s);
  });

  it("is a pure function of the mapping it is handed", () => {
    const mapping = loadMapping("mapping.yaml");
    expect(renderMappingTable(mapping)).toBe(renderMappingTable(mapping));
  });
});
