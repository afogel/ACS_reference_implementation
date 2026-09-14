import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateId, checkAllocated, formatId, idToAnchor, nodeType, parseId, readCounter, readTombstones } from "../src/ids.ts";

describe("provision IDs -- opaque, typed, four digits", () => {
  it("parses and formats the four types", () => {
    expect(parseId("ACS-REQ-0017")).toEqual({ type: "REQ", number: 17 });
    expect(parseId("ACS-3.4.2-MUST-1")).toBeNull();
    expect(formatId("EXC", 4)).toBe("ACS-EXC-0004");
    expect(idToAnchor("ACS-DEF-0002")).toBe("acs-def-0002");
    expect(nodeType("INV")).toBe("Invariant");
  });
});

describe("allocateId -- the counter only goes up", () => {
  it("allocates the next number and persists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-ids-"));
    writeFileSync(join(dir, "counter.yaml"), "REQ: 2\nDEF: 0\nINV: 0\nEXC: 0\n");
    writeFileSync(join(dir, "tombstones.yaml"), "tombstones: []\n");
    expect(allocateId("REQ", dir)).toBe("ACS-REQ-0003");
    expect(allocateId("DEF", dir)).toBe("ACS-DEF-0001");
    expect(readCounter(dir)).toEqual({ REQ: 3, DEF: 1, INV: 0, EXC: 0 });
    expect(readFileSync(join(dir, "counter.yaml"), "utf8")).toStartWith("# Monotonic ID allocation");
  });

  it("rejects a malformed counter or tombstone file", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-ir-ids-"));
    writeFileSync(join(dir, "counter.yaml"), "REQ: -1\nDEF: 0\nINV: 0\nEXC: 0\n");
    writeFileSync(join(dir, "tombstones.yaml"), "tombstones:\n  - id: ACS-REQ-0001\n");
    expect(() => readCounter(dir)).toThrow("REQ must be a non-negative integer");
    expect(() => readTombstones(dir)).toThrow("needs withdrawn_in and reason");
  });
});

describe("checkAllocated -- IDs in use must come from the counter and not from the tombstones", () => {
  const counter = { REQ: 3, DEF: 1, INV: 0, EXC: 0 };
  const tombstones = [{ id: "ACS-REQ-0002", withdrawn_in: "0.1.2", reason: "merged into ACS-REQ-0003" }];

  it("passes allocated, live, unique IDs", () => {
    expect(checkAllocated(["ACS-REQ-0001", "ACS-REQ-0003", "ACS-DEF-0001"], counter, tombstones)).toEqual([]);
  });

  it("names unallocated, tombstoned, duplicated, and malformed IDs", () => {
    expect(checkAllocated(["ACS-REQ-0004", "ACS-REQ-0002", "ACS-INV-0001", "ACS-REQ-0001", "ACS-REQ-0001", "nope"], counter, tombstones)).toEqual([
      "ACS-REQ-0004: never allocated (counter for REQ is 3)",
      "ACS-REQ-0002: is tombstoned and cannot be reused",
      "ACS-INV-0001: never allocated (counter for INV is 0)",
      "ACS-REQ-0001: used more than once",
      "nope: not a provision ID (expected ACS-{REQ|DEF|INV|EXC}-NNNN)",
    ]);
  });
});
