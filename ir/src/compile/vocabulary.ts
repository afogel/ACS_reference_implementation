/**
 * N30: `loadVocabulary()` -- the fact vocabulary (S7), read and checked.
 *
 * Relations, their typed columns, where their tuples come from, and for
 * static relations the tuples themselves. The compiler's type checker is
 * the vocabulary's validator (the breadboard's one gap, closed by letting
 * the compiler find what the vocabulary cannot express rather than a
 * separate lint guess at it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ColumnType = "symbol" | "number";
export type RelationSource = "wire" | "external" | "guardian-state" | "deployment" | "static";

export interface Column {
  name: string;
  type: ColumnType;
}

export interface Relation {
  name: string;
  source: RelationSource;
  columns: Column[];
  doc: string | null;
  /** Static relations only: the tuples, shipped with the compiled program. */
  facts: (string | number)[][];
}

export interface Vocabulary {
  relations: Map<string, Relation>;
}

const NAME = /^[a-z][a-z0-9_]*$/;
const SOURCES: ReadonlySet<string> = new Set(["wire", "external", "guardian-state", "deployment", "static"]);

export function defaultVocabularyPath(): string {
  return resolve(import.meta.dir, "..", "..", "vocabulary", "relations.yaml");
}

export function loadVocabulary(path: string = defaultVocabularyPath()): Vocabulary {
  return parseVocabulary(readFileSync(path, "utf8"));
}

export function parseVocabulary(yamlText: string): Vocabulary {
  const parsed = Bun.YAML.parse(yamlText) as { relations?: unknown };
  if (!Array.isArray(parsed?.relations)) throw new Error("relations.yaml: expected a top-level `relations:` list");
  const relations = new Map<string, Relation>();
  for (const raw of parsed.relations) {
    if (typeof raw !== "object" || raw === null) throw new Error("relations.yaml: each relation must be a map");
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || !NAME.test(r.name)) throw new Error(`relations.yaml: bad relation name ${String(r.name)}`);
    if (relations.has(r.name)) throw new Error(`relations.yaml: ${r.name} declared twice`);
    if (typeof r.source !== "string" || !SOURCES.has(r.source)) throw new Error(`relations.yaml: ${r.name}: source must be wire | external | guardian-state | deployment | static`);
    if (!Array.isArray(r.columns) || r.columns.length === 0) throw new Error(`relations.yaml: ${r.name}: needs at least one column`);
    const columns: Column[] = r.columns.map((c) => {
      const col = c as Record<string, unknown>;
      if (typeof col.name !== "string" || !NAME.test(col.name)) throw new Error(`relations.yaml: ${r.name}: bad column name`);
      if (col.type !== "symbol" && col.type !== "number") throw new Error(`relations.yaml: ${r.name}.${col.name}: type must be symbol | number`);
      return { name: col.name, type: col.type };
    });
    const facts: (string | number)[][] = [];
    if (r.facts !== undefined) {
      if (r.source !== "static") throw new Error(`relations.yaml: ${r.name}: only static relations carry facts`);
      if (!Array.isArray(r.facts)) throw new Error(`relations.yaml: ${r.name}: facts must be a list of tuples`);
      for (const tuple of r.facts) {
        if (!Array.isArray(tuple) || tuple.length !== columns.length) throw new Error(`relations.yaml: ${r.name}: a fact has the wrong arity`);
        tuple.forEach((v, i) => {
          const type = columns[i]?.type;
          if ((type === "number" && typeof v !== "number") || (type === "symbol" && typeof v !== "string")) {
            throw new Error(`relations.yaml: ${r.name}: fact column ${columns[i]?.name} must be a ${type}`);
          }
        });
        facts.push(tuple as (string | number)[]);
      }
    } else if (r.source === "static") {
      throw new Error(`relations.yaml: ${r.name}: a static relation must list its facts`);
    }
    relations.set(r.name, { name: r.name, source: r.source as RelationSource, columns, doc: typeof r.doc === "string" ? r.doc : null, facts });
  }
  return { relations };
}
