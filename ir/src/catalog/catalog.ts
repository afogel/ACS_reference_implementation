/**
 * E5.1 and N15: the authored semantic layer, and the one join.
 *
 * `ir/provisions/<ID>.yaml` holds what only an editor can say about a
 * provision: which actor it binds, which profile activates it, what
 * observation could falsify it, whether it is an obligation or a permission,
 * and what it depends on or restates. `loadCatalog()` joins those records
 * to the generated manifest by ID and nothing else. S4 is written only by
 * the extractor; S5 is written only by a human; this is the only place they
 * are joined, which is what lets R2.5 and R7.1 hold at once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest, ManifestEntry } from "../extract/extract.ts";
import { ID_PATTERN } from "../ids.ts";

export const ACTORS = ["observed-agent", "guardian", "approver", "framework", "deployment", "verifier", "none"] as const;
export type Actor = (typeof ACTORS)[number];

export const PROFILES = ["acs-core", "acs-trace", "acs-inspect", "acs-inspect-dynamic", "acs-provenance", "acs-crypto", "acs-audit"] as const;
export type Profile = (typeof PROFILES)[number];

export const MODALITIES = ["obligation", "permission", "conditional-on-exercise", "definition", "invariant", "exclusion"] as const;
export type Modality = (typeof MODALITIES)[number];

export const EVIDENCE_CLASSES = ["wire", "schema", "guardian-state", "deployment-config", "non-testable", "not-applicable"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface SchemaRef {
  file: string;
  pointer: string;
  /** SHA-256 of the canonicalized subschema at `pointer`, as last reviewed (R2.8). Required from V4; `lintSchemaRefs()` says what to pin. */
  pinned?: string;
}

export interface ProvisionRecord {
  id: string;
  title: string;
  actor: Actor;
  reported_against: Actor;
  /** The profiles that activate the provision, or `all` for one that holds under every profile. */
  profile: Profile[] | "all";
  /** Session state that activates a conditional provision, in prose; null when unconditional (R4.5). */
  activation: string | null;
  modality_kind: Modality;
  evidence_class: EvidenceClass;
  schema_refs: SchemaRef[];
  depends_on: string[];
  /** R2.9: the concept-page provision this pillar copy restates. Direction is fixed: pillar copy -> concept provision. */
  restates: string | null;
  status: "active" | "withdrawn";
  since: string;
  superseded_by: string[];
  /** The `text_hash` this record was last reviewed against (E5.2). */
  reviewed_against: string;
  note: string | null;
  predicate: PredicateSpec | null;
}

/** E5.1's `predicate`: rules over the vocabulary, an alias of the restated provision's, or a declared reason the vocabulary cannot express it (R3.6). */
export type PredicateSpec =
  | { kind: "rules"; subject: string[]; witness: string[]; rules: string[] }
  | { kind: "alias"; alias_of: string }
  | { kind: "inexpressible"; reason: string };

export interface CatalogEntry {
  manifest: ManifestEntry;
  record: ProvisionRecord;
}

export interface Catalog {
  entries: CatalogEntry[];
  problems: string[];
}

export function defaultProvisionsDir(): string {
  return resolve(import.meta.dir, "..", "..", "provisions");
}

export function parseProvisionRecord(yamlText: string, expectedId?: string): ProvisionRecord {
  const raw = Bun.YAML.parse(yamlText);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("provision record must be a map");
  const r = raw as Record<string, unknown>;
  const id = str(r, "id");
  if (!ID_PATTERN.test(id)) throw new Error(`${id}: not a provision ID`);
  if (expectedId !== undefined && id !== expectedId) throw new Error(`${expectedId}: record carries id ${id}`);
  const profile = r.profile === "all" ? "all" : list(r, "profile");
  if (profile !== "all") for (const p of profile) if (!PROFILES.includes(p as Profile)) throw new Error(`${id}: unknown profile ${p}`);
  const record: ProvisionRecord = {
    id,
    title: str(r, "title"),
    actor: oneOf(r, "actor", ACTORS, id),
    reported_against: oneOf(r, "reported_against", ACTORS, id),
    profile: profile as Profile[] | "all",
    activation: optStr(r, "activation"),
    modality_kind: oneOf(r, "modality_kind", MODALITIES, id),
    evidence_class: oneOf(r, "evidence_class", EVIDENCE_CLASSES, id),
    schema_refs: schemaRefs(r, id),
    depends_on: list(r, "depends_on"),
    restates: optStr(r, "restates"),
    status: oneOf(r, "status", ["active", "withdrawn"] as const, id),
    since: str(r, "since"),
    superseded_by: list(r, "superseded_by"),
    reviewed_against: str(r, "reviewed_against"),
    note: optStr(r, "note"),
    predicate: predicateSpec(r, id),
  };
  for (const ref of [...record.depends_on, ...record.superseded_by, ...(record.restates ? [record.restates] : [])]) {
    if (!ID_PATTERN.test(ref)) throw new Error(`${id}: ${ref} is not a provision ID`);
  }
  return record;
}

export function loadRecords(dir: string = defaultProvisionsDir()): { records: ProvisionRecord[]; problems: string[] } {
  const records: ProvisionRecord[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
    try {
      records.push(parseProvisionRecord(readFileSync(join(dir, name), "utf8"), name.replace(/\.yaml$/, "")));
    } catch (error) {
      problems.push(`provisions/${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, problems };
}

/** N15: manifest ⋈ records on ID. Every mismatch is a problem: a provision with one half is not a provision. */
export function loadCatalog(manifest: Manifest, records: ProvisionRecord[]): Catalog {
  const problems: string[] = [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const manifestIds = new Set(manifest.provisions.map((p) => p.id));
  const entries: CatalogEntry[] = [];
  for (const m of manifest.provisions) {
    const record = byId.get(m.id);
    if (!record) {
      problems.push(`${m.id}: marked in the corpus but has no record in ir/provisions/`);
      continue;
    }
    entries.push({ manifest: m, record });
  }
  for (const r of records) {
    // A withdrawn record is expected to have no marker: that is what withdrawal means (R2.2).
    if (!manifestIds.has(r.id) && r.status !== "withdrawn") problems.push(`${r.id}: has a record but is not marked in the corpus`);
  }
  const sourceOf = new Map(manifest.provisions.map((p) => [p.id, p.source_file]));
  for (const { record } of entries) {
    for (const dep of record.depends_on) {
      if (!manifestIds.has(dep)) problems.push(`${record.id}: depends_on ${dep}, which is not in the catalog`);
    }
    if (record.restates) {
      const target = sourceOf.get(record.restates);
      if (target === undefined) problems.push(`${record.id}: restates ${record.restates}, which is not in the catalog`);
      else if (!target.startsWith("concepts/")) {
        problems.push(`${record.id}: restates ${record.restates} in ${target}; a restatement points at the concept-page copy (concepts/README.md:33)`);
      }
    }
  }
  return { entries, problems };
}

function str(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${String(r.id ?? "?")}: ${key} must be a non-empty string`);
  return v;
}

function optStr(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${String(r.id ?? "?")}: ${key} must be a string or null`);
  return v;
}

function list(r: Record<string, unknown>, key: string): string[] {
  const v = r[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${String(r.id ?? "?")}: ${key} must be a list of strings`);
  return v as string[];
}

function oneOf<T extends string>(r: Record<string, unknown>, key: string, allowed: readonly T[], id: string): T {
  const v = r[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new Error(`${id}: ${key} must be one of ${allowed.join(" | ")}`);
  return v as T;
}

function predicateSpec(r: Record<string, unknown>, id: string): PredicateSpec | null {
  const v = r.predicate;
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${id}: predicate must be a map`);
  const p = v as Record<string, unknown>;
  if (typeof p.alias_of === "string") {
    if (!ID_PATTERN.test(p.alias_of)) throw new Error(`${id}: predicate alias_of must be a provision ID`);
    return { kind: "alias", alias_of: p.alias_of };
  }
  if (typeof p.inexpressible === "string") return { kind: "inexpressible", reason: p.inexpressible };
  const names = (key: string): string[] => {
    const l = p[key];
    if (!Array.isArray(l) || !l.every((x) => typeof x === "string" && /^[A-Z][A-Za-z0-9_]*$/.test(x))) throw new Error(`${id}: predicate.${key} must be a list of variable names`);
    return l as string[];
  };
  if (!Array.isArray(p.rules) || !p.rules.every((x) => typeof x === "string")) throw new Error(`${id}: predicate.rules must be a list of rule strings`);
  return { kind: "rules", subject: names("subject"), witness: names("witness"), rules: p.rules as string[] };
}

function schemaRefs(r: Record<string, unknown>, id: string): SchemaRef[] {
  const v = r.schema_refs;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${id}: schema_refs must be a list`);
  return v.map((ref) => {
    if (typeof ref !== "object" || ref === null) throw new Error(`${id}: each schema_ref needs file and pointer`);
    const o = ref as Record<string, unknown>;
    if (typeof o.file !== "string" || typeof o.pointer !== "string" || !o.pointer.startsWith("/")) {
      throw new Error(`${id}: each schema_ref needs a file and a JSON Pointer starting with /`);
    }
    const parsed: SchemaRef = { file: o.file, pointer: o.pointer };
    if (o.pinned !== undefined) {
      if (typeof o.pinned !== "string" || !/^[0-9a-f]{64}$/.test(o.pinned)) throw new Error(`${id}: schema_ref pinned must be a SHA-256 hex digest`);
      parsed.pinned = o.pinned;
    }
    return parsed;
  });
}
