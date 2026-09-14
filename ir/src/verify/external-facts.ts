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
 * `unevaluated` rather than a pass that was never checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Relation } from "../compile/vocabulary.ts";
import { readFacts, type FactSet, type Tuple } from "./facts.ts";
import { chainEntryHash, verifyHmac } from "./jcs.ts";
import { findProvenance, type NormalizedTrace } from "./normalize-trace.ts";
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

const DEFAULT_SKEW_MS = 300000;

export function computeExternalFacts(normalized: NormalizedTrace, relations: Relation[], schemas: SchemaRegistry, options: ExternalOptions = {}): ExternalFacts {
  const { lines } = normalized;
  const profilesOf = new Map(normalized.sessions.map((s) => [s.session, s.profiles]));
  const skewOf = new Map<string, number>();
  for (const t of normalized.facts.get("skew_window") ?? []) skewOf.set(String(t[0]), Number(t[1]));
  const facts: FactSet = new Map();
  const available = new Set<string>();
  const seen = new Set<string>();
  const add = (relation: string, tuple: Tuple): void => {
    const key = `${relation}\u0000${JSON.stringify(tuple)}`;
    if (seen.has(key)) return; // Ajv reports one instance path several times; a fact is a set member
    seen.add(key);
    facts.set(relation, [...(facts.get(relation) ?? []), tuple]);
  };

  // N43: schemas, always. Envelope, hook payload, the strict provenance variant when the session claims it, and every Provenance object.
  available.add("schema_violation");
  available.add("modification_targets_overlap");
  available.add("timestamp_out_of_window");
  for (const line of lines) {
    const envelope = Array.isArray(line.envelope) ? line.envelope[0] : line.envelope;
    const file = line.direction === "request" ? "request-envelope.json" : "response-envelope.json";
    for (const e of schemas.validate(file, envelope)) add("schema_violation", [line.seq, file, e.path]);
    const session = normalized.sessionOf.get(line.seq) ?? "";
    if (line.direction === "request" && line.method) {
      const params = (envelope as { params?: Record<string, unknown> })?.params;
      const payload = params?.payload;
      const hook = hookSchemaFile(line.method);
      if (hook && schemas.has(hook) && payload !== undefined) {
        for (const e of schemas.validate(hook, payload)) add("schema_violation", [line.seq, hook, e.path]);
        const strict = hook.replace(/\.json$/, ".acs-provenance.json");
        if ((profilesOf.get(session) ?? []).includes("acs-provenance") && schemas.has(strict)) {
          for (const e of schemas.validate(strict, payload)) add("schema_violation", [line.seq, strict, e.path]);
        }
      }
      for (const p of findProvenance(payload)) for (const e of schemas.validate("provenance.json", p)) add("schema_violation", [line.seq, "provenance.json", `/${p.provenance_id}${e.path}`]);
      // §10.3: the request's timestamp against the Guardian's clock, within the negotiated window.
      const stamp = typeof params?.timestamp === "string" ? Date.parse(params.timestamp) : Number.NaN;
      const recorded = line.recorded_at ? Date.parse(line.recorded_at) : Number.NaN;
      if (!Number.isNaN(stamp) && !Number.isNaN(recorded) && Math.abs(stamp - recorded) > (skewOf.get(session) ?? DEFAULT_SKEW_MS)) add("timestamp_out_of_window", [line.seq]);
    } else {
      // §6.3: redaction paths against parameter-override targets.
      const result = (envelope as { result?: { modifications?: { redactions?: { path?: string }[]; parameter_overrides?: Record<string, unknown> } } })?.result;
      const mods = result?.modifications;
      if (mods) {
        const redactions = (mods.redactions ?? []).map((r) => r.path).filter((p): p is string => typeof p === "string");
        const overrides = Object.keys(mods.parameter_overrides ?? {});
        for (const p of redactions) for (const key of overrides) for (const q of [`/arguments/${key}`, `/${key}`]) if (p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)) add("modification_targets_overlap", [line.seq, p, q]);
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
      available.add("context_entry_field");
      available.add("context_entry_step");
      for (const raw of readFileSync(entries, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        const { session_id, seq, entry } = JSON.parse(raw) as { session_id: string; seq: number; entry: Record<string, unknown> };
        add("context_entry", [session_id, String(entry.entry_id), seq, String(entry.entry_hash)]);
        add("entry_hash_recomputed", [String(entry.entry_id), chainEntryHash(entry)]);
        for (const [field, value] of Object.entries(entry)) if (value !== null && value !== undefined) add("context_entry_field", [session_id, String(entry.entry_id), field]);
        if (typeof entry.step_type === "string") add("context_entry_step", [session_id, String(entry.entry_id), entry.step_type]);
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
