/**
 * N42: `computeExternalFacts()` -- the relations Datalog cannot derive (E7.1, S10).
 *
 * Three sources, each declared and each optional:
 *
 *  - schema validation of every envelope and hook payload (N43), always;
 *  - signature verification, when the deployment's HMAC key is supplied,
 *    giving `signature_status` and `signature_covers`;
 *  - the Guardian's own records, when a dump directory is supplied:
 *    `context-entries.jsonl` (full ContextEntry objects, from which
 *    `context_entry` and the §8.2 recomputation `entry_hash_recomputed` are
 *    produced) and `facts/<relation>.facts` for the other guardian-state
 *    relations; plus deployment facts from a facts directory.
 *
 * What was not supplied is reported as unavailable, and every provision
 * whose predicate needs an unavailable relation gets the verdict
 * `unevaluated` rather than a pass it did not earn.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Relation } from "../compile/vocabulary.ts";
import { readFacts, type FactSet, type Tuple } from "./facts.ts";
import { chainEntryHash, verifyHmac } from "./jcs.ts";
import type { TraceLine } from "./normalize-trace.ts";
import { hookSchemaFile, type SchemaRegistry } from "./schemas.ts";

export interface ExternalOptions {
  hmacKey?: Buffer | null;
  guardianDir?: string | null;
  deploymentDir?: string | null;
}

export interface ExternalFacts {
  facts: FactSet;
  /** Relations whose source could be produced from what was supplied. */
  available: Set<string>;
}

export function computeExternalFacts(lines: TraceLine[], relations: Relation[], schemas: SchemaRegistry, options: ExternalOptions = {}): ExternalFacts {
  const facts: FactSet = new Map();
  const available = new Set<string>();
  const seen = new Set<string>();
  const add = (relation: string, tuple: Tuple): void => {
    const key = `${relation}\u0000${JSON.stringify(tuple)}`;
    if (seen.has(key)) return; // Ajv reports one instance path several times; a fact is a set member
    seen.add(key);
    facts.set(relation, [...(facts.get(relation) ?? []), tuple]);
  };

  // N43: schemas, always.
  available.add("schema_violation");
  for (const line of lines) {
    const envelope = Array.isArray(line.envelope) ? line.envelope[0] : line.envelope;
    const file = line.direction === "request" ? "request-envelope.json" : "response-envelope.json";
    for (const e of schemas.validate(file, envelope)) add("schema_violation", [line.seq, file, e.path]);
    if (line.direction === "request" && line.method) {
      const hook = hookSchemaFile(line.method);
      const payload = (envelope as { params?: { payload?: unknown } })?.params?.payload;
      if (hook && schemas.has(hook) && payload !== undefined) {
        for (const e of schemas.validate(hook, payload)) add("schema_violation", [line.seq, hook, e.path]);
      }
    }
  }

  // Signatures, when the key is known.
  if (options.hmacKey) {
    available.add("signature_status");
    available.add("signature_covers");
    for (const line of lines) {
      const envelope = Array.isArray(line.envelope) ? line.envelope[0] : line.envelope;
      if (typeof envelope !== "object" || envelope === null) continue;
      const { status, coversChainHash } = verifyHmac(envelope as Record<string, unknown>, options.hmacKey);
      add("signature_status", [line.seq, status]);
      if (status === "valid" && coversChainHash) add("signature_covers", [line.seq, "chain_hash"]);
    }
  }

  // The Guardian's records.
  if (options.guardianDir) {
    const entries = join(options.guardianDir, "context-entries.jsonl");
    if (existsSync(entries)) {
      available.add("context_entry");
      available.add("entry_hash_recomputed");
      for (const raw of readFileSync(entries, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        const { session_id, seq, entry } = JSON.parse(raw) as { session_id: string; seq: number; entry: Record<string, unknown> };
        add("context_entry", [session_id, String(entry.entry_id), seq, String(entry.entry_hash)]);
        add("entry_hash_recomputed", [String(entry.entry_id), chainEntryHash(entry)]);
      }
    }
    const factsDir = join(options.guardianDir, "facts");
    if (existsSync(factsDir)) mergeFactFiles(factsDir, relations.filter((r) => r.source === "guardian-state"), facts, available);
  }
  if (options.deploymentDir && existsSync(options.deploymentDir)) {
    mergeFactFiles(options.deploymentDir, relations.filter((r) => r.source === "deployment"), facts, available);
  }
  return { facts, available };
}

function mergeFactFiles(dir: string, relations: Relation[], into: FactSet, available: Set<string>): void {
  const read = readFacts(dir, relations);
  for (const rel of relations) {
    if (!existsSync(join(dir, `${rel.name}.facts`))) continue;
    available.add(rel.name);
    into.set(rel.name, [...(into.get(rel.name) ?? []), ...(read.get(rel.name) ?? [])]);
  }
}
