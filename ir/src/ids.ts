/**
 * E1.1 / E1.2: provision identity.
 *
 * `ACS-REQ-0001`, `ACS-DEF-0001`, `ACS-INV-0001`, `ACS-EXC-0001`: a type
 * prefix that partitions the counters and makes a citation self-describing,
 * then a zero-padded opaque sequence number and nothing else. Never a
 * section number, never a structured path (R2.1). The rendered anchor is
 * the lowercase form, `acs-req-0001`, so the HTML `id` namespace is 1:1
 * with provisions (E2.4).
 *
 * Numbers are allocated once from `ir/ids/counter.yaml` and never rewind;
 * a withdrawn provision keeps its number in `ir/ids/tombstones.yaml`
 * (R2.2). Four digits rather than the shaping doc's three, because the
 * slices doc already writes `acs-req-0037` and 203 provisions at v0.1 leave
 * three digits no headroom for v0.2.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toYaml } from "./yaml.ts";

export const PROVISION_TYPES = ["REQ", "DEF", "INV", "EXC"] as const;
export type ProvisionType = (typeof PROVISION_TYPES)[number];
export type NodeType = "Requirement" | "Definition" | "Invariant" | "Exclusion";

export const ID_PATTERN = /^ACS-(REQ|DEF|INV|EXC)-(\d{4})$/;
export const ANCHOR_PATTERN = /^acs-(req|def|inv|exc)-(\d{4})$/;

export function parseId(id: string): { type: ProvisionType; number: number } | null {
  const m = ID_PATTERN.exec(id);
  if (!m) return null;
  return { type: m[1] as ProvisionType, number: Number(m[2]) };
}

export function formatId(type: ProvisionType, number: number): string {
  return `ACS-${type}-${String(number).padStart(4, "0")}`;
}

const NODE_TYPES: Record<ProvisionType, NodeType> = { REQ: "Requirement", DEF: "Definition", INV: "Invariant", EXC: "Exclusion" };

export function nodeType(type: ProvisionType): NodeType {
  return NODE_TYPES[type];
}

export function idToAnchor(id: string): string {
  return id.toLowerCase();
}

export function anchorToId(anchor: string): string {
  return anchor.toUpperCase();
}

export interface Counter {
  REQ: number;
  DEF: number;
  INV: number;
  EXC: number;
}

export interface Tombstone {
  id: string;
  withdrawn_in: string;
  reason: string;
  superseded_by?: string[];
}

export function defaultIdsDir(): string {
  return resolve(import.meta.dir, "..", "ids");
}

export function readCounter(dir: string = defaultIdsDir()): Counter {
  const parsed = Bun.YAML.parse(readFileSync(join(dir, "counter.yaml"), "utf8")) as Partial<Record<ProvisionType, unknown>>;
  const counter = { REQ: 0, DEF: 0, INV: 0, EXC: 0 };
  for (const type of PROVISION_TYPES) {
    const value = parsed[type];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`ids/counter.yaml: ${type} must be a non-negative integer`);
    }
    counter[type] = value;
  }
  return counter;
}

export function readTombstones(dir: string = defaultIdsDir()): Tombstone[] {
  const parsed = Bun.YAML.parse(readFileSync(join(dir, "tombstones.yaml"), "utf8")) as { tombstones?: unknown };
  if (!Array.isArray(parsed?.tombstones)) throw new Error("ids/tombstones.yaml: expected a top-level `tombstones:` list");
  return parsed.tombstones.map((t, i) => {
    if (typeof t !== "object" || t === null) throw new Error(`ids/tombstones.yaml: entry ${i + 1} must be a map`);
    const entry = t as Record<string, unknown>;
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) throw new Error(`ids/tombstones.yaml: entry ${i + 1} needs a valid id`);
    if (typeof entry.withdrawn_in !== "string" || typeof entry.reason !== "string") {
      throw new Error(`ids/tombstones.yaml: ${entry.id} needs withdrawn_in and reason`);
    }
    const tombstone: Tombstone = { id: entry.id, withdrawn_in: entry.withdrawn_in, reason: entry.reason };
    if (Array.isArray(entry.superseded_by)) tombstone.superseded_by = entry.superseded_by.map(String);
    return tombstone;
  });
}

/** N3: hand out the next number of a type and persist the counter, so no two provisions can ever share one. */
export function allocateId(type: ProvisionType, dir: string = defaultIdsDir()): string {
  const counter = readCounter(dir);
  counter[type] += 1;
  writeFileSync(
    join(dir, "counter.yaml"),
    "# Monotonic ID allocation (S6). Bumped by `acs-ir ids next <type>`; never edited down.\n" + toYaml({ ...counter }),
  );
  return formatId(type, counter[type]);
}

/** Every way a set of IDs in use can disagree with the allocation records. */
export function checkAllocated(ids: string[], counter: Counter, tombstones: Tombstone[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const retired = new Set(tombstones.map((t) => t.id));
  for (const id of ids) {
    const parsed = parseId(id);
    if (!parsed) {
      problems.push(`${id}: not a provision ID (expected ACS-{REQ|DEF|INV|EXC}-NNNN)`);
      continue;
    }
    if (seen.has(id)) problems.push(`${id}: used more than once`);
    seen.add(id);
    if (parsed.number === 0 || parsed.number > counter[parsed.type]) {
      problems.push(`${id}: never allocated (counter for ${parsed.type} is ${counter[parsed.type]})`);
    }
    if (retired.has(id)) problems.push(`${id}: is tombstoned and cannot be reused`);
  }
  return problems;
}
