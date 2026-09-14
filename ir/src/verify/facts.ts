/**
 * S9: relation facts on disk, one tab-separated `<relation>.facts` per
 * relation, the format Soufflé reads. The evaluator reads the same files,
 * so both engines see byte-identical input (R3.8).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Relation } from "../compile/vocabulary.ts";

export type Value = string | number;
export type Tuple = Value[];

/** Relation name -> tuples. */
export type FactSet = Map<string, Tuple[]>;

export function readFacts(dir: string, relations: Relation[]): FactSet {
  const facts: FactSet = new Map();
  for (const rel of relations) {
    if (rel.source === "static") {
      facts.set(rel.name, rel.facts.map((t) => [...t]));
      continue;
    }
    const path = join(dir, `${rel.name}.facts`);
    if (!existsSync(path)) {
      facts.set(rel.name, []);
      continue;
    }
    const tuples: Tuple[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const cells = line.split("\t");
      if (cells.length !== rel.columns.length) throw new Error(`${path}: expected ${rel.columns.length} columns, got ${cells.length}: ${line}`);
      tuples.push(cells.map((cell, i) => (rel.columns[i]?.type === "number" ? parseNumber(cell, path) : cell)));
    }
    facts.set(rel.name, tuples);
  }
  return facts;
}

/** Write every non-static relation, including empty ones, so Soufflé finds a file for each `.input`. */
export function writeFacts(dir: string, relations: Relation[], facts: FactSet): void {
  mkdirSync(dir, { recursive: true });
  for (const rel of relations) {
    if (rel.source === "static") continue;
    const tuples = facts.get(rel.name) ?? [];
    writeFileSync(join(dir, `${rel.name}.facts`), tuples.map((t) => t.map(String).join("\t")).join("\n") + (tuples.length ? "\n" : ""));
  }
}

export function listFactFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".facts")).sort();
}

function parseNumber(cell: string, path: string): number {
  if (!/^-?\d+$/.test(cell)) throw new Error(`${path}: expected an integer, got ${JSON.stringify(cell)}`);
  return Number(cell);
}
