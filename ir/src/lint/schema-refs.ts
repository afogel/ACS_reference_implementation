/**
 * N26: `lintSchemaRefs()` -- R2.8, schema changes propagate like text changes.
 *
 * A provision that delegates shape to one of the pinned schemas cites a
 * file plus a JSON Pointer (R5.2) and pins `pinned`, the SHA-256 of the
 * subschema at that pointer, canonicalized. A pointer that no longer
 * resolves is a lint failure; a resolved subschema whose hash moved is
 * needs-review on the provision, the same class as a changed sentence.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SchemaRef } from "../catalog/catalog.ts";

export function defaultSchemaDir(): string {
  return resolve(import.meta.dir, "..", "..", "..", "spec", "acs", "specification", "v0.1.0");
}

export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let node: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
      node = node[index];
    } else if (typeof node === "object" && node !== null && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** SHA-256 of the subschema serialized with sorted keys, so key order in the file is not a change. */
export function hashSubschema(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface SchemaRefCheck {
  /** Failures: the ref cannot be checked at all. */
  problems: string[];
  /** Refs whose pinned subschema hash no longer matches: needs-review on the provision. */
  changed: { id: string; ref: SchemaRef; pinned: string; current: string }[];
}

export function lintSchemaRefs(refs: { id: string; refs: SchemaRef[] }[], schemaDir: string = defaultSchemaDir()): SchemaRefCheck {
  const problems: string[] = [];
  const changed: SchemaRefCheck["changed"] = [];
  const cache = new Map<string, unknown>();
  for (const { id, refs: list } of refs) {
    for (const ref of list) {
      const path = join(schemaDir, ref.file);
      if (!cache.has(ref.file)) {
        if (!existsSync(path)) {
          problems.push(`${id}: schema_refs cites ${ref.file}, which is not in ${schemaDir}`);
          cache.set(ref.file, undefined);
          continue;
        }
        cache.set(ref.file, JSON.parse(readFileSync(path, "utf8")));
      }
      const document = cache.get(ref.file);
      if (document === undefined) continue;
      const sub = resolvePointer(document, ref.pointer);
      if (sub === undefined) {
        problems.push(`${id}: schema_refs pointer ${ref.file}#${ref.pointer} does not resolve`);
        continue;
      }
      const current = hashSubschema(sub);
      if (!ref.pinned) {
        problems.push(`${id}: schema_refs ${ref.file}#${ref.pointer} has no pinned hash; pin ${current.slice(0, 12)}…`);
      } else if (ref.pinned !== current) {
        changed.push({ id, ref, pinned: ref.pinned, current });
      }
    }
  }
  return { problems, changed };
}
